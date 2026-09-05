'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import type { Fund, Overlap } from './fundTypes';
import { money, pct } from './fundUi';
import s from './fund.module.css';
export default function FundComparison({ tickers }: { tickers: string[] }) {
  const [funds, setFunds] = useState<Fund[]>([]), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [right, setRight] = useState(tickers[1]), [overlap, setOverlap] = useState<Overlap | null>(null), [overlapError, setOverlapError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setFunds([]); setError('');
    (async () => { const results: Fund[] = []; for (const ticker of tickers) { const res = await fetch(`/api/fund?v=2&ticker=${ticker}`, { signal: controller.signal }); const data = await res.json(); if (!res.ok || data.status !== 'ready') throw new Error(`${ticker}: ${data.error || data.reason}`); results.push(data); } if (!controller.signal.aborted) setFunds(results); })().catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [tickers, attempt]);
  useEffect(() => {
    if (funds.length < 2) return;
    const controller = new AbortController(); setOverlap(null); setOverlapError('');
    fetch(`/api/fund?v=2&ticker=${funds[0].ticker}&compare=${right}`, { signal: controller.signal }).then(async res => { const data = await res.json(); if (!res.ok) throw new Error(data.error); if (!controller.signal.aborted) setOverlap(data); }).catch(err => { if (!controller.signal.aborted) setOverlapError(err.message); });
    return () => controller.abort();
  }, [funds, right, attempt]);
  return <section className={s.panel} aria-label="Fund comparison results"><div className={s.sectionHeading}><div><p className={s.eyebrow}>Side by side</p><h2>Different tickers. How different are the portfolios?</h2></div><button className={s.secondary} onClick={() => setAttempt(n => n + 1)}><RefreshCw size={14} /> Retry / refresh</button></div>
    {error ? <p role="alert" className={s.notice}>{error}</p> : !funds.length ? <p role="status" className={s.loading}>Reading SEC portfolios for {tickers.join(', ')}…</p> : <><div className={s.tableWrap}><table className={s.table}><caption>Portfolio fundamentals from each fund’s latest available report</caption><thead><tr><th scope="col">Portfolio measure</th>{funds.map(f => <th scope="col" key={f.ticker}><Link href={`/fund/${f.ticker}`}>{f.ticker} <ArrowUpRight size={13} /></Link></th>)}</tr></thead><tbody>{[
      ['Portfolio as of', ...funds.map(f => f.asOf)], ['SEC series', ...funds.map(f => f.seriesId || 'Not assigned')], ['Portfolio net assets', ...funds.map(f => money(f.fundInfo.netAssets))], ['Reported positions', ...funds.map(f => f.summary.count.toLocaleString())], ['Top 10 positive weights / NAV', ...funds.map(f => pct(f.summary.top10Weight))], ['Largest positive position', ...funds.map(f => f.summary.largest?.name || 'Unavailable')], ['Largest position / NAV', ...funds.map(f => pct(f.summary.largest?.pctOfNav))], ['Reported derivative positions', ...funds.map(f => String(f.summary.derivativeCount))]
    ].map(row => <tr key={row[0]}><th scope="row">{row[0]}</th>{row.slice(1).map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}<tr><th scope="row">Evidence</th>{funds.map(f => <td key={f.ticker}><a href={f.sourceUrl} target="_blank" rel="noreferrer">N-PORT · filed {f.filingDate} ↗</a></td>)}</tr></tbody></table></div><p className={s.caption}>Net assets are portfolio totals and may include multiple share classes. Dates are shown per fund; these are historical holdings.</p>
      <div className={s.overlapHeading}><h3>Security overlap</h3><label>{funds[0].ticker} compared with <select value={right} onChange={e => setRight(e.target.value)} aria-label="Overlap comparison fund">{funds.slice(1).map(f => <option key={f.ticker}>{f.ticker}</option>)}</select></label></div>
      {overlapError ? <p className={s.notice} role="alert">{overlapError}</p> : !overlap ? <p role="status">Matching all reported positions…</p> : <><div className={s.overlapSummary}><div><span className={s.bigNumber}>{overlap.overlap.toFixed(2)}<small> pp</small></span><p>Shared positive NAV weight</p></div><div><b>{overlap.count}</b><p>Matched securities</p></div><div><b>{pct(overlap.leftEligibleWeight)} / {pct(overlap.rightEligibleWeight)}</b><p>Eligible weight · {overlap.left} / {overlap.right}</p></div></div>{!overlap.samePeriod && <p className={s.notice}>Different portfolio dates: {overlap.left} {overlap.leftAsOf} vs {overlap.right} {overlap.rightAsOf}. Overlap is an approximate comparison across those dates.</p>}{overlap.samePortfolio && <p className={s.notice}>These tickers map to the same SEC portfolio. Their share-class fees and prices may differ; underlying reported holdings are shared.</p>}<p className={s.caption}>Sum of the smaller NAV weight for each matching CUSIP, or ISIN when CUSIP is missing. Only positive, long, non-derivative positions with identifiers qualify. {overlap.leftExcludedCount} / {overlap.rightExcludedCount} positions excluded. No look-through into other funds. Weights are not normalized and may exceed 100% in leveraged portfolios.</p><div className={s.tableWrap}><table className={s.table}><caption>Largest shared positions · up to 30 securities</caption><thead><tr><th scope="col">Security</th><th scope="col">{overlap.left} weight</th><th scope="col">{overlap.right} weight</th><th scope="col">Shared weight</th></tr></thead><tbody>{overlap.rows.map(r => <tr key={r.key}><th scope="row">{r.name}<small>{r.key}</small></th><td>{pct(r.leftWeight)}</td><td>{pct(r.rightWeight)}</td><td>{r.overlap.toFixed(2)} pp</td></tr>)}</tbody></table>{!overlap.rows.length && <p className={s.empty}>No securities matched under this method.</p>}</div></>}
    </>}
  </section>;
}
