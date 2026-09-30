'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, Search } from 'lucide-react';
import { readRiskEvidence } from './riskEvidenceClient.js';
import { isBankDirectory } from '../../utils/bank/directory.js';
import s from './RiskIntelligence.module.css';

export default function RiskBankEvidence({ companyName, ticker, companyPeriod }: { companyName: string; ticker: string; companyPeriod: string }) {
  // Suggested text is a directory search, never an inferred corporate mapping.
  const suggestion = companyName.replace(/&.*$|\b(?:CORP(?:ORATION)?|INC(?:ORPORATED)?|CO|LTD|HOLDINGS?)\b.*$/i, '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim().slice(0, 90);
  const [input, setInput] = useState(suggestion);
  const [query, setQuery] = useState(suggestion.length >= 2 ? suggestion : '');
  const [directory, setDirectory] = useState<any>(null), [directoryError, setDirectoryError] = useState('');
  const [rssd, setRssd] = useState(''), [data, setData] = useState<any>(null), [error, setError] = useState('');
  const [retry, setRetry] = useState(0), [period, setPeriod] = useState('');
  useEffect(() => {
    let active = true; setDirectory(null); setDirectoryError('');
    if (query.length < 2) return;
    readRiskEvidence(`/api/banks?q=${encodeURIComponent(query)}`).then(result => {
      if (!isBankDirectory(result)) throw new Error('The bank directory response could not be verified.');
      if (active) setDirectory(result);
    }).catch(cause => { if (active) setDirectoryError(cause.message); });
    return () => { active = false; };
  }, [query, retry]);
  useEffect(() => {
    let active = true; setData(null); setError('');
    if (!rssd) return;
    readRiskEvidence(`/api/risk/context?source=bank&rssd=${rssd}`).then(result => {
      if (result.source !== 'bank' || result.rssd !== Number(rssd) || !Array.isArray(result.metrics) || !Array.isArray(result.reportingPeriods)) throw new Error('The bank’s reporting identity could not be verified.');
      if (!active) return;
      setData(result);
      const dates = result.reportingPeriods.map((row: any) => row.date);
      setPeriod(dates.includes(companyPeriod) ? companyPeriod : dates.at(-1) || '');
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [rssd, retry, companyPeriod]);
  const bank = data?.bank;
  const dates: string[] = data?.reportingPeriods?.map((row: any) => row.date) || [];
  const report = data?.reportingPeriods?.find((row: any) => row.date === period);
  const view = { report, sourceUrl: report?.sourceUrl, valid: report?.status === 'ready',
    cards: (data?.metrics || []).map((metric: any) => ({ ...metric, value: metric.history.find((row: any) => row.date === period)?.value ?? null })) };
  return <>
    <div className={s.panelHeading}><div><h3>See the bank behind the balance sheet</h3><p>FFIEC Call Reports · Legal bank entity · Quarterly regulatory data</p></div><Building2 size={24}/></div>
    <p className={s.notice}>Select a bank to review alongside {ticker}. Search results are name matches, not verified ownership links. Bank capital and deposits are separate from the SEC registrant’s consolidated figures.</p>
    <form className={s.bankSearch} onSubmit={event => { event.preventDefault(); const next = input.trim(); if (next.length < 2) return; setRssd(''); setData(null); if (next === query) setRetry(n => n + 1); else setQuery(next); }}>
      <label htmlFor="risk-bank-search">Find a legal bank by name, RSSD, or FDIC certificate</label><div><input id="risk-bank-search" value={input} onChange={event => setInput(event.target.value)} placeholder="e.g. JPMorgan Chase" maxLength={100}/><button className={s.button} disabled={input.trim().length < 2}><Search size={16}/>Find bank</button></div>
    </form>
    {query && !directory && !directoryError && <p className={s.state} role="status">Searching the FFIEC bank directory…</p>}
    {directoryError && <p className={s.state} role="alert">{directoryError} <button className={s.button} onClick={() => setRetry(n => n + 1)}>Retry directory</button></p>}
    {directory && <><p className={s.caption}>{directory.banks.length ? `${directory.banks.length} matches · Select the institution you intend to analyze.` : 'No matching banks. Try a shorter legal name, RSSD, or FDIC certificate.'}</p><ul className={s.bankResults}>{directory.banks.map((row: any) => <li key={row.id_rssd}><button aria-pressed={rssd === String(row.id_rssd)} onClick={() => { if (rssd === String(row.id_rssd)) return; setRssd(String(row.id_rssd)); setData(null); }}><strong>{row.legal_name}</strong><span>{row.city}, {row.state} · RSSD {row.id_rssd}</span><span>{row.prepared_quarters} prepared quarters · FFIEC {row.form_type}</span></button></li>)}</ul></>}
    {rssd && !data && !error && <p className={s.state} role="status">Reading prepared Call Reports…</p>}
    {error && <p className={s.state} role="alert">{error} <button className={s.button} onClick={() => setRetry(n => n + 1)}>Retry bank reports</button></p>}
    {data && !bank && <p className={s.state}>This institution has no prepared bank profile. Open BankScope to review its coverage.</p>}
    {data && bank && <>
      <div className={s.bankIdentity}><div><h4>{bank.name}</h4><p>RSSD {rssd} · FFIEC {bank.form}</p></div><label>Quarter<select value={period} onChange={event => setPeriod(event.target.value)}>{dates.map((date: string) => <option key={date}>{date}</option>)}</select></label></div>
      {data.stale && <p className={s.notice}>Retained bank data. Confirm the latest prepared quarter in BankScope.</p>}
      {period !== companyPeriod && <p className={s.notice}>Different reporting dates: bank {period || 'unavailable'}; SEC company {companyPeriod || 'unavailable'}. These figures are not reconciled or combined.</p>}
      {view.valid ? <>
        <div className={s.statGrid}>{view.cards.map(card => <div className={s.stat} key={card.key}><span>{card.label}</span><strong>{card.value == null ? 'Unavailable' : `${card.value.toFixed(2)}%`}</strong><small>{card.formula}</small></div>)}</div>
        <p className={s.caption}>Bank period {period} · Retrieved {view.report.retrievedAt?.slice(0, 10)}. Percentages use the bank’s own reporting scope. CET1 is shown as reported, without an inferred compliance or supervisory rating.</p>
        <details className={s.method}><summary>Quarterly comparison & definitions</summary><div className={s.tableScroll}><table><thead><tr><th>Measure</th>{[...dates].sort().map((date: string) => <th key={date}>{date}</th>)}</tr></thead><tbody>{view.cards.map(card => <tr key={card.key}><th scope="row">{card.label}</th>{[...dates].sort().map((date: string) => { const value = card.history.find((row: any) => row.date === date)?.value; return <td key={date}>{value == null ? 'Unavailable' : `${value.toFixed(2)}%`}</td>; })}</tr>)}</tbody></table></div><p>Nonaccruals use all loans before allowance. Allowance coverage uses held-for-investment loans, and brokered deposits use domestic deposits. Missing inputs and nonpositive denominators remain unavailable. Community Bank Leverage Ratio reporters may not report risk-based capital ratios.</p></details>
      </> : <div className={s.unavailable}><h3>{view.report?.status === 'review' ? 'This report requires financial review.' : 'This quarter is not prepared yet.'}</h3><p>Validated metrics are available in BankScope when preparation completes. Open the bank workspace to view coverage or request preparation.</p></div>}
      <div className={s.links}><Link prefetch={false} href={`/analysis/banks/${rssd}?period=${period}`}>Open full bank analysis</Link><Link prefetch={false} href={`/analysis/banks/${rssd}?view=exposures&period=${period}`}>Loan & funding concentrations</Link><Link prefetch={false} href={`/analysis/banks/${rssd}?view=compare`}>Peer benchmarks</Link><Link prefetch={false} href={`/analysis/banks/${rssd}?view=organization`}>Verify organization</Link>{view.valid && view.sourceUrl && <a href={view.sourceUrl} target="_blank" rel="noreferrer">FFIEC source report</a>}</div>
    </>}
    <div className={s.links}><Link prefetch={false} href="/analysis/banks">Browse all banks</Link></div>
  </>;
}
