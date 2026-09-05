'use client';

import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, CircleAlert, FileText, FlaskConical, Loader2, RotateCcw, Search } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PILLAR_LABELS, RISK_VERSION, formatRiskValue, riskDelta, riskHistoryCsv, riskPeriodLabel, runRiskStress } from '../../utils/riskWorkspace.js';
import type { RiskData, RiskMetric, RiskProfile, RiskSource } from './riskTypes';
import { downloadRiskFile } from './riskDownload';
import s from './risk.module.css';

function Sources({ sources }: { sources: RiskSource[] }) {
  return <div className={s.sourceList}>{sources.length ? sources.map((source, i) => <div className={s.source} key={`${source.accession}:${source.tag}:${source.start}:${i}`}><div><strong>{source.label || source.tag}</strong><span>{formatRiskValue(source.value, 'usd')} <small>{source.unit || 'USD'}</small></span></div><p>{source.start ? `${source.start} → ` : 'As of '}{source.end} · Filed {source.filed || 'date unavailable'}{source.revised && <em> · Revised context</em>}</p><p>Exact input: {source.value?.toLocaleString('en-US', { maximumFractionDigits: 8 }) ?? 'Unavailable'} {source.unit || 'USD'}</p><code>{source.tag}</code><div className={s.sourceLinks}>{source.documentUrl && <a href={source.documentUrl} target="_blank" rel="noreferrer">SEC filing <ArrowUpRight size={13}/></a>}{source.url && <a href={source.url} target="_blank" rel="noreferrer">XBRL fact <ArrowUpRight size={13}/></a>}<span>{source.accession}</span></div></div>) : <p className={s.muted}>No compatible source fact is available for this period.</p>}</div>;
}

