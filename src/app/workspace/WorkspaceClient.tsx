'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../components/research/WorkspaceProvider';
import { snapshotChanges, validTicker } from '../../utils/researchWorkspace.js';
import { downloadText } from '../../utils/download.js';

export default function WorkspaceClient() {
  const { data, ready, error, update } = useWorkspace();
  const [ticker, setTicker] = useState('');
  const [results, setResults] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const companies = Object.values(data.companies).filter((c) => c.saved);
  async function checkChanges() {
    controller.current?.abort(); const signalController = new AbortController(); controller.current = signalController;
    setBusy(true); setStatus('Checking saved companies…');
    const queue = companies.slice(0, 20);
    async function worker() {
      while (queue.length && !signalController.signal.aborted) {
        const company = queue.shift();
        if (!company) break;
        try {
          const response = await fetch(`/api/research-summary?ticker=${encodeURIComponent(company.ticker)}&basis=${encodeURIComponent(company.baseline?.period?.kind || 'quarter')}`, { signal: signalController.signal });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Request failed');
          setResults((prev) => ({ ...prev, [company.ticker]: result }));
        } catch (err) { if (!signalController.signal.aborted) setResults((prev) => ({ ...prev, [company.ticker]: { error: err instanceof Error ? err.message : 'Request failed' } })); }
      }
    }
    await Promise.all([worker(), worker()]);
    if (!signalController.signal.aborted) { setBusy(false); setStatus('Check complete. Results show each company’s coverage and any request errors. Up to 20 companies are checked at a time.'); }
  }
  function addCompany() {
    const value = ticker.trim().toUpperCase();
    if (!validTicker(value)) { setStatus('Enter a valid company ticker.'); return; }
    if (companies.length >= 20 && !data.companies[value]?.saved) { setStatus('This browser workspace supports 20 saved companies.'); return; }
    const ok = update((w) => ({ ...w, companies: { ...w.companies, [value]: { ...w.companies[value], ticker: value, saved: true } } }));
    if (ok) { setTicker(''); setStatus(`${value} saved. Open the company or check changes to resolve SEC data.`); }
  }
  return <div className="research-workspace mx-auto max-w-6xl space-y-6">
    <header><p className="text-sm font-semibold text-amber-300">Research workspace</p><h1 className="mt-2 text-3xl font-bold text-white">Your companies. Your next review.</h1><p className="mt-3 text-base leading-7 text-slate-400">Keep review baselines, notes, selected evidence, and peers in this browser. Checking for changes does not overwrite your review baseline.</p></header>
    <div className="flex flex-wrap gap-3"><label className="sr-only" htmlFor="saved-ticker">Company ticker</label><input id="saved-ticker" placeholder="Add ticker, e.g. JPM" value={ticker} onChange={(e) => setTicker(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCompany(); }} className="rounded-xl border border-white/15 bg-slate-950 p-3 text-base text-slate-100" /><button type="button" className="primary-button" disabled={!ready} onClick={addCompany}>Save company</button><button type="button" className="secondary-button" disabled={busy || !companies.length} onClick={checkChanges}>{busy ? 'Checking…' : 'Check for changes'}</button><button type="button" className="secondary-button" disabled={!ready} onClick={() => downloadText('edgar-workspace-backup.json', JSON.stringify(data, null, 2), 'application/json')}>Export workspace</button></div>
    <p role="status" className="text-sm text-amber-200">{error || status}</p>
    <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={onlyAlerts} onChange={(e) => setOnlyAlerts(e.target.checked)} />Show enabled alerts with changes</label>
    {!ready && <p role="status" className="text-slate-400">Loading saved research…</p>}
    {ready && !companies.length && <div className="rounded-2xl border border-dashed border-white/20 p-8"><h2 className="text-xl font-semibold text-white">Start with a company you follow</h2><p className="mt-3 text-slate-400">Save a ticker above, then open its analysis and select “Mark reviewed” to capture your first baseline.</p><Link className="mt-4 inline-block text-amber-300 underline" href="/analysis/JPM">Explore JPMorgan</Link></div>}
    <div className="space-y-4">{companies.map((company) => {
      const result = results[company.ticker];
      const changes = result?.snapshot ? snapshotChanges(company.baseline, result.snapshot) : [];
      const filings = company.baseline && result?.filings ? result.filings.filter((f) => f.filingDate >= company.reviewedAt?.slice(0, 10) && !company.baseline.accessions?.includes(f.accession)) : [];
      if (onlyAlerts && (!company.alerts || !changes.length && !filings.length)) return null;
      return <article key={company.ticker} className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><Link href={`/analysis/${company.ticker}`} className="text-xl font-bold text-white hover:text-amber-300">{company.ticker} <span className="text-base font-normal text-slate-400">{result?.name || company.name || ''}</span></Link><p className="mt-2 text-sm text-slate-400">{company.reviewedAt ? `Last reviewed ${company.reviewedAt.slice(0, 10)}` : 'No review baseline saved yet'} · {company.evidence?.length || 0} saved evidence items</p></div><label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={!!company.alerts} onChange={(e) => update((w) => ({ ...w, companies: { ...w.companies, [company.ticker]: { ...w.companies[company.ticker], alerts: e.target.checked } } }))} />In-app change alerts</label></div>
        {result?.error && <p className="mt-4 text-sm text-rose-200">{result.error}</p>}
        {result?.snapshot && <div className="mt-4"><p className="text-sm text-slate-200">{company.baseline ? `${filings.length} new filings in the loaded feed · ${changes.length} comparable metric changes` : 'Current SEC data loaded. Open the company to mark your first review.'}</p><p className="mt-1 text-xs text-slate-500">Checked {result.snapshot.observedAt.slice(0, 19).replace('T', ' ')} UTC. Period {result.snapshot.period?.end || 'unavailable'}.</p></div>}
        <div className="mt-4 flex flex-wrap gap-4 text-sm"><Link href={`/analysis/${company.ticker}?view=changes`} className="text-amber-300 underline">Review filing changes</Link><Link href={`/analysis/${company.ticker}`} className="text-amber-300 underline">Open notes and financials</Link><button type="button" className="text-slate-400" onClick={() => update((w) => ({ ...w, companies: { ...w.companies, [company.ticker]: { ...w.companies[company.ticker], saved: false } } }))}>Unsave</button></div>
      </article>;
    })}</div>
    <p className="text-sm leading-6 text-slate-400">In-app alerts appear when you check for changes here. They do not send emails, run while the browser is closed, or require an account. Export a workspace backup before clearing browser data.</p>
    {data.peerGroups.length > 0 && <section><h2 className="text-xl font-semibold text-white">Saved peer groups</h2><ul className="mt-4 space-y-3">{data.peerGroups.map((g) => <li key={g.name}><Link href={`/compare/${g.tickers.join(',')}`} className="text-amber-300 underline">{g.name} · {g.tickers.join(', ')}</Link></li>)}</ul></section>}
  </div>;
}
