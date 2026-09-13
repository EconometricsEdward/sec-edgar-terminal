'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Building2, Check, CircleAlert, Database, Loader2, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { downloadRiskFile } from './riskDownload';
import { fcmChange, fcmComparisonCsv, fcmMoney, fcmRatio, fcmSignals, filterFcmFirms } from './fcmPresentation.js';
import s from './risk.module.css';

type FcmValues = {
  reportDate: string;
  adjustedNetCapital: number | null;
  netCapitalRequirement: number | null;
  excessNetCapital: number | null;
  capitalCoverage: number | null;
  customerSegregationRequired: number | null;
  customerAssetsInSegregation: number | null;
  customerSegregationExcess: number | null;
  targetResidualInterest: number | null;
  part30Required: number | null;
  part30Assets: number | null;
  part30Excess: number | null;
  clearedSwapsRequired: number | null;
  clearedSwapsAssets: number | null;
  clearedSwapsExcess: number | null;
  retailForexObligation: number | null;
  sourceUrl?: string;
};
type FcmFirm = FcmValues & {
  id: string;
  legalName: string;
  registration: string | null;
  dsro: string | null;
  identityBasis: string;
  previous: FcmValues | null;
  changes: { adjustedNetCapital: number | null; netCapitalRequirement: number | null; excessNetCapital: number | null; excessNetCapitalPct: number | null; capitalCoverage: number | null } | null;
  comparisonStatus: string;
  validationNotes?: string[];
  unavailableFields?: string[];
};
type FcmResponse = {
  schema_version: string;
  status: string;
  reportDate: string;
  previousReportDate: string | null;
  retrievedAt: string;
  units: string;
  source: { publisher: string; indexUrl: string; definitionsUrl: string; reports: { reportDate: string; url: string }[] };
  freshness: { cacheStatus: string; stale: boolean; sourceAgeDays: number | null; checkedAt?: string };
  firms: FcmFirm[];
  warnings?: string[];
  notes?: string[];
};

const COMPARISON_FIELDS: { field: keyof FcmValues; label: string; ratio?: boolean }[] = [
  { field: 'adjustedNetCapital', label: 'Adjusted net capital' },
  { field: 'netCapitalRequirement', label: 'Net capital requirement' },
  { field: 'excessNetCapital', label: 'Excess net capital' },
  { field: 'capitalCoverage', label: 'Capital coverage', ratio: true },
  { field: 'customerSegregationRequired', label: 'Customer segregation requirement' },
  { field: 'customerAssetsInSegregation', label: 'Customer assets in segregation' },
  { field: 'customerSegregationExcess', label: 'Customer segregation excess' },
  { field: 'targetResidualInterest', label: 'Target residual interest in segregation' },
  { field: 'part30Required', label: 'Foreign futures customer funds requirement (Section 30.7)' },
  { field: 'part30Assets', label: 'Funds in separate Section 30.7 accounts' },
  { field: 'part30Excess', label: 'Section 30.7 account excess / deficiency' },
  { field: 'clearedSwapsRequired', label: 'Cleared swaps customer funds requirement' },
  { field: 'clearedSwapsAssets', label: 'Funds in separate cleared swaps accounts' },
  { field: 'clearedSwapsExcess', label: 'Cleared swaps account excess / deficiency' },
  { field: 'retailForexObligation', label: 'Retail foreign exchange obligation' },
];

