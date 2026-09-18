'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, CalendarDays, Check, ChevronDown, CircleAlert, FileText, Loader2, Search, SlidersHorizontal } from 'lucide-react';
import ExposureMarketContext from './ExposureMarketContext';
import { CFTC_LAUNCH_CATALOG } from '../../utils/cftc.js';
import { companyExposureMapCsv, companyExposureEvidenceMarkdown, exposureAmountLabel } from './exposurePresentation.js';
import { downloadRiskFile } from './riskDownload';
import { matchesExposureRequest, selectExposureEvidence } from './exposureSelection.js';
import s from './CompanyExposureMap.module.css';

const loadingPanel = () => <p className={s.loading} role="status"><Loader2 size={18} className={s.spin} /> Opening exposure view…</p>;
const CompanyConcentrations = dynamic(() => import('./CompanyConcentrations'), { loading: loadingPanel });
const ExposureInstruments = dynamic(() => import('./ExposureInstruments'), { loading: loadingPanel });
const CompanyOwnership = dynamic(() => import('./CompanyOwnership'), { loading: loadingPanel });
const PANELS = [['concentrations', 'Concentrations', 'Revenue & funding'], ['instruments', 'Credit & derivatives', 'Counterparties & contracts'], ['markets', 'Market links', 'SEC evidence + CFTC'], ['ownership', 'Funds & holders', 'Reported positions']] as const;
function panelFromLocation() { const value = new URLSearchParams(window.location.search).get('exposurePanel'); return PANELS.some(([id]) => id === value) ? value! : 'concentrations'; }

type Amount = { text: string; kind: string; context: string };
type Filing = { url: string; accession: string; form: string; filed: string; reportDate: string; role: 'annual' | 'quarterly' };
type Evidence = Filing & { id: string; text: string; amounts: Amount[]; benchmark: Market | null; disclosureDirection?: 'connection' | 'qualifying-or-negative' };
type Market = { family: string; contract: string; label: string; group: string; fit: 'named-reference' | 'proxy'; basisLimit: string };
type Exposure = { id: string; category: string; categoryLabel: string; marketId: string; marketLabel: string; channelExplanation: string; reviewStatus: string; benchmark: Market | null; benchmarkUnavailableReason?: string; evidence: Evidence[] };
type Source = Filing & { status: string; retrievedAt: string | null; message?: string };
type ExposureMap = {
  schemaVersion: string; ticker: string; companyName: string | null; cik: string | null; asOf: string | null; generatedAt: string; checkedAt: string;
  status: string; retryable: boolean; sources: Source[]; rows: Exposure[]; message?: string; limitations: string[];
  coverage: { historyFilesScanned: number; historyLimited: boolean; searchComplete: boolean; filingsEligible: number; filingsScanned: number; filingsFailed: number; annualAvailable: boolean; quarterlyAvailable: boolean; extractionLimited?: boolean; omittedRows?: number; omittedEvidence?: number; historyFailures?: { name: string; message: string }[]; filings: (Filing & { textCharactersScanned: number; textTruncated: boolean; passagesScanned: number })[] };
};

const TRANSMISSION: Record<string, string> = { revenue: 'Revenue & demand', 'input-costs': 'Operating costs & margins', borrowing: 'Interest expense & cash coverage', investments: 'Investment income & asset values', currencies: 'Cash flows & currency translation' };

