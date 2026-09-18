'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, CircleAlert, Loader2 } from 'lucide-react';
import s from './CompanyOwnership.module.css';

type Predecessor = { name: string; cik: string; effectiveDate: string; sourceUrl: string };

type OwnershipRow = {
  id: string;
  kind: 'fund' | 'manager';
  name: string;
  ticker?: string;
  cik: string;
  seriesId?: string;
  reportDate: string;
  filingDate: string;
  checkedAt: string;
  stale: boolean;
  valueUsd: number | null;
  shares: number | null;
  weightPct: number | null;
  denominatorUsd: number | null;
  denominatorLabel: 'fund net assets' | 'reported 13F holdings';
  sourceUrl: string;
  researchUrl: string;
  predecessor?: Predecessor;
  positions: { cusip: string; name: string; classTitle: string; shares: number | null; valueUsd: number | null }[];
};

type Ownership = {
  schemaVersion: 'edgar.company-ownership.v1';
  ticker: string;
  companyName: string | null;
  asOf: string | null;
  checkedAt: string | null;
  identity: { status: 'reported-match' | 'unavailable'; cusips: string[]; note: string; predecessor?: Predecessor };
  funds: OwnershipRow[];
  managers: OwnershipRow[];
  coverage: {
    fundsChecked: number;
    fundsAvailable: number;
    managersChecked: number;
    managersAvailable: number;
    notPrepared: { kind: 'fund' | 'manager'; id: string; name: string; url: string }[];
    excludedAfterCutoff: number;
  };
  limitations: string[];
};

type RequestState = { key: string; data: Ownership | null; loading: boolean; error: string };
type Metric = 'weightPct' | 'valueUsd';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const exactDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const sharesFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function dateLabel(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return 'Not reported';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Not reported';
}

function finiteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function validPredecessor(value: unknown): value is Predecessor | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const predecessor = value as Predecessor;
  return typeof predecessor.name === 'string' && predecessor.name.trim().length > 0
    && typeof predecessor.cik === 'string' && /^\d{1,10}$/.test(predecessor.cik)
    && typeof predecessor.effectiveDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(predecessor.effectiveDate)
    && dateLabel(predecessor.effectiveDate) !== 'Not reported'
    && typeof predecessor.sourceUrl === 'string' && !!linkUrl(predecessor.sourceUrl);
}

function validPayload(value: unknown): value is Ownership {
  if (!value || typeof value !== 'object') return false;
  const body = value as Ownership;
  return body.schemaVersion === 'edgar.company-ownership.v1' && typeof body.ticker === 'string'
    && (typeof body.asOf === 'string' || body.asOf === null) && (typeof body.checkedAt === 'string' || body.checkedAt === null)
    && !!body.identity && ['reported-match', 'unavailable'].includes(body.identity.status)
    && Array.isArray(body.identity.cusips) && typeof body.identity.note === 'string'
    && validPredecessor(body.identity.predecessor)
    && Array.isArray(body.funds) && Array.isArray(body.managers) && !!body.coverage
    && ['fundsChecked', 'fundsAvailable', 'managersChecked', 'managersAvailable', 'excludedAfterCutoff'].every(key => Number.isFinite(body.coverage[key as keyof Ownership['coverage']]))
    && Array.isArray(body.coverage.notPrepared) && body.coverage.notPrepared.every(row => !!row && typeof row.id === 'string' && typeof row.name === 'string' && typeof row.url === 'string')
    && Array.isArray(body.limitations) && body.limitations.every(note => typeof note === 'string')
    && [...body.funds, ...body.managers].every(row => !!row && typeof row.id === 'string' && typeof row.name === 'string'
      && typeof row.reportDate === 'string' && typeof row.filingDate === 'string' && typeof row.checkedAt === 'string'
      && typeof row.sourceUrl === 'string' && typeof row.researchUrl === 'string' && typeof row.denominatorLabel === 'string'
      && validPredecessor(row.predecessor)
      && finiteOrNull(row.valueUsd) && finiteOrNull(row.weightPct) && finiteOrNull(row.shares) && finiteOrNull(row.denominatorUsd)
      && Array.isArray(row.positions) && row.positions.every(position => !!position && typeof position.cusip === 'string'
        && typeof position.name === 'string' && typeof position.classTitle === 'string' && finiteOrNull(position.shares) && finiteOrNull(position.valueUsd)));
}

