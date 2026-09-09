'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  Loader2,
  Play,
  Sigma,
} from 'lucide-react';
import { downloadText } from '../../utils/download.js';
import type { Basis, Company } from './marketTypes';
import s from './market.module.css';

export type FactorWindow = '1y' | '3y' | '5y';
export type FactorSector = 'auto' | 'XLF' | 'XLRE' | 'XHB' | 'XLE' | 'XLY' | 'XLK' | 'XLI' | 'XLV' | 'XLU';

type FactorViewPatch = {
  factorTicker?: string;
  factorWindow?: FactorWindow;
  factorSector?: FactorSector;
};

type ModelEstimate = {
  observations?: number | null;
  beta?: number | null;
  beta_standard_error?: number | null;
  beta_confidence_interval95?: [number, number] | null;
  beta_t_statistic?: number | null;
  intercept_daily?: number | null;
  intercept_annualized?: number | null;
  r_squared?: number | null;
  adjusted_r_squared?: number | null;
  correlation?: number | null;
  residual_volatility_annualized?: number | null;
  asset_volatility_annualized?: number | null;
  benchmark_volatility_annualized?: number | null;
  hac_lag?: number | null;
  durbin_watson?: number | null;
  influential_dates?: { date?: string | null; distance?: number | null }[];
};

type FilingPoint = {
  end?: string | null;
  filed?: string | null;
  accepted_at?: string | null;
  form?: string | null;
  accession?: string | null;
  source?: string | null;
  metrics?: Record<string, number | null>;
};

type FilingComponent = {
  key?: string;
  label?: string;
  unit?: string;
  weight?: number | null;
  available?: boolean;
  current?: number | null;
  prior?: number | null;
  change?: number | null;
  z?: number | null;
  raw_z?: number | null;
  clipped?: boolean;
  weighted_z?: number | null;
  peer_percentile?: number | null;
  peer_count?: number | null;
  peer_distribution?: {
    median?: number | null;
    mad?: number | null;
    scale?: number | null;
    scale_method?: string | null;
  } | null;
  reason?: string | null;
};

type PriceDescriptor = {
  ticker?: string | null;
  provider?: string | null;
  cache_status?: string | null;
  price_basis?: string | null;
  adjustment_coverage?: number | null;
  retrieved_at?: string | null;
  first_observation?: string | null;
  last_observation?: string | null;
  observations?: number | null;
};

type MarketSignalsResponse = {
  schema_version: string;
  methodology_version?: string;
  universe_version?: string;
  snapshot_id?: string;
  status?: 'ready' | 'partial' | 'withheld' | 'stale' | string;
  cache_status?: string;
  generated_at?: string | null;
  data_through?: string | null;
  request?: {
    ticker?: string;
    window?: FactorWindow;
    basis?: Basis;
    cohort?: string;
    sector_proxy?: string;
    market_benchmark?: string;
    frequency?: string;
  };
  issuer?: { ticker?: string; name?: string; cik?: string; sic?: string; cohorts?: string[] };
  sample?: {
    requested_start?: string | null;
    effective_start?: string | null;
    effective_end?: string | null;
    observations?: number | null;
    eligible_benchmark_intervals?: number | null;
    overlap_coverage?: number | null;
    excluded?: Record<string, number | null>;
  } | null;
  estimates?: {
    market_model?: ModelEstimate | null;
    conditional_beta?: {
      upside?: ModelEstimate | null;
      downside?: ModelEstimate | null;
      asymmetry?: number | null;
      observations?: { upside?: number; downside?: number; zero?: number };
    } | null;
    independent_sector_sensitivity?: {
      observations?: number | null;
      market_beta?: number | null;
      independent_sector_beta?: number | null;
      r_squared?: number | null;
      residual_volatility_annualized?: number | null;
    } | null;
    rolling_beta?: {
      window?: number | null;
      points?: { date?: string | null; beta?: number | null }[];
      current?: number | null;
      median?: number | null;
      minimum?: number | null;
      maximum?: number | null;
      range?: number | null;
    } | null;
  } | null;
  edgar_snapshot?: {
    available?: boolean;
    filing_change_z?: number | null;
    direction?: { id?: string | null; label?: string | null; interpretation?: string | null } | string | null;
    cohort_id?: string | null;
    peer_count?: number | null;
    coverage?: {
      eligible_peer_issuers?: number | null;
      minimum_peers_per_component?: number | null;
      available_components?: number | null;
      required_components?: number | null;
      peer_filing_clock?: {
        focus?: string | null;
        earliest_peer?: string | null;
        latest_peer?: string | null;
        observed_peers?: number | null;
        missing_peers?: number | null;
        peers_after_focus?: number | null;
      } | null;
    } | null;
    components?: FilingComponent[];
    reason?: string | null;
  } | null;
  filing_event?: {
    event_date?: string | null;
    event_start?: string | null;
    timing_quality?: string | null;
    estimation?: { start?: string | null; end?: string | null; observations?: number | null; gap_sessions?: number | null };
    windows?: Record<string, {
      sessions?: number | null;
      through?: string | null;
      cumulative_abnormal_return?: number | null;
      standardized_response?: number | null;
    } | null>;
  } | null;
  evidence_gap?: {
    available?: boolean;
    evidence_gap?: number | null;
    inputs?: { filing_change_z?: number | null; price_response_z?: number | null } | null;
    classification?: { id?: string | null; label?: string | null; interpretation?: string | null } | string | null;
    neutral_band?: number | null;
    gap_interpretation?: string | null;
    reason?: string | null;
    formula?: string | null;
    claim_limits?: string[];
  } | null;
  quality?: {
    grade?: string | null;
    headline_eligible?: boolean;
    evidence_gap_eligible?: boolean;
    observations?: number | null;
    peer_count?: number | null;
    filing_components?: number | null;
    filing_event_complete?: boolean;
    sec_snapshot_status?: string | null;
  };
  interpretation?: string | null;
  provenance?: {
    sec?: {
      source?: string | null;
      snapshot_generated_at?: string | null;
      reporting_basis?: Basis;
      current_filing?: FilingPoint | null;
      prior_filing?: FilingPoint | null;
    };
    prices?: {
      asset?: PriceDescriptor;
      market?: PriceDescriptor;
      sector_proxy?: PriceDescriptor;
    };
  };
  equations?: { id?: string; expression?: string; inference?: string }[];
  warnings?: { code?: string; severity?: string; message?: string }[];
  limitations?: string[];
  links?: {
    methodology?: string;
    api?: string;
    schema?: string;
    company_analysis?: string;
    sec_companyfacts?: string;
  };
  cite_as?: string;
};

