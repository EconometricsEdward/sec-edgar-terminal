'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from './WorkspaceProvider';
import { useEvidence } from './EvidenceProvider';
import { companySnapshot, exportResearchBrief, snapshotChanges, validTicker, RESEARCH_FORMS } from '../../utils/researchWorkspace.js';
import { extractAnnualPeriods, extractQuarterlyPeriods, formatValue, periodLabel, withPeriodKind } from '../../utils/xbrlParser.js';
import { downloadText } from '../../utils/download.js';

export default function CompanyOverview({ ticker, company, facts, sic, filings, onChanges }: { ticker: string; company: any; facts: any; sic: any; filings: any[]; onChanges: () => void }) {
  const workspace = useWorkspace();
  const openEvidence = useEvidence();
  const saved = workspace.data.companies[ticker];
  const [basis, setBasis] = useState('quarter');
  const [notes, setNotes] = useState('');
  const [peerInput, setPeerInput] = useState('');
  const [peerName, setPeerName] = useState('');
  const [status, setStatus] = useState('');
  const notesLoaded = useRef(false);
  useEffect(() => {
    if (workspace.ready && !notesLoaded.current) { setNotes(saved?.notes || ''); notesLoaded.current = true; }
  }, [workspace.ready, saved?.notes]);
  const period = useMemo(() => {
    const annual = extractAnnualPeriods(facts)[0];
    const quarter = extractQuarterlyPeriods(facts)[0];
    if (basis === 'annual') return annual;
    return quarter ? withPeriodKind([quarter], basis)[0] : annual;
  }, [facts, basis]);
  const snapshot = useMemo(() => companySnapshot(facts, sic, filings, period), [facts, sic, filings, period]);
  const changes = snapshotChanges(saved?.baseline, snapshot);
  const recent = filings.filter((f) => RESEARCH_FORMS.test(f.form)).slice(0, 4);
  const newFilings = saved?.baseline ? filings.filter((f) => RESEARCH_FORMS.test(f.form) && f.filingDate >= saved.reviewedAt?.slice(0, 10) && !saved.baseline.accessions?.includes(f.accession || f.accessionNumber)) : [];
  function save(patch: any, message: string) {
    const ok = workspace.update((w) => ({ ...w, companies: { ...w.companies, [ticker]: { ticker, name: company.name, cik: company.cik, saved: true, ...w.companies[ticker], ...patch } } }));
    setStatus(ok ? message : 'Could not save. Export your brief to keep a copy.');
  }
  function exportBrief() {
    const text = exportResearchBrief({ ticker, name: company.name, cik: company.cik, notes, snapshot, evidence: saved?.evidence || [], peerGroups: workspace.data.peerGroups.filter((g) => g.tickers.includes(ticker)), changes });
    downloadText(`${ticker}-research-brief.md`, text, 'text/markdown');
  }
  function savePeers() {
    const tickers = [...new Set([ticker, ...peerInput.toUpperCase().split(/[\s,]+/).filter(Boolean)])];
    if (tickers.length < 2 || tickers.length > 5 || !tickers.every(validTicker)) { setStatus('Enter one to four peer tickers; a comparison can contain up to five companies.'); return; }
    const name = peerName.trim().slice(0, 80) || `${ticker} peers`;
    const ok = workspace.update((w) => ({ ...w, peerGroups: [...w.peerGroups.filter((g) => g.name !== name), { name, tickers }].slice(-30) }));
    setStatus(ok ? 'Peer group saved.' : 'Could not save the peer group.');
  }
  return <div className="research-overview space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h2 className="text-xl font-bold text-white">Latest financial snapshot</h2><p className="mt-1 text-sm text-slate-400">{snapshot.period ? `${periodLabel(snapshot.period)} · period ending ${snapshot.period.end}` : 'No compatible financial periods available'}</p></div>
      <label className="flex items-center gap-2 text-sm text-slate-300">Period <select value={basis} onChange={(e) => setBasis(e.target.value)} className="rounded-lg border border-white/15 bg-slate-900 p-2"><option value="quarter">Latest quarter</option><option value="annual">Annual</option><option value="ytd">Year to date</option><option value="ttm">Trailing twelve months</option></select></label>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {snapshot.metrics.map((metric) => <button type="button" key={metric.key} onClick={() => openEvidence?.({ label: metric.label, point: metric, format: metric.format })} className="rounded-xl border border-white/10 bg-white/[0.025] p-5 text-left transition hover:border-amber-300/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"><span className="text-sm text-slate-300">{metric.label}</span><span className="mt-3 block text-2xl font-bold tabular-nums text-white">{formatValue(metric.value, metric.format)}</span><span className="mt-3 block text-xs capitalize text-slate-400">{metric.classification || 'Unavailable'} · {metric.source?.start ? `${metric.source.start} → ${metric.source.end}` : `as of ${metric.source?.end || snapshot.period?.end}`}</span></button>)}
    </div>
    <div className="flex flex-wrap gap-3"><button disabled={!workspace.ready} type="button" className="primary-button" onClick={() => save({ saved: !saved?.saved }, saved?.saved ? 'Removed from saved companies.' : 'Company saved.')}>{saved?.saved ? 'Unsave company' : 'Save company'}</button><button type="button" disabled={!workspace.ready || !snapshot.period} className="secondary-button" onClick={() => save({ baseline: snapshot, reviewedAt: new Date().toISOString() }, 'Review baseline saved. Future changes will be compared with this snapshot.')}>Mark reviewed</button><button type="button" className="secondary-button" onClick={exportBrief}>Export research brief</button><Link className="secondary-button" href="/workspace">Saved research</Link></div>
    <p role="status" className="text-sm text-amber-200">{workspace.error || status}</p>
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="rounded-xl border border-white/10 p-5"><h3 className="font-semibold text-white">Since your last review</h3>{saved?.reviewedAt ? <><p className="mt-2 text-sm text-slate-400">Reviewed {saved.reviewedAt.slice(0, 10)} · {newFilings.length} new report or event filings in the loaded feed.</p><ul className="my-3 space-y-2 text-sm text-slate-300">{changes.slice(0, 3).map((c) => <li key={c.key}>{c.label}: {formatValue(c.before.value, 'currency')} → {formatValue(c.after.value, 'currency')}</li>)}</ul>{!changes.length && <p className="my-3 text-sm text-slate-400">No numeric changes in comparable saved metrics. Choose the same period basis as your review to compare values.</p>}</> : <p className="my-3 text-sm leading-6 text-slate-400">Mark this company reviewed to preserve the figures and filing accessions you saw. Your baseline changes only when you mark it reviewed again.</p>}<button type="button" onClick={onChanges} className="text-sm font-semibold text-amber-300 underline underline-offset-4">Compare filings and financial changes</button></section>
      <section className="rounded-xl border border-white/10 p-5"><h3 className="font-semibold text-white">Recent reports and events</h3><ul className="mt-3 space-y-3">{recent.map((f) => <li key={f.accession} className="flex justify-between gap-3 text-sm"><a href={f.documentUrl} target="_blank" rel="noreferrer" className="text-amber-300 underline">{f.form} · {f.reportDate || f.filingDate}</a><span className="text-slate-400">Filed {f.filingDate}</span></li>)}</ul>{!recent.length && <p className="mt-3 text-sm text-slate-400">No report or event filings in the loaded submissions feed.</p>}</section>
    </div>
    <section className="rounded-xl border border-white/10 p-5"><label htmlFor="research-notes" className="font-semibold text-white">Research notes</label><textarea id="research-notes" rows={4} maxLength={50000} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-3 block w-full rounded-xl border border-white/15 bg-slate-950 p-4 text-base leading-7 text-slate-200" placeholder="Questions, conclusions, and next steps for this company…" /><div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-400">Saved on this browser. Export a brief to keep a portable copy.</p><button type="button" className="secondary-button" disabled={!workspace.ready} onClick={() => save({ notes }, 'Notes saved.')}>Save notes</button></div></section>
    <details className="rounded-xl border border-white/10 p-5"><summary className="cursor-pointer font-semibold text-white">Peer groups and selected evidence</summary><div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-sm text-slate-300">Group name<input value={peerName} maxLength={80} onChange={(e) => setPeerName(e.target.value)} placeholder={`${ticker} peers`} className="mt-2 block rounded-lg border border-white/15 bg-slate-950 p-2" /></label><label className="text-sm text-slate-300">Peer tickers<input value={peerInput} onChange={(e) => setPeerInput(e.target.value)} placeholder="BAC, WFC, C" className="mt-2 block rounded-lg border border-white/15 bg-slate-950 p-2" /></label><button type="button" onClick={savePeers} className="secondary-button">Save peer group</button></div><ul className="mt-4 space-y-2 text-sm">{workspace.data.peerGroups.filter((g) => g.tickers.includes(ticker)).map((g) => <li key={g.name}><Link className="text-amber-300 underline" href={`/compare/${g.tickers.join(',')}`}>{g.name}: {g.tickers.join(', ')}</Link></li>)}</ul><p className="mt-5 text-sm text-slate-400">{saved?.evidence?.length || 0} selected evidence items will be included in your research brief.</p><ul className="mt-3 space-y-3">{(saved?.evidence || []).map((e, i) => <li key={i} className="flex justify-between gap-3 text-sm"><button type="button" className="text-left text-amber-300 underline" onClick={() => openEvidence?.(e)}>{e.label}</button><button type="button" className="text-slate-400" onClick={() => save({ evidence: saved.evidence.filter((_, index) => index !== i) }, 'Evidence removed from brief.')}>Remove</button></li>)}</ul></details>
  </div>;
}
