'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Building2, CalendarDays, Check, ChevronDown, CircleAlert, FileText, Landmark, Link2, Loader2, Network, Search, ShoppingCart, TrendingUp, Wallet } from 'lucide-react';
import ExposureMarketContext from './ExposureMarketContext';
import { companyExposureMapCsv, companyExposureEvidenceMarkdown, exposureAmountLabel } from './exposurePresentation.js';
import { downloadRiskFile } from './riskDownload';
import { matchesExposureRequest, selectExposureEvidence } from './exposureSelection.js';
import s from './CompanyExposureMap.module.css';

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

const CHANNELS = [
  { id: 'revenue', label: 'Revenue', help: 'Selling prices & demand', Icon: TrendingUp },
  { id: 'input-costs', label: 'Input costs', help: 'Materials & operating costs', Icon: ShoppingCart },
  { id: 'borrowing', label: 'Borrowing', help: 'Debt & interest expense', Icon: Landmark },
  { id: 'investments', label: 'Investments', help: 'Assets & investment income', Icon: Wallet },
  { id: 'currencies', label: 'Currencies', help: 'Transactions & translation', Icon: Building2 },
];

function dateLabel(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return 'Not reported';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Not reported';
}

function quoteLink(evidence: Evidence) {
  const quote = evidence.text.trim().slice(0, 160);
  return `${evidence.url.split('#')[0]}${quote ? `#:~:text=${encodeURIComponent(quote)}` : ''}`;
}

function validPayload(value: unknown): value is ExposureMap {
  if (!value || typeof value !== 'object') return false;
  const body = value as ExposureMap;
  return body.schemaVersion === 'edgar.company-exposure-map.v1' && typeof body.ticker === 'string' && (typeof body.companyName === 'string' || body.companyName === null)
    && Array.isArray(body.rows) && Array.isArray(body.sources) && Array.isArray(body.limitations) && !!body.coverage
    && body.rows.every(row => typeof row.id === 'string' && typeof row.marketLabel === 'string' && Array.isArray(row.evidence)
      && row.evidence.every(evidence => typeof evidence.text === 'string' && typeof evidence.url === 'string' && Array.isArray(evidence.amounts)));
}