type SignalErrorPayload = {
  error?: string;
  code?: string;
  retryable?: boolean;
};

type FactorError = {
  message: string;
  code?: string;
  retryable?: boolean;
  status?: number;
  retryAt?: number;
};

type AnalysisRequest = {
  ticker: string;
  window: FactorWindow;
  sector: FactorSector;
  basis: Basis;
  cohort: string;
  sequence: number;
};

type RollingPoint = { date: string; beta: number };

const SECTOR_OPTIONS: { value: FactorSector; label: string }[] = [
  { value: 'auto', label: 'Auto · cohort-matched' },
  { value: 'XLF', label: 'XLF · Financials' },
  { value: 'XLRE', label: 'XLRE · Real estate' },
  { value: 'XHB', label: 'XHB · Homebuilders' },
  { value: 'XLE', label: 'XLE · Energy' },
  { value: 'XLY', label: 'XLY · Consumer discretionary' },
  { value: 'XLK', label: 'XLK · Technology' },
  { value: 'XLI', label: 'XLI · Industrials' },
  { value: 'XLV', label: 'XLV · Health care' },
  { value: 'XLU', label: 'XLU · Utilities' },
];

const WINDOW_OPTIONS: { value: FactorWindow; label: string }[] = [
  { value: '1y', label: '1 year' },
  { value: '3y', label: '3 years' },
  { value: '5y', label: '5 years' },
];

const SECTOR_VALUES = new Set<FactorSector>(SECTOR_OPTIONS.map((option) => option.value));
const normalizeSector = (value: string): FactorSector => SECTOR_VALUES.has(value as FactorSector) ? value as FactorSector : 'auto';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const betaText = (value: unknown) => finite(value) ? value.toFixed(2) : '—';
const zText = (value: unknown) => finite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}` : '—';
const percentText = (value: unknown, digits = 1) => finite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
const coverageText = (value: unknown) => finite(value) ? `${(value * 100).toFixed(1)}%` : '—';
const plainDate = (value: unknown) => typeof value === 'string' && value ? value.slice(0, 10) : '—';
const words = (value: unknown) => typeof value === 'string' && value
  ? value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
  : '—';
const labelText = (value: unknown) => {
  if (typeof value === 'string') return words(value);
  if (value && typeof value === 'object') {
    const candidate = value as { label?: unknown; id?: unknown };
    if (typeof candidate.label === 'string' && candidate.label) return candidate.label;
    if (typeof candidate.id === 'string' && candidate.id) return words(candidate.id);
  }
  return '—';
};

const filingLevelText = (value: unknown) => finite(value) ? `${value.toFixed(1)}%` : '—';
const filingChangeText = (value: unknown) => finite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(1)} pp` : '—';

function safeFileTicker(value: string | undefined) {
  return (value || 'company').replace(/[^A-Z0-9.-]/gi, '-').toUpperCase();
}

function retryAtFromHeader(value: string | null, now: number) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : null;
}