function linkUrl(value: string) {
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; }
}

function metricLabel(row: OwnershipRow, metric: Metric) {
  const value = row[metric];
  if (value === null) return 'Not reported';
  if (metric === 'valueUsd') return dollars.format(value);
  return value > 0 && value < 0.01 ? '<0.01%' : `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

export default function CompanyOwnership({ ticker, asOf = '' }: { ticker: string; asOf?: string }) {
  const normalizedTicker = ticker.trim().toUpperCase();
  const requestKey = `${normalizedTicker}:${asOf}`;
  const [request, setRequest] = useState<RequestState>({ key: '', data: null, loading: true, error: '' });
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<'funds' | 'managers'>('funds');
  const [metric, setMetric] = useState<Metric>('weightPct');
  const [showAll, setShowAll] = useState(false);
  const [expandedId, setExpandedId] = useState('');
  const [preparation, setPreparation] = useState<{ key: string; id: string; kind: string; loading: boolean; error: string } | null>(null);
  const preparationController = useRef<AbortController | null>(null);
  const instanceId = useId();
  const data = request.key === requestKey ? request.data : null;
  const loading = request.key !== requestKey || request.loading;
  const error = request.key === requestKey ? request.error : '';
  const activePreparation = preparation?.key === requestKey ? preparation : null;

  useEffect(() => {
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(60_000);
    const signal = AbortSignal.any([controller.signal, deadline]);
    setRequest({ key: requestKey, data: null, loading: true, error: '' });
    setExpandedId('');
    setShowAll(false);
    const params = new URLSearchParams({ ticker: normalizedTicker });
    if (asOf) params.set('asOf', asOf);
    fetch(`/api/company-ownership?${params}`, { signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'The ownership reports could not be loaded.');
        if (!validPayload(body)) throw new Error('The ownership response could not be verified. Please retry.');
        if (body.ticker.toUpperCase() !== normalizedTicker || (body.asOf || '') !== asOf) throw new Error('The returned reports do not match this company and filing cutoff. Please retry.');
        return body;
      })
      .then(body => { if (!controller.signal.aborted) setRequest({ key: requestKey, data: body, loading: false, error: '' }); })
      .catch(cause => {
        if (controller.signal.aborted) return;
        const message = deadline.aborted ? 'The ownership review took too long. Please retry.' : cause instanceof Error && cause.message !== 'Failed to fetch' ? cause.message : 'The ownership service could not be reached. Please retry.';
        setRequest({ key: requestKey, data: null, loading: false, error: message });
      });
    return () => {
      controller.abort();
      preparationController.current?.abort();
      preparationController.current = null;
    };
  }, [normalizedTicker, asOf, requestKey, retry]);

  const rows = useMemo(() => [...(data?.[view] || [])].sort((a, b) => {
    if (a[metric] === null) return b[metric] === null ? a.name.localeCompare(b.name) : 1;
    if (b[metric] === null) return -1;
    return b[metric] - a[metric] || a.name.localeCompare(b.name);
  }), [data, view, metric]);
  const visibleRows = showAll ? rows : rows.slice(0, 5);
  const visiblePredecessor = visibleRows.find(row => row.predecessor)?.predecessor;
  const predecessor = visiblePredecessor ? data?.identity.predecessor || visiblePredecessor : undefined;
  const maximum = Math.max(0, ...rows.map(row => row[metric] || 0));
  const fundView = view === 'funds';
  const denominator = fundView ? 'fund net assets' : 'reported 13F holdings';

  function changeView(nextView: 'funds' | 'managers') {
    setView(nextView); setShowAll(false); setExpandedId('');
  }

  async function prepareReport(row: Ownership['coverage']['notPrepared'][number]) {
    if (preparationController.current) return;
    const controller = new AbortController();
    preparationController.current = controller;
    const deadline = AbortSignal.timeout(120_000);
    const signal = AbortSignal.any([controller.signal, deadline]);
    setPreparation({ key: requestKey, id: row.id, kind: row.kind, loading: true, error: '' });
    try {
      const response = await fetch('/api/company-ownership', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ ticker: normalizedTicker, ...(asOf ? { asOf } : {}), kind: row.kind, id: row.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'This report could not be prepared. Please retry.');
      if (!validPayload(body) || body.ticker.toUpperCase() !== normalizedTicker || (body.asOf || '') !== asOf) throw new Error('The prepared report could not be verified for this company and cutoff. Please retry.');
      if (controller.signal.aborted) return;
      setRequest({ key: requestKey, data: body, loading: false, error: '' });
      setPreparation({ key: requestKey, id: row.id, kind: row.kind, loading: false, error: '' });
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message = deadline.aborted ? 'Report preparation took too long. Please retry.' : cause instanceof Error && cause.message !== 'Failed to fetch' ? cause.message : 'The report service could not be reached. Please retry.';
      setPreparation({ key: requestKey, id: row.id, kind: row.kind, loading: false, error: message });
    } finally {
      if (preparationController.current === controller) preparationController.current = null;
    }
  }

  return <section className={s.root} aria-label={`${normalizedTicker} reported ownership`}>
    <header className={s.heading}>
      <div><h3>Reported holders of {normalizedTicker}</h3><p>Position size and portfolio weight, directly from SEC disclosures.</p></div>
      {data?.checkedAt && <span className={s.checked}>Source checks from {dateLabel(data.checkedAt)}</span>}
    </header>

    {loading && <div className={s.state} role="status"><Loader2 className={s.spin} size={22} /><div><strong>Checking reported holders</strong><p>Matching {normalizedTicker} to available fund and manager reports.</p></div></div>}
    {error && <div className={s.state} role="alert"><CircleAlert size={22} /><div><strong>Ownership reports are unavailable</strong><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry reports</button></div></div>}

    {data && <>
      <div className={s.toolbar}>
        <div className={s.views} role="group" aria-label="Holder type">
          <button type="button" aria-pressed={fundView} onClick={() => changeView('funds')}>Investment funds <span>{data.funds.length}</span></button>
          <button type="button" aria-pressed={!fundView} onClick={() => changeView('managers')}>Investment managers <span>{data.managers.length}</span></button>
        </div>
        <div className={s.metrics} role="group" aria-label="Sort and compare holders by">
          <button type="button" aria-pressed={metric === 'weightPct'} onClick={() => setMetric('weightPct')}>Portfolio weight</button>
          <button type="button" aria-pressed={metric === 'valueUsd'} onClick={() => setMetric('valueUsd')}>Position value</button>
        </div>
      </div>

      <p className={s.context}>{fundView ? <><strong>Individual SEC fund series · N-PORT.</strong> Weight is the position’s share of the whole fund series’ net assets.</> : <><strong>Manager portfolios · 13F.</strong> These are manager reports, not individual funds. Weight is the position’s share of reported 13F holdings.</>} Neither weight measures the percentage of {normalizedTicker} owned.</p>
      {asOf && <p className={s.cutoff}>Filings through {dateLabel(asOf)}. Saved reports filed after this cutoff are excluded.</p>}
      {predecessor && <aside className={s.predecessorNotice} aria-label="Historical predecessor holdings"><strong>Predecessor holdings · {predecessor.name}</strong><p>Reports dated before {dateLabel(predecessor.effectiveDate)} describe the predecessor company. A one-for-one share exchange established continuity; these are historical positions. <a href={linkUrl(predecessor.sourceUrl)} target="_blank" rel="noreferrer">SEC source <ArrowUpRight size={15} /></a></p></aside>}

      {rows.length > 0 ? <>
        <div className={s.listHeading}><span>{showAll ? rows.length : Math.min(5, rows.length)} of {rows.length} matching {fundView ? 'funds' : 'managers'}</span><span>Largest {metric === 'weightPct' ? 'portfolio weights' : 'positions'} first</span></div>
        <ol className={s.rows}>
          {visibleRows.map((row, index) => {
            const detailId = `${instanceId}-holder-${index}`;
            const expanded = expandedId === `${view}:${row.id}`;
            const sourceUrl = linkUrl(row.sourceUrl);
            const researchUrl = linkUrl(row.researchUrl);
            const value = row[metric];
            const width = value !== null && maximum > 0 ? Math.max(0, Math.min(100, value / maximum * 100)) : 0;
            return <li key={row.id} className={s.row}>
              <div className={s.rowMain}>
                <button type="button" className={s.holderButton} aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpandedId(expanded ? '' : `${view}:${row.id}`)}>
                  <span className={s.rank}>{index + 1}</span><span><strong>{row.name}</strong><span className={s.holderMeta}>{row.ticker || (fundView ? 'Fund series' : 'Investment manager')}{row.stale && <span className={s.stale}>Saved report</span>}</span></span><ChevronDown size={17} className={expanded ? s.chevronOpen : ''} />
                </button>
                <div className={s.measure}>
                  <strong title={metric === 'valueUsd' && row.valueUsd !== null ? exactDollars.format(row.valueUsd) : undefined}>{metricLabel(row, metric)}</strong>
                  <span>{metric === 'weightPct' ? 'portfolio weight' : 'reported value'}</span>
                  <div className={s.barTrack} aria-hidden="true"><span style={{ width: `${width}%` }} /></div>
                  <span className={s.secondary}>{metricLabel(row, metric === 'weightPct' ? 'valueUsd' : 'weightPct')} {metric === 'weightPct' ? 'position' : 'portfolio weight'}</span>
                </div>
                <div className={s.source}><span>Held {dateLabel(row.reportDate)}{row.predecessor && <span className={s.predecessorLabel}>Predecessor shares</span>}</span>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">SEC filing <ArrowUpRight size={15} /></a> : <span>Source unavailable</span>}</div>
              </div>
              <div id={detailId} className={s.rowDetail} hidden={!expanded}>
                <dl><div><dt>Filed</dt><dd>{dateLabel(row.filingDate)}</dd></div><div><dt>Shares reported</dt><dd>{row.shares === null ? 'Not reported' : sharesFormat.format(row.shares)}</dd></div><div><dt>{row.denominatorLabel}</dt><dd>{row.denominatorUsd === null ? 'Not reported' : exactDollars.format(row.denominatorUsd)}</dd></div></dl>
                {row.predecessor && <p className={s.predecessorEvidence}><strong>Historical issuer:</strong> {row.predecessor.name} · CIK {row.predecessor.cik}. These positions report predecessor shares.</p>}
                <div className={s.positions}><strong>Matched securities</strong>{row.positions.map((position, positionIndex) => <p key={`${position.cusip}:${positionIndex}`}>{position.name}{position.classTitle ? ` · ${position.classTitle}` : ''}<span>CUSIP {position.cusip}{position.valueUsd !== null ? ` · ${exactDollars.format(position.valueUsd)}` : ''}</span></p>)}</div>
                <div className={s.detailFooter}><span>CIK {row.cik}{row.seriesId ? ` · Series ${row.seriesId}` : ''} · Checked {dateLabel(row.checkedAt)}</span>{researchUrl && <a href={researchUrl}>Open {fundView ? 'fund' : 'manager'} research <ArrowUpRight size={15} /></a>}</div>
              </div>
            </li>;
          })}
        </ol>
        <div className={s.listFooter}><p>Bars compare the displayed measure across matching reports. Reports can cover different dates.</p>{rows.length > 5 && <button type="button" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? 'Show top 5' : `Show all ${rows.length}`}</button>}</div>
      </> : <div className={s.empty}><strong>{data.identity.status === 'unavailable' ? 'The company security match is not available yet' : `No matching ${fundView ? 'fund' : 'manager'} positions in available reports`}</strong><p>{data.identity.status === 'unavailable' ? data.identity.note : `This does not establish that no ${fundView ? 'funds' : 'managers'} hold ${normalizedTicker}. Only the prepared reports below were searched.`}</p>{fundView && data.managers.length > 0 && <button type="button" onClick={() => changeView('managers')}>View {data.managers.length} matching managers</button>}{!fundView && data.funds.length > 0 && <button type="button" onClick={() => changeView('funds')}>View {data.funds.length} matching funds</button>}</div>}

      <details className={s.coverage}>
        <summary><span>Sources & coverage <span>{data.coverage.fundsAvailable} fund reports · {data.coverage.managersAvailable} manager reports available</span></span><ChevronDown size={17} /></summary>
        <div className={s.coverageBody}>
          <p><strong>A bounded sample of prepared reports.</strong> This is not a complete beneficial ownership register. Fund and manager holdings can overlap and should not be added together.</p>
          <dl className={s.coverageStats}><div><dt>Fund reports</dt><dd>{data.coverage.fundsAvailable} available / {data.coverage.fundsChecked} checked</dd></div><div><dt>Manager reports</dt><dd>{data.coverage.managersAvailable} available / {data.coverage.managersChecked} checked</dd></div><div><dt>Filing cutoff</dt><dd>{asOf ? dateLabel(asOf) : 'Latest prepared reports'}</dd></div></dl>
          {asOf && <p>{data.coverage.excludedAfterCutoff} reports excluded after the filing cutoff. A prepared sample may omit earlier holdings.</p>}
          <p>{data.identity.note}{data.identity.cusips.length > 0 && <> Matched CUSIPs: {data.identity.cusips.join(', ')}.</>}</p>
          <p>Current view uses {denominator} as its denominator. Holdings may be reported with a delay; the holding date and filing date are different.</p>
          {data.limitations.length > 0 && <ul>{data.limitations.map((note, index) => <li key={index}>{note}</li>)}</ul>}
          {data.coverage.notPrepared.length > 0 && <div className={s.unprepared}><strong>Reports not prepared ({data.coverage.notPrepared.length})</strong><p>Prepare one report to check for this company’s holdings.</p><ul>{data.coverage.notPrepared.map(row => {
            const preparing = activePreparation?.id === row.id && activePreparation.kind === row.kind && activePreparation.loading;
            return <li key={`${row.kind}:${row.id}`}><span>{linkUrl(row.url) ? <a href={linkUrl(row.url)}>{row.name} <ArrowUpRight size={15} /></a> : row.name}<span className={s.reportKind}>{row.kind === 'fund' ? 'Fund · N-PORT' : 'Manager · 13F'}</span></span><button type="button" disabled={activePreparation?.loading} onClick={() => void prepareReport(row)} aria-label={`Prepare ${row.name} report`}>{preparing ? <><Loader2 size={15} className={s.spin} /> Preparing…</> : 'Prepare'}</button></li>;
          })}</ul></div>}
          {activePreparation?.loading && <p className={s.preparationStatus} role="status">Preparing the selected report. This can take up to two minutes.</p>}
          {activePreparation?.error && <p className={s.preparationError} role="alert">{activePreparation.error}</p>}
          {activePreparation && !activePreparation.loading && !activePreparation.error && <p className={s.preparationStatus} role="status">Report preparation finished. The holdings and coverage above reflect the latest available reports.</p>}
        </div>
      </details>
      <p className={s.boundary}>Reported holdings from a prepared sample, not the full shareholder register. Fund and manager portfolios may overlap.</p>
    </>}
  </section>;
}