function dateLabel(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return 'Not reported';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Not reported';
}
function quoteLink(evidence: Evidence) { const quote = evidence.text.trim().slice(0, 160); return `${evidence.url.split('#')[0]}${quote ? `#:~:text=${encodeURIComponent(quote)}` : ''}`; }
function validPayload(value: unknown): value is ExposureMap {
  if (!value || typeof value !== 'object') return false;
  const body = value as ExposureMap;
  return body.schemaVersion === 'edgar.company-exposure-map.v1' && typeof body.ticker === 'string'
    && Array.isArray(body.rows) && Array.isArray(body.sources) && Array.isArray(body.limitations) && !!body.coverage
    && body.rows.every(row => typeof row.id === 'string' && typeof row.marketLabel === 'string' && Array.isArray(row.evidence)
      && row.evidence.every(evidence => typeof evidence.text === 'string' && typeof evidence.url === 'string' && Array.isArray(evidence.amounts)));
}

export default function CompanyExposureMap({ ticker, asOf = '', basis = 'ttm', onAsOfChange, onBasisChange }: { ticker: string; asOf?: string; basis?: string; onAsOfChange: (value: string) => void; onBasisChange: (value: string) => void }) {
  const [panel, setPanel] = useState<string | null>(null);
  const [draftAsOf, setDraftAsOf] = useState(asOf);
  useEffect(() => { const restore = () => setPanel(panelFromLocation()); restore(); window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore); }, []);
  useEffect(() => { setDraftAsOf(asOf); }, [asOf]);
  function choosePanel(next: string) { setPanel(next); const url = new URL(window.location.href); if (next === 'concentrations') url.searchParams.delete('exposurePanel'); else url.searchParams.set('exposurePanel', next); window.history.pushState({}, '', url); }
  return <section className={s.root} aria-label={`${ticker} business exposures`}>
    <div className={s.toolbar}><p><strong>{ticker}</strong><span>Company exposure workspace</span></p><details className={s.settings}><summary><SlidersHorizontal size={15} /> Reporting settings {asOf && <span>· {asOf}</span>}<ChevronDown size={15} /></summary><div className={s.settingsBody}><label>SEC filing basis<select value={basis} onChange={event => onBasisChange(event.target.value)}><option value="ttm">Latest filing</option><option value="annual">Annual filing</option></select></label><form onSubmit={event => { event.preventDefault(); if (draftAsOf !== asOf) onAsOfChange(draftAsOf); }}><label htmlFor="exposure-cutoff">Filed on or before<input id="exposure-cutoff" type="date" min="1994-01-01" max={new Date().toISOString().slice(0, 10)} value={draftAsOf} onChange={event => setDraftAsOf(event.target.value)} /></label><div className={s.actions}><button type="submit" disabled={draftAsOf === asOf}>Apply cutoff</button>{asOf && <button type="button" onClick={() => onAsOfChange('')}>Use latest</button>}</div></form><p>Each chart shows its reporting period. Holdings use separately dated portfolio reports.</p></div></details></div>
    <nav className={s.panelNav} aria-label="Business exposure views">{PANELS.map(([id, label, subtitle], index) => <button key={id} aria-current={panel === id ? 'page' : undefined} aria-controls="company-exposure-panel" onClick={() => choosePanel(id)}><span className={s.navNumber}>0{index + 1}</span><span><strong>{label}</strong><small>{subtitle}</small></span></button>)}</nav>
    {asOf && <p className={s.notice}><CalendarDays size={17} /><span>SEC filing cutoff: {dateLabel(asOf)}. CFTC observations are separately dated and may be later.</span></p>}
    <div id="company-exposure-panel" className={s.panel}>
      {panel === null && loadingPanel()}
      {panel === 'concentrations' && <CompanyConcentrations ticker={ticker} basis={basis} asOf={asOf} />}
      {panel === 'instruments' && <ExposureInstruments ticker={ticker} basis={basis} asOf={asOf} />}
      {panel === 'markets' && <MarketConnections ticker={ticker} basis={basis} asOf={asOf} />}
      {panel === 'ownership' && <CompanyOwnership ticker={ticker} asOf={asOf} />}
    </div>
  </section>;
}