function retryDelayText(seconds: number) {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function signalMarkdown(data: MarketSignalsResponse) {
  const market = data.estimates?.market_model;
  const conditional = data.estimates?.conditional_beta;
  const sector = data.estimates?.independent_sector_sensitivity;
  const event20 = data.filing_event?.windows?.['20'];
  const gap = data.evidence_gap;
  const filing = data.edgar_snapshot;
  const current = data.provenance?.sec?.current_filing;
  const prior = data.provenance?.sec?.prior_filing;
  const componentLines = (filing?.components || []).map((component) => (
    `- ${component.label || words(component.key)}: weight ${percentText(component.weight)}, z ${zText(component.z)}, weighted contribution ${zText(component.weighted_z)}`
  ));
  return [
    `# EDGAR Factor Lab — ${data.issuer?.ticker || data.request?.ticker || 'Company'}`,
    '',
    data.interpretation || 'No interpretation is available.',
    '',
    `- Status: ${data.status || 'unknown'}; quality grade: ${data.quality?.grade || '—'}`,
    `- Sample: ${data.sample?.observations ?? '—'} exactly aligned daily returns, ${plainDate(data.sample?.effective_start)} to ${plainDate(data.sample?.effective_end)}`,
    `- Market beta vs ${data.request?.market_benchmark || 'SPY'}: ${betaText(market?.beta)}`,
    `- 95% Newey–West HAC interval: ${market?.beta_confidence_interval95 ? `${betaText(market.beta_confidence_interval95[0])} to ${betaText(market.beta_confidence_interval95[1])}` : '—'}`,
    `- Upside / downside beta: ${betaText(conditional?.upside?.beta)} / ${betaText(conditional?.downside?.beta)}`,
    `- Independent ${data.request?.sector_proxy || 'sector'} sensitivity: ${betaText(sector?.independent_sector_beta)}`,
    `- R² / annualized residual volatility: ${percentText(market?.r_squared)} / ${percentText(market?.residual_volatility_annualized)}`,
    `- Filing change z / 20-session price-response z: ${zText(filing?.filing_change_z)} / ${zText(event20?.standardized_response)}`,
    `- EDGAR Evidence Gap: ${gap?.available ? zText(gap.evidence_gap) : `withheld (${gap?.reason || 'insufficient inputs'})`}`,
    `- Classification: ${gap?.available ? labelText(gap.classification) : 'Unavailable'}`,
    `- Current filing: ${current?.form || '—'}, period ${plainDate(current?.end)}, filed ${plainDate(current?.filed)}, accession ${current?.accession || '—'}`,
    `- Prior filing: ${prior?.form || '—'}, period ${plainDate(prior?.end)}, filed ${plainDate(prior?.filed)}, accession ${prior?.accession || '—'}`,
    `- Peer filing clocks: ${plainDate(filing?.coverage?.peer_filing_clock?.earliest_peer)} to ${plainDate(filing?.coverage?.peer_filing_clock?.latest_peer)}; ${filing?.coverage?.peer_filing_clock?.peers_after_focus ?? '—'} after the focus filing`,
    `- Price data through: ${plainDate(data.data_through)}; SEC snapshot: ${plainDate(data.provenance?.sec?.snapshot_generated_at)}`,
    '',
    '## Filing-score components',
    '',
    ...(componentLines.length ? componentLines : ['- Unavailable']),
    '',
    '## Guardrails',
    '',
    ...(data.limitations || []).map((item) => `- ${item}`),
    ...(data.warnings || []).map((item) => `- ${item.code || 'WARNING'}: ${item.message || 'Unspecified warning.'}`),
    '',
    `Methodology: ${data.links?.methodology || 'https://secedgarterminal.com/market/factors'}`,
    `Machine-readable API: ${data.links?.api || '—'}`,
    `Schema: ${data.links?.schema || '—'}`,
    ...(data.cite_as ? [`Cite as: ${data.cite_as}`] : []),
    '',
    'This record contains descriptive diagnostics, not a valuation, forecast, recommendation, or trade signal.',
  ].join('\n');
}

function modelContext(data: MarketSignalsResponse) {
  return [
    'EDGAR Terminal model context. Treat null as unavailable, preserve source clocks, and do not convert these descriptive diagnostics into a forecast or recommendation.',
    ...(data.cite_as ? [`Citation: ${data.cite_as}`] : []),
    '',
    JSON.stringify(data, null, 2),
  ].join('\n');
}

function filingReference(point: FilingPoint | null | undefined, label: string) {
  if (!point) return <p className={s.factorFilingRef}><b>{label}</b><span>Unavailable</span></p>;
  const text = `${point.form || 'Filing'} · period ${plainDate(point.end)} · filed ${plainDate(point.filed)}`;
  return <p className={s.factorFilingRef}>
    <b>{label}</b>
    {point.source
      ? <a href={point.source} target="_blank" rel="noreferrer">{text}<ExternalLink size={12} /></a>
      : <span>{text}</span>}
    <small>Accession {point.accession || 'unavailable'}{point.accepted_at ? ` · accepted ${point.accepted_at.replace('T', ' ').slice(0, 19)} UTC` : ''}</small>
  </p>;
}

function evidenceQuadrant(filingZ: number | null, responseZ: number | null, neutralBand: number) {
  if (!finite(filingZ) || !finite(responseZ)) return 'Unavailable';
  const axis = (value: number) => value >= neutralBand ? 'positive' : value <= -neutralBand ? 'negative' : 'neutral';
  const state = `${axis(filingZ)}:${axis(responseZ)}`;
  const labels: Record<string, string> = {
    'positive:positive': 'Aligned improvement',
    'positive:negative': 'Filing improvement not confirmed by price',
    'negative:positive': 'Price response ahead of reported evidence',
    'negative:negative': 'Aligned deterioration',
    'positive:neutral': 'Positive filing change; muted price response',
    'negative:neutral': 'Negative filing change; muted price response',
    'neutral:positive': 'Positive price response; muted filing change',
    'neutral:negative': 'Negative price response; muted filing change',
    'neutral:neutral': 'Both measures near neutral',
  };
  return labels[state] || 'Unavailable';
}

function buildRollingChart(points: { date?: string | null; beta?: number | null }[] | undefined) {
  const clean: RollingPoint[] = (points || []).flatMap((point) => (
    typeof point.date === 'string' && finite(point.beta) && Number.isFinite(Date.parse(point.date))
      ? [{ date: point.date, beta: point.beta }]
      : []
  ));
  if (!clean.length) return null;
  const width = 720;
  const height = 250;
  const left = 48;
  const right = 16;
  const top = 18;
  const bottom = 38;
  const firstTime = Date.parse(clean[0].date);
  const lastTime = Date.parse(clean.at(-1)!.date);
  const values = clean.map((point) => point.beta);
  const actualMinimum = Math.min(...values);
  const actualMaximum = Math.max(...values);
  let domainMinimum = Math.min(actualMinimum, 1);
  let domainMaximum = Math.max(actualMaximum, 1);
  const padding = Math.max(0.15, (domainMaximum - domainMinimum) * 0.15);
  domainMinimum -= padding;
  domainMaximum += padding;
  const x = (point: RollingPoint, index: number) => left
    + (lastTime === firstTime ? index / Math.max(1, clean.length - 1) : (Date.parse(point.date) - firstTime) / (lastTime - firstTime))
    * (width - left - right);
  const y = (value: number) => top + (domainMaximum - value) / (domainMaximum - domainMinimum) * (height - top - bottom);
  const path = clean.map((point, index) => `${index ? 'L' : 'M'}${x(point, index).toFixed(2)},${y(point.beta).toFixed(2)}`).join(' ');
  return {
    clean, width, height, left, right, top, bottom, actualMinimum, actualMaximum, domainMinimum, domainMaximum, path,
    referenceY: y(1),
    start: clean[0].date,
    end: clean.at(-1)!.date,
  };
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className={s.factorMetric}>
    <dt>{label}</dt>
    <dd>{value}</dd>
    <small>{detail}</small>
  </div>;
}

function PriceProvenance({ label, value }: { label: string; value?: PriceDescriptor }) {
  return <tr>
    <th scope="row">{label}</th>
    <td>{value?.ticker || '—'}</td>
    <td>{words(value?.provider)}</td>
    <td>{words(value?.price_basis)}</td>
    <td>{value?.observations ?? '—'}</td>
    <td>{plainDate(value?.last_observation)}</td>
    <td>{words(value?.cache_status)}</td>
  </tr>;
}

export default function MarketFactorLab({
  companies,
  basis,
  cohortId,
  factorTicker,
  factorWindow,
  factorSector,
  onView,
  onNotice,
}: {
  companies: Company[];
  basis: Basis;
  cohortId: string;
  factorTicker: string;
  factorWindow: FactorWindow;
  factorSector: string;
  onView: (patch: FactorViewPatch) => void;
  onNotice: (message: string) => void;
}) {
  const chartTitleId = useId();
  const chartDescriptionId = useId();
  const mapTitleId = useId();
  const mapDescriptionId = useId();
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const eligibleCompanies = useMemo(() => {
    const rows = cohortId === 'all' ? companies : companies.filter((company) => company.cohorts.includes(cohortId));
    return [...rows].sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [cohortId, companies]);
  const validTicker = eligibleCompanies.some((company) => company.ticker === factorTicker);
  const selectedSector = normalizeSector(factorSector);
  const initialRequest = validTicker ? {
    ticker: factorTicker,
    window: factorWindow,
    sector: selectedSector,
    basis,
    cohort: cohortId === 'all' ? 'auto' : cohortId,
    sequence: 0,
  } satisfies AnalysisRequest : null;
  const [request, setRequest] = useState<AnalysisRequest | null>(initialRequest);
  const [data, setData] = useState<MarketSignalsResponse | null>(null);
  const [loading, setLoading] = useState(Boolean(initialRequest));
  const [error, setError] = useState<FactorError | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 65_000);
    const params = new URLSearchParams({
      ticker: request.ticker,
      window: request.window,
      basis: request.basis,
      cohort: request.cohort,
      sector_proxy: request.sector,
    });
    setLoading(true);
    setError(null);
    setData(null);

    async function load() {
      try {
        const response = await fetch(`/api/v1/market-signals?${params.toString()}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        const responseTime = Date.now();
        const retryAt = retryAtFromHeader(response.headers.get('Retry-After'), responseTime);
        const result = await response.json().catch(() => ({})) as MarketSignalsResponse & SignalErrorPayload;
        if (!response.ok) throw Object.assign(new Error(result.error || 'The factor analysis is temporarily unavailable.'), {
          code: result.code,
          retryable: typeof result.retryable === 'boolean'
            ? result.retryable
            : response.status === 429 || response.status >= 500,
          status: response.status,
          retryAt: response.status === 429 ? retryAt || responseTime + 60_000 : retryAt || undefined,
        });
        if (result.schema_version !== 'edgar.market-signals.v1') throw new Error('The factor response did not match the supported schema.');
        setData(result);
      } catch (caught) {
        if (controller.signal.aborted && !timedOut) return;
        const cause = caught as Error & FactorError;
        setClock(Date.now());
        setError({
          message: timedOut ? 'The calculation exceeded 65 seconds. Retry shortly; a completed result may now be cached.' : cause.message,
          code: cause.code,
          retryable: timedOut ? true : cause.retryable,
          status: cause.status,
          retryAt: cause.retryAt,
        });
      } finally {
        window.clearTimeout(timeout);
        if (!controller.signal.aborted || timedOut) setLoading(false);
      }
    }
    void load();
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [request]);

  useEffect(() => {
    if (data && request && request.sequence > 0) resultHeadingRef.current?.focus();
  }, [data, request]);

  useEffect(() => {
    if (!error?.retryAt || error.retryAt <= Date.now()) return;
    const retryAt = error.retryAt;
    const interval = window.setInterval(() => {
      const currentTime = Date.now();
      setClock(currentTime);
      if (currentTime >= retryAt) window.clearInterval(interval);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [error?.retryAt]);

  const rollingChart = useMemo(() => buildRollingChart(data?.estimates?.rolling_beta?.points), [data?.estimates?.rolling_beta?.points]);
  const currentControlsDiffer = request ? (
    request.ticker !== factorTicker
    || request.window !== factorWindow
    || request.sector !== selectedSector
    || request.basis !== basis
    || request.cohort !== (cohortId === 'all' ? 'auto' : cohortId)
  ) : false;
  const retryWaitSeconds = error?.retryAt ? Math.max(0, Math.ceil((error.retryAt - clock) / 1000)) : 0;
  const unchangedNonRetryableError = Boolean(error?.retryable === false && !currentControlsDiffer);
  const runBlocked = retryWaitSeconds > 0 || unchangedNonRetryableError;

  function runAnalysis() {
    if (!validTicker) {
      onNotice('Choose a covered company before running Factor Lab.');
      return;
    }
    if (retryWaitSeconds > 0) {
      onNotice(`The server asked clients to wait ${retryDelayText(retryWaitSeconds)} before another Factor Lab request.`);
      return;
    }
    if (unchangedNonRetryableError) {
      onNotice('This request cannot be retried unchanged. Adjust a Factor Lab control before running another analysis.');
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    setRequest((current) => ({
      ticker: factorTicker,
      window: factorWindow,
      sector: selectedSector,
      basis,
      cohort: cohortId === 'all' ? 'auto' : cohortId,
      sequence: (current?.sequence || 0) + 1,
    }));
  }

  async function copyContext() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(modelContext(data));
      onNotice('Factor Lab model context copied.');
    } catch {
      onNotice('Clipboard access is unavailable. Download the JSON or Markdown record instead.');
    }
  }

  function exportJson() {
    if (!data) return;
    const ticker = safeFileTicker(data.issuer?.ticker || data.request?.ticker);
    downloadText(`${ticker}-edgar-factor-lab.json`, JSON.stringify(data, null, 2), 'application/json');
    onNotice(`${ticker} Factor Lab JSON exported.`);
  }

  function exportMarkdown() {
    if (!data) return;
    const ticker = safeFileTicker(data.issuer?.ticker || data.request?.ticker);
    downloadText(`${ticker}-edgar-factor-lab.md`, signalMarkdown(data), 'text/markdown');
    onNotice(`${ticker} Factor Lab research note exported.`);
  }

  const marketModel = data?.estimates?.market_model;
  const conditional = data?.estimates?.conditional_beta;
  const independentSector = data?.estimates?.independent_sector_sensitivity;
  const betaInterval = marketModel?.beta_confidence_interval95;
  const filingZ = data?.evidence_gap?.inputs?.filing_change_z ?? data?.edgar_snapshot?.filing_change_z ?? null;
  const event20 = data?.filing_event?.windows?.['20'];
  const responseZ = data?.evidence_gap?.inputs?.price_response_z ?? event20?.standardized_response ?? null;
  const neutralBand = finite(data?.evidence_gap?.neutral_band) && data.evidence_gap.neutral_band > 0
    ? Math.min(3, data.evidence_gap.neutral_band)
    : 0.5;
  const mapQuadrant = evidenceQuadrant(filingZ, responseZ, neutralBand);
  const classification = labelText(data?.evidence_gap?.classification);
  const classificationInterpretation = data?.evidence_gap?.classification
    && typeof data.evidence_gap.classification === 'object'
    ? data.evidence_gap.classification.interpretation
    : null;
  const mapX = finite(filingZ) ? 250 + Math.max(-3, Math.min(3, filingZ)) / 3 * 205 : null;
  const mapY = finite(responseZ) ? 160 - Math.max(-3, Math.min(3, responseZ)) / 3 * 125 : null;
  const neutralLeft = 250 - neutralBand / 3 * 205;
  const neutralRight = 250 + neutralBand / 3 * 205;
  const neutralTop = 160 - neutralBand / 3 * 125;
  const neutralBottom = 160 + neutralBand / 3 * 125;
  const components = data?.edgar_snapshot?.components || [];
  const peerClock = data?.edgar_snapshot?.coverage?.peer_filing_clock;
  const prices = data?.provenance?.prices;
  const autoRunAnnouncement = data && request?.sequence === 0
    ? `Factor analysis ready for ${data.issuer?.ticker || data.request?.ticker || 'the selected company'}. Status ${words(data.status)}; quality ${data.quality?.grade || 'unavailable'}.`
    : '';
  const statusClass = data?.status === 'ready'
    ? s.factorStatusReady
    : data?.status === 'withheld'
      ? s.factorStatusWithheld
      : data?.status === 'stale'
        ? s.factorStatusStale
        : s.factorStatusPartial;

  return <section className={s.factorLab} aria-labelledby="factor-lab-heading">
    <p className={s.srOnly} role="status" aria-live="polite" aria-atomic="true">{autoRunAnnouncement}</p>
    <div className={`${s.panel} ${s.factorIntro}`}>
      <div className={s.factorIntroCopy}>
        <span className={s.eyebrow}><Sigma size={15} />EDGAR Factor Lab</span>
        <h2 id="factor-lab-heading">Where filing evidence meets market behavior</h2>
        <p>Estimate transparent market and sector sensitivities, then compare the latest peer-normalized SEC filing change with the model-adjusted price response. Every result preserves its sample, uncertainty, filing references, source clocks, and machine-readable context.</p>
      </div>
      <div className={s.factorEquationGrid} aria-label="Factor Lab equations">
        <p><b>Market model</b><code>rᵢ = intercept + βₘrSPY + error</code><span>Daily log returns; Newey–West HAC inference.</span></p>
        <p><b>Sector sensitivity</b><code>rᵢ = βₘrSPY + βₛrsector⊥SPY + error</code><span>The sector ETF is residualized against SPY first.</span></p>
        <p><b>Evidence Gap</b><code>clip(filing z) − clip(price-response z)</code><span>A descriptive disagreement measure, not expected return.</span></p>
      </div>
    </div>

    <form className={`${s.panel} ${s.factorControls}`} onSubmit={(event) => { event.preventDefault(); runAnalysis(); }}>
      <div className={s.factorControlGrid}>
        <label>Company
          <select value={validTicker ? factorTicker : ''} onChange={(event) => onView({ factorTicker: event.target.value })}>
            <option value="">Choose a covered company</option>
            {eligibleCompanies.map((company) => <option key={company.ticker} value={company.ticker}>{company.ticker} · {company.name}</option>)}
          </select>
        </label>
        <label>Estimation window
          <select value={factorWindow} onChange={(event) => onView({ factorWindow: event.target.value as FactorWindow })}>
            {WINDOW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>Independent sector proxy
          <select value={selectedSector} onChange={(event) => onView({ factorSector: event.target.value as FactorSector })}>
            {SECTOR_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>Market benchmark
          <input value="SPY · fixed" readOnly aria-label="Market benchmark, fixed at SPY" />
        </label>
      </div>
      <div className={s.factorRunRow}>
        <p><b>{basis === 'ttm' ? 'Latest TTM' : 'Annual'} filing basis</b> · Peer normalization: {cohortId === 'all' ? 'automatic company cohort' : words(cohortId)}. Changing controls does not spend an API request until you run the analysis.</p>
        <button className={s.primary} type="submit" disabled={!validTicker || loading || runBlocked}>
          {loading ? <Loader2 className={s.spin} size={15} /> : <Play size={15} />}
          {loading ? 'Estimating…' : retryWaitSeconds > 0 ? `Wait ${retryDelayText(retryWaitSeconds)}` : data ? 'Run again' : 'Run analysis'}
        </button>
      </div>
      {currentControlsDiffer ? <p className={s.factorPending} role="status">Controls changed. Run the analysis to refresh the displayed estimates.</p> : null}
    </form>

    {!request && !loading && !error ? <div className={`${s.panel} ${s.factorEmpty}`}>
      <Sigma size={28} />
      <div><h2>Choose a company to start</h2><p>The calculation joins adjusted daily prices with the company’s latest comparable SEC filing snapshot. No live SEC request is made by this panel.</p></div>
    </div> : null}

    {loading ? <div className={s.loading} role="status" aria-live="polite">
      <Loader2 className={s.spin} size={25} />
      <div><h2>Estimating the market model</h2><p>Aligning trading intervals, calculating HAC uncertainty, residualizing the sector proxy, and evaluating the latest filing event…</p></div>
    </div> : null}

    {error ? <div className={s.error} role="alert">
      <h2>Factor analysis unavailable</h2>
      <p>{error.message}</p>
      {error.code ? <small>Error code: {error.code}</small> : null}
      {retryWaitSeconds > 0 ? <p className={s.factorRetryGuidance}>The server asked clients to wait {retryDelayText(retryWaitSeconds)} before another request.</p> : null}
      {error.retryable === false ? <p className={s.factorRetryGuidance}>This response is not retryable unchanged. Adjust the company, window, filing basis, cohort, or proxy to make a new request.</p> : null}
      <div className={s.factorErrorActions}>
        {error.retryable !== false ? <button type="button" className={s.button} onClick={runAnalysis} disabled={retryWaitSeconds > 0}>{retryWaitSeconds > 0 ? `Retry in ${retryDelayText(retryWaitSeconds)}` : 'Retry analysis'}</button> : null}
        <a className={s.button} href="/market/factors">Read methodology</a>
      </div>
    </div> : null}

    {data && !loading ? <>
      <div className={`${s.panel} ${s.factorResultHeader}`}>
        <div>
          <span className={s.eyebrow}>Research diagnostic</span>
          <h2 ref={resultHeadingRef} tabIndex={-1}>{data.issuer?.ticker || data.request?.ticker} · {data.issuer?.name || 'Company analysis'}</h2>
          <p>{data.interpretation || 'The deterministic interpretation is unavailable.'}</p>
        </div>
        <div className={s.factorStatusGroup} aria-label="Result status">
          <span className={`${s.factorStatus} ${statusClass}`}>
            {data.status === 'ready' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            {words(data.status)}
          </span>
          <span className={s.factorQuality}>Quality {data.quality?.grade || '—'}</span>
          <small>{data.sample?.observations ?? '—'} matched sessions · through {plainDate(data.data_through)}</small>
        </div>
      </div>

      {data.status === 'withheld' ? <div className={s.warning} role="status">
        <AlertTriangle size={16} />
        <p><b>Headline estimates are withheld.</b> The required adjusted-close provenance or minimum exactly aligned sample was not available. Review the coded warnings below.</p>
      </div> : null}

      <dl className={s.factorMetricGrid}>
        <MetricCard label={`Market β · ${data.request?.market_benchmark || 'SPY'}`} value={betaText(marketModel?.beta)} detail={`${marketModel?.observations ?? data.sample?.observations ?? '—'} daily return observations`} />
        <MetricCard label="95% HAC interval" value={betaInterval ? `${betaText(betaInterval[0])} to ${betaText(betaInterval[1])}` : '—'} detail={`Newey–West Bartlett lag ${marketModel?.hac_lag ?? '—'}`} />
        <MetricCard label="Downside β" value={betaText(conditional?.downside?.beta)} detail={`${conditional?.observations?.downside ?? '—'} SPY down sessions`} />
        <MetricCard label="Upside β" value={betaText(conditional?.upside?.beta)} detail={`${conditional?.observations?.upside ?? '—'} SPY up sessions`} />
        <MetricCard label={`${data.request?.sector_proxy || 'Sector'} sensitivity`} value={betaText(independentSector?.independent_sector_beta)} detail="Sector return orthogonal to SPY" />
        <MetricCard label="Market-model R²" value={percentText(marketModel?.r_squared)} detail={`Return correlation ${betaText(marketModel?.correlation)}`} />
        <MetricCard label="Residual volatility" value={percentText(marketModel?.residual_volatility_annualized)} detail="Annualized unexplained daily-return volatility" />
      </dl>

      <div className={s.factorFeatureGrid}>
        <section className={`${s.panel} ${s.factorGap}`} aria-labelledby="evidence-gap-heading">
          <span className={s.eyebrow}>Custom SEC diagnostic</span>
          <h2 id="evidence-gap-heading">EDGAR Evidence Gap</h2>
          {data.evidence_gap?.available ? <>
            <strong>{zText(data.evidence_gap.evidence_gap)}</strong>
            <p><b>{classification}</b></p>
            <p>{data.evidence_gap.gap_interpretation || classificationInterpretation || data.evidence_gap.formula || 'Clipped filing-change z minus clipped model-adjusted price-response z.'}</p>
          </> : <>
            <strong>Withheld</strong>
            <p>{data.evidence_gap?.reason || 'The required filing and price-response inputs are incomplete.'}</p>
          </>}
          <dl className={s.factorGapInputs}>
            <div><dt>Filing-change z</dt><dd>{zText(filingZ)}</dd></div>
            <div><dt>20-session response z</dt><dd>{zText(responseZ)}</dd></div>
            <div><dt>20-session abnormal return</dt><dd>{percentText(event20?.cumulative_abnormal_return)}</dd></div>
          </dl>
          <p className={s.note}>Positive means filing evidence sits higher relative to peers than the standardized price response sits relative to the event model. Negative means the reverse. Magnitude is disagreement, not mispricing.</p>
        </section>

        <section className={`${s.panel} ${s.factorMap}`} aria-labelledby="filing-market-map-heading">
          <div className={s.factorSectionHeading}>
            <div><span className={s.eyebrow}>Filing–Market map</span><h2 id="filing-market-map-heading">One point, two independently scaled observations</h2></div>
            <span className={s.factorMapLabel}>{classification !== '—' ? classification : mapQuadrant}</span>
          </div>
          {mapX != null && mapY != null ? <figure className={s.factorMapFigure}>
            <svg viewBox="0 0 500 320" role="img" aria-labelledby={`${mapTitleId} ${mapDescriptionId}`} className={s.factorMapSvg}>
              <title id={mapTitleId}>{data.issuer?.ticker} Filing–Market coordinate</title>
              <desc id={mapDescriptionId}>Filing-change z is {filingZ?.toFixed(2)} on the horizontal axis and 20-session model-adjusted price-response z is {responseZ?.toFixed(2)} on the vertical axis. Absolute z values below {neutralBand.toFixed(2)} are neutral on each axis. Classification: {classification !== '—' ? classification : mapQuadrant}.</desc>
              <rect x="45" y="35" width="410" height="250" className={s.factorMapField} />
              <rect x={neutralLeft} y="35" width={neutralRight - neutralLeft} height="250" className={s.factorMapNeutralBand} />
              <rect x="45" y={neutralTop} width="410" height={neutralBottom - neutralTop} className={s.factorMapNeutralBand} />
              <line x1={neutralLeft} y1="35" x2={neutralLeft} y2="285" className={s.factorMapNeutralBoundary} />
              <line x1={neutralRight} y1="35" x2={neutralRight} y2="285" className={s.factorMapNeutralBoundary} />
              <line x1="45" y1={neutralTop} x2="455" y2={neutralTop} className={s.factorMapNeutralBoundary} />
              <line x1="45" y1={neutralBottom} x2="455" y2={neutralBottom} className={s.factorMapNeutralBoundary} />
              <line x1="250" y1="35" x2="250" y2="285" className={s.factorMapAxis} />
              <line x1="45" y1="160" x2="455" y2="160" className={s.factorMapAxis} />
              <text x="55" y="53" className={s.factorMapQuadrant}>Positive price / negative filing</text>
              <text x="445" y="53" textAnchor="end" className={s.factorMapQuadrant}>Both positive</text>
              <text x="55" y="276" className={s.factorMapQuadrant}>Both negative</text>
              <text x="445" y="276" textAnchor="end" className={s.factorMapQuadrant}>Positive filing / negative price</text>
              <text x="255" y="153" className={s.factorMapNeutralLabel}>neutral</text>
              <circle cx={mapX} cy={mapY} r="9" className={s.factorMapPoint} />
              <circle cx={mapX} cy={mapY} r="15" className={s.factorMapPointRing} />
              <text x={mapX + (mapX > 375 ? -14 : 14)} y={mapY - 13} textAnchor={mapX > 375 ? 'end' : 'start'} className={s.factorMapTicker}>{data.issuer?.ticker}</text>
              <text x="250" y="308" textAnchor="middle" className={s.factorMapAxisLabel}>Peer-normalized filing change z →</text>
              <text x="15" y="160" textAnchor="middle" transform="rotate(-90 15 160)" className={s.factorMapAxisLabel}>Model-adjusted response z →</text>
            </svg>
            <figcaption>Coordinates are clipped to ±3 only for display. Shaded, dashed strips mark the neutral band; the exact values are below.</figcaption>
            <p className={s.factorMapLegend}><b>Classification rule:</b> positive ≥ +{neutralBand.toFixed(2)}; neutral when |z| &lt; {neutralBand.toFixed(2)}; negative ≤ −{neutralBand.toFixed(2)}.</p>
          </figure> : <div className={s.factorMapUnavailable}>The map requires both a peer-normalized filing score and a complete 20-session filing-event estimate.</div>}
          <div className={s.tableScroll}>
            <table className={s.comparison}>
              <caption className={s.srOnly}>Exact Filing–Market map coordinates</caption>
              <thead><tr><th scope="col">Coordinate</th><th scope="col">Exact value</th><th scope="col">Reference</th></tr></thead>
              <tbody>
                <tr><th scope="row">Filing change</th><td>{zText(filingZ)}</td><td>{data.edgar_snapshot?.coverage?.eligible_peer_issuers ?? data.quality?.peer_count ?? '—'} eligible peers</td></tr>
                <tr><th scope="row">Price response</th><td>{zText(responseZ)}</td><td>{event20?.sessions ?? 20} sessions through {plainDate(event20?.through)}</td></tr>
                <tr><th scope="row">Classification</th><td colSpan={2}>{classification !== '—' ? classification : mapQuadrant}</td></tr>
                <tr><th scope="row">Neutral band</th><td colSpan={2}>|z| &lt; {neutralBand.toFixed(2)} on each axis</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className={`${s.panel} ${s.factorRolling}`} aria-labelledby="rolling-beta-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>Stability diagnostic</span><h2 id="rolling-beta-heading">Rolling {data.estimates?.rolling_beta?.window || 126}-session market beta</h2></div>
          <div className={s.factorRollingSummary}><span>Current <b>{betaText(data.estimates?.rolling_beta?.current)}</b></span><span>Median <b>{betaText(data.estimates?.rolling_beta?.median)}</b></span><span>Range <b>{betaText(data.estimates?.rolling_beta?.range)}</b></span></div>
        </div>
        {rollingChart ? <>
          <figure className={s.factorChartFigure}>
            <svg viewBox={`0 0 ${rollingChart.width} ${rollingChart.height}`} role="img" aria-labelledby={`${chartTitleId} ${chartDescriptionId}`} className={s.factorChartSvg}>
              <title id={chartTitleId}>{data.issuer?.ticker} rolling market beta</title>
              <desc id={chartDescriptionId}>Rolling beta from {rollingChart.start} to {rollingChart.end}. Observed minimum {rollingChart.actualMinimum.toFixed(2)}, observed maximum {rollingChart.actualMaximum.toFixed(2)}, and current {betaText(data.estimates?.rolling_beta?.current)}. Exact observations follow in a table.</desc>
              <line x1={rollingChart.left} y1={rollingChart.top} x2={rollingChart.left} y2={rollingChart.height - rollingChart.bottom} className={s.factorChartAxis} />
              <line x1={rollingChart.left} y1={rollingChart.height - rollingChart.bottom} x2={rollingChart.width - rollingChart.right} y2={rollingChart.height - rollingChart.bottom} className={s.factorChartAxis} />
              <line x1={rollingChart.left} y1={rollingChart.referenceY} x2={rollingChart.width - rollingChart.right} y2={rollingChart.referenceY} className={s.factorChartReference} />
              <text x={rollingChart.left - 8} y={rollingChart.referenceY + 4} textAnchor="end" className={s.factorChartLabel}>1.00</text>
              <text x={rollingChart.left} y={rollingChart.height - 12} className={s.factorChartLabel}>{plainDate(rollingChart.start)}</text>
              <text x={rollingChart.width - rollingChart.right} y={rollingChart.height - 12} textAnchor="end" className={s.factorChartLabel}>{plainDate(rollingChart.end)}</text>
              <path d={rollingChart.path} className={s.factorChartLine} />
            </svg>
            <figcaption>Windows advance in five-session steps; the latest endpoint is included. The dashed reference is β = 1.</figcaption>
          </figure>
          <details className={`${s.details} ${s.factorDetails}`}>
            <summary>Exact rolling-beta observations · {rollingChart.clean.length}</summary>
            <div className={s.tableScroll}><table className={s.comparison}>
              <caption className={s.srOnly}>Exact rolling market beta observations</caption>
              <thead><tr><th scope="col">Window end</th><th scope="col">Market beta</th></tr></thead>
              <tbody>{rollingChart.clean.map((point) => <tr key={point.date}><td>{point.date}</td><td>{point.beta.toFixed(4)}</td></tr>)}</tbody>
            </table></div>
          </details>
        </> : <p className={s.factorUnavailable}>A rolling series is unavailable for this sample.</p>}
      </section>

      <section className={`${s.panel} ${s.factorFiling}`} aria-labelledby="filing-score-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>SEC filing change</span><h2 id="filing-score-heading">Peer-robust filing components</h2></div>
          <div className={s.factorFilingScore}><span>Composite z</span><strong>{zText(data.edgar_snapshot?.filing_change_z)}</strong><small>{labelText(data.edgar_snapshot?.direction)}</small></div>
        </div>
        <p className={s.factorSectionCopy}>Each available component compares the issuer with other companies in the selected research cohort. The target issuer is excluded from its own peer distribution; median and MAD-based scaling reduce outlier influence. Composite z is the sum of the displayed weighted z contributions. Peer reports form a calculation-time cross-section rather than a cross-section frozen at the focus event.</p>
        {peerClock ? <p className={s.note}>Peer filing clocks: {plainDate(peerClock.earliest_peer)} to {plainDate(peerClock.latest_peer)} · {peerClock.observed_peers ?? '—'} observed · {peerClock.peers_after_focus ?? '—'} became public after the focus filing.</p> : null}
        <div className={s.factorFilingRefs}>
          {filingReference(data.provenance?.sec?.current_filing, 'Current filing')}
          {filingReference(data.provenance?.sec?.prior_filing, 'Prior comparison')}
        </div>
        {components.length ? <div className={s.tableScroll}>
          <table className={s.comparison}>
            <caption className={s.srOnly}>Peer-normalized filing score components and exact inputs</caption>
            <thead><tr><th scope="col">Component</th><th scope="col">Current (%)</th><th scope="col">Prior (%)</th><th scope="col">Input change (pp)</th><th scope="col">Peer median (pp)</th><th scope="col">MAD / scale (pp)</th><th scope="col">Peer percentile</th><th scope="col">Weight</th><th scope="col">z</th><th scope="col">Weighted z</th></tr></thead>
            <tbody>{components.map((component) => <tr key={component.key || component.label}>
              <th scope="row">{component.label || words(component.key)}{component.reason ? <small>{component.reason}</small> : null}</th>
              <td>{filingLevelText(component.current)}</td>
              <td>{filingLevelText(component.prior)}</td>
              <td>{filingChangeText(component.change)}</td>
              <td>{filingChangeText(component.peer_distribution?.median)}</td>
              <td>{filingChangeText(component.peer_distribution?.mad)} / {filingChangeText(component.peer_distribution?.scale)}<small>{words(component.peer_distribution?.scale_method)}</small></td>
              <td>{finite(component.peer_percentile) ? `${component.peer_percentile.toFixed(1)}%` : '—'}<small>{component.peer_count ?? '—'} peers</small></td>
              <td>{percentText(component.weight)}</td>
              <td>{zText(component.z)}{component.clipped ? <small>Clipped; raw {zText(component.raw_z)}</small> : null}</td>
              <td>{zText(component.weighted_z)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className={s.factorUnavailable}>{data.edgar_snapshot?.reason || 'Comparable filing components are unavailable.'}</p>}
      </section>

      <section className={`${s.panel} ${s.factorAudit}`} aria-labelledby="factor-audit-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>Audit & reuse</span><h2 id="factor-audit-heading">Researcher and model handoff</h2></div>
          <div className={s.actions}>
            <button type="button" className={s.primary} onClick={copyContext}><Clipboard size={14} />Copy model context</button>
            <button type="button" className={s.button} onClick={exportJson}><Download size={14} />JSON</button>
            <button type="button" className={s.button} onClick={exportMarkdown}><Download size={14} />Markdown</button>
          </div>
        </div>
        <p className={s.factorSectionCopy}>The exports contain derived statistics, exact definitions, source clocks, quality fields, warnings, and nulls for unavailable values. They do not include bulk vendor price history.</p>
        <div className={s.tableScroll}><table className={s.comparison}>
          <caption className={s.srOnly}>Price-series provenance</caption>
          <thead><tr><th scope="col">Role</th><th scope="col">Ticker</th><th scope="col">Provider</th><th scope="col">Price basis</th><th scope="col">Prices</th><th scope="col">Through</th><th scope="col">Cache</th></tr></thead>
          <tbody>
            <PriceProvenance label="Company" value={prices?.asset} />
            <PriceProvenance label="Market" value={prices?.market} />
            <PriceProvenance label="Sector proxy" value={prices?.sector_proxy} />
          </tbody>
        </table></div>
        <dl className={s.factorClocks}>
          <div><dt>SEC snapshot</dt><dd>{data.provenance?.sec?.snapshot_generated_at?.replace('T', ' ').slice(0, 19) || '—'} UTC</dd></div>
          <div><dt>Price through</dt><dd>{plainDate(data.data_through)}</dd></div>
          <div><dt>Result generated</dt><dd>{data.generated_at?.replace('T', ' ').slice(0, 19) || '—'} UTC</dd></div>
          <div><dt>Overlap coverage</dt><dd>{coverageText(data.sample?.overlap_coverage)}</dd></div>
          <div><dt>Schema</dt><dd>{data.schema_version}</dd></div>
          <div><dt>Method</dt><dd>{data.methodology_version || '—'}</dd></div>
        </dl>
        <div className={s.factorAuditLinks}>
          <a href={data.links?.methodology || '/market/factors'}>Methodology <ExternalLink size={12} /></a>
          {data.links?.api ? <a href={data.links.api}>API result <ExternalLink size={12} /></a> : null}
          {data.links?.schema ? <a href={data.links.schema}>JSON Schema <ExternalLink size={12} /></a> : null}
          {data.links?.sec_companyfacts ? <a href={data.links.sec_companyfacts} target="_blank" rel="noreferrer">SEC Company Facts <ExternalLink size={12} /></a> : null}
        </div>
        {data.cite_as ? <p className={s.factorCitation}><b>Cite as:</b> {data.cite_as}</p> : null}
      </section>

      <details className={`${s.panel} ${s.details} ${s.factorCaveats}`} open={Boolean(data.warnings?.length)}>
        <summary>Warnings, limitations, and econometric diagnostics</summary>
        {data.warnings?.length ? <div className={s.factorWarningList}>{data.warnings.map((warning) => <p key={`${warning.code}-${warning.message}`}><AlertTriangle size={14} /><span><b>{warning.code || 'WARNING'}</b> · {warning.message || 'Unspecified warning.'}</span></p>)}</div> : <p className={s.factorNoWarnings}><CheckCircle2 size={14} />No coded warnings were returned for this result.</p>}
        <div className={s.factorCaveatGrid}>
          <div><h3>Interpretation limits</h3><ul>{(data.limitations || []).map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div><h3>Additional diagnostics</h3><dl>
            <div><dt>Regression intercept</dt><dd>{percentText(marketModel?.intercept_annualized)}</dd></div>
            <div><dt>β standard error</dt><dd>{betaText(marketModel?.beta_standard_error)}</dd></div>
            <div><dt>β t-statistic</dt><dd>{betaText(marketModel?.beta_t_statistic)}</dd></div>
            <div><dt>Adjusted R²</dt><dd>{percentText(marketModel?.adjusted_r_squared)}</dd></div>
            <div><dt>Durbin–Watson</dt><dd>{betaText(marketModel?.durbin_watson)}</dd></div>
            <div><dt>Downside − upside β</dt><dd>{zText(conditional?.asymmetry)}</dd></div>
          </dl></div>
        </div>
        <p className={s.note}>The intercept is a market-model intercept, not Jensen alpha: this model does not subtract a risk-free return. Only pre-open timestamped filings use that session&apos;s return; intraday, post-close, non-trading-day, and date-only events begin with the next benchmark session. An event horizon is withheld if any expected company, SPY, or sector interval is missing.</p>
      </details>
    </> : null}
  </section>;
}
