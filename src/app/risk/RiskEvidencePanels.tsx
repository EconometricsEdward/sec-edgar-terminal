'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Building2, CalendarRange, ChartNoAxesCombined } from 'lucide-react';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import { ASSETS, DTCC_LINKS, SWAPS_HOME } from '../../utils/marketPlumbing/catalog.js';
import ChartPeriodOverlay from '../../components/charts/ChartPeriodOverlay';
import s from './RiskEvidence.module.css';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const dollars = (n: unknown) => finite(n) ? formatRiskValue(n) : 'Unavailable';
const percent = (n: unknown) => finite(n) ? `${n.toFixed(2)}%` : 'Unavailable';
const checked = (date?: string) => date?.slice(0, 10) || 'Unavailable';

const maturityReasons: Record<string, string> = {
  no_supported_annual_schedule: 'No supported annual maturity schedule was reported in the reviewed filing.',
  schedule_too_old: 'The available schedule is outside the supported reporting window.',
  invalid_or_mismatched_cik: 'The disclosure could not be matched confidently to this company.',
  ambiguous_schedule: 'The available disclosures could not be reconciled into a supported schedule.',
  conflicting_facts: 'Reported inputs could not be reconciled.',
  negative_principal: 'A negative principal amount was excluded; check the source disclosure.',
  negative_balance: 'A negative cash balance was excluded; check the source disclosure.',
  partial_schedule: 'Only part of the maturity schedule was reported in compatible standard tags.',
  not_reported: 'This maturity bucket was not reported in compatible standard tags.',
  not_reported_in_schedule_filing: 'No compatible value was reported in this annual filing.',
  not_comparable_for_financial_institutions: 'This measure is not comparable for financial institutions.',
  compatible_annual_operating_income_and_interest_required: 'Requires operating income and positive interest expense for the same annual period.',
  positive_next_year_maturities_and_cash_required: 'Requires reported cash and positive first-year principal from this annual filing.',
};
const maturityReason = (reason: string) => maturityReasons[reason] || 'Compatible source evidence is unavailable; review the filing.';


function useVisible() {
  const ref = useRef<HTMLElement>(null), [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, visible };
}

function useEvidence(path: string, enabled: boolean) {
  const [result, setResult] = useState<{ path: string; data?: any; error?: string }>({ path: '' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled || !path) return;
    const controller = new AbortController();
    setResult({ path });
    fetch(path, { signal: controller.signal }).then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'This evidence is temporarily unavailable.');
      if (!controller.signal.aborted) setResult({ path, data });
    }).catch(error => { if (!controller.signal.aborted) setResult({ path, error: error.message || 'This evidence is temporarily unavailable.' }); });
    return () => controller.abort();
  }, [path, enabled, retry]);
  return { data: result.path === path ? result.data : null, error: result.path === path ? result.error : '', retry: () => setRetry(n => n + 1) };
}

function Pending({ error, retry }: { error?: string; retry: () => void }) {
  return <div className={s.empty} role={error ? 'alert' : 'status'}>{error || 'Loading prepared source evidence…'}{error && <div><button className={s.action} onClick={retry}>Retry this section</button></div>}</div>;
}

function Head({ icon, eyebrow, title, description, href, link }: { icon: ReactNode; eyebrow: string; title: string; description: string; href: string; link: string }) {
  return <header className={s.panelHead}><div><span className={s.eyebrow}>{icon}{eyebrow}</span><h2>{title}</h2><p>{description}</p></div><Link prefetch={false} href={href}>{link}</Link></header>;
}

