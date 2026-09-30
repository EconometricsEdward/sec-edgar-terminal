'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Building2, Search } from 'lucide-react';
import { readRiskEvidence } from './riskEvidenceClient.js';
import { isBankDirectory } from '../../utils/bank/directory.js';
import RiskBankPeers from './RiskBankPeers';
import s from './RiskIntelligence.module.css';

type BankPoint = { date: string; value: number | null };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function BankSparkline({ points, label }: { points: BankPoint[]; label: string }) {
  const values = points.map(point => point.value).filter(finite);
  if (!values.length) return <span className={s.bankSparkGap}>History unavailable</span>;
  const first = Date.parse(points[0].date), last = Date.parse(points.at(-1)!.date);
  const low = Math.min(...values), high = Math.max(...values), range = high - low || 1;
  const x = (date: string) => last > first ? 5 + (Date.parse(date) - first) / (last - first) * 170 : 90;
  const y = (value: number) => high === low ? 24 : 42 - (value - low) / range * 34;
  const segments: string[] = []; let segment: string[] = [];
  points.forEach((point, index) => {
    if (index && Date.parse(point.date) - Date.parse(points[index - 1].date) > 140 * 86400000 && segment.length) { segments.push(segment.join(' ')); segment = []; }
    if (finite(point.value)) segment.push(`${x(point.date)},${y(point.value)}`);
    else if (segment.length) { segments.push(segment.join(' ')); segment = []; }
  });
  if (segment.length) segments.push(segment.join(' '));
  return <div className={s.bankSpark}><svg viewBox="0 0 180 48" role="img" aria-label={`${label}, quarterly history through ${points.at(-1)?.date}. Each chart uses its own scale.`}><path d="M5 45H175" className={s.plotGuide}/>{segments.map((line, index) => <polyline key={index} points={line} className={s.plotLine}/>)}{points.map(point => finite(point.value) && <circle key={point.date} cx={x(point.date)} cy={y(point.value)} r={2.6} className={s.plotDot}><title>{point.date}: {point.value.toFixed(2)}%</title></circle>)}</svg><div className={s.bankSparkDates}><time>{points[0].date}</time><time>{points.at(-1)?.date}</time></div></div>;
}