function reportLabel(date: string | null | undefined) {
  if (!date) return 'Unavailable';
  return new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function hasFcmPayload(value: unknown): value is FcmResponse {
  if (!value || typeof value !== 'object') return false;
  const body = value as Partial<FcmResponse>;
  return body.schema_version === 'edgar.cftc-fcm.v1' && body.units === 'USD' && Array.isArray(body.firms)
    && body.firms.every(firm => typeof firm?.id === 'string' && typeof firm?.legalName === 'string')
    && typeof body.reportDate === 'string' && typeof body.source?.indexUrl === 'string'
    && Array.isArray(body.source?.reports) && typeof body.source?.definitionsUrl === 'string'
    && typeof body.retrievedAt === 'string';
}

export default function FcmCapitalPanel({ initialEntity = '' }: { initialEntity?: string }) {
  const [data, setData] = useState<FcmResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [entity, setEntity] = useState(initialEntity);
  const [filter, setFilter] = useState('');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [sort, setSort] = useState('name');
  const [exported, setExported] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    fetch('/api/v1/cftc/fcm', { signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'The monthly CFTC capital report is unavailable.');
        if (!hasFcmPayload(body)) throw new Error('The capital report could not be verified. Please retry.');
        return body;
      })
      .then(body => { if (!controller.signal.aborted) setData(body); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message === 'Failed to fetch' ? 'The CFTC capital service could not be reached. Please retry.' : cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    function restore() { setEntity(new URLSearchParams(window.location.search).get('entity') || ''); setExported(''); }
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  const firms = useMemo(() => filterFcmFirms(data?.firms || []), [data]);
  const active: FcmFirm | undefined = entity ? firms.find((firm: FcmFirm) => firm.id === entity) : firms[0];
  const screened: FcmFirm[] = useMemo(() => filterFcmFirms(firms, filter, reviewOnly, sort), [firms, filter, reviewOnly, sort]);
  const signals = active ? fcmSignals(active) : [];
  const reviewCount = firms.filter((firm: FcmFirm) => fcmSignals(firm).length > 0).length;

  function selectEntity(id: string) {
    setEntity(id); setExported('');
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'fcm');
    if (id) url.searchParams.set('entity', id); else url.searchParams.delete('entity');
    if (url.href !== window.location.href) window.history.pushState({}, '', url);
  }

  function exportRows(rows: FcmFirm[], name: string) {
    if (!data) return;
    downloadRiskFile(`cftc-fcm-${name}-${data.reportDate}.csv`, fcmComparisonCsv(rows, data), 'text/csv');
    setExported(name);
  }

  return <section className={s.fcmWorkspace} aria-labelledby="fcm-heading">
    <div className={s.fcmHero}>
      <div><div className={s.eyebrow}><Building2 size={15} /> Monthly CFTC financial data</div><h2 id="fcm-heading">Follow the capital cushion.</h2><p>Review a futures broker’s reported capital, customer fund requirements, and changes from the previous month.</p></div>
      <span className={s.fcmSourceBadge}><Database size={15} /> Official CFTC reports · USD</span>
    </div>
    {loading && !data && <div className={s.loading} role="status"><Loader2 className={s.spin} size={24} /><h3>Loading futures broker capital</h3><p>Reading the latest available CFTC report and matching prior legal entity names.</p></div>}
    {error && <div className={s.notice} role="alert"><CircleAlert size={18} /><div><strong>Capital report unavailable</strong><p>{error}</p><button className={s.button} disabled={loading} onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} /> Retry report</button></div></div>}
    {data && <>
      <div className={s.fcmReportBar}>
        <span><strong>Report</strong> {reportLabel(data.reportDate)}</span>
        <span><strong>Compared with</strong> {reportLabel(data.previousReportDate)}</span>
        <span>{firms.length} legal entities</span>
        <button className={s.textButton} disabled={loading} onClick={() => setRetry(value => value + 1)}><RefreshCw size={13} className={loading ? s.spin : undefined} /> {loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {(data.freshness?.stale || error) && <div className={s.notice} role="status"><CircleAlert size={17} /><p>Showing the last available capital report. {data.freshness?.sourceAgeDays != null ? `Its reporting period ended ${data.freshness.sourceAgeDays} days before the latest check. ` : ''}Monthly reports are published with a delay; check the source for newer information.</p></div>}
      {data.warnings?.map(warning => <div className={s.notice} key={warning} role="status"><CircleAlert size={16} /><p>{warning}</p></div>)}
      {!firms.length ? <div className={s.empty}><Building2 size={26} /><h3>No legal entities in this report</h3><p>There are no verified capital records available for this report date.</p><button className={s.button} onClick={() => setRetry(value => value + 1)}>Retry report</button></div> : <>
        <div className={s.fcmSelection}>
          <label htmlFor="fcm-entity">CFTC reporting entity — exact legal name<select id="fcm-entity" value={active?.id || entity} onChange={event => selectEntity(event.target.value)}>
            {entity && !active && <option value={entity}>Requested entity unavailable</option>}
            {firms.map((firm: FcmFirm) => <option key={firm.id} value={firm.id}>{firm.legalName}</option>)}
          </select></label>
          <p>Select the entity named in the CFTC report. Capital belongs to that entity and is separate from a listed parent’s consolidated SEC financials.</p>
        </div>
        {!active ? <div className={s.empty} role="status"><CircleAlert size={26} /><h3>The requested legal entity is not in this report</h3><p>Select an available entity above. The requested link has not been silently replaced with another firm.</p></div> : <>
          <div className={s.fcmEntityHeading}><div><h3>{active.legalName}</h3><p>{active.registration && `Registration: ${active.registration} · `}{active.dsro && `Designated self-regulatory organization: ${active.dsro} · `}Period ended {active.reportDate}</p></div><div className={s.actions}>{active.sourceUrl && <a className={s.button} href={active.sourceUrl} target="_blank" rel="noreferrer">Official report <ArrowUpRight size={14} /></a>}<button className={s.button} onClick={() => exportRows([active], 'selected-firm')}>{exported === 'selected-firm' ? <Check size={14} /> : <ArrowDownToLine size={14} />} Export firm CSV</button></div></div>
          {active.validationNotes?.map(note => <div className={s.notice} key={note} role="status"><CircleAlert size={16} /><p>{note} Monthly comparison is unavailable for this record.</p></div>)}
          <div className={s.scorecards}>
            {[
              { label: 'Adjusted net capital', value: fcmMoney(active.adjustedNetCapital, true), change: active.changes?.adjustedNetCapital, hint: 'Capital after regulatory adjustments' },
              { label: 'Capital requirement', value: fcmMoney(active.netCapitalRequirement, true), change: active.changes?.netCapitalRequirement, hint: 'Reported minimum net capital' },
              { label: 'Excess net capital', value: fcmMoney(active.excessNetCapital, true), change: active.changes?.excessNetCapital, hint: 'Reported cushion above the requirement' },
              { label: 'Capital coverage', value: fcmRatio(active.capitalCoverage), change: active.changes?.capitalCoverage, ratio: true, hint: 'Adjusted net capital ÷ requirement' },
            ].map(metric => <div className={`${s.scorecard} ${s.fcmStat}`} key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><span className={s.fcmStatChange}>{fcmChange(metric.change, metric.ratio)}{metric.change != null && ' vs prior month'}</span><small>{metric.hint}</small></div>)}
          </div>
          <div className={s.fcmSignals} aria-labelledby="fcm-review-title">
            <div><div className={s.eyebrow}><ShieldCheck size={14} /> Review observations</div><h3 id="fcm-review-title">{signals.length ? `${signals.length} ${signals.length === 1 ? 'item' : 'items'} to investigate` : 'Read the capital and customer fund context'}</h3><p>These screens guide research. They do not measure a firm’s probability of default.</p></div>
            <div>{signals.length ? signals.map(signal => <div key={signal.id} className={s.fcmSignal} data-level={signal.level}><CircleAlert size={17} /><div><strong>{signal.title}</strong><p>{signal.detail}</p></div></div>) : <p className={s.muted}>No available field crossed these review thresholds. Assess reporting gaps, business activity, and events after the report date before reaching a conclusion.</p>}
              {!active.previous && <p className={s.note}>No comparable prior record is available. Monthly changes require the same legal name, consecutive reporting months, and reconciled capital figures; a missing match can reflect a name change or reporting coverage.</p>}
              {!!active.unavailableFields?.length && <p className={s.note}>{active.unavailableFields.length} published fields are unavailable for this entity. Inspect the detailed table and official source; blanks are not treated as zero.</p>}
            </div>
          </div>
          <section className={s.fcmDetail} aria-labelledby="fcm-comparison-title">
            <div className={s.detailHeader}><div><h3 id="fcm-comparison-title">What moved between reports?</h3><p>Separate changes in reported capital from changes in its requirement. All monetary values below are USD.</p></div></div>
            <div className={s.tableWrap} tabIndex={0} role="region" aria-label="Selected legal entity monthly capital comparison">
              <table><caption>{active.legalName} · Full reported amounts; missing inputs remain unavailable.</caption><thead><tr><th scope="col">Financial measure</th><th scope="col">{reportLabel(active.reportDate)}</th><th scope="col">{active.previous ? reportLabel(active.previous.reportDate) : 'Prior report unavailable'}</th><th scope="col">Change</th></tr></thead><tbody>{COMPARISON_FIELDS.map(({ field, label, ratio }) => {
                const current = active[field]; const prior = active.previous?.[field];
                const change = typeof current === 'number' && typeof prior === 'number' ? current - prior : null;
                return <tr key={field}><th scope="row">{label}</th><td>{ratio ? fcmRatio(current) : fcmMoney(current)}</td><td>{ratio ? fcmRatio(prior) : fcmMoney(prior)}</td><td>{change == null ? 'Unavailable' : ratio ? `${change > 0 ? '+' : ''}${change.toFixed(2)}×` : `${change > 0 ? '+' : ''}${fcmMoney(change)}`}</td></tr>;
              })}</tbody></table>
            </div>
            <p className={s.note}>Domestic futures segregation, foreign futures Section 30.7 accounts, and cleared swaps accounts are assessed separately. Each category’s reported excess or deficiency is shown independently, without offsetting a shortfall against another account’s surplus. Customer funds are separate from the firm’s own regulatory capital. Retail foreign exchange obligations show business context; this report alone does not establish matching asset coverage.</p>
          </section>
        </>}
        <section className={s.fcmDetail} aria-labelledby="fcm-peer-title">
          <div className={s.detailHeader}><div><div className={s.eyebrow}>Across reported entities</div><h3 id="fcm-peer-title">Find firms for your review</h3><p>{reviewCount} of {firms.length} entities have an observation under the capital or customer fund screens.</p></div><button className={s.button} disabled={!screened.length} onClick={() => exportRows(screened, 'peer-screen')}>{exported === 'peer-screen' ? <Check size={14} /> : <ArrowDownToLine size={14} />} Export {screened.length} firms</button></div>
          <div className={s.fcmFilters}>
            <label className={s.filterSearch}><Search size={16} /><input aria-label="Filter futures brokers by legal name" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter by legal name…" /></label>
            <label>Sort by<select aria-label="Sort futures brokers" value={sort} onChange={event => setSort(event.target.value)}><option value="name">Legal name</option><option value="coverage">Lowest capital coverage</option><option value="decline">Largest cushion decline (%)</option></select></label>
            <label className={s.checkLabel}><input type="checkbox" checked={reviewOnly} onChange={event => setReviewOnly(event.target.checked)} /> Review observations only</label>
          </div>
          <div className={`${s.tableWrap} ${s.fcmPeerTable}`} tabIndex={0} role="region" aria-label="Futures broker capital peer screen"><table><caption>Current report {data.reportDate} · {screened.length} matching entities. Select a name to inspect its reported figures.</caption><thead><tr><th scope="col">Legal entity</th><th scope="col">Capital coverage</th><th scope="col">Excess capital</th><th scope="col">Cushion change</th><th scope="col">Review observations</th></tr></thead><tbody>{screened.map(firm => <tr key={firm.id} data-selected={firm.id === active?.id || undefined}><th scope="row"><button className={s.textButton} onClick={() => { selectEntity(firm.id); document.getElementById('fcm-entity')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>{firm.legalName}<ArrowRight size={13} /></button>{firm.reportDate !== data.reportDate && <small className={s.muted}>As of {firm.reportDate}</small>}</th><td>{fcmRatio(firm.capitalCoverage)}</td><td>{fcmMoney(firm.excessNetCapital, true)}</td><td>{fcmChange(firm.changes?.excessNetCapital)}<small>{firm.changes?.excessNetCapitalPct != null ? `${firm.changes.excessNetCapitalPct > 0 ? '+' : ''}${firm.changes.excessNetCapitalPct.toFixed(1)}%` : ''}</small></td><td>{fcmSignals(firm).map(signal => <span className={s.badge} data-level={signal.level} key={signal.id}>{signal.title}</span>)}{!fcmSignals(firm).length && <span className={s.muted}>None in available fields</span>}</td></tr>)}</tbody></table></div>
          {!screened.length && <div className={s.emptySmall}><p>No legal entities match these filters.</p><button className={s.textButton} onClick={() => { setFilter(''); setReviewOnly(false); }}>Clear filters</button></div>}
        </section>
      </>}
      <details className={s.fcmMethodology}><summary>Sources, dates & calculation details</summary><div>
        <p><strong>Source:</strong> CFTC Financial Data for Futures Commission Merchants. The report includes futures commission merchants (FCM), retail foreign exchange dealers (RFED), and firms with both registrations. This monthly dataset is separate from weekly Commitments of Traders positioning.</p>
        <p><strong>Capital coverage:</strong> adjusted net capital divided by the reported net capital requirement. Coverage is unavailable when the requirement is missing or zero. Monthly changes use the previous available monthly report and an exact published legal name match; no parent or subsidiary match is inferred.</p>
        <p><strong>Review thresholds:</strong> negative excess capital, a decrease in excess capital, capital coverage from 1.00× to below 1.25×, or a negative reported excess in domestic futures, Section 30.7 foreign futures, or cleared swaps customer accounts. A capital cushion decrease of 10% or more receives additional emphasis. The 1.25× and 10% thresholds are site conventions, not CFTC regulatory thresholds.</p>
        <p><strong>Comparability:</strong> registration types, customer business, and capital requirements differ across firms. Capital coverage and dollar cushions must be assessed together. Posted figures are not revised for subsequently received amendments.</p>
        <p><strong>Timing:</strong> report {data.reportDate}; prior report {data.previousReportDate || 'unavailable'}; retrieved {data.retrievedAt?.slice(0, 19).replace('T', ' ')} UTC. Latest check: {data.freshness?.checkedAt?.slice(0, 19).replace('T', ' ') || 'unavailable'} UTC. Report age at latest check: {data.freshness?.sourceAgeDays ?? 'unavailable'} days. Cache state: {data.freshness?.cacheStatus || 'unavailable'}.</p>
        {data.notes?.map(note => <p key={note}>{note}</p>)}
        <div className={s.sourceLinks}><a href={data.source.indexUrl} target="_blank" rel="noreferrer">CFTC report archive <ArrowUpRight size={13} /></a><a href={data.source.definitionsUrl} target="_blank" rel="noreferrer">CFTC field definitions <ArrowUpRight size={13} /></a>{data.source.reports.map(report => <a key={report.reportDate} href={report.url} target="_blank" rel="noreferrer">Official report: {report.reportDate} <ArrowUpRight size={13} /></a>)}<a href="/api/v1/cftc/fcm" target="_blank" rel="noreferrer">View source data <ArrowUpRight size={13} /></a></div>
      </div></details>
    </>}
  </section>;
}