export function MaturityEvidence({ cik, ticker, profileDate, financial }: { cik: string; ticker: string; profileDate?: string; financial: boolean }) {
  const { ref, visible } = useVisible();
  const { data, error, retry } = useEvidence(`/api/risk/context?source=maturities&cik=${encodeURIComponent(cik)}`, visible);
  const [selection, setSelection] = useState('');
  const matched = data?.cik === cik ? data : null, profile = matched?.profile;
  const buckets = profile?.buckets || [];
  const selected = buckets.find((b: any) => b.key === selection) || buckets[0];
  const max = Math.max(...buckets.map((b: any) => b.value ?? 0), 1);
  const amount = profile?.metrics?.cashToNext12m?.value;
  return <section ref={ref} id="risk-maturities" className={s.panel} aria-label="Company debt maturities">
    <Head icon={<CalendarRange size={15}/>} eyebrow="SEC · Contractual debt schedule" title="When debt comes due." description={`Read ${ticker}’s disclosed principal schedule alongside cash and cash generation from the same annual filing.`} href={`/market/refinancing?company=${encodeURIComponent(cik)}`} link="Full refinancing wall"/>
    {!matched ? <Pending error={error} retry={retry}/> : profile?.status !== 'ready' ? <div className={s.empty}><p>{matched.status === 'outside-coverage' ? 'This issuer is outside the currently prepared maturity universe.' : matched.status === 'pending' ? 'A validated maturity schedule has not yet been prepared for this issuer.' : profile?.coverage?.reason ? maturityReason(profile.coverage.reason) : 'Compatible standard-tagged debt maturities were not reported in the reviewed annual filing.'}</p><p className={s.caption}>An unavailable schedule does not mean there is no debt. Review the borrowing note and the financial profile above.</p><Link prefetch={false} href={`/filings/${cik}`}>Open company filings</Link></div> : <>
      <div className={s.sourceLine}><span>Annual schedule as of {profile.asOf}</span><span>Filed {profile.filedAt}</span><span>{profile.coverage.reportedBuckets}/6 buckets reported</span><a href={profile.sourceUrl} target="_blank" rel="noreferrer">Source filing</a></div>
      {(profileDate && profileDate !== profile.asOf) && <p className={s.notice}>The financial profile above ends {profileDate}; this maturity schedule was reported at {profile.asOf}. The first bucket runs from {buckets[0]?.startDate} to {buckets[0]?.endDate}. It is not a forecast from today.</p>}
      {matched.stale && <p className={s.notice}>Retained snapshot · last prepared {checked(matched.snapshotAt)}. Check the issuer’s latest filing for changes.</p>}
      <div className={s.metrics}><div><span>First-year scheduled principal</span><strong>{dollars(buckets[0]?.value)}</strong><small>{buckets[0]?.startDate} to {buckets[0]?.endDate}</small></div><div><span>Cash / first-year principal</span><strong>{finite(amount) ? `${amount.toFixed(2)}×` : 'Unavailable'}</strong><small>{profile.metrics.cashToNext12m.reason ? maturityReason(profile.metrics.cashToNext12m.reason) : `Cash reported at ${profile.metrics.cash.endDate}`}</small></div><div><span>{profile.coverage.complete ? 'Total scheduled principal' : 'Reported buckets subtotal'}</span><strong>{dollars(profile.reportedSubtotal)}</strong><small>{profile.coverage.complete ? 'All six maturity buckets reported' : 'Partial schedule; missing buckets are not zero'}</small></div></div>
      <div className={s.bars} aria-label="Debt principal by maturity bucket">{buckets.map((b: any) => <button key={b.key} className={s.bar} onMouseEnter={() => setSelection(b.key)} onFocus={() => setSelection(b.key)} onClick={() => setSelection(b.key)} aria-pressed={selected?.key === b.key} aria-label={`${b.label}, ${b.startDate} to ${b.endDate || 'thereafter'}: ${dollars(b.value)}`}><span className={s.barValue}>{finite(b.value) ? dollars(b.value) : 'N/A'}</span><span className={s.barTrack}>{finite(b.value) ? <i style={{ height: `${b.value / max * 100}%` }}/> : <small>Not reported</small>}</span><span className={s.barLabel}>{b.calendarYear || b.label}</span></button>)}</div>
      {selected && <div className={s.inspection}><strong>{selected.label}: {dollars(selected.value)}</strong><small>{selected.startDate} {selected.endDate ? `through ${selected.endDate}` : 'onward'} · {selected.dateBasis === 'anniversary-estimate' ? 'Anniversary-based interval; verify exact fiscal dates in the filing' : 'Calendar-year interval'}{selected.reason ? ` · ${maturityReason(selected.reason)}` : ''}</small></div>}
      <p className={s.caption}>{financial ? 'For financial institutions, this debt schedule excludes deposits and does not measure liquidity coverage or regulatory capital. ' : ''}Principal maturities may exclude leases, short-term borrowing and other obligations. Cash can have restrictions; cash flow is historical and not reserved for debt repayment.</p>
      <details className={s.note}><summary>Cash capacity, definitions & source dates</summary><div className={s.tableWrap}><table className={s.table}><thead><tr><th>Annual filing measure</th><th>Value</th><th>Period / definition</th></tr></thead><tbody>{[['cash','Cash and equivalents'],['operatingCashFlow','Operating cash flow'],['operatingIncome','Operating income'],['interestExpense','Interest expense'],['interestCoverage','Operating income / interest expense']].map(([key,label]) => { const m = profile.metrics[key]; return <tr key={key}><td>{label}</td><td>{key === 'interestCoverage' ? finite(m.value) ? `${m.value.toFixed(2)}×` : 'Unavailable' : dollars(m.value)}</td><td>{m.startDate ? `${m.startDate} to ` : ''}{m.endDate || 'Unavailable'}{m.reason && ` · ${maturityReason(m.reason)}`}{m.tag && <small> · {m.tag}</small>}</td></tr>; })}</tbody></table></div>{profile.warnings?.map((warning: string) => <p key={warning}>{warning}</p>)}<p>Source last checked {checked(matched.checkedAt)}. Annual filing measures retain their original dates when you switch the SEC profile between annual and TTM.</p></details>
    </>}
  </section>;
}

