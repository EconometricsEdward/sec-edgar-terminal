'use client';
import { useState } from 'react';
import { Activity, Building2, CalendarRange, ChartNoAxesCombined, FileSearch } from 'lucide-react';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import { buildRiskProfilePresentation } from './riskProfilePresentation.js';
import { comparableRiskChanges } from './riskEvidenceModel.js';
import type { RiskData, RiskProfile, RiskMetric } from './riskTypes';
import s from './RiskEvidence.module.css';

type Change = { delta: number; deltaFormat: string; prior: number; priorEnd: string; end: string };

export default function RiskSignalDesk({ data, profile, onInspect, cftcEnabled }: { data: RiskData; profile: RiskProfile; onInspect: (id: string, missing?: boolean) => void; cftcEnabled: boolean }) {
  const [view, setView] = useState('signals');
  const presentation = buildRiskProfilePresentation(profile, data);
  const changes = new Map<string, Change>(comparableRiskChanges(profile).map(row => [row.id, row]));
  const focal = presentation.dimensions.map(d => d.metric?.id).filter(Boolean);
  const ordered = [...new Set([...profile.watchItems.map(m => m.id), ...focal])].map(id => profile.metrics.find(m => m.id === id)).filter((m): m is RiskMetric => m !== undefined);
  const metrics = view === 'gaps' ? profile.metrics.filter(m => m.value == null).slice(0, 3)
    : view === 'changes' ? ordered.filter(m => changes.has(m.id) && m.id !== 'loss_years').slice(0, 3)
    : ordered.filter(m => m.value != null).slice(0, 3);
  return <section className={s.desk} aria-label="Risk evidence summary">
    <div className={s.deskHead}><div><span className={s.eyebrow}><Activity size={15}/> Evidence briefing</span><h2>{data.ticker}: the signals behind the numbers.</h2></div><div className={s.coverage}><strong>{profile.coverage.available}/{profile.coverage.total}</strong>metrics available</div></div>
    <div className={s.deskBody}><div className={s.switch} aria-label="Evidence briefing view">{[['signals','Key signals'],['changes','Recent changes'],['gaps',`Data gaps (${profile.coverage.missing.length})`]].map(([id,label]) => <button key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</div>
      <div className={s.signals}>{metrics.map(m => <button key={m.id} className={s.signal} onClick={() => onInspect(m.id, view === 'gaps')}><span>{m.label}</span><strong>{view === 'gaps' ? 'Unavailable' : view === 'changes' ? formatRiskValue(changes.get(m.id)!.delta, changes.get(m.id)!.deltaFormat, true) : formatRiskValue(m.value, m.format)}</strong><small>{view === 'changes' ? `${formatRiskValue(changes.get(m.id)!.prior, m.format)} → ${formatRiskValue(m.value, m.format)} · ${changes.get(m.id)!.priorEnd} to ${changes.get(m.id)!.end}` : view === 'gaps' ? m.why : `${m.zone.label} · ${m.question}`}</small><em>Inspect calculation & filing</em></button>)}</div>
      {!metrics.length && <p className={s.empty}>{view === 'gaps' ? 'All metrics in this profile have compatible reported inputs.' : 'No compatible observations for this view.'}</p>}
      <p className={s.caption}>{view === 'changes' ? 'Changes use adjacent observations on the selected basis. TTM windows overlap; a change alone does not establish improving or deteriorating credit.' : 'Industry-specific screening observations, not a composite risk rating. Missing evidence stays visible.'}</p>
    </div>
    <nav className={s.jump} aria-label="Risk evidence sections"><a href="#risk-financial-position"><FileSearch size={14}/>Financial position</a><a href="#risk-maturities"><CalendarRange size={14}/>Debt maturities</a>{profile.industry.isBank && <a href="#risk-bank"><Building2 size={14}/>Bank Call Reports</a>}<a href="#risk-markets"><ChartNoAxesCombined size={14}/>Funding{cftcEnabled ? ' & swaps' : ' markets'}</a></nav>
  </section>;
}