export default function CompanyExposureMap({ ticker, asOf = '', onAsOfChange }: { ticker: string; asOf?: string; onAsOfChange: (value: string) => void }) {
  const [data, setData] = useState<ExposureMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [sourceRole, setSourceRole] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [draftAsOf, setDraftAsOf] = useState(asOf);
  const [exported, setExported] = useState('');
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => { setDraftAsOf(asOf); }, [asOf]);
  useEffect(() => {
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(60_000);
    const signal = AbortSignal.any([controller.signal, deadline]);
    setLoading(true); setError(''); setData(null); setExported(''); setSelectedId('');
    const params = new URLSearchParams({ ticker });
    if (asOf) params.set('asOf', asOf);
    fetch(`/api/v1/cftc/company-exposures?${params}`, { signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok && !(validPayload(body) && body.status === 'unavailable')) throw new Error(body.error || body.message || 'Company filing evidence is temporarily unavailable.');
        if (!validPayload(body)) throw new Error('The filing evidence could not be verified. Please retry.');
        if (!matchesExposureRequest(body, ticker, asOf)) throw new Error('The returned filing evidence does not match the selected company and cutoff. Please retry.');
        return body;
      })
      .then(body => { if (!controller.signal.aborted) { setData(body); if (body.status === 'unavailable') setError(body.message || 'The filing evidence is temporarily unavailable.'); } })
      .catch(cause => { if (!controller.signal.aborted) setError(deadline.aborted ? 'The filing review took too long. Please retry.' : cause.message === 'Failed to fetch' ? 'The company evidence service could not be reached. Please retry.' : cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticker, asOf, retry]);

  const sourceRows: Exposure[] = useMemo(() => selectExposureEvidence(data?.rows || [], sourceRole), [data, sourceRole]);
  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sourceRows.filter(row => (category === 'all' || row.category === category) && (!term || `${row.categoryLabel} ${row.marketLabel} ${row.channelExplanation} ${row.benchmark?.label || ''} ${row.evidence.map(evidence => evidence.text).join(' ')}`.toLowerCase().includes(term)));
  }, [sourceRows, category, search]);
  const selected = filteredRows.find(row => row.id === selectedId) || filteredRows[0];
  const selectedQualifyingOnly = selected?.evidence.every(evidence => evidence.disclosureDirection === 'qualifying-or-negative');
  const annualSource = data?.sources.find(source => source.role === 'annual');
  const quarterSources = data?.sources.filter(source => source.role === 'quarterly') || [];
  const readySourceCount = data?.sources.filter(source => source.status === 'ready').length || 0;
  const reportedAmountCount = data?.rows.filter(row => row.evidence.some(evidence => evidence.amounts.length)).length || 0;
  const mappedCount = data?.rows.filter(row => !!row.benchmark).length || 0;

  function choose(row: Exposure) {
    setSelectedId(row.id); setExported('');
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }));
  }

  return <section className={s.root} aria-label={`${ticker} company exposure map`}>
    <header className={s.hero}>
      <div className={s.heroMain}><div className={s.eyebrow}><Network size={15} /> Company exposure map</div><h2>{data?.companyName || ticker}<span>{ticker}</span></h2><p>Follow a market exposure into the business. Start with the company’s words, inspect reported amounts, then review relevant CFTC market context.</p><div className={s.method}><span><FileText size={14} /> SEC establishes the connection</span><ArrowRight size={13} /><span><Link2 size={14} /> CFTC adds market context</span></div></div>
      <form className={s.cutoff} onSubmit={event => { event.preventDefault(); if (draftAsOf !== asOf) onAsOfChange(draftAsOf); }}><label htmlFor="exposure-cutoff"><CalendarDays size={14} /> SEC filing cutoff</label><input id="exposure-cutoff" type="date" min="1994-01-01" max={new Date().toISOString().slice(0, 10)} value={draftAsOf} onChange={event => setDraftAsOf(event.target.value)} /><div className={s.cutoffActions}><button type="submit" disabled={draftAsOf === asOf}>Apply cutoff</button>{asOf && <button type="button" onClick={() => onAsOfChange('')}>Use latest</button>}</div><small>{asOf ? `Filings filed by ${dateLabel(asOf)}` : 'Latest available annual filing and eligible quarterly updates'}</small></form>
    </header>

    {asOf && <div className={s.notice}><CalendarDays size={17} /><p><strong>Historical SEC evidence through {dateLabel(asOf)}.</strong> CFTC panels show separately dated market observations available now; they can postdate this cutoff. This is not a reconstruction of information available on that historical date.</p></div>}
    {loading && <div className={s.loading} role="status"><Loader2 size={24} className={s.spin} /><div><h3>Tracing {ticker}’s market exposures</h3><p>Reading eligible filings and connecting passages to business channels. This can take about a minute on the first request.</p></div></div>}
    {error && <div className={s.empty} role="alert"><CircleAlert size={25} /><h3>The exposure map could not be loaded</h3><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Retry filing review</button></div>}

    {data && data.status !== 'unavailable' && <>
      <div className={s.sourceStrip}><span><BookOpen size={14} /> {readySourceCount} filing{readySourceCount === 1 ? '' : 's'} reviewed</span>{annualSource && <span>Annual period: <b>{dateLabel(annualSource.reportDate)}</b></span>}{quarterSources.length > 0 && <span>Quarterly updates: <b>{quarterSources.length}</b></span>}<span>Checked: <b>{dateLabel(data.checkedAt || data.generatedAt)}</b></span></div>
      {(data.status === 'partial' || !data.coverage.searchComplete) && <div className={s.notice}><CircleAlert size={18} /><p><strong>Coverage is incomplete.</strong> {data.message || 'Some eligible filing evidence could not be reviewed. The map shows only the passages successfully retrieved.'} Inspect the source coverage below before drawing conclusions.{data.retryable && <button className={s.inlineButton} onClick={() => setRetry(value => value + 1)}>Retry review</button>}</p></div>}
      {!data.coverage.annualAvailable && data.coverage.quarterlyAvailable && <div className={s.notice}><BookOpen size={18} /><p><strong>Quarterly evidence only for this SEC company identity.</strong> No complete annual baseline was available in the reviewed sources. A quarterly filing may omit exposures described in an annual report. Predecessor or related company filings have not been substituted.</p></div>}
      {data.coverage.extractionLimited && <div className={s.notice}><BookOpen size={18} /><p><strong>The narrative review reached a coverage limit.</strong> Some text, connections, or additional passages fall outside the displayed map. The source coverage below identifies these limits; a missing connection is not proof of no exposure.</p></div>}

      <div className={s.sectionHeading}><div><div className={s.eyebrow}>01 · Locate the business channel</div><h3>Where the market enters the company</h3><p>Counts identify connections found in reviewed text. They do not measure exposure size, risk severity, or completeness.</p></div><button aria-pressed={category === 'all'} onClick={() => setCategory('all')}>All channels <span>{sourceRows.length}</span></button></div>
      <div className={s.channels} aria-label="Filter exposures by business channel">{CHANNELS.map(({ id, label, help, Icon }) => {
        const count = sourceRows.filter(row => row.category === id).length;
        return <button key={id} className={s.channel} aria-pressed={category === id} onClick={() => setCategory(category === id ? 'all' : id)}><span className={s.channelLabel}><Icon size={18} />{label}</span><strong>{count ? `${count} topic${count === 1 ? '' : 's'}` : 'No evidence found'}</strong><small>{count ? help : 'Not proof of zero exposure'}</small></button>;
      })}</div>

      <section className={s.map} aria-labelledby="exposure-list-title">
        <div className={s.mapHeading}><div><h3 id="exposure-list-title">The exposure register</h3><p>{data.rows.length} evidence-linked connections · {reportedAmountCount} with reported amounts · {mappedCount} with supported CFTC context</p></div><button disabled={!data.rows.length} onClick={() => { downloadRiskFile(`${ticker}-exposure-map-${asOf || 'latest'}.csv`, companyExposureMapCsv(data), 'text/csv'); setExported('map'); }}>{exported === 'map' ? <Check size={14} /> : <ArrowDownToLine size={14} />}Export full map</button></div>
        <div className={s.filters}><label className={s.search}><Search size={15} /><input aria-label="Search company exposure evidence" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search markets, amounts, or filing language…" /></label><label className={s.sourceFilter}>Filing evidence<select value={sourceRole} onChange={event => setSourceRole(event.target.value)}><option value="all">Annual + quarterly</option><option value="annual">Annual filing only</option><option value="quarterly">Quarterly updates only</option></select></label></div>
        {filteredRows.length > 0 ? <><div className={s.tableWrap} role="region" tabIndex={0} aria-label="Exposure register; scroll horizontally for all columns"><table className={s.table}><thead><tr><th scope="col">Business channel / exposure</th><th scope="col">Reported amounts</th><th scope="col">Filing evidence</th><th scope="col">CFTC benchmark fit</th><th scope="col"><span className={s.srOnly}>Review evidence</span></th></tr></thead><tbody>{filteredRows.map(row => {
          const amounts = row.evidence.flatMap(evidence => evidence.amounts.map(amount => ({ ...amount, evidence })));
          const latest = row.evidence[0];
          return <tr key={row.id} data-selected={selected?.id === row.id}><th scope="row"><small>{row.categoryLabel}</small>{row.evidence.every(evidence => evidence.disclosureDirection === 'qualifying-or-negative') && <span className={s.qualifier}>Qualifying disclosure</span>}<button className={s.rowTitle} onClick={() => choose(row)} aria-controls="company-exposure-detail" aria-pressed={selected?.id === row.id}>{row.marketLabel}</button></th><td>{amounts.length ? <><strong>{amounts[0].text}</strong><small>{exposureAmountLabel(amounts[0].kind)} · {amounts[0].evidence.form} filed {dateLabel(amounts[0].evidence.filed)}</small>{amounts.length > 1 && <small>+{amounts.length - 1} additional amount{amounts.length === 2 ? '' : 's'} in evidence</small>}</> : <><span>No amount safely extracted</span><small>Inspect the filing passage</small></>}</td><td><strong>{latest.form} · {dateLabel(latest.reportDate)}</strong><small>Filed {dateLabel(latest.filed)}</small><small>{row.evidence.length} passage{row.evidence.length === 1 ? '' : 's'}</small></td><td><span className={s.fit} data-fit={row.benchmark?.fit || 'unsupported'}>{row.benchmark?.fit === 'named-reference' ? 'Named reference' : row.benchmark ? 'Related proxy' : 'No supported benchmark'}</span>{row.benchmark && <small>{row.benchmark.label}</small>}</td><td><button className={s.reviewButton} onClick={() => choose(row)} aria-label={`Review ${row.categoryLabel}: ${row.marketLabel}`}><ArrowRight size={16} /></button></td></tr>;
        })}</tbody></table></div><p className={s.registerNote}>Amounts retain their filing context and dates. Notionals, balances, sensitivities, and historical activity are not interchangeable and are never summed here.</p></> : <div className={s.empty}><Search size={23} /><h3>{data.rows.length ? 'No passages match these filters' : data.status === 'no_filing' ? 'No eligible filing found' : 'No supported exposure passages found'}</h3><p>{data.rows.length ? 'Try another business channel, filing type, or search phrase.' : data.message || 'The reviewed text did not establish a supported connection. This does not establish that the company has no market exposure.'}</p>{data.rows.length > 0 && <button onClick={() => { setCategory('all'); setSearch(''); setSourceRole('all'); }}>Clear filters</button>}</div>}
      </section>

      {selected && <section id="company-exposure-detail" ref={detailRef} className={s.detail} aria-labelledby="exposure-detail-title">
        <div className={s.detailHeading}><div><div className={s.eyebrow}>02 · Inspect the company evidence</div><h3 id="exposure-detail-title">{selected.marketLabel}<span>{selected.categoryLabel}</span></h3><p>{selectedQualifyingOnly ? 'This filing selection contains qualifying wording about an exposure identified in another reviewed filing. Read the dated passage before interpreting whether the exposure changed.' : selected.channelExplanation}</p></div><button onClick={() => { downloadRiskFile(`${ticker}-${selected.id}-exposure-evidence.md`, companyExposureEvidenceMarkdown(data, selected)); setExported(`evidence:${selected.id}`); }}>{exported === `evidence:${selected.id}` ? <Check size={14} /> : <ArrowDownToLine size={14} />}Export evidence</button></div>
        <p className={s.evidenceNote}>This connection is identified from the passages below. Review the company’s wording, timing, and scope before treating it as an exposure estimate.</p>
        <div className={s.evidenceList}>{selected.evidence.map((evidence, index) => <article className={s.evidence} key={evidence.id}>
          <div className={s.evidenceHeader}><span className={s.evidenceNumber}>{String(index + 1).padStart(2, '0')}</span><div><strong>{evidence.form} · {evidence.role === 'quarterly' ? 'Quarterly update' : 'Annual filing'}</strong>{evidence.disclosureDirection === 'qualifying-or-negative' && <span className={s.qualifier}>Qualifying disclosure — review dated passage</span>}<span>Fiscal period ended {dateLabel(evidence.reportDate)} · Filed {dateLabel(evidence.filed)}</span></div><a href={quoteLink(evidence)} target="_blank" rel="noreferrer">Open SEC passage <ArrowUpRight size={14} /></a></div>
          <blockquote>{evidence.text}</blockquote>{evidence.disclosureDirection === 'qualifying-or-negative' && <p className={s.amountNote}>This passage qualifies or limits an earlier connection. Its wording is not treated as a new positive exposure, a measured reduction, or proof that the exposure has disappeared.</p>}
          {evidence.amounts.length > 0 ? <div className={s.amounts}><h4>Reported amounts in this passage</h4>{evidence.amounts.map((amount, amountIndex) => <div className={s.amount} key={`${amount.text}:${amountIndex}`}><div><strong>{amount.text}</strong><span>{exposureAmountLabel(amount.kind)}</span></div><p>{amount.context}</p></div>)}<p className={s.amountNote}>These are quoted amounts from this filing, with the period and purpose stated in the text. They are not automatically the company’s current unhedged exposure.</p></div> : <p className={s.amountNote}>No qualifying amount was extracted from this passage. Read the filing’s tables and surrounding discussion for additional detail.</p>}
          <div className={s.provenance}><span>Accession {evidence.accession}</span><a href={evidence.url} target="_blank" rel="noreferrer">Open full filing <ArrowUpRight size={12} /></a></div>
        </article>)}</div>
        <div className={s.benchmark}><div><div className={s.eyebrow}>03 · Evaluate the market connection</div><h3>{selected.benchmark ? selected.benchmark.label : 'Keep the company exposure visible'}</h3></div>{selected.benchmark ? <><span className={s.fit} data-fit={selected.benchmark.fit}>{selected.benchmark.fit === 'named-reference' ? 'Named reference in filing' : 'Related market proxy'}</span><p>{selected.benchmark.basisLimit}</p></> : <p>{selected.benchmarkUnavailableReason || 'This exposure has no supported CFTC benchmark in the current map.'} The SEC evidence remains useful; a futures contract is not substituted without a supported connection.</p>}</div>
        {selected.benchmark && <ExposureMarketContext key={`${ticker}:${selected.benchmark.family}:${selected.benchmark.contract}`} ticker={ticker} market={selected.benchmark} asOf={asOf} />}
      </section>}


    </>}
    {data && <SourceCoverage data={data} ticker={ticker} />}
  </section>;
}