function MarketConnections({ ticker, basis, asOf }: { ticker: string; basis: string; asOf: string }) {
  const [data, setData] = useState<ExposureMap | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [search, setSearch] = useState(''), [sourceRole, setSourceRole] = useState(basis === 'annual' ? 'annual' : 'all'), [selectedId, setSelectedId] = useState(''), [exported, setExported] = useState('');
  useEffect(() => {
    const controller = new AbortController(), deadline = AbortSignal.timeout(60_000), signal = AbortSignal.any([controller.signal, deadline]);
    setLoading(true); setError(''); setData(null); setSelectedId('');
    const params = new URLSearchParams({ ticker }); if (asOf) params.set('asOf', asOf);
    fetch(`/api/v1/cftc/company-exposures?${params}`, { signal }).then(async response => {
      const body = await response.json();
      if (!response.ok && !(validPayload(body) && body.status === 'unavailable')) throw new Error(body.error || body.message || 'Company evidence is temporarily unavailable.');
      if (!validPayload(body) || !matchesExposureRequest(body, ticker, asOf)) throw new Error('The filing evidence could not be verified. Please retry.');
      return body;
    }).then(body => { if (!controller.signal.aborted) { setData(body); if (body.status === 'unavailable') setError(body.message || 'Filing evidence is unavailable.'); } })
      .catch(cause => { if (!controller.signal.aborted) setError(deadline.aborted ? 'The filing review took too long. Please retry.' : cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticker, asOf, retry]);
  const sourceRows: Exposure[] = useMemo(() => selectExposureEvidence(data?.rows || [], sourceRole), [data, sourceRole]);
  const rows = useMemo(() => { const term = search.trim().toLowerCase(); return sourceRows.filter(row => !term || `${row.categoryLabel} ${row.marketLabel} ${row.evidence.map(item => item.text).join(' ')}`.toLowerCase().includes(term)); }, [sourceRows, search]);
  const selected = rows.find(row => row.id === selectedId) || rows[0];
  const qualifying = selected?.evidence.every(item => item.disclosureDirection === 'qualifying-or-negative');
  const amount = selected?.evidence.flatMap(item => item.amounts.map(value => ({ ...value, filing: item })))[0];
  return <section aria-label="Disclosed market connections">
    <div className={s.sectionHeading}><div><h2>Markets connected to the business</h2><p>Select a disclosed connection, then inspect its market context.</p></div>{data && <button className={s.export} onClick={() => { downloadRiskFile(`${ticker}-exposure-map-${asOf || 'latest'}.csv`, companyExposureMapCsv(data), 'text/csv'); setExported('map'); }}>{exported === 'map' ? <Check size={15} /> : <ArrowDownToLine size={15} />}Export</button>}</div>
    {loading && <div className={s.loading} role="status"><Loader2 size={22} className={s.spin} /><p>Reading {ticker}’s filing evidence. The first review can take about a minute.</p></div>}
    {error && <div className={s.empty} role="alert"><CircleAlert size={22} /><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Retry filing review</button></div>}
    {data && data.status !== 'unavailable' && <>
      <div className={s.sourceStrip}><span>{data.sources.filter(item => item.status === 'ready').length} filings reviewed</span><span>Checked {dateLabel(data.checkedAt || data.generatedAt)}</span>{(data.coverage.extractionLimited || !data.coverage.searchComplete || data.status === 'partial') && <span className={s.limited}>Partial coverage · see sources below</span>}{!data.coverage.annualAvailable && <span className={s.limited}>No annual baseline available</span>}</div>
      <div className={s.marketWorkspace}>
        <aside className={s.connectionList} aria-label="Select a disclosed connection"><label className={s.search}><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} aria-label="Search disclosed connections" placeholder="Find a market or exposure" /></label><label className={s.sourceFilter}>Filing evidence<select value={sourceRole} onChange={event => setSourceRole(event.target.value)}><option value="all">Annual + quarterly</option><option value="annual">Annual only</option><option value="quarterly">Quarterly only</option></select></label><div className={s.connectionItems}>{rows.map(row => <button key={row.id} className={s.connection} aria-pressed={selected?.id === row.id} onClick={() => { setSelectedId(row.id); setExported(''); }}><small>{row.categoryLabel}</small><strong>{row.marketLabel}</strong><span>{row.benchmark ? 'CFTC connection available' : 'SEC disclosure'}<ArrowRight size={15} /></span></button>)}</div>{!rows.length && <p className={s.noMatches}>No matching disclosed connections. Missing evidence does not establish zero exposure.</p>}</aside>
        <div className={s.marketDetail}>{selected ? <>
          <div className={s.detailHeading}><span className={s.eyebrow}>{selected.categoryLabel}</span><h3>{selected.marketLabel}</h3>{qualifying && <p className={s.notice}>Qualifying disclosure: read the dated passages before inferring a change in exposure.</p>}</div>
          <div className={s.transmission}><div><small>Disclosed driver</small><strong>{selected.marketLabel}</strong></div><ArrowRight size={22} /><div><small>Financial channel</small><strong>{TRANSMISSION[selected.category] || selected.categoryLabel}</strong></div></div>
          {amount && <p className={s.reportedAmount}><strong>{amount.text}</strong> {exposureAmountLabel(amount.kind)} · {amount.filing.form} · {dateLabel(amount.filing.reportDate)}</p>}
          <details className={s.evidenceDisclosure} key={selected.id}><summary><BookOpen size={16} /><span>Filing evidence <b>{selected.evidence.length}</b></span><ChevronDown size={16} /></summary><div className={s.evidenceList}><p className={s.evidenceNote}>{qualifying ? 'These passages qualify an earlier connection; they do not quantify a reduction.' : selected.channelExplanation}</p>{selected.evidence.map(item => <article key={item.id} className={s.evidence}><header><strong>{item.form} · {dateLabel(item.reportDate)}</strong><a href={quoteLink(item)} target="_blank" rel="noreferrer">SEC passage <ArrowUpRight size={14} /></a></header><small>Filed {dateLabel(item.filed)}{item.disclosureDirection === 'qualifying-or-negative' ? ' · Qualifying disclosure' : ''}</small><blockquote>{item.text}</blockquote>{item.amounts.map((value, index) => <p key={index} className={s.amountContext}><strong>{value.text}</strong> · {exposureAmountLabel(value.kind)}<span>{value.context}</span></p>)}</article>)}<p className={s.evidenceNote}>Reported amounts retain their dates and purpose; they are not summed or treated as current unhedged exposure.</p><button className={s.export} onClick={() => downloadRiskFile(`${ticker}-${selected.id}-exposure-evidence.md`, companyExposureEvidenceMarkdown(data, selected))}><ArrowDownToLine size={15} /> Export evidence</button></div></details>
          {selected.benchmark ? <><p className={s.marketFit}><strong>{selected.benchmark.fit === 'named-reference' ? 'Named filing reference' : 'Related market proxy'}</strong> · {selected.benchmark.basisLimit}</p><ExposureMarketContext key={`${ticker}:${selected.benchmark.family}:${selected.benchmark.contract}`} ticker={ticker} market={selected.benchmark} asOf={asOf} /></> : <><p className={s.marketFit}>The disclosure does not identify a supported CFTC benchmark. You can add a separately labelled market comparison.</p><ReferenceMarketPicker key={selected.id} ticker={ticker} asOf={asOf} category={selected.category} /></>}
        </> : <div className={s.empty}><h3>No supported connection in this selection</h3><p>{data.message || 'Try another filing selection or search term.'}</p></div>}</div>
      </div>
    </>}
    {data && <SourceCoverage data={data} ticker={ticker} />}
  </section>;
}
function ReferenceMarketPicker({ ticker, asOf, category }: { ticker: string; asOf: string; category: string }) {
  const [choice, setChoice] = useState('');
  const market = CFTC_LAUNCH_CATALOG.find(item => `${item.family}:${item.code}` === choice);
  const preferred = category === 'currencies' ? ['currencies'] : ['borrowing', 'investments'].includes(category) ? ['rates'] : ['energy', 'metals', 'agriculture'];
  return <div className={s.referenceMarket}><label>Compare a reference market<select value={choice} onChange={event => setChoice(event.target.value)}><option value="">Choose a market</option>{[true, false].map(relevant => <optgroup key={String(relevant)} label={relevant ? 'Related market categories' : 'Other reference markets'}>{CFTC_LAUNCH_CATALOG.filter(item => preferred.includes(item.category) === relevant).map(item => <option key={item.code} value={`${item.family}:${item.code}`}>{item.label}</option>)}</optgroup>)}</select></label>{market && <ExposureMarketContext ticker={ticker} asOf={asOf} market={{ family: market.family, contract: market.code, label: market.label, group: market.family === 'tff' ? 'leveraged-funds' : 'managed-money', fit: 'user-selected', basisLimit: 'Independent market comparison; no company position or hedge is inferred.' }} />}</div>;
}

function SourceCoverage({ data, ticker }: { data: ExposureMap; ticker: string }) {
  return <details className={s.coverage} open={data.status === 'unavailable' ? true : undefined}><summary><span><BookOpen size={17} /> Sources, coverage, and interpretation</span><ChevronDown size={17} /></summary><div className={s.coverageBody}><h3>What was reviewed</h3><p>The map reads eligible company filing text and extracts supported market connections. A missing channel means no qualifying evidence was found in that reviewed text, not that the company has zero exposure.</p><div className={s.sourceList}>{data.sources.map(source => <div key={source.accession}><FileText size={17} /><div><a href={source.url} target="_blank" rel="noreferrer">{source.form} · Period ended {dateLabel(source.reportDate)} <ArrowUpRight size={13} /></a><p>Filed {dateLabel(source.filed)} · {source.role === 'quarterly' ? 'Quarterly update' : 'Annual baseline'} · {source.status === 'ready' ? 'Reviewed' : 'Unavailable'}</p>{source.message && <p>{source.message}</p>}{data.coverage.filings.filter(filing => filing.accession === source.accession).map(filing => <p key={filing.accession}>{filing.textTruncated ? 'Text review limit reached; the remaining source text was not searched.' : 'Available narrative text searched.'} {filing.passagesScanned.toLocaleString()} passages reviewed.</p>)}<small>Accession {source.accession}{source.retrievedAt ? ` · Retrieved ${dateLabel(source.retrievedAt)}` : ''}</small></div></div>)}</div>{!data.sources.length && <p>No eligible filing source was identified.</p>}<div className={s.coverageLimits}>{data.coverage.extractionLimited && <p>Display limits: {data.coverage.omittedRows || 0} additional connection matches and {data.coverage.omittedEvidence || 0} additional passage matches omitted. {data.coverage.filings.filter(filing => filing.textTruncated).length} source document(s) exceeded the text review limit.</p>}{data.coverage.historyFailures?.map(failure => <p key={failure.name}>{failure.message}</p>)}</div><ul>{data.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul><p>CFTC commitments reports describe aggregate trader groups in a futures market. They do not establish {ticker}’s positions, hedging activity, hedge effectiveness, or unhedged exposure.</p><a href="https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm" target="_blank" rel="noreferrer">CFTC report descriptions <ArrowUpRight size={13} /></a></div></details>;
}