type SeriesPoint = { date: string; value: number | null };
function EvidenceChart({ points, label, format, maxGap = 10 }: { points: SeriesPoint[]; label: string; format: (n: unknown) => string; maxGap?: number }) {
  const [active, setActive] = useState<string | null>(null);
  const numbers = points.map(p => p.value).filter(finite);
  if (!points.length || !numbers.length) return <p className={s.empty}>History unavailable.</p>;
  const low = Math.min(...numbers), high = Math.max(...numbers), spread = high - low;
  const first = Date.parse(points[0].date), last = Date.parse(points.at(-1)!.date);
  const x = (i: number) => last === first ? 215 : 12 + (Date.parse(points[i].date) - first) / (last - first) * 406;
  const y = (value: number) => spread ? 110 - (value - low) / spread * 86 : 67;
  const segments: string[] = []; let segment: string[] = [];
  points.forEach((p, i) => {
    if (!finite(p.value) || i > 0 && Date.parse(p.date) - Date.parse(points[i - 1].date) > maxGap * 86400000) { if (segment.length) segments.push(segment.join(' ')); segment = []; }
    if (finite(p.value)) segment.push(`${x(i)},${y(p.value)}`);
  });
  if (segment.length) segments.push(segment.join(' '));
  const selected = points.find(p => p.date === active) || points.at(-1)!;
  const index = points.indexOf(selected);
  return <><div className={s.chartValue}><strong>{format(selected.value)}</strong><span>{selected.date} · {label}</span></div><svg className={s.plot} viewBox="0 0 430 145" role="group" aria-label={`${label}. Hover, tap or use arrow keys to inspect dates.`}><line x1="12" x2="418" y1="114" y2="114"/>{segments.map((segment,i) => <polyline key={i} points={segment} fill="none"/>)}<line x1={x(index)} x2={x(index)} y1="18" y2="114"/>{finite(selected.value) && <circle cx={x(index)} cy={y(selected.value)} r="4"/>}<text x="12" y="140">{points[0].date}</text><text x="418" y="140" textAnchor="end">{points.at(-1)!.date}</text><ChartPeriodOverlay points={points.map((p,i) => ({ id:p.date, label:p.date, x:x(i) }))} activeId={selected.date} onInspect={setActive} left={0} right={430} top={0} bottom={120} label={label} describePoint={id => `${id}: ${format(points.find(p => p.date === id)?.value)}`}/></svg></>;
}