function SourceCoverage({ data, ticker }: { data: ExposureMap; ticker: string }) {
  return <details className={s.coverage} open={data.status === 'unavailable' ? true : undefined}><summary><span><BookOpen size={17} /> Sources, coverage, and interpretation</span><ChevronDown size={17} /></summary><div className={s.coverageBody}><h3>What was reviewed</h3><p>The map reads eligible company filing text and extracts supported market connections. A missing channel means no qualifying evidence was found in that reviewed text, not that the company has zero exposure.</p><div className={s.sourceList}>{data.sources.map(source => <div key={source.accession}><FileText size={17} /><div><a href={source.url} target="_blank" rel="noreferrer">{source.form} · Period ended {dateLabel(source.reportDate)} <ArrowUpRight size={13} /></a><p>Filed {dateLabel(source.filed)} · {source.role === 'quarterly' ? 'Quarterly update' : 'Annual baseline'} · {source.status === 'ready' ? 'Reviewed' : 'Unavailable'}</p>{source.message && <p>{source.message}</p>}{data.coverage.filings.filter(filing => filing.accession === source.accession).map(filing => <p key={filing.accession}>{filing.textTruncated ? 'Text review limit reached; the remaining source text was not searched.' : 'Available narrative text searched.'} {filing.passagesScanned.toLocaleString()} passages reviewed.</p>)}<small>Accession {source.accession}{source.retrievedAt ? ` · Retrieved ${dateLabel(source.retrievedAt)}` : ''}</small></div></div>)}</div>{!data.sources.length && <p>No eligible filing source was identified.</p>}<div className={s.coverageLimits}>{data.coverage.extractionLimited && <p>Display limits: {data.coverage.omittedRows || 0} additional connection matches and {data.coverage.omittedEvidence || 0} additional passage matches omitted. {data.coverage.filings.filter(filing => filing.textTruncated).length} source document(s) exceeded the text review limit.</p>}{data.coverage.historyFailures?.map(failure => <p key={failure.name}>{failure.message}</p>)}</div><ul>{data.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul><p>CFTC commitments reports describe aggregate trader groups in a futures market. They do not establish {ticker}’s positions, hedging activity, hedge effectiveness, or unhedged exposure.</p><a href="https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm" target="_blank" rel="noreferrer">CFTC report descriptions <ArrowUpRight size={13} /></a></div></details>;
}
