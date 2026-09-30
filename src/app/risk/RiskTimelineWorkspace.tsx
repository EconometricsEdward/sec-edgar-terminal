'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { buildRiskChangeTimeline } from './riskChangeTimelineModel.js';
import { matchesRiskTimelineResponse } from '../../utils/riskTimelineResponse.js';
import RiskChangeTimeline, { type RiskTimelineEvent, type RiskTimelineModel } from './RiskChangeTimeline';
import type { RiskData, RiskProfile } from './riskTypes';
import s from './RiskTimelineWorkspace.module.css';

type Topic = { status: string; matches: number; comparisonError?: string; limited?: boolean };
type DisclosureResult = {
  events: RiskTimelineEvent[]; status: string; message?: string; checkedAt: string;
  filings: { accession: string; form: string; filed: string; reportDate: string; url: string; status: string; error?: string; topics: Record<string, Topic> }[];
  coverage: { selected?: number; reviewed?: number; failed?: number; historyLimited?: boolean; eventsOmitted?: number };
  limitations: string[];
};
const topics = [['customer-concentration', 'Customers'], ['covenants', 'Covenants'], ['collateral', 'Collateral']];
const statusLabel: Record<string, string> = { missing: 'No match', unchanged: 'Unchanged', differed: 'Changed', uncompared: 'Unpaired', unavailable: 'Unreadable' };

export default function RiskTimelineWorkspace({ data, profile, asOf = '', onInspect }: { data: RiskData; profile: RiskProfile; asOf?: string; onInspect: (id: string, missing?: boolean) => void }) {
  const model = useMemo(() => buildRiskChangeTimeline(profile, data, { asOf }) as RiskTimelineModel, [profile, data, asOf]);
  const [result, setResult] = useState<DisclosureResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'partial' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function loadDisclosures() {
    if (controller.current && !controller.current.signal.aborted) controller.current.abort();
    const current = new AbortController(); controller.current = current;
    const timer = setTimeout(() => current.abort('timeout'), 60_000);
    setStatus('loading'); setMessage('');
    try {
      const params = new URLSearchParams({ ticker: data.ticker, basis: profile.basis });
      if (asOf) params.set('asOf', asOf);
      const response = await fetch(`/api/risk/timeline?${params}`, { signal: current.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The filing comparison is unavailable.');
      if (!matchesRiskTimelineResponse(body, data.ticker, profile.basis, asOf, data.cik)) throw new Error('The filing evidence did not match this company and reporting selection. Please retry.');
      if (controller.current !== current || current.signal.aborted) return;
      setResult(body);
      setStatus(body.status === 'partial' ? 'partial' : 'ready');
      setMessage(body.message || (body.status === 'no_filing' ? 'No compatible original reports were available within the bounded search.' : body.status === 'no_changes' ? 'No paired wording changes in the reviewed passages. Coverage appears below.' : ''));
    } catch (error) {
      if (controller.current !== current) return;
      if (current.signal.aborted && current.signal.reason !== 'timeout') return;
      setStatus('error'); setMessage(current.signal.reason === 'timeout' ? 'The filing comparison timed out. Retry the bounded read.' : error instanceof Error ? error.message : 'Could not compare filings.');
    } finally { clearTimeout(timer); }
  }

  const coverage = result && <div className={s.coverage}>
    <div className={s.coverageHeading}><strong>Filing text coverage</strong><span>{result.filings.filter(filing => filing.status === 'reviewed').length}/{result.filings.length} reports read</span></div>
    <div className={s.reports}>{result.filings.map(filing => <article key={filing.accession} className={s.report}>
      <a href={filing.url} target="_blank" rel="noreferrer"><strong>{filing.form} · {filing.reportDate}</strong><ArrowUpRight size={13}/></a>
      <small>Filed {filing.filed}</small>
      <div className={s.topics}>{topics.map(([id, label]) => <span key={id} data-status={filing.topics[id].status} title={filing.topics[id].comparisonError || `${filing.topics[id].matches} selected passage${filing.topics[id].matches === 1 ? '' : 's'}${filing.topics[id].limited ? ' · excerpt limit reached' : ''}`}><span>{label}</span><strong>{statusLabel[filing.topics[id].status] || filing.topics[id].status}</strong></span>)}</div>
      {filing.error && <p className={s.failure}>{filing.error}</p>}
    </article>)}</div>
    <details><summary>Disclosure coverage & limits</summary><p>Changed means paired wording differed. No match, unpaired or unreadable evidence cannot establish that a risk began or ended.</p>{result.limitations.map((limit, i) => <p key={i}>{limit}</p>)}{result.coverage.historyLimited && <p>The available history was limited by the bounded manifest search.</p>}{!!result.coverage.eventsOmitted && <p>{result.coverage.eventsOmitted} additional changes omitted by the response limit.</p>}<small>Checked {result.checkedAt}</small></details>
  </div>;
  return <RiskChangeTimeline model={model} disclosureEvents={result?.events} disclosureStatus={status} disclosureMessage={message} onLoadDisclosures={loadDisclosures} onInspect={onInspect} disclosureCoverage={coverage}/>;
}
