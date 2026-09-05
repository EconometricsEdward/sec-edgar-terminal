'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatValue, buildSourceUrl } from '../../utils/xbrlParser.js';
import { evidenceSources, evidenceCalculations } from '../../utils/researchEvidence.js';
import { sourceDocumentUrl } from '../../utils/xbrlPeriods.js';
import { useWorkspace } from './WorkspaceProvider';

type Evidence = { label: string; point?: any; format?: string; text?: string; url?: string };
const Context = createContext<((e: Evidence) => void) | null>(null);
export const useEvidence = () => useContext(Context);

export default function EvidenceProvider({ children, cik, ticker, filings }: { children: ReactNode; cik?: string; ticker: string; filings: any[] }) {
  const [selected, setSelected] = useState<Evidence | null>(null);
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const workspace = useWorkspace();
  useEffect(() => {
    if (selected && !dialog.current?.open) dialog.current?.showModal();
    if (!selected && dialog.current?.open) dialog.current.close();
  }, [selected]);
  const open = (e: Evidence) => { setSelected(e); setMessage(''); };
  const point = selected?.point;
  const sources = evidenceSources(point);
  const calculations = evidenceCalculations(point);
  const classification = point?.classification || (point?.formula || sources.length > 1 ? 'calculated' : point?.value == null ? 'unavailable' : 'reported');
  function pin() {
    if (!selected) return;
    const saved = workspace.update((w) => {
      const company = w.companies[ticker] || { ticker, saved: true };
      const evidence = [...(company.evidence || []).filter((e: Evidence) => JSON.stringify(e) !== JSON.stringify(selected)), selected].slice(-100);
      return { ...w, companies: { ...w.companies, [ticker]: { ...company, evidence } } };
    });
    setMessage(saved ? 'Added to research brief.' : 'Could not save this evidence.');
  }
  return <Context.Provider value={open}>{children}
    <dialog ref={dialog} onCancel={() => setSelected(null)} onClose={() => setSelected(null)} aria-labelledby="evidence-title" className="research-drawer m-0 ml-auto h-dvh max-h-dvh w-full max-w-xl border-l border-white/15 bg-slate-950 p-0 text-slate-100 backdrop:bg-black/60">
      <div className="sticky top-0 flex items-start justify-between gap-4 border-b border-white/10 bg-slate-950 p-6"><div><p className="text-sm capitalize text-amber-300">{selected?.text ? 'Filing excerpt' : classification}</p><h2 id="evidence-title" className="mt-1 text-xl font-bold">{selected?.label}</h2></div><button type="button" onClick={() => setSelected(null)} className="secondary-button">Close</button></div>
      <div className="space-y-6 p-6">
        {point && <div><div className="text-3xl font-bold">{formatValue(point.value, selected?.format || 'currency')}</div><p className="mt-2 text-sm text-slate-400">{point.period?.kind || (point.period?.fp === 'FY' ? 'Annual' : 'Quarter')} · ending {point.period?.end || point.source?.end}</p></div>}
        {(point?.formula || point?.source?.formula) && <section><h3 className="font-semibold">Calculation</h3><p className="mt-2 text-sm leading-6 text-slate-300">{point.formula || point.source.formula}</p></section>}
        {(point?.note || point?.source?.note) && <p className="text-sm leading-6 text-slate-400">{point.note || point.source.note}</p>}
        {selected?.text && <blockquote className="whitespace-pre-wrap border-l-2 border-amber-300 pl-4 text-base leading-7">{selected.text}</blockquote>}
        {calculations.length > 0 && <section><h3 className="font-semibold">Intermediate calculations</h3><ul className="mt-3 space-y-3 text-sm text-slate-300">{calculations.map((c: any, i: number) => <li key={i}>{c.label && `${c.label}: `}{Number(c.value).toLocaleString()} {c.unit} · {c.start} → {c.end}<p className="mt-1 text-slate-400">{c.formula}</p></li>)}</ul></section>}
        {sources.map((source: any, i: number) => {
          const filing = filings.find((f) => (f.accession || f.accessionNumber) === source.accession);
          const url = filing?.documentUrl || sourceDocumentUrl(cik, source);
          return <section key={`${source.accession}:${source.start}:${source.end}:${i}`} className="rounded-xl border border-white/10 p-4"><h3 className="font-semibold">{source.label || `Input ${i + 1}`}</h3><dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm"><dt className="text-slate-400">Value</dt><dd>{source.value == null ? 'See source' : Number(source.value).toLocaleString()} {source.unit}</dd><dt className="text-slate-400">Period</dt><dd>{source.start ? `${source.start} → ${source.end}` : `As of ${source.end}`}</dd><dt className="text-slate-400">Filed</dt><dd>{source.filed} · {source.form}</dd><dt className="text-slate-400">Concept</dt><dd className="break-all">{source.taxonomy || 'us-gaap'}:{source.tag}</dd><dt className="text-slate-400">Accession</dt><dd className="break-all">{source.accession}</dd></dl>{source.revised && <p className="mt-3 text-sm text-amber-200">{source.revisionNote}</p>}<div className="mt-4 flex flex-wrap gap-4 text-sm">{url && <a href={url} target="_blank" rel="noreferrer" className="text-amber-300 underline">{filing ? 'Read source filing' : 'Open filing documents'}</a>}<a href={buildSourceUrl(cik, source) || undefined} target="_blank" rel="noreferrer" className="text-slate-400 underline">Raw SEC observations</a></div></section>;
        })}
        {selected?.url && <a href={selected.url} target="_blank" rel="noreferrer" className="block text-amber-300 underline">Read the original filing</a>}
        <button type="button" onClick={pin} disabled={!workspace.ready} className="primary-button">Add evidence to brief</button><p role="status" className="text-sm text-slate-300">{message}</p>
      </div>
    </dialog>
  </Context.Provider>;
}