export default function RiskBankEvidence({ companyName, ticker, companyPeriod }: { companyName: string; ticker: string; companyPeriod: string }) {
  // Suggested text is a directory search, never an inferred corporate mapping.
  const suggestion = companyName.replace(/&.*$|\b(?:CORP(?:ORATION)?|INC(?:ORPORATED)?|CO|LTD|HOLDINGS?)\b.*$/i, '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim().slice(0, 90);
  const [input, setInput] = useState(suggestion);
  const [query, setQuery] = useState(suggestion.length >= 2 ? suggestion : '');
  const [directory, setDirectory] = useState<any>(null), [directoryError, setDirectoryError] = useState('');
  const [rssd, setRssd] = useState(''), [data, setData] = useState<any>(null), [error, setError] = useState('');
  const periodAtOpen = useRef(companyPeriod);
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
      setPeriod(previous => dates.includes(previous) ? previous : dates.includes(periodAtOpen.current) ? periodAtOpen.current : dates.at(-1) || '');
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [rssd, retry]);
  const bank = data?.bank;
  const selectedName = directory?.banks.find((row: any) => String(row.id_rssd) === rssd)?.legal_name;
  const dates: string[] = data?.reportingPeriods?.map((row: any) => row.date) || [];
  const report = data?.reportingPeriods?.find((row: any) => row.date === period);
  const view = { report, sourceUrl: report?.sourceUrl, valid: report?.status === 'ready',
    cards: (data?.metrics || []).map((metric: any) => ({ ...metric, value: metric.history.find((row: any) => row.date === period)?.value ?? null,
      shownHistory: [...metric.history].filter((point: any) => point.date <= period).sort((a: any, b: any) => a.date.localeCompare(b.date)).map((point: any) => ({ date: point.date, value: data.reportingPeriods.find((row: any) => row.date === point.date)?.status === 'ready' && finite(point.value) ? point.value : null })),
    })) };
  return <>
    <div className={s.panelHeading}><div><h3>Bank regulatory metrics</h3><p>FFIEC · Selected legal bank · Quarterly</p></div><Building2 size={24}/></div>
    <details className={s.method}><summary>Entity scope</summary><p>Select a bank to review alongside {ticker}. Search results are name matches, not verified ownership links. Bank capital and deposits are separate from the SEC registrant’s consolidated figures.</p></details>
    <form className={s.bankSearch} onSubmit={event => { event.preventDefault(); const next = input.trim(); if (next.length < 2) return; setRssd(''); setData(null); if (next === query) setRetry(n => n + 1); else setQuery(next); }}>
      <label htmlFor="risk-bank-search">Legal bank name, RSSD, or FDIC certificate</label><div><input id="risk-bank-search" value={input} onChange={event => setInput(event.target.value)} placeholder="e.g. JPMorgan Chase" maxLength={100}/><button className={s.button} disabled={input.trim().length < 2}><Search size={16}/>Find bank</button></div>
    </form>
    {query && !directory && !directoryError && <p className={s.state} role="status">Searching the FFIEC bank directory…</p>}
    {directoryError && <p className={s.state} role="alert">{directoryError} <button className={s.button} onClick={() => setRetry(n => n + 1)}>Retry directory</button></p>}
    {directory && (directory.banks.length ? <details className={s.bankMatches} open={!rssd}><summary>{directory.banks.length} name matches · Choose a legal bank</summary><ul className={s.bankResults}>{directory.banks.map((row: any) => <li key={row.id_rssd}><button aria-pressed={rssd === String(row.id_rssd)} onClick={() => { if (rssd === String(row.id_rssd)) return; setRssd(String(row.id_rssd)); setData(null); }}><strong>{row.legal_name}</strong><span>{row.city}, {row.state} · RSSD {row.id_rssd}</span><span>{row.prepared_quarters} quarters · FFIEC {row.form_type}</span></button></li>)}</ul></details> : <p className={s.caption}>No matching banks. Try a shorter name or identifier.</p>)}
    {rssd && !bank && <p className={s.caption}>{selectedName || 'Selected legal bank'} · RSSD {rssd}</p>}
    {rssd && !data && !error && <p className={s.state} role="status">Reading prepared Call Reports…</p>}
    {error && <p className={s.state} role="alert">{error} <button className={s.button} onClick={() => setRetry(n => n + 1)}>Retry bank reports</button></p>}
    {data && !bank && <p className={s.state}>This institution has no prepared bank profile. Open BankScope to review its coverage.</p>}
    {data && bank && <>
      <div className={s.bankIdentity}><div><h4>{bank.name}</h4><p>RSSD {rssd} · FFIEC {bank.form}</p></div><label>Quarter<select aria-label="Bank reporting quarter" value={period} onChange={event => setPeriod(event.target.value)}>{dates.map((date: string) => <option key={date}>{date}</option>)}</select></label></div>
      {data.stale && <p className={s.notice}>Retained bank data. Confirm the latest prepared quarter in BankScope.</p>}
      {period !== companyPeriod && <p className={s.notice}>Different dates · Bank {period || 'unavailable'} · SEC {companyPeriod || 'unavailable'}</p>}
      {view.valid ? <>
        <div className={`${s.statGrid} ${s.bankStats}`}>{view.cards.map(card => <div className={s.stat} key={card.key}><span>{card.label}</span><strong>{card.value == null ? 'Unavailable' : `${card.value.toFixed(2)}%`}</strong><BankSparkline points={card.shownHistory} label={card.label}/></div>)}</div>
        <p className={s.caption}>Period {period} · Retrieved {view.report.retrievedAt?.slice(0, 10)} · Each trend uses its own scale</p>
        <details className={s.method}><summary>Exact history & definitions</summary><div className={s.tableScroll}><table><thead><tr><th>Measure / definition</th>{[...dates].sort().map((date: string) => <th key={date}>{date}</th>)}</tr></thead><tbody>{view.cards.map(card => <tr key={card.key}><th scope="row">{card.label}<small className={s.bankDefinition}>{card.formula}</small></th>{[...dates].sort().map((date: string) => { const value = card.history.find((row: any) => row.date === date)?.value; return <td key={date}>{value == null ? 'Unavailable' : `${value.toFixed(2)}%`}</td>; })}</tr>)}</tbody></table></div><p>Percentages use the bank’s own reporting scope. CET1 is shown as reported, without an inferred compliance or supervisory rating. Bank and SEC company figures are not reconciled or combined. Nonaccruals use all loans before allowance. Allowance coverage uses held-for-investment loans, and brokered deposits use domestic deposits. Missing inputs and nonpositive denominators remain unavailable. Community Bank Leverage Ratio reporters may not report risk-based capital ratios.</p></details>
      </> : <div className={s.unavailable}><h3>{view.report?.status === 'review' ? 'This report requires financial review.' : 'This quarter is not prepared yet.'}</h3><p>Validated metrics are available in BankScope when preparation completes. Open the bank workspace to view coverage or request preparation.</p></div>}
      {period && <RiskBankPeers key={rssd} rssd={rssd} period={period} bankName={bank.name}/>}
      <div className={s.links}><Link prefetch={false} href={`/analysis/banks/${rssd}?period=${period}`}>Open full bank analysis</Link><Link prefetch={false} href={`/analysis/banks/${rssd}?view=exposures&period=${period}`}>Loan & funding concentrations</Link><Link prefetch={false} href={`/analysis/banks/${rssd}?view=compare&period=${period}`}>Peer benchmarks</Link><Link prefetch={false} href={`/analysis/banks/${rssd}?view=organization`}>Verify organization</Link>{view.valid && view.sourceUrl && <a href={view.sourceUrl} target="_blank" rel="noreferrer">FFIEC source report</a>}</div>
    </>}
    <div className={s.links}><Link prefetch={false} href="/analysis/banks">Browse all banks</Link></div>
  </>;
}