export function MetricExplorer({ data, profile, selected, onSelect, pillar, onPillar, onlyMissing, onOnlyMissing }: { data: RiskData; profile: RiskProfile; selected: string; onSelect: (s: string) => void; pillar: string; onPillar: (s: string) => void; onlyMissing: boolean; onOnlyMissing: (b: boolean) => void }) {
  const [search, setSearch] = useState('');
  const metrics = profile.metrics.filter((m) => (pillar === 'all' || pillar === 'watch' && profile.watchItems.some((w) => w.id === m.id) || pillar === m.pillar) && (!onlyMissing || m.value == null) && m.label.toLowerCase().includes(search.toLowerCase()));
  const active = metrics.find((m) => m.id === selected) || metrics[0];
  return <div className={s.explorer}>
    <aside className={s.metricSidebar} aria-label="Metric selection"><div className={s.sidebarTools}><label className={s.filterSearch}><Search size={15}/><input aria-label="Find a risk metric" placeholder="Find a metric…" value={search} onChange={(e) => setSearch(e.target.value)} /></label><label htmlFor="risk-pillar">Risk pillar</label><select id="risk-pillar" value={pillar} onChange={(e) => onPillar(e.target.value)}><option value="all">All pillars</option><option value="watch">Review priorities</option>{Object.entries(PILLAR_LABELS).filter(([key]) => profile.metrics.some((m) => m.pillar === key)).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select><label className={s.checkLabel}><input type="checkbox" checked={onlyMissing} onChange={(e) => onOnlyMissing(e.target.checked)} /> Show data gaps only</label></div>
      <div className={s.metricList}>{metrics.map((m) => <button key={m.id} aria-pressed={active?.id === m.id} onClick={() => onSelect(m.id)}><span className={s.metricCategory}>{PILLAR_LABELS[m.pillar]}</span><span className={s.metricName}>{m.label}</span><span><strong>{formatRiskValue(m.value, m.format)}</strong><small className={s.badge} data-level={m.zone.level}>{m.zone.label}</small></span></button>)}</div>
      {!metrics.length && <div className={s.emptySmall}><p>No matching metrics.</p><button className={s.textButton} onClick={() => { onPillar('all'); onOnlyMissing(false); setSearch(''); }}>Clear filters</button></div>}
    </aside>
    {active ? <MetricDetail key={active.id} metric={active} data={data} profile={profile} /> : <div className={s.empty}><Search/><h2>No metrics in this view</h2><p>Choose another pillar or clear the filters.</p></div>}
  </div>;
}

function MetricDetail({ metric: m, data, profile }: { metric: RiskMetric; data: RiskData; profile: RiskProfile }) {
  const [index, setIndex] = useState(m.series.length - 1);
  const [detail, setDetail] = useState('evidence');
  const point = m.series[index];
  const points = m.series.map((p) => ({ ...p, label: riskPeriodLabel(p) }));
  const historical = index !== m.series.length - 1;
  const sources = point?.sources || [];
  const calculations = [...new Map((point?.calculations || []).map((c) => [[c.label,c.formula,c.start,c.end,c.value].join(':'),c])).values()];
  return <article className={s.metricDetail}>
    <div className={s.detailHeader}><div><div className={s.eyebrow}>{PILLAR_LABELS[m.pillar]} / Metric explorer</div><h2>{m.label}</h2></div><span className={s.badge} data-level={m.zone.level}>{m.zone.label}</span></div>
    <div className={s.metricHeadline}><strong>{formatRiskValue(m.value, m.format)}</strong><span>{m.delta != null ? `${riskDelta(m)} vs ${profile.basis === 'ttm' ? 'prior quarter end' : 'prior fiscal year'}` : 'Prior-period comparison unavailable'}<small>{m.classification === 'illustrative' ? 'Illustrative adjustment' : m.classification === 'reported' ? 'Reported SEC fact' : m.value != null ? 'Calculated from SEC facts' : 'Missing required input(s)'} · {profile.periods[0]?.end}</small></span></div>
    <p className={s.explanation}>{m.why}</p>
    {m.note && <p className={s.note}>{m.note}</p>}
    {m.value == null && <div className={s.notice}><CircleAlert size={17}/><span>Unavailable does not mean zero or low risk. This period may require custom tags or dimensional notes outside SEC company facts.</span></div>}
    <div className={s.chartHeader}><span>{m.id === 'loss_years' ? 'Loss flag by observation · 1 = loss, 0 = no loss' : profile.basis === 'ttm' ? 'Quarter-end / overlapping TTM history' : 'Annual history'}</span><button className={s.textButton} onClick={() => downloadRiskFile(`${data.ticker}-${m.id}-${profile.basis}.csv`, riskHistoryCsv(data, profile, m), 'text/csv')}><ArrowDownToLine size={14}/> CSV</button></div>
    {points.some((p) => p.value != null) ? <div className={s.chart} role="img" aria-label={`${m.label} history. Exact observations are available in the History table below.`}><ResponsiveContainer width="100%" height="100%"><LineChart data={points} margin={{ top: 16, right: 18, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--r-line)" strokeDasharray="3 4" vertical={false}/><XAxis dataKey="label" stroke="var(--r-muted)" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} minTickGap={18}/><YAxis stroke="var(--r-muted)" tickLine={false} axisLine={false} width={75} tick={{ fontSize: 11 }} tickFormatter={(n) => formatRiskValue(n, m.format)} domain={['auto','auto']}/><Tooltip contentStyle={{ background: 'var(--r-panel)', border: '1px solid var(--r-line)', borderRadius: 8, color: 'var(--r-text)' }} formatter={(v) => [formatRiskValue(Number(v), m.format), m.label]} labelFormatter={(_, payload) => payload?.[0]?.payload?.end || ''}/><Line type="linear" dataKey="value" stroke="var(--r-accent)" strokeWidth={2.5} dot={{ r: 4, strokeWidth: 2, fill: 'var(--r-panel)' }} activeDot={{ r: 6 }} connectNulls={false} isAnimationActive={false}/></LineChart></ResponsiveContainer></div> : <div className={s.noChart}>No compatible observations in this reporting window.</div>}
    <div className={s.question}><span>Question to take to the filing</span><p>{m.question}</p></div>
    <div className={s.detailTabs}><div>{[['evidence','Calculation & sources'],['history','History table']].map(([key,label]) => <button key={key} aria-pressed={detail === key} onClick={() => setDetail(key)}>{label}</button>)}</div><label>Observation<select aria-label="Evidence observation" value={index} onChange={(e) => setIndex(Number(e.target.value))}>{m.series.map((p,i) => <option value={i} key={p.end}>{p.end}{i === m.series.length - 1 ? ' (latest)' : ''}</option>)}</select></label></div>
    {detail === 'evidence' ? <div className={s.evidence}>
      <div className={s.formula}><span>{historical ? `Historical observation · ${point?.end}` : 'Calculation for selected observation'}{m.id !== 'loss_years' && ` · ${formatRiskValue(point?.value, m.format)}`}</span><p>{m.id === 'loss_years' ? 'Each observation: 1 if reported net income is negative, otherwise 0. The headline counts losses in the whole window.' : point?.formula || m.formula}</p></div>
      {calculations.length > 0 && <details className={s.disclosure}><summary>Intermediate calculations ({calculations.length})</summary><div>{calculations.map((c,i) => <p key={i}><strong>{c.label || 'Derived flow'}: {c.unit === 'USD' ? formatRiskValue(c.value, 'usd') : c.value?.toLocaleString('en-US')}</strong><br/>{c.formula} · {c.start ? `${c.start} → ` : ''}{c.end}</p>)}</div></details>}
      {m.thresholds && <details className={s.disclosure}><summary>Screen thresholds and interpretation</summary><p>Within screen / Monitor / Review / Priority review: <strong>{m.thresholds}</strong></p><p>These are fixed product screening conventions. They are not peer percentiles, regulatory requirements, or calibrated credit ratings.</p></details>}
      <h3>Reported source inputs <span>{sources.length}</span></h3><Sources sources={sources}/>
    </div> : <div className={s.tableWrap}><table><caption>{m.label} · {profile.basis === 'ttm' ? 'TTM flows and quarter-end balances' : 'Annual observations'}</caption><thead><tr><th>Reporting end</th><th>Value{m.id === 'loss_years' ? ' (loss flag)' : ''}</th><th>Source inputs</th></tr></thead><tbody>{[...m.series].reverse().map((p,i) => <tr key={p.end}><th scope="row">{p.end}</th><td>{formatRiskValue(p.value, m.format)}</td><td><button className={s.textButton} onClick={() => { setIndex(m.series.length - 1 - i); setDetail('evidence'); }}>Inspect {p.sources.length} inputs <ArrowUpRight size={13}/></button></td></tr>)}</tbody></table><p className={s.note}>Gaps are retained. Percentage-ratio changes are percentage points. SEC facts may reflect later revisions to the same reporting period.</p></div>}
  </article>;
}

export function RiskStress({ profile, controls, onControls }: { profile: RiskProfile; controls: Record<string,number>; onControls: (c: Record<string,number>) => void }) {
  const result = runRiskStress(profile, controls);
  const bank = profile.industry.isBank;
  const insurer = profile.industry.isFinancial && !bank;
  const fields = bank ? [{ key: 'runoff', label: 'Requested deposit withdrawal', max: 30, step: 0.5, detail: '% of reported deposits' }, { key: 'creditLoss', label: 'Additional unreserved credit loss', max: 5, step: 0.1, detail: '% of net loans, beyond existing allowances' }] : insurer ? [{ key: 'assetLoss', label: 'Illustrative asset loss', max: 10, step: 0.1, detail: '% of total assets, before tax' }] : [{ key: 'earningsDecline', label: 'Operating earnings decline', max: 100, step: 5, detail: '% of the absolute operating-income baseline' }, { key: 'interestIncrease', label: 'Interest expense increase', max: 100, step: 5, detail: '% above the reported or TTM interest expense' }];
  return <section className={s.stress}>
    <div className={s.detailHeader}><div><div className={s.eyebrow}><FlaskConical size={15}/> Scenario laboratory</div><h2>{bank ? 'How much pressure can the balance sheet absorb?' : insurer ? 'Test the sensitivity of book capital.' : 'How resilient is interest coverage?'}</h2><p>Move an assumption. See the arithmetic. Start at zero to reproduce the baseline.</p></div><button className={s.button} onClick={() => onControls({})}><RotateCcw size={15}/>Reset</button></div>
    {!result.available ? <div className={s.empty}><CircleAlert/><h3>Scenario unavailable for this reporting period</h3><p>Required inputs: {result.missing.join(', ')}. Missing figures are not assumed to be zero.</p></div> : <>
      <div className={s.stressGrid}><div className={s.controls}>{fields.map((field) => <div key={field.key} className={s.control}><label htmlFor={`stress-${field.key}`}>{field.label}<strong>{(controls[field.key] || 0).toFixed(field.step < 1 ? 1 : 0)}%</strong></label><p>{field.detail}</p><input id={`stress-${field.key}`} type="range" min={0} max={field.max} step={field.step} value={controls[field.key] || 0} onChange={(e) => onControls({ ...controls, [field.key]: Number(e.target.value) })}/><div><span>0%</span><span>{field.max}%</span></div></div>)}<div className={s.notice}><CircleAlert size={17}/><span>Illustrative sensitivity · {profile.periods[0]?.end}<br/>Before tax; not a forecast or regulatory stress test.{bank && <><br/><br/>Cash basis: {profile.stressInputs.cash?.formula || 'Reported cash'}. Other funding sources are excluded.</>}</span></div></div>
        <div className={s.scenarioResults}><div className={s.resultHeader}><span>Outcome</span><span>Baseline</span><span>Your scenario</span></div>{result.rows.map((r) => <div className={s.resultRow} key={r.label}><span>{r.label}</span><span>{formatRiskValue(r.baseline,r.format)}</span><strong>{formatRiskValue(r.stressed,r.format)}</strong></div>)}</div></div>
      <div className={s.assumptions}><h3>What this scenario assumes</h3><ul>{result.assumptions.map((a) => <li key={a}>{a}</li>)}</ul><details className={s.disclosure}><summary>Equations and reported scenario inputs</summary>{result.rows.map((r) => <p key={r.label}><strong>{r.label}:</strong> {r.formula}</p>)}<Sources sources={(result.inputs || []).flatMap((key) => profile.stressInputs[key].sources)}/></details></div>
    </>}
  </section>;
}

export function RiskDisclosures({ data }: { data: RiskData }) {
  const [scan, setScan] = useState<any>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setScan(null); setError('');
    fetch(`/api/risk?ticker=${encodeURIComponent(data.ticker)}&include=disclosures&v=${RISK_VERSION}`, { signal: controller.signal })
      .then(async (res) => { const body = await res.json(); if (!res.ok) throw new Error(body.error || 'Could not read disclosures.'); return body; })
      .then((body) => { if (!controller.signal.aborted) setScan(body.filingScan); })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [data.ticker, retry]);
  const models = [['Altman Z″',data.annual.zScore],['Zmijewski index',data.annual.models.zmijewski],['Beneish M-Score',data.annual.models.beneish]] as const;
  return <section className={s.disclosuresPanel}><div className={s.detailHeader}><div><div className={s.eyebrow}><FileText size={15}/> Read the original disclosure</div><h2>Risk language, in context.</h2><p>Literal mentions are reading aids. They do not establish a breach, a control failure, or a going-concern qualification.</p></div></div>
    {!scan && !error && <p className={s.inlineLoading} role="status"><Loader2 size={18} className={s.spin}/> Locating and scanning the annual filing…</p>}
    {(error || scan?.error) && <div className={s.notice} role="alert"><CircleAlert size={17}/><span>{error || scan.error} <button className={s.textButton} onClick={() => setRetry((n) => n + 1)}>Retry scan</button></span></div>}
    {scan?.url && <a className={s.filingLink} href={scan.url} target="_blank" rel="noreferrer"><FileText size={20}/><span>{scan.form} · Period ended {scan.reportDate}<small>Filed {scan.filingDate} · {scan.accession}</small></span><ArrowUpRight size={17}/></a>}
    {scan?.historyLimited && <p className={s.note}>The filing-history search was limited; a more recent annual filing may be outside the searched records.</p>}
    {scan && !scan.error && <div className={s.termGrid}>{scan.terms.map((term: any) => <details key={term.term} className={s.term}><summary>{term.term}<span>{term.count} {term.count === 1 ? 'mention' : 'mentions'}</span></summary>{term.excerpts.map((excerpt: string,i: number) => <blockquote key={i}>{excerpt}</blockquote>)}{!term.count && <p>No literal matches in the extracted text. This does not establish absence of the underlying risk.</p>}</details>)}</div>}
    <div className={s.models}><h2>Annual research models</h2><p>Historical academic screens using annual inputs. Model outputs are not current default probabilities, credit ratings, or findings of manipulation.</p>{data.annual.industry.isFinancial ? <div className={s.notice}>Altman, Zmijewski, and Beneish are not applied to banks or insurers. Use the sector-specific accounting metrics and original capital disclosures.</div> : models.map(([name, model]) => <details className={s.disclosure} key={name}><summary>{name}<span>{model?.value == null ? 'Unavailable' : model.value.toFixed(2)} · FY{model?.fiscalYear || '—'}</span></summary>{model ? <><p className={s.formula}>{String(model.formula || '').replace('P(distress)', 'Historical model transform')}</p>{model.missing?.length > 0 && <p>Missing inputs: {model.missing.join(', ')}</p>}{model.caution && <p>{model.caution}</p>}{model.assumptions?.map((a: string) => <p key={a}>{a}</p>)}{model.thresholds && <p>Published model cutoffs: {Object.entries(model.thresholds).map(([key,value]) => `${key} ${value}`).join(' · ')}</p>}<div className={s.tableWrap}><table><thead><tr><th>Input / index</th><th>Value</th><th>Coefficient</th><th>Contribution</th></tr></thead><tbody>{(model.inputs || model.indices || []).map((input: any) => <tr key={input.id}><th scope="row">{input.label}</th><td>{(input.ratio ?? input.value)?.toFixed(3) ?? '—'}</td><td>{input.weight ?? input.coefficient ?? '—'}</td><td>{input.contribution?.toFixed(3) ?? '—'}</td></tr>)}</tbody></table></div><Sources sources={model.sources || []}/></> : <p>No compatible annual inputs.</p>}</details>)}</div>
  </section>;
}
