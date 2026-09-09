'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  Pin,
  Play,
  Sigma,
  X,
} from 'lucide-react';
import { downloadText } from '../../utils/download.js';
import {
  factorComparisonCsv,
  factorComparisonSnapshot,
  factorContextText,
  factorFileStem,
  parseFactorComparisons,
  factorTidyCsv,
} from '../../utils/marketFactorExports.js';
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
  fingerprints?: {
    algorithm?: string;
    canonicalization?: string;
    input_scope?: string;
    result_scope?: string;
    input_sha256?: string;
    result_sha256?: string;
    sec_sha256?: string;
    prices?: Record<string, string>;
  };
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
      first_quartile?: number | null;
      third_quartile?: number | null;
      interquartile_range?: number | null;
      minimum?: number | null;
      maximum?: number | null;
      range?: number | null;
      current_minus_median?: number | null;
      current_percentile?: number | null;
    } | null;
    beta_term_structure?: {
      window?: FactorWindow;
      requested_start?: string | null;
      available?: boolean;
      reason?: string | null;
      effective_start?: string | null;
      effective_end?: string | null;
      observations?: number | null;
      overlap_coverage?: number | null;
      beta?: number | null;
      beta_confidence_interval95?: [number, number] | null;
      r_squared?: number | null;
      residual_volatility_annualized?: number | null;
    }[];
    influence_sensitivity?: {
      available?: boolean;
      method?: string;
      threshold?: number | null;
      reason?: string | null;
      observations?: number | null;
      excluded_dates?: { date?: string | null; distance?: number | null }[];
      beta?: number | null;
      beta_delta?: number | null;
      r_squared?: number | null;
    } | null;
    residual_tail?: {
      probability?: number | null;
      lower_quantile?: number | null;
      expected_shortfall?: number | null;
      tail_observations?: number | null;
      worst?: { date?: string | null; abnormal_return?: number | null } | null;
      best?: { date?: string | null; abnormal_return?: number | null } | null;
      interpretation?: string | null;
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
    driver_summary?: {
      available?: boolean;
      ranked?: { key?: string; label?: string; weighted_z?: number | null; z?: number | null; weight?: number | null }[];
      strongest_positive?: { label?: string; weighted_z?: number | null } | null;
      strongest_negative?: { label?: string; weighted_z?: number | null } | null;
      contribution_sum?: number | null;
    } | null;
    reason?: string | null;
  } | null;
  filing_event?: {
    event_date?: string | null;
    acceptance_timestamp?: string | null;
    event_start?: string | null;
    event_interval_end?: string | null;
    timing_quality?: string | null;
    estimation?: { start?: string | null; end?: string | null; observations?: number | null; gap_sessions?: number | null; inference?: string | null; hac_lag?: number | null };
    windows?: Record<string, {
      sessions?: number | null;
      through?: string | null;
      cumulative_abnormal_return?: number | null;
      standardized_response?: number | null;
    } | null>;
    path?: {
      session?: number | null;
      date?: string | null;
      daily_abnormal_return?: number | null;
      cumulative_abnormal_return?: number | null;
      standardized_response?: number | null;
    }[];
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
    gates?: { id?: string; label?: string; status?: 'pass' | 'warn' | 'fail' | string; value?: string; requirement?: string }[];
  };
  research_readout?: {
    observations?: { id?: string; level?: string; finding?: string; rule?: string }[];
    questions?: string[];
    claim_boundary?: string;
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

type FactorComparison = ReturnType<typeof factorComparisonSnapshot>;

const RESULT_CACHE_TTL_MS = 10 * 60_000;
const RESULT_CACHE_LIMIT = 12;
const resultCache = new Map<string, { data: MarketSignalsResponse; storedAt: number }>();
const pendingRequests = new Map<string, Promise<MarketSignalsResponse>>();
const COMPARISON_STORAGE_KEY = 'edgar:factor-lab-comparisons:v1';

function factorRequestKey(request: Omit<AnalysisRequest, 'sequence'> | AnalysisRequest) {
  return [request.ticker, request.window, request.basis, request.cohort, request.sector].join('|');
}

function factorResponseMatchesRequest(data: MarketSignalsResponse, request: AnalysisRequest) {
  return data.request?.ticker === request.ticker
    && data.request?.window === request.window
    && data.request?.basis === request.basis
    && (request.cohort === 'auto' || data.request?.cohort === request.cohort)
    && (request.sector === 'auto' || data.request?.sector_proxy === request.sector);
}

function cachedFactorResult(key: string) {
  const entry = resultCache.get(key);
  if (!entry || Date.now() - entry.storedAt > RESULT_CACHE_TTL_MS) {
    if (entry) resultCache.delete(key);
    return null;
  }
  resultCache.delete(key);
  resultCache.set(key, entry);
  return entry.data;
}

function rememberFactorResult(key: string, data: MarketSignalsResponse) {
  const degraded = data.cache_status === 'stale'
    || data.status === 'stale'
    || data.warnings?.some((warning) => ['PRICE_BASIS_UNVERIFIED', 'PRICE_REFRESH_FAILED', 'STALE_SIGNAL_RESULT'].includes(warning.code || ''));
  if (degraded) {
    resultCache.delete(key);
    return;
  }
  resultCache.delete(key);
  resultCache.set(key, { data, storedAt: Date.now() });
  while (resultCache.size > RESULT_CACHE_LIMIT) resultCache.delete(resultCache.keys().next().value!);
}

function fetchFactorResult(key: string, url: string) {
  const existing = pendingRequests.get(key);
  if (existing) return existing;
  const task = (async () => {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(65_000),
    });
    const responseTime = Date.now();
    const retryAt = retryAtFromHeader(response.headers.get('Retry-After'), responseTime);
    const result = await response.json().catch(() => ({})) as MarketSignalsResponse & SignalErrorPayload;
    if (!response.ok) throw Object.assign(new Error(result.error || 'The factor analysis is temporarily unavailable.'), {
      code: result.code,
      retryable: typeof result.retryable === 'boolean' ? result.retryable : response.status === 429 || response.status >= 500,
      status: response.status,
      retryAt: response.status === 429 ? retryAt || responseTime + 60_000 : retryAt || undefined,
    });
    if (result.schema_version !== 'edgar.market-signals.v1') throw new Error('The factor response did not match the supported schema.');
    rememberFactorResult(key, result);
    return result;
  })().finally(() => pendingRequests.delete(key));
  pendingRequests.set(key, task);
  return task;
}

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
  const termLines = (data.estimates?.beta_term_structure || []).map((point) => (
    `- ${point.window?.toUpperCase() || 'Horizon'}: ${point.available ? `beta ${betaText(point.beta)}, 95% HAC interval ${point.beta_confidence_interval95 ? `${betaText(point.beta_confidence_interval95[0])} to ${betaText(point.beta_confidence_interval95[1])}` : '—'}, ${point.observations ?? '—'} observations` : `unavailable (${words(point.reason)})`}`
  ));
  const eventLines = ['1', '5', '20'].map((horizon) => {
    const point = data.filing_event?.windows?.[horizon];
    return `- ${horizon} session${horizon === '1' ? '' : 's'}: abnormal return ${percentText(point?.cumulative_abnormal_return)}, response z ${zText(point?.standardized_response)}, through ${plainDate(point?.through)}`;
  });
  return [
    `# EDGAR Factor Lab — ${data.issuer?.ticker || data.request?.ticker || 'Company'}`,
    '',
    data.interpretation || 'No interpretation is available.',
    '',
    `- Status: ${data.status || 'unknown'}; quality grade: ${data.quality?.grade || '—'}`,
    `- Snapshot ID: ${data.snapshot_id || '—'}`,
    `- Input / calculation SHA-256: ${data.fingerprints?.input_sha256 || '—'} / ${data.fingerprints?.result_sha256 || '—'}`,
    `- Sample: ${data.sample?.observations ?? '—'} exactly aligned daily returns, ${plainDate(data.sample?.effective_start)} to ${plainDate(data.sample?.effective_end)}`,
    `- Market beta vs ${data.request?.market_benchmark || 'SPY'}: ${betaText(market?.beta)}`,
    `- 95% Newey–West HAC interval: ${market?.beta_confidence_interval95 ? `${betaText(market.beta_confidence_interval95[0])} to ${betaText(market.beta_confidence_interval95[1])}` : '—'}`,
    `- Upside / downside beta: ${betaText(conditional?.upside?.beta)} / ${betaText(conditional?.downside?.beta)}`,
    `- Independent ${data.request?.sector_proxy || 'sector'} sensitivity: ${betaText(sector?.independent_sector_beta)}`,
    `- R² / annualized residual volatility: ${percentText(market?.r_squared)} / ${percentText(market?.residual_volatility_annualized)}`,
    `- Filing change z / 20-session price-response z: ${zText(filing?.filing_change_z)} / ${zText(event20?.standardized_response)}`,
    `- EDGAR Evidence Gap: ${gap?.available ? zText(gap.evidence_gap) : `withheld (${gap?.reason || 'insufficient inputs'})`}`,
    `- Classification: ${gap?.available ? labelText(gap.classification) : 'Unavailable'}`,
    `- Influence refit beta / change: ${betaText(data.estimates?.influence_sensitivity?.beta)} / ${zText(data.estimates?.influence_sensitivity?.beta_delta)}`,
    `- Residual 5% quantile / mean lower-tail abnormal return: ${percentText(data.estimates?.residual_tail?.lower_quantile)} / ${percentText(data.estimates?.residual_tail?.expected_shortfall)}`,
    `- Current filing: ${current?.form || '—'}, period ${plainDate(current?.end)}, filed ${plainDate(current?.filed)}, accession ${current?.accession || '—'}`,
    `- Current filing source: ${current?.source || '—'}`,
    `- Prior filing: ${prior?.form || '—'}, period ${plainDate(prior?.end)}, filed ${plainDate(prior?.filed)}, accession ${prior?.accession || '—'}`,
    `- Prior filing source: ${prior?.source || '—'}`,
    `- Peer filing clocks: ${plainDate(filing?.coverage?.peer_filing_clock?.earliest_peer)} to ${plainDate(filing?.coverage?.peer_filing_clock?.latest_peer)}; ${filing?.coverage?.peer_filing_clock?.peers_after_focus ?? '—'} after the focus filing`,
    `- Price data through: ${plainDate(data.data_through)}; SEC snapshot: ${plainDate(data.provenance?.sec?.snapshot_generated_at)}`,
    '',
    '## Beta term structure',
    '',
    ...(termLines.length ? termLines : ['- Unavailable']),
    '',
    '## Filing-event windows',
    '',
    ...eventLines,
    '',
    '## Filing-score components',
    '',
    ...(componentLines.length ? componentLines : ['- Unavailable']),
    '',
    '## Research questions',
    '',
    ...(data.research_readout?.questions || []).map((item) => `- ${item}`),
    '',
    '## Quality gates',
    '',
    ...(data.quality?.gates || []).map((gate) => `- ${gate.label || gate.id}: ${gate.status}; ${gate.value}. Requirement: ${gate.requirement}`),
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

function filingReference(point: FilingPoint | null | undefined, label: string) {
  if (!point) return <p className={s.factorFilingRef}><b>{label}</b><span>Unavailable</span></p>;
  const text = `${point.form || 'Filing'} · period ${plainDate(point.end)} · filed ${plainDate(point.filed)}`;
  return <p className={s.factorFilingRef}>
    <b>{label}</b>
    {point.source
      ? <a href={point.source} target="_blank" rel="noreferrer" aria-label={`${label}: ${text}, opens in a new tab`}>{text}<ExternalLink size={12} /></a>
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

function buildEventChart(points: {
  session?: number | null;
  date?: string | null;
  cumulative_abnormal_return?: number | null;
}[] | undefined) {
  const clean = (points || []).flatMap((point) => (
    finite(point.session) && typeof point.date === 'string' && finite(point.cumulative_abnormal_return)
      ? [{ session: point.session, date: point.date, value: point.cumulative_abnormal_return }]
      : []
  ));
  if (!clean.length) return null;
  const width = 720;
  const height = 230;
  const left = 50;
  const right = 18;
  const top = 18;
  const bottom = 38;
  let minimum = Math.min(0, ...clean.map((point) => point.value));
  let maximum = Math.max(0, ...clean.map((point) => point.value));
  const padding = Math.max(0.005, (maximum - minimum) * 0.15);
  minimum -= padding;
  maximum += padding;
  const x = (session: number) => left + (session - 1) / Math.max(1, clean.at(-1)!.session - 1) * (width - left - right);
  const y = (value: number) => top + (maximum - value) / (maximum - minimum) * (height - top - bottom);
  return {
    clean, width, height, left, right, top, bottom, zeroY: y(0),
    path: clean.map((point, index) => `${index ? 'L' : 'M'}${x(point.session).toFixed(2)},${y(point.value).toFixed(2)}`).join(' '),
    start: clean[0],
    end: clean.at(-1)!,
    minimum,
    maximum,
  };
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className={s.factorMetric}>
    <dt>{label}</dt>
    <dd>{value}<small>{detail}</small></dd>
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
  const eventTitleId = useId();
  const eventDescriptionId = useId();
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const handledRequestSequenceRef = useRef(0);
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
  const [data, setData] = useState<MarketSignalsResponse | null>(() => initialRequest ? cachedFactorResult(factorRequestKey(initialRequest)) : null);
  const [loading, setLoading] = useState(() => Boolean(initialRequest && !cachedFactorResult(factorRequestKey(initialRequest))));
  const [error, setError] = useState<FactorError | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [comparison, setComparison] = useState<FactorComparison[]>([]);
  const [rollingRowsSnapshot, setRollingRowsSnapshot] = useState<string | null>(null);
  const [eventRowsSnapshot, setEventRowsSnapshot] = useState<string | null>(null);

  useEffect(() => {
    try {
      setComparison(parseFactorComparisons(sessionStorage.getItem(COMPARISON_STORAGE_KEY) || '[]') as FactorComparison[]);
    } catch { /* Storage can be unavailable; keep the in-memory notebook usable. */ }
  }, []);

  useEffect(() => {
    if (!request) return;
    let active = true;
    const params = new URLSearchParams({
      ticker: request.ticker,
      window: request.window,
      basis: request.basis,
      cohort: request.cohort,
      sector_proxy: request.sector,
    });
    const key = factorRequestKey(request);
    const cached = request.sequence === 0 ? cachedFactorResult(key) : null;
    if (cached) {
      setData(cached);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const result = await fetchFactorResult(key, `/api/v1/market-signals?${params.toString()}`);
        if (active) setData(result);
      } catch (caught) {
        if (!active) return;
        const cause = caught as Error & FactorError;
        setClock(Date.now());
        setError({
          message: cause.name === 'TimeoutError' ? 'The calculation exceeded 65 seconds. Retry shortly; a completed result may now be cached.' : cause.message,
          code: cause.code,
          retryable: cause.name === 'TimeoutError' ? true : cause.retryable,
          status: cause.status,
          retryAt: cause.retryAt,
        });
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [request]);

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
  const eventChart = useMemo(() => buildEventChart(data?.filing_event?.path), [data?.filing_event?.path]);
  const compactContextLength = useMemo(() => data ? factorContextText(data).length : 0, [data]);
  const currentControlsDiffer = request ? (
    request.ticker !== factorTicker
    || request.window !== factorWindow
    || request.sector !== selectedSector
    || request.basis !== basis
    || request.cohort !== (cohortId === 'all' ? 'auto' : cohortId)
  ) : false;
  useEffect(() => {
    if (!request || request.sequence <= handledRequestSequenceRef.current || loading) return;
    if (error || !data || !factorResponseMatchesRequest(data, request)) {
      if (error) handledRequestSequenceRef.current = request.sequence;
      return;
    }
    handledRequestSequenceRef.current = request.sequence;
    if (!currentControlsDiffer) resultHeadingRef.current?.focus();
  }, [currentControlsDiffer, data, error, loading, request]);
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
      await navigator.clipboard.writeText(factorContextText(data));
      onNotice('Compact, versioned Factor Lab model context copied.');
    } catch {
      onNotice('Clipboard access is unavailable. Download the compact context TXT instead.');
    }
  }

  function exportJson() {
    if (!data) return;
    const stem = factorFileStem(data);
    downloadText(`${stem}.json`, JSON.stringify(data, null, 2), 'application/json');
    onNotice(`${safeFileTicker(data.issuer?.ticker || data.request?.ticker)} Factor Lab JSON exported.`);
  }

  function exportMarkdown() {
    if (!data) return;
    const stem = factorFileStem(data);
    downloadText(`${stem}.md`, signalMarkdown(data), 'text/markdown');
    onNotice(`${safeFileTicker(data.issuer?.ticker || data.request?.ticker)} Factor Lab research note exported.`);
  }

  function exportCsv() {
    if (!data) return;
    const stem = factorFileStem(data);
    downloadText(`${stem}.csv`, factorTidyCsv(data), 'text/csv');
    onNotice(`${safeFileTicker(data.issuer?.ticker || data.request?.ticker)} analysis-ready CSV exported.`);
  }

  function exportContext() {
    if (!data) return;
    downloadText(`${factorFileStem(data)}-ai-context.txt`, factorContextText(data), 'text/plain');
    onNotice('Compact Factor Lab AI context downloaded.');
  }

  function persistComparison(next: FactorComparison[], message: string) {
    setComparison(next);
    try { sessionStorage.setItem(COMPARISON_STORAGE_KEY, JSON.stringify(next)); } catch { /* Session comparison remains available in memory. */ }
    onNotice(message);
  }

  function pinAnalysis() {
    if (!data) return;
    const snapshot = factorComparisonSnapshot(data) as FactorComparison;
    const withoutDuplicate = comparison.filter((item) => item.snapshot_id !== snapshot.snapshot_id);
    const next = [snapshot, ...withoutDuplicate].slice(0, 4);
    persistComparison(next, `${snapshot.ticker} result pinned for this session${withoutDuplicate.length >= 4 ? '; oldest pin replaced' : ''}.`);
  }

  function removePinned(snapshotId: string) {
    persistComparison(comparison.filter((item) => item.snapshot_id !== snapshotId), 'Pinned Factor Lab result removed.');
  }

  function exportPinnedComparison() {
    if (!comparison.length) return;
    downloadText(`factor-lab-session-comparison-${new Date().toISOString().slice(0, 10)}.csv`, factorComparisonCsv(comparison), 'text/csv');
    onNotice('Pinned Factor Lab comparison exported.');
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
  const termStructure = data?.estimates?.beta_term_structure || [];
  const influence = data?.estimates?.influence_sensitivity;
  const residualTail = data?.estimates?.residual_tail;
  const driverRows = data?.edgar_snapshot?.driver_summary?.ranked || [];
  const maxDriver = Math.max(0.01, ...driverRows.map((item) => finite(item.weighted_z) ? Math.abs(item.weighted_z) : 0));
  const resultMatchesRequest = !data || !request ? true : factorResponseMatchesRequest(data, request);
  const resultIdentity = data?.snapshot_id || data?.generated_at || 'current-result';
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
      <details className={`${s.details} ${s.factorMethodDetails}`}>
        <summary>Model equations and definitions</summary>
        <div className={s.factorEquationGrid} aria-label="Factor Lab equations">
          <p><b>Market model</b><code role="math" aria-label="issuer return equals intercept plus market beta times S P Y return plus an error term">rᵢ = intercept + βₘrSPY + error</code><span>Daily log returns; Newey–West HAC inference.</span></p>
          <p><b>Sector sensitivity</b><code role="math" aria-label="issuer return equals market beta times S P Y return plus sector beta times the sector return orthogonal to S P Y plus an error term">rᵢ = βₘrSPY + βₛrsector⊥SPY + error</code><span>The sector ETF is residualized against SPY first.</span></p>
          <p><b>Evidence Gap</b><code role="math" aria-label="clipped filing z score minus clipped price response z score">clip(filing z) − clip(price-response z)</code><span>A descriptive disagreement measure, not expected return.</span></p>
        </div>
      </details>
    </div>

    <form className={`${s.panel} ${s.factorControls}`} aria-busy={loading} onSubmit={(event) => { event.preventDefault(); runAnalysis(); }}>
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
        <p id="factor-run-help"><b>{basis === 'ttm' ? 'Latest TTM' : 'Annual'} filing basis</b> · Peer normalization: {cohortId === 'all' ? 'automatic company cohort' : words(cohortId)}. Changing controls does not spend an API request until you run the analysis.</p>
        <button className={s.primary} type="submit" aria-describedby="factor-run-help" disabled={!validTicker || loading || runBlocked}>
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

    {loading && !data ? <div className={s.loading} role="status" aria-live="polite" aria-atomic="true">
      <Loader2 className={s.spin} size={25} />
      <div><h2>Estimating the market model</h2><p>Aligning trading intervals, calculating HAC uncertainty, residualizing the sector proxy, and evaluating the latest filing event…</p></div>
    </div> : null}

    {error && !data ? <div className={s.error} role="alert">
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

    {loading && data ? <div className={s.warning} role="status" aria-live="polite">
      <Loader2 className={s.spin} size={16} />
      <p><b>Updating—previous result shown.</b> The current result remains available until the refreshed analysis completes.</p>
    </div> : null}

    {error && data ? <div className={s.warning} role="alert">
      <AlertTriangle size={16} />
      <div><p><b>Previous result retained.</b> {error.message} Dates and request settings on the displayed result remain authoritative.</p>{error.retryable !== false ? <button type="button" className={s.button} onClick={runAnalysis} disabled={retryWaitSeconds > 0}>{retryWaitSeconds > 0 ? `Retry in ${retryDelayText(retryWaitSeconds)}` : 'Retry refresh'}</button> : null}</div>
    </div> : null}

    {data ? <div aria-busy={loading}>
      <div className={`${s.panel} ${s.factorResultHeader}`} id="factor-summary">
        <div>
          <span className={s.eyebrow}>Research diagnostic</span>
          <h2 ref={resultHeadingRef} tabIndex={-1} className={s.factorResultHeading}>{data.issuer?.ticker || data.request?.ticker} · {data.issuer?.name || 'Company analysis'}</h2>
          <p>{data.interpretation || 'The deterministic interpretation is unavailable.'}</p>
          {!resultMatchesRequest ? <p className={s.factorPending}>Displayed result uses its labeled settings while a different request is pending.</p> : null}
        </div>
        <div className={s.factorStatusGroup} aria-label="Result status">
          <span className={`${s.factorStatus} ${statusClass}`}>
            {data.status === 'ready' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            {words(data.status)}
          </span>
          <span className={s.factorQuality}>Quality {data.quality?.grade || '—'}</span>
          <small>{data.sample?.observations ?? '—'} matched sessions · through {plainDate(data.data_through)}</small>
          <button type="button" className={s.button} onClick={pinAnalysis}><Pin size={13} />Pin result</button>
        </div>
      </div>

      <nav className={s.factorResultNav} aria-label="Factor result sections" tabIndex={0}>
        <a href="#factor-summary">Summary</a><a href="#factor-readout">Research readout</a><a href="#factor-term">Term structure</a><a href="#factor-evidence">Evidence Gap</a><a href="#factor-event">Filing event</a><a href="#factor-rolling">Rolling beta</a><a href="#factor-filing">Filing drivers</a><a href="#factor-quality">Quality</a><a href="#factor-compare">Comparison</a><a href="#factor-handoff">Handoff</a>
      </nav>

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

      <section className={`${s.panel} ${s.factorReadout}`} id="factor-readout" aria-labelledby="factor-readout-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>Deterministic research triage</span><h2 id="factor-readout-heading">What stands out—and what to investigate</h2></div>
          <small>Rules are disclosed beside every observation</small>
        </div>
        <div className={s.factorReadoutGrid}>
          <div className={s.factorObservationList}>
            {(data.research_readout?.observations || []).map((item) => <article key={item.id || item.finding} data-level={item.level}>
              <b>{item.finding || 'Observation unavailable'}</b>
              <small>{item.rule || 'No rule supplied.'}</small>
            </article>)}
            {!data.research_readout?.observations?.length ? <p className={s.factorUnavailable}>No deterministic observations are available.</p> : null}
          </div>
          <div className={s.factorQuestions}>
            <h3>Next diligence questions</h3>
            <ol>{(data.research_readout?.questions || []).map((question) => <li key={question}>{question}</li>)}</ol>
            <p>{data.research_readout?.claim_boundary || 'Descriptive research triage only; not a forecast or recommendation.'}</p>
          </div>
        </div>
      </section>

      <section className={`${s.panel} ${s.factorTerm}`} id="factor-term" aria-labelledby="factor-term-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>Exposure stability</span><h2 id="factor-term-heading">Beta term structure and sensitivity checks</h2></div>
          <small>One loaded price set · no extra provider calls</small>
        </div>
        <div className={s.tableScroll} tabIndex={0} role="region" aria-label="Beta term structure table; scroll horizontally when needed">
          <table className={s.comparison}>
            <caption className={s.srOnly}>One, three, and five year beta estimates available from the loaded history</caption>
            <thead><tr><th scope="col">Requested horizon</th><th scope="col">Effective sample</th><th scope="col">Observations</th><th scope="col">Market β</th><th scope="col">95% HAC interval</th><th scope="col">R²</th><th scope="col">Residual volatility</th></tr></thead>
            <tbody>{termStructure.map((point) => <tr key={point.window}>
              <th scope="row">{point.window?.toUpperCase() || '—'}</th>
              <td>{point.available ? `${plainDate(point.effective_start)} to ${plainDate(point.effective_end)}` : words(point.reason)}</td>
              <td>{point.observations ?? '—'}</td>
              <td>{betaText(point.beta)}</td>
              <td>{point.beta_confidence_interval95 ? `${betaText(point.beta_confidence_interval95[0])} to ${betaText(point.beta_confidence_interval95[1])}` : '—'}</td>
              <td>{percentText(point.r_squared)}</td>
              <td>{percentText(point.residual_volatility_annualized)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className={s.factorSensitivityGrid}>
          <article>
            <span>Influence sensitivity</span>
            <strong>{influence?.available ? betaText(influence.beta) : 'Withheld'}</strong>
            <p>{influence?.available ? `β change ${zText(influence.beta_delta)} after excluding the three largest Cook-distance sessions.` : words(influence?.reason)}</p>
            {influence?.excluded_dates?.length ? <small>Dates: {influence.excluded_dates.map((point) => `${plainDate(point.date)} (${betaText(point.distance)})`).join(' · ')}</small> : null}
          </article>
          <article>
            <span>Residual 5% tail</span>
            <strong>{percentText(residualTail?.expected_shortfall)}</strong>
            <p>Mean abnormal return in the empirical residual tail below the {percentText(residualTail?.lower_quantile)} quantile.</p>
            <small>Worst {plainDate(residualTail?.worst?.date)} · {percentText(residualTail?.worst?.abnormal_return)} · not portfolio VaR</small>
          </article>
        </div>
      </section>

      <div className={s.factorFeatureGrid} id="factor-evidence">
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
          {mapX != null && mapY != null ? <figure className={s.factorMapFigure} tabIndex={0} role="region" aria-label="Filing–Market map; scroll horizontally when needed">
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
          <div className={s.tableScroll} tabIndex={0} role="region" aria-label="Exact Filing–Market coordinates; scroll horizontally when needed">
            <table className={s.comparison}>
              <caption className={s.srOnly}>Exact Filing–Market map coordinates</caption>
              <thead><tr><th scope="col">Coordinate</th><th scope="col">Exact value</th><th scope="col">Reference</th></tr></thead>
              <tbody>
                <tr><th scope="row">Filing change</th><td>{zText(filingZ)}</td><td>{data.edgar_snapshot?.coverage?.eligible_peer_issuers ?? data.quality?.peer_count ?? '—'} eligible peers</td></tr>
                <tr><th scope="row">Price response</th><td>{zText(responseZ)}</td><td>{event20 ? `${event20.sessions ?? 20} sessions through ${plainDate(event20.through)}` : 'Unavailable'}</td></tr>
                <tr><th scope="row">Classification</th><td colSpan={2}>{classification !== '—' ? classification : mapQuadrant}</td></tr>
                <tr><th scope="row">Neutral band</th><td colSpan={2}>|z| &lt; {neutralBand.toFixed(2)} on each axis</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className={`${s.panel} ${s.factorEvent}`} id="factor-event" aria-labelledby="filing-event-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>Filing response path</span><h2 id="filing-event-heading">How the model-adjusted response accumulated</h2></div>
          <small>{words(data.filing_event?.timing_quality)} · event interval ends {plainDate(data.filing_event?.event_interval_end)}</small>
        </div>
        <div className={s.factorEventGrid}>
          <div className={s.tableScroll} tabIndex={0} role="region" aria-label="Filing event horizon summary">
            <table className={`${s.comparison} ${s.factorCompactTable}`}>
              <caption className={s.srOnly}>One, five, and twenty session filing-event estimates</caption>
              <thead><tr><th scope="col">Horizon</th><th scope="col">Through</th><th scope="col">Abnormal return</th><th scope="col">Response z</th></tr></thead>
              <tbody>{['1', '5', '20'].map((horizon) => {
                const point = data.filing_event?.windows?.[horizon];
                return <tr key={horizon}><th scope="row">{horizon} session{horizon === '1' ? '' : 's'}</th><td>{plainDate(point?.through)}</td><td>{percentText(point?.cumulative_abnormal_return)}</td><td>{zText(point?.standardized_response)}</td></tr>;
              })}</tbody>
            </table>
          </div>
          <dl className={s.factorEventMeta}>
            <div><dt>Pre-event model</dt><dd>{data.filing_event?.estimation?.observations ?? '—'} sessions</dd></div>
            <div><dt>Estimation end</dt><dd>{plainDate(data.filing_event?.estimation?.end)}</dd></div>
            <div><dt>Information gap</dt><dd>{data.filing_event?.estimation?.gap_sessions ?? '—'} sessions</dd></div>
            <div><dt>Response inference</dt><dd>{data.filing_event?.estimation?.inference || 'Unavailable'}{finite(data.filing_event?.estimation?.hac_lag) ? ` · lag ${data.filing_event.estimation.hac_lag}` : ''}</dd></div>
          </dl>
        </div>
        {eventChart ? <figure className={s.factorChartFigure} tabIndex={0} role="region" aria-label="Cumulative filing-event abnormal-return chart; scroll horizontally when needed">
          <svg viewBox={`0 0 ${eventChart.width} ${eventChart.height}`} role="img" aria-labelledby={`${eventTitleId} ${eventDescriptionId}`} className={s.factorChartSvg}>
            <title id={eventTitleId}>{data.issuer?.ticker} cumulative model-adjusted filing response</title>
            <desc id={eventDescriptionId}>Cumulative abnormal return from session one through session {eventChart.end.session}, ending at {percentText(eventChart.end.value)}. Exact daily observations follow in a disclosure table.</desc>
            <line x1={eventChart.left} y1={eventChart.top} x2={eventChart.left} y2={eventChart.height - eventChart.bottom} className={s.factorChartAxis} />
            <line x1={eventChart.left} y1={eventChart.zeroY} x2={eventChart.width - eventChart.right} y2={eventChart.zeroY} className={s.factorChartReference} />
            <text x={eventChart.left - 7} y={eventChart.zeroY + 4} textAnchor="end" className={s.factorChartLabel}>0%</text>
            <text x={eventChart.left} y={eventChart.height - 12} className={s.factorChartLabel}>Session {eventChart.start.session}</text>
            <text x={eventChart.width - eventChart.right} y={eventChart.height - 12} textAnchor="end" className={s.factorChartLabel}>Session {eventChart.end.session}</text>
            <path d={eventChart.path} className={s.factorChartLine} />
          </svg>
          <figcaption>Cumulative simple return transformed from daily log residuals. The standardized response uses Bartlett-weighted HAC cumulative residual variance and does not isolate concurrent news.</figcaption>
        </figure> : <p className={s.factorUnavailable}>A complete event path is unavailable.</p>}
        <details key={`event-path-${resultIdentity}`} className={`${s.details} ${s.factorDetails}`} onToggle={(event) => setEventRowsSnapshot(event.currentTarget.open ? resultIdentity : null)}>
          <summary>Exact daily filing-event path · {data.filing_event?.path?.length || 0}</summary>
          {eventRowsSnapshot === resultIdentity ? <div className={s.tableScroll} tabIndex={0} role="region" aria-label="Exact daily filing-event path">
            <table className={`${s.comparison} ${s.factorCompactTable}`}>
              <thead><tr><th scope="col">Session</th><th scope="col">Date</th><th scope="col">Daily abnormal return</th><th scope="col">Cumulative abnormal return</th><th scope="col">Response z</th></tr></thead>
              <tbody>{(data.filing_event?.path || []).map((point) => <tr key={`${point.session}-${point.date}`}><th scope="row">{point.session ?? '—'}</th><td>{plainDate(point.date)}</td><td>{percentText(point.daily_abnormal_return, 3)}</td><td>{percentText(point.cumulative_abnormal_return, 3)}</td><td>{zText(point.standardized_response)}</td></tr>)}</tbody>
            </table>
          </div> : null}
        </details>
      </section>

      <section className={`${s.panel} ${s.factorRolling}`} id="factor-rolling" aria-labelledby="rolling-beta-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>Stability diagnostic</span><h2 id="rolling-beta-heading">Rolling {data.estimates?.rolling_beta?.window || 126}-session market beta</h2></div>
          <div className={s.factorRollingSummary}><span>Current <b>{betaText(data.estimates?.rolling_beta?.current)}</b></span><span>Median <b>{betaText(data.estimates?.rolling_beta?.median)}</b></span><span>Percentile rank <b>{finite(data.estimates?.rolling_beta?.current_percentile) ? `${data.estimates.rolling_beta.current_percentile.toFixed(0)}%` : '—'}</b></span><span>IQR <b>{betaText(data.estimates?.rolling_beta?.interquartile_range)}</b></span></div>
        </div>
        {rollingChart ? <>
          <figure className={s.factorChartFigure} tabIndex={0} role="region" aria-label="Rolling beta chart; scroll horizontally when needed">
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
          <details key={`rolling-points-${resultIdentity}`} className={`${s.details} ${s.factorDetails}`} onToggle={(event) => setRollingRowsSnapshot(event.currentTarget.open ? resultIdentity : null)}>
            <summary>Exact rolling-beta observations · {rollingChart.clean.length}</summary>
            {rollingRowsSnapshot === resultIdentity ? <div className={s.tableScroll} tabIndex={0} role="region" aria-label="Exact rolling beta observations"><table className={`${s.comparison} ${s.factorNarrowTable}`}>
              <caption className={s.srOnly}>Exact rolling market beta observations</caption>
              <thead><tr><th scope="col">Window end</th><th scope="col">Market beta</th></tr></thead>
              <tbody>{rollingChart.clean.map((point) => <tr key={point.date}><td>{point.date}</td><td>{point.beta.toFixed(4)}</td></tr>)}</tbody>
            </table></div> : null}
          </details>
        </> : <p className={s.factorUnavailable}>A rolling series is unavailable for this sample.</p>}
      </section>

      <section className={`${s.panel} ${s.factorFiling}`} id="factor-filing" aria-labelledby="filing-score-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>SEC filing change</span><h2 id="filing-score-heading">Peer-robust filing components</h2></div>
          <div className={s.factorFilingScore}><span>Composite z</span><strong>{zText(data.edgar_snapshot?.filing_change_z)}</strong><small>{labelText(data.edgar_snapshot?.direction)}</small></div>
        </div>
        <p className={s.factorSectionCopy}>Each available component compares the issuer with other companies in the selected research cohort. The target issuer is excluded from its own peer distribution; median and MAD-based scaling reduce outlier influence. Composite z is the sum of the displayed weighted z contributions. Peer reports form a calculation-time cross-section rather than a cross-section frozen at the focus event.</p>
        {peerClock ? <p className={s.note}>Peer filing clocks: {plainDate(peerClock.earliest_peer)} to {plainDate(peerClock.latest_peer)} · {peerClock.observed_peers ?? '—'} observed · {peerClock.peers_after_focus ?? '—'} became public after the focus filing.</p> : null}
        {driverRows.length ? <div className={s.factorDrivers} aria-label="Ranked weighted filing-score contributions">
          {driverRows.map((driver) => <div key={driver.key || driver.label}>
            <span>{driver.label || words(driver.key)}</span>
            <i aria-hidden="true"><b data-sign={finite(driver.weighted_z) && driver.weighted_z < 0 ? 'negative' : 'positive'} style={{ width: `${finite(driver.weighted_z) && driver.weighted_z !== 0 ? Math.max(3, Math.abs(driver.weighted_z) / maxDriver * 100) : 0}%` }} /></i>
            <strong>{zText(driver.weighted_z)}</strong>
          </div>)}
          <p>Bars rank fixed-weight z contributions by absolute magnitude. They do not redistribute unavailable weights.</p>
        </div> : null}
        <div className={s.factorFilingRefs}>
          {filingReference(data.provenance?.sec?.current_filing, 'Current filing')}
          {filingReference(data.provenance?.sec?.prior_filing, 'Prior comparison')}
        </div>
        {components.length ? <div className={`${s.tableScroll} ${s.factorDesktopComponents}`} tabIndex={0} role="region" aria-label="Peer-normalized filing components; scroll horizontally when needed">
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
        {components.length ? <div className={s.factorMobileComponents} aria-label="Peer-normalized filing components">
          {components.map((component) => <article key={component.key || component.label}>
            <h3>{component.label || words(component.key)}</h3>
            {component.reason ? <p>{component.reason}</p> : null}
            <dl>
              <div><dt>Current / prior</dt><dd>{filingLevelText(component.current)} / {filingLevelText(component.prior)}</dd></div>
              <div><dt>Change / peer median</dt><dd>{filingChangeText(component.change)} / {filingChangeText(component.peer_distribution?.median)}</dd></div>
              <div><dt>MAD / scale</dt><dd>{filingChangeText(component.peer_distribution?.mad)} / {filingChangeText(component.peer_distribution?.scale)} · {words(component.peer_distribution?.scale_method)}</dd></div>
              <div><dt>Peer percentile</dt><dd>{finite(component.peer_percentile) ? `${component.peer_percentile.toFixed(1)}%` : '—'} · {component.peer_count ?? '—'} peers</dd></div>
              <div><dt>z / raw z</dt><dd>{zText(component.z)} / {zText(component.raw_z)}{component.clipped ? ' · clipped' : ''}</dd></div>
              <div><dt>Weight / weighted z</dt><dd>{percentText(component.weight)} / {zText(component.weighted_z)}</dd></div>
            </dl>
          </article>)}
        </div> : null}
      </section>

      <section className={`${s.panel} ${s.factorQualityPanel}`} id="factor-quality" aria-labelledby="factor-quality-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>Reliability dashboard</span><h2 id="factor-quality-heading">Why this result received quality {data.quality?.grade || '—'}</h2></div>
          <span className={s.factorQuality}>Quality {data.quality?.grade || '—'}</span>
        </div>
        <div className={s.factorGateGrid}>{(data.quality?.gates || []).map((gate) => <article key={gate.id} data-status={gate.status}>
          <span>{gate.status === 'pass' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{words(gate.status)}</span>
          <h3>{gate.label || words(gate.id)}</h3>
          <b>{gate.value || '—'}</b>
          <p>{gate.requirement || 'No gate definition supplied.'}</p>
        </article>)}</div>
        <details className={`${s.details} ${s.factorDetails}`}>
          <summary>Excluded and unmatched observations</summary>
          <dl className={s.factorExcluded}>{Object.entries(data.sample?.excluded || {}).map(([key, value]) => <div key={key}><dt>{words(key)}</dt><dd>{value ?? '—'}</dd></div>)}</dl>
        </details>
      </section>

      <section className={`${s.panel} ${s.factorCompare}`} id="factor-compare" aria-labelledby="factor-compare-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>Session notebook</span><h2 id="factor-compare-heading">Compare up to four pinned results</h2></div>
          <div className={s.actions}><button type="button" className={s.button} onClick={pinAnalysis}><Pin size={14} />Pin current</button><button type="button" className={s.button} disabled={!comparison.length} onClick={exportPinnedComparison}><FileSpreadsheet size={14} />Comparison CSV</button></div>
        </div>
        {comparison.length ? <div className={s.tableScroll} tabIndex={0} role="region" aria-label="Pinned Factor Lab comparison; scroll horizontally when needed">
          <table className={s.comparison}>
            <caption className={s.srOnly}>Pinned Factor Lab results from this browser session</caption>
            <thead><tr><th scope="col">Company</th><th scope="col">Settings</th><th scope="col">Market β</th><th scope="col">95% interval</th><th scope="col">Down / up β</th><th scope="col">Sector sensitivity</th><th scope="col">Evidence Gap</th><th scope="col">Quality</th><th scope="col">Remove</th></tr></thead>
            <tbody>{comparison.map((item) => <tr key={item.snapshot_id}>
              <th scope="row">{item.ticker}<small>{item.name}</small></th>
              <td>{item.request?.window?.toUpperCase()} · {String(item.request?.basis || '').toUpperCase()} · {item.request?.sector_proxy}<small>Cohort {item.request?.cohort || '—'} · method {item.methodology_version || '—'} · through {plainDate(item.data_through)}</small></td>
              <td>{betaText(item.beta)}</td><td>{item.beta_ci95 ? `${betaText(item.beta_ci95[0])} to ${betaText(item.beta_ci95[1])}` : '—'}</td>
              <td>{betaText(item.downside_beta)} / {betaText(item.upside_beta)}</td><td>{betaText(item.sector_sensitivity)}</td><td>{zText(item.evidence_gap)}</td><td>{item.quality || '—'}</td>
              <td><button type="button" className={s.iconButton} onClick={() => removePinned(item.snapshot_id)} aria-label={`Remove ${item.ticker} pinned result`}><X size={14} /></button></td>
            </tr>)}</tbody>
          </table>
        </div> : <p className={s.factorSectionCopy}>Pin this result, run another company or setting, then pin again. No requests run automatically and no investment ranking is created.</p>}
        <p className={s.note}>Compare like-for-like settings and methodology versions. Different windows, cohorts, or price-through dates remain visibly labeled rather than silently normalized.</p>
      </section>

      <section className={`${s.panel} ${s.factorAudit}`} id="factor-handoff" aria-labelledby="factor-audit-heading">
        <div className={s.factorSectionHeading}>
          <div><span className={s.eyebrow}>Audit & reuse</span><h2 id="factor-audit-heading">Researcher and model handoff</h2></div>
          <div className={s.actions}>
            <button type="button" className={s.primary} onClick={copyContext}><Clipboard size={14} />Copy AI context</button>
            <button type="button" className={s.button} onClick={exportContext}><Download size={14} />Context TXT</button>
            <button type="button" className={s.button} onClick={exportCsv}><FileSpreadsheet size={14} />Tidy CSV</button>
            <button type="button" className={s.button} onClick={exportJson}><Download size={14} />JSON</button>
            <button type="button" className={s.button} onClick={exportMarkdown}><Download size={14} />Markdown</button>
          </div>
        </div>
        <p className={s.factorSectionCopy}>The compact <code>edgar.factor-context.v1</code> packet is about {Math.max(1, Math.ceil(compactContextLength / 4)).toLocaleString()} tokens by a four-characters-per-token estimate. CSV contains raw decimals and tidy record types; full JSON and Markdown retain the audit record. No export includes bulk vendor price history.</p>
        <div className={s.tableScroll} tabIndex={0} role="region" aria-label="Price series provenance; scroll horizontally when needed"><table className={s.comparison}>
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
          <div><dt>Input fingerprint</dt><dd className={s.factorHash}><code>{data.fingerprints?.input_sha256 || '—'}</code></dd></div>
          <div><dt>Calculation fingerprint</dt><dd className={s.factorHash}><code>{data.fingerprints?.result_sha256 || '—'}</code></dd></div>
        </dl>
        <div className={s.factorAuditLinks}>
          <a href={data.links?.methodology || '/market/factors'}>Methodology <ExternalLink size={12} /></a>
          {data.links?.api ? <a href={data.links.api}>API result <ExternalLink size={12} /></a> : null}
          {data.links?.schema ? <a href={data.links.schema}>JSON Schema <ExternalLink size={12} /></a> : null}
          {data.links?.sec_companyfacts ? <a href={data.links.sec_companyfacts} target="_blank" rel="noreferrer" aria-label="SEC Company Facts, opens in a new tab">SEC Company Facts <ExternalLink size={12} /></a> : null}
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
    </div> : null}
  </section>;
}