export function MarketEvidence({ cftcEnabled }: { cftcEnabled: boolean }) {
  const { ref, visible } = useVisible(), { data, error, retry } = useEvidence('/api/risk/context?source=markets', visible);
  const [measure, setMeasure] = useState('SOFR'), [range, setRange] = useState('3m'), [asset, setAsset] = useState('rates');
  const funding = data?.funding, swaps = data?.swaps;
  const raw = measure === 'deliver' || measure === 'receive' ? funding?.fails || [] : funding?.rates || [];
  const cutoff = Date.parse(raw.at(-1)?.date) - (range === '1y' ? 366 : 93) * 86400000;
  const points = raw.filter((p: any) => Date.parse(p.date) >= cutoff).map((p: any) => ({ date:p.date, value:p[measure] ?? null }));
  const labels: Record<string,string> = { SOFR:'SOFR', spread:'SOFR − TGCR', deliver:'Treasury fails to deliver', receive:'Treasury fails to receive' };
  const formatter = measure === 'SOFR' ? percent : measure === 'spread' ? (n: unknown) => finite(n) ? `${n.toFixed(1)} bp` : 'Unavailable' : (n: unknown) => finite(n) ? dollars(n * 1e6) : 'Unavailable';
  const swap = swaps?.assets[asset];
  return <section ref={ref} id="risk-markets" className={s.panel} aria-label="Funding and derivatives market context">
    <Head icon={<ChartNoAxesCombined size={15}/>} eyebrow="Market-wide · Separate reporting scope" title="The environment around the issuer." description="Funding prices, settlement frictions and swaps activity add context to company financials. They do not measure this issuer’s trades, losses or credit spread." href="/market/funding" link="Explore funding markets"/>
    {!data ? <Pending error={error} retry={retry}/> : <>
      <div className={s.marketGrid}><div className={s.marketChart}><h3>Funding & settlement</h3>{funding ? <><div className={s.switch}>{Object.entries(labels).map(([id,label]) => <button key={id} aria-pressed={measure === id} onClick={() => setMeasure(id)}>{label}</button>)}</div><div className={s.sourceLine}><span>New York Fed</span><span>Checked {checked(funding.generatedAt)}</span>{funding.stale && <span>Retained source snapshot</span>}</div><EvidenceChart key={`${measure}:${range}`} points={points} label={labels[measure]} format={formatter} maxGap={measure === 'deliver' || measure === 'receive' ? 8 : 5}/><div className={s.switch} aria-label="Funding chart range">{[['3m','3 months'],['1y','1 year']].map(([id,label]) => <button key={id} aria-pressed={range === id} onClick={() => setRange(id)}>{label}</button>)}</div><p className={s.caption}>{measure === 'SOFR' ? 'SOFR is a broad Treasury repo financing rate. Company borrowing spreads and repricing dates can differ.' : measure === 'spread' ? 'SOFR minus tri-party Treasury repo (TGCR), in basis points. This is a market-segment spread, not an issuer’s funding premium.' : 'Cumulative weekly primary-dealer Treasury and TIPS fails. Delivery and receipt figures overlap; they are kept separate and are not losses.'}</p></> : <p className={s.empty}>Funding data is temporarily unavailable.</p>}</div>
      {cftcEnabled && <div className={s.marketChart}><h3>Weekly swaps activity</h3>{swaps ? <><div className={s.switch}>{Object.entries(ASSETS).map(([id,label]) => <button key={id} aria-pressed={asset === id} onClick={() => setAsset(id)}>{label}</button>)}</div><div className={s.sourceLine}><span>CFTC Weekly Swaps Report</span><span>Checked {checked(swaps.generatedAt)}</span>{swaps.stale && <span>Retained source snapshot</span>}</div><EvidenceChart key={asset} points={swap?.trend || []} label="notional traded" format={n => finite(n) ? dollars(n * 1e6) : 'Unavailable'} maxGap={8}/><div className={s.sourceLine}><span>{finite(swap?.change) ? `${swap.change > 0 ? '+' : ''}${swap.change.toFixed(1)}% vs previous week` : 'Adjacent-week change unavailable'}</span><span>{finite(swap?.share) ? `${swap.share.toFixed(1)}% cleared` : 'Clearing split unavailable'} · {swap?.date || 'Date unavailable'}</span></div><p className={s.caption}>Aggregate reported activity across the market. Notional is a contract reference amount, not credit exposure or loss. Credit-swap activity does not provide this company’s CDS spread.</p><Link prefetch={false} href={`/market/derivatives?asset=${asset}`}>Explore products & clearing</Link></> : <p className={s.empty}>Swaps data is temporarily unavailable.</p>}</div>}</div>
      <details className={s.note}><summary>Source scope, dates & exact chart observations</summary><p>The CFTC swaps release has its own publication lag. It is separate from CFTC futures positioning and DTCC transaction-level dissemination. Reporting dates remain visible on the charts.</p><div className={s.links}>{funding?.sources?.map((source: any,i: number) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">New York Fed source {i + 1}</a>)}{cftcEnabled && <a href={SWAPS_HOME} target="_blank" rel="noreferrer">CFTC Weekly Swaps Report</a>}</div><div className={s.tableWrap}><table className={s.table}><thead><tr><th>Date</th><th>{labels[measure]}</th></tr></thead><tbody>{[...points].reverse().map((p: SeriesPoint) => <tr key={p.date}><td>{p.date}</td><td>{formatter(p.value)}</td></tr>)}</tbody></table></div>{cftcEnabled && <div className={s.tableWrap}><table className={s.table}><thead><tr><th>Week ending</th><th>{ASSETS[asset]} · notional traded</th></tr></thead><tbody>{[...(swap?.trend || [])].reverse().map((p: SeriesPoint) => <tr key={p.date}><td>{p.date}</td><td>{finite(p.value) ? dollars(p.value * 1e6) : 'Unavailable'}</td></tr>)}</tbody></table></div>}</details>
      <div className={s.sourceCards}>{DTCC_LINKS.map(link => <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label}<small>{link.detail} · Open at DTCC</small></a>)}</div>
      <p className={s.caption}>DTCC / FICC reports open at the publisher; their data is not reproduced in these charts.</p>
      {funding?.notice && <p className={s.caption}>{funding.notice}</p>}
    </>}
  </section>;
}

export function BankEvidence({ companyName }: { companyName: string }) {
  const { ref, visible } = useVisible();
  const suggested = companyName.replace(/\/[A-Z]{2,3}\/?$/i, '').replace(/\b(corporation|corp|incorporated|inc|company|co|holdings|holding|group)\b/gi, '').replace(/[&.,/]/g,' ').replace(/\s+/g,' ').trim();
  const [input,setInput] = useState(suggested), [query,setQuery] = useState(suggested), [rssd,setRssd] = useState('');
  const search = useEvidence(`/api/banks?q=${encodeURIComponent(query)}`, visible && query.length >= 2);
  const report = useEvidence(`/api/risk/context?source=bank&rssd=${rssd}`, visible && Boolean(rssd));
  const data = report.data?.rssd === Number(rssd) ? report.data : null;
  return <section ref={ref} id="risk-bank" className={s.panel} aria-label="Bank Call Report risk measures">
    <Head icon={<Building2 size={15}/>} eyebrow="FFIEC · Legal-bank evidence" title="Look inside the regulated bank." description="Select a legal bank to inspect regulatory capital, credit quality and funding. Search results are name candidates, not verified subsidiaries of the SEC registrant." href="/analysis/banks" link="Open BankScope"/>
    <form className={s.bankSearch} onSubmit={e => { e.preventDefault(); const next = input.trim(); if (next === query) search.retry(); else setQuery(next); }}><label htmlFor="risk-bank-name">Bank name, RSSD or FDIC certificate<input id="risk-bank-name" value={input} onChange={e => setInput(e.target.value)} maxLength={100}/></label><button type="submit" className={s.action} disabled={input.trim().length < 2}>Find banks</button></form>
    {!search.data ? <Pending error={search.error} retry={search.retry}/> : <div className={s.bankChoices}>{search.data.banks.slice(0,8).map((bank: any) => <button key={bank.id_rssd} onClick={() => setRssd(String(bank.id_rssd))} aria-pressed={rssd === String(bank.id_rssd)}><span>{bank.legal_name}<small>RSSD {bank.id_rssd} · {[bank.city,bank.state].filter(Boolean).join(', ')}</small></span><small>{bank.prepared_quarters} prepared quarters</small></button>)}{!search.data.banks.length && <p className={s.empty}>No matching legal bank found. Try its legal name or RSSD identifier.</p>}{search.data.banks.length > 8 && <p className={s.caption}>Showing eight candidates. Refine the name to narrow the results.</p>}</div>}
    {rssd && (!data ? <Pending error={report.error} retry={report.retry}/> : <>
      <h3>{data.bank?.name || `RSSD ${rssd}`}</h3><div className={s.sourceLine}><span>Call Report {data.period || 'period unavailable'}</span><span>Retrieved {checked(data.retrievedAt)}</span><span>RSSD {rssd}</span></div>
      <p className={s.notice}>User-selected legal bank. Figures are separate from {companyName}’s SEC reporting scope. No parent relationship is inferred from this selection.</p>
      {data.stale && <p className={s.notice}>Retained bank data. Confirm the latest prepared period in BankScope.</p>}
      {data.status !== 'ready' ? <p className={s.empty}>{data.status === 'review' ? 'The latest Call Report needs financial validation before figures can be displayed.' : 'The latest Call Report has not been prepared for this bank. Open BankScope to request it.'}</p> : <div className={s.bankGrid}>{data.metrics.map((m: any) => { const max = Math.max(...m.history.map((p: any) => Math.abs(p.value || 0)),1); return <div key={m.key}><span>{m.label}</span><strong>{percent(m.value)}</strong><div className={s.history} role="img" aria-label={m.history.map((p: any) => `${p.date}: ${percent(p.value)}`).join('; ')}>{m.history.map((p: any) => <i key={p.date} title={`${p.date}: ${percent(p.value)}`} style={{height:finite(p.value) ? `${Math.abs(p.value)/max*100}%` : '0', background:finite(p.value) ? undefined : 'transparent'}}/>)}</div><small>{m.history[0]?.date} — {m.history.at(-1)?.date}</small></div>; })}</div>}
      <div className={s.links} style={{marginTop:20}}><Link prefetch={false} href={`/analysis/banks/${rssd}`}>Full bank financials</Link><Link prefetch={false} href={`/analysis/banks/${rssd}?view=exposures`}>Loan & funding concentrations</Link><Link prefetch={false} href={`/analysis/banks/${rssd}?view=compare`}>Peer benchmarks</Link><Link prefetch={false} href={`/analysis/banks/${rssd}?view=organization`}>Verify organization</Link></div>
      <details className={s.note}><summary>Definitions, exact history & source calculations</summary><p>These are public financial measures, not supervisory CAMELS ratings. Missing items remain unavailable. Each quarter uses its own validated report.</p><div className={s.tableWrap}><table className={s.table}><thead><tr><th>Measure / definition</th>{data.metrics[0]?.history.map((p: any) => <th key={p.date}>{p.date}</th>)}<th>Latest source inputs</th></tr></thead><tbody>{data.metrics.map((m: any) => <tr key={m.key}><td>{m.label}<p>{m.formula}</p></td>{m.history.map((p: any) => <td key={p.date}>{percent(p.value)}</td>)}<td>{m.sources.map((source: any) => <div key={source.metric}><a href={source.url} target="_blank" rel="noreferrer">{source.metric}</a></div>)}</td></tr>)}</tbody></table></div></details>
    </>)}
  </section>;
}
