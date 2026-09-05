'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useWorkspace } from './WorkspaceProvider';
import { useEvidence } from './EvidenceProvider';
import { formatValue } from '../../utils/xbrlParser.js';

export default function FilingChangesPanel({ ticker }: { ticker: string }) {
  const { data: workspace } = useWorkspace();
  const baseline = workspace.companies[ticker]?.baseline?.reportAccession;
  const [comparison, setComparison] = useState(baseline ? 'review' : 'year');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState('all');
  const controller = useRef<AbortController | null>(null);
  const evidence = useEvidence();
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { controller.current?.abort(); setData(null); setError(''); setLoading(false); }, [ticker]);
  async function compare() {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setLoading(true); setError(''); setData(null);
    const params = new URLSearchParams({ ticker, comparison: comparison === 'previous' ? 'previous' : 'year' });
    if (comparison === 'review' && baseline) params.set('baseline', baseline);
    try {
      const response = await fetch(`/api/filing-changes?${params}`, { signal: current.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Comparison returned HTTP ${response.status}`);
      if (!current.signal.aborted) setData(result);
    } catch (err) { if (!current.signal.aborted) setError(err instanceof Error ? err.message : 'Comparison failed.'); }
    finally { if (!current.signal.aborted) setLoading(false); }
  }
  const themes = [...new Set<string>((data?.disclosure?.changes || []).flatMap((c) => c.themes))];
  const changes = (data?.disclosure?.changes || []).filter((c) => theme === 'all' || c.themes.includes(theme));
  const selectedPeer = workspace.peerGroups.find((g) => g.tickers.includes(ticker));
  return <section className="research-changes space-y-6">
    <div><h2 className="text-2xl font-bold text-white">What changed?</h2><p className="mt-2 max-w-3xl text-base leading-7 text-slate-400">Compare reported financials and changes in Risk Factors and Management Discussion. Every comparison keeps the earlier and later filings together.</p></div>
    <div className="flex flex-wrap items-end gap-3"><label className="text-sm text-slate-300">Compare latest report with<select disabled={loading} className="mt-2 block rounded-lg border border-white/15 bg-slate-950 p-3" value={comparison} onChange={(e) => { setComparison(e.target.value); setData(null); }}><option value="year">Same reporting season, prior year</option><option value="previous">Previous report of the same form</option><option value="review" disabled={!baseline}>Last saved review{baseline ? '' : ' (mark reviewed first)'}</option></select></label><button type="button" onClick={compare} disabled={loading} className="primary-button">{loading ? 'Comparing SEC filings…' : 'Compare filings'}</button>{selectedPeer && <Link className="secondary-button" href={`/compare/${selectedPeer.tickers.join(',')}`}>Compare saved peers</Link>}</div>
    {loading && <p role="status" className="text-sm text-slate-400">Loading comparable reports and source passages. Financials are evaluated using information filed by each report date.</p>}
    {error && <p role="alert" className="rounded-xl border border-rose-400/40 p-4 text-sm text-rose-200">{error} You can retry this comparison.</p>}
    {data && <>
      <p role="status" className="text-sm text-slate-300">{data.pair.reason}{data.historyLimited && ' Filing-history coverage is limited; some archived submission files could not be inspected.'}</p>
      <div className="grid gap-4 sm:grid-cols-2">{[['Earlier filing', data.pair.prior], ['Latest filing', data.pair.current]].map(([label, report]: any[]) => report && <div key={label} className="rounded-xl border border-white/10 p-4"><p className="text-sm text-slate-400">{label}</p><a className="mt-2 block font-semibold text-amber-300 underline" href={report.documentUrl} target="_blank" rel="noreferrer">{report.form} · period {report.reportDate}</a><p className="mt-2 text-xs text-slate-400">Filed {report.filingDate} · {report.accession}</p></div>)}</div>
      {data.financials.length > 0 && <section><h3 className="mb-3 text-lg font-semibold text-white">Financial changes</h3><div className="overflow-x-auto rounded-xl border border-white/10"><table className="w-full text-left text-sm"><thead className="bg-white/5 text-slate-400"><tr><th className="p-3">Metric</th><th className="p-3">Earlier period</th><th className="p-3">Latest period</th><th className="p-3">Change</th></tr></thead><tbody>{data.financials.map((metric) => <tr key={metric.key} className="border-t border-white/10"><th className="p-3 text-slate-200">{metric.label}</th>{['before', 'after'].map((side) => <td key={side} className="p-3"><button type="button" onClick={() => evidence?.({ label: `${metric.label} · ${metric[side].period.end}`, point: metric[side], format: 'currency' })} className="text-amber-300 underline">{formatValue(metric[side].value, 'currency')}</button></td>)}<td className="p-3 text-slate-200">{metric.percentChange == null ? '—' : `${metric.percentChange >= 0 ? '+' : ''}${metric.percentChange.toFixed(1)}%`}</td></tr>)}</tbody></table></div><p className="mt-2 text-xs leading-5 text-slate-400">Missing inputs remain unavailable. Percentage changes are omitted for zero or negative baselines. Interim returns and annual totals are not mixed.</p></section>}
      {data.disclosure?.error && <p role="alert" className="rounded-xl border border-amber-300/30 p-4 text-sm text-amber-100">Financial comparison is available, but filing text could not be loaded: {data.disclosure.error}</p>}
      {data.disclosure && !data.disclosure.error && <>
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-semibold text-white">Disclosure changes ({data.disclosure.totalChanges})</h3><label className="text-sm text-slate-300">Related topic <select value={theme} onChange={(e) => setTheme(e.target.value)} className="ml-2 rounded-lg border border-white/15 bg-slate-950 p-2"><option value="all">All changes</option>{themes.map((t) => <option key={t} value={t}>{t}</option>)}</select></label></div>
        <div className="space-y-2 text-sm text-slate-400">{data.disclosure.coverage.map((c) => <p key={c.section}>{c.section}: {c.currentFound && c.priorFound ? `${c.priorParagraphs} earlier / ${c.currentParagraphs} current paragraphs inspected` : 'A comparable section could not be identified in both documents.'}{c.referenceOnly && ' At least one section only refers to another report or states that risks are unchanged; linked material is not included.'}</p>)}{data.disclosure.truncated && <p className="text-amber-200">Bounded review: up to 220 paragraphs per section and 40 changes are shown. Open the filings for full coverage.</p>}</div>
        {!changes.length && <p className="rounded-xl border border-white/10 p-5 text-sm text-slate-400">No changes matched this view within the inspected sections. This does not establish that the company’s risks are unchanged.</p>}
        {changes.map((change, i) => <article key={`${change.section}:${i}`} className="rounded-xl border border-white/10 p-5"><div className="flex flex-wrap items-center gap-3"><span className="rounded-full bg-amber-300/10 px-3 py-1 text-xs font-semibold capitalize text-amber-200">{change.type}</span><h4 className="font-semibold text-white">{change.section}</h4><span className="text-sm text-slate-400">{change.themes.join(' · ')}</span></div><p className="my-3 text-sm leading-6 text-slate-300">{change.reason}</p><div className="grid gap-4 lg:grid-cols-2">{[['Earlier', change.before, data.pair.prior], ['Current', change.after, data.pair.current]].map(([label, text, report]: any[]) => <div key={label} className="min-w-0 rounded-lg bg-slate-950/70 p-4"><p className="mb-2 text-xs font-semibold uppercase text-slate-500">{label}</p><p className="whitespace-pre-wrap text-sm leading-7 text-slate-300">{text ? `${text.slice(0, 900)}${text.length > 900 ? '…' : ''}` : 'No matched paragraph.'}</p>{text && <button type="button" className="mt-3 text-sm text-amber-300 underline" onClick={() => evidence?.({ label: `${ticker} · ${change.section} · ${report.filingDate}`, text, url: report.documentUrl })}>Read and save passage</button>}</div>)}</div></article>)}
      </>}
    </>}
  </section>;
}
