// Public research is a bounded projection of an already prepared financial
// model. These reads never start SEC acquisition or persist query variants.
import { readPreparedAnalysis } from './preparedFinancialData.js';
import { preparedEnvelopeUsable } from './secDocumentStore.js';
import { analysisBaseline, analysisChange, ANALYSIS_VERSION } from './analysisResearch.js';

export const PUBLIC_ANALYSIS_VERSION = 'edgar.public-analysis.v1';
export const PUBLIC_ANALYSIS_BASES = Object.freeze(['annual', 'quarter', 'ytd', 'ttm']);
export const PUBLIC_ANALYSIS_MAX_BYTES = 64 * 1024;
const MAX_SOURCES = 96;
const MAX_INPUTS = 64;
const MAX_CALCULATIONS = 32;
const primary = {
  corporate: ['revenue', 'netIncome', 'operatingMargin', 'operatingCashFlow', 'freeCashFlow', 'roe'],
  banking: ['bankRevenue', 'netIncome', 'roe', 'equityAssets', 'deposits', 'loanDeposits'],
  insurance: ['premiumsEarned', 'investmentIncome', 'netIncome', 'roe', 'equityAssets', 'cashAssets'],
};
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : '';
function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
}
function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** Only financial selectors belong to a public summary, never saved research settings. */
export function publicAnalysisSelection(input = {}, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['ticker', 'basis', 'end', 'asOf'].includes(key))) return null;
  const { ticker, basis = 'annual', end = '', asOf = '' } = input;
  if (typeof ticker !== 'string' || !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker.trim().toUpperCase())
    || typeof basis !== 'string' || !PUBLIC_ANALYSIS_BASES.includes(basis)
    || typeof end !== 'string' || typeof asOf !== 'string') return null;
  const today = new Date(now).toISOString().slice(0, 10);
  if (end && end !== 'latest' && (!date(end) || end > today) || asOf && (!date(asOf) || asOf > today)) return null;
  return { ticker: ticker.trim().toUpperCase(), basis, end: end === 'latest' ? '' : end, asOf };
}

function urls(selection) {
  const query = new URLSearchParams();
  if (selection.basis !== 'annual') query.set('basis', selection.basis);
  if (selection.end) query.set('end', selection.end);
  if (selection.asOf) query.set('asOf', selection.asOf);
  const suffix = query.size ? `?${query}` : '';
  return { interactiveUrl: `/analysis/${selection.ticker}${suffix}#analysis-workspace`,
    summaryUrl: `/api/v1/analysis/${selection.ticker}${suffix}` };
}
function unavailable(selection, reason) {
  return { schemaVersion: PUBLIC_ANALYSIS_VERSION, calculationVersion: ANALYSIS_VERSION,
    status: 'not-prepared', ticker: selection.ticker, name: selection.ticker, basis: selection.basis,
    asOf: selection.asOf, selectedEnd: selection.end || 'latest', stale: false,
    period: null, comparisonPeriod: null, metrics: [], sourceCatalog: [], coverage: null,
    checkedAt: null, retrievedAt: null, calculatedAt: null, freshUntil: null,
    reason, limitations: ['A missing prepared summary does not establish that financial data or a filing does not exist.'], ...urls(selection) };
}
function period(value) {
  if (!value || !PUBLIC_ANALYSIS_BASES.includes(value.kind) || !date(value.end)) return null;
  return { kind: value.kind, start: date(value.start), end: value.end,
    fiscalYear: Number.isSafeInteger(value.fy) ? value.fy : null,
    fiscalPeriod: text(value.fp, 8) || null };
}
function source(value) {
  if (!value || !date(value.end) || !date(value.filed) || !/^\d{10}-\d{2}-\d{6}$/.test(value.accession || '')
    || !value.tag || !value.taxonomy || !value.unit || finite(value.value) === null
    || value.start != null && !date(value.start)) throw new Error('Incomplete public source provenance');
  const url = new URL(value.documentUrl);
  if (url.protocol !== 'https:' || !['sec.gov', 'www.sec.gov'].includes(url.hostname)
    || url.username || url.password || url.port || !url.pathname.startsWith('/Archives/')) throw new Error('Invalid SEC source');
  return { taxonomy: text(value.taxonomy, 40), tag: text(value.tag, 240), unit: text(value.unit, 40),
    start: date(value.start), end: value.end, value: value.value, accession: value.accession,
    filed: value.filed, form: text(value.form, 16), url: url.href, revised: value.revised === true };
}
const units = { currency: 'USD', percent: '%', decimal: 'ratio', eps: 'USD/shares', shares: 'shares', days: 'days', number: 'count' };

/** Dependency injection verifies that misses and historical cutoffs never acquire SEC data. */
export function createPublicAnalysisReader({ read = readPreparedAnalysis, now = Date.now } = {}) {
  /** @param {{ticker: string, basis?: string, end?: string, asOf?: string}} input */
  return async function readPublicAnalysis(input) {
    const at = now();
    const selected = publicAnalysisSelection(input, at);
    if (!selected) throw new RangeError('Invalid public financial selection');
    const missing = reason => unavailable(selected, reason);
    if (selected.asOf) return missing('A prepared public summary is not available for this filing cutoff. The interactive workspace can research the selected vintage; current-vintage values have not been substituted.');
    let envelope;
    try { envelope = await read({ ticker: selected.ticker, basis: selected.basis, asOf: '' }); }
    catch { return missing('Prepared financial storage is temporarily unavailable. Open the interactive workspace or retry later.'); }
    const data = envelope?.payload;
    if (!preparedEnvelopeUsable(envelope, at) || data?.version !== ANALYSIS_VERSION || data?.packed !== true
      || data.ticker !== selected.ticker || data.basis !== selected.basis || data.asOf
      || !/^\d{10}$/.test(data.cik || '') || Number(data.cik) === 0
      || !Array.isArray(data.periods) || !Array.isArray(data.definitions)
      || !Array.isArray(data.sourceCatalog) || !Array.isArray(data.calculationCatalog)) {
      return missing('A verified prepared financial model is not available for this company and reporting basis. This request does not start SEC acquisition.');
    }
    const index = selected.end ? data.periods.findIndex(value => value.end === selected.end) : 0;
    const currentPeriod = period(data.periods[index]);
    if (index < 0 || !currentPeriod || currentPeriod.kind !== selected.basis) return missing('The selected reporting period is not available in the prepared financial model. No other period has been substituted.');
    const beforeIndex = analysisBaseline(data.periods, index, 'year');
    const beforePeriod = period(data.periods[beforeIndex]);
    const sources = [], sourceIds = new Map();
    function point(value, reportingPeriod) {
      if (!value || finite(value.value) === null) return { value: null, classification: 'unavailable', formula: null,
        observationPeriod: reportingPeriod, reason: text(value?.reason || value?.note || 'A required reported input is unavailable.', 500), sourceIds: [], calculations: [] };
      if (!['reported', 'calculated'].includes(value.classification) || !Array.isArray(value.sourceIds)
        || !value.sourceIds.length || value.sourceIds.length > MAX_INPUTS
        || (value.calculationIds || []).length > MAX_CALCULATIONS) throw new Error('Unbounded public evidence');
      const ids = [...new Set(value.sourceIds.map(id => {
        if (!Number.isSafeInteger(id) || id < 0 || id >= data.sourceCatalog.length) throw new Error('Invalid source reference');
        const row = source(data.sourceCatalog[id]), key = JSON.stringify(row);
        if (!sourceIds.has(key)) {
          if (sources.length >= MAX_SOURCES) throw new Error('Public source limit exceeded');
          sourceIds.set(key, sources.length); sources.push(row);
        }
        return sourceIds.get(key);
      }))];
      const calculations = [...new Set(value.calculationIds || [])].map(id => {
        const step = data.calculationCatalog[id];
        if (!Number.isSafeInteger(id) || id < 0 || !step || typeof step.formula !== 'string') throw new Error('Invalid calculation reference');
        return { formula: text(step.formula, 800), value: finite(step.value), start: date(step.start), end: date(step.end), unit: text(step.unit, 40) || null };
      });
      const instant = ids.every(id => sources[id].start === null && sources[id].end === reportingPeriod.end);
      return { value: value.value, classification: value.classification,
        formula: text(value.formula, 1000) || null,
        observationPeriod: value.observationPeriod ? {
          kind: value.observationPeriod.kind === 'instant' ? 'instant' : 'duration',
          start: date(value.observationPeriod.start), end: date(value.observationPeriod.end),
        } : { kind: instant ? 'instant' : 'duration', start: instant ? null : reportingPeriod.start, end: reportingPeriod.end },
        reason: text(value.reason || value.note, 500) || null, sourceIds: ids, calculations };
    }
    try {
      const metricKeys = primary[data.lens] || primary.corporate;
      const metrics = metricKeys.map(key => {
        const definition = data.definitions.find(value => value.key === key);
        if (!definition) return null;
        const raw = data.metrics?.[key]?.[index], old = data.metrics?.[key]?.[beforeIndex];
        const current = point(raw, currentPeriod), previous = beforePeriod ? point(old, beforePeriod) : null;
        const forComparison = (value, i) => value ? { ...value, period: data.periods[i],
          sources: (value.sourceIds || []).map(id => data.sourceCatalog[id]) } : null;
        return { key, label: text(definition.label), format: text(definition.format, 20),
          unit: units[definition.format] || 'ratio', ...current, previous,
          change: analysisChange(forComparison(raw, index), forComparison(old, beforeIndex), definition.format) };
      }).filter(Boolean);
      if (!metrics.length) return missing('This prepared model has no supported financial summary metrics.');
      const metadata = envelope.metadata;
      const result = { schemaVersion: PUBLIC_ANALYSIS_VERSION, calculationVersion: data.version, status: 'ready',
        ticker: selected.ticker, cik: data.cik, name: text(data.name) || selected.ticker,
        lens: text(data.lens, 32), businessModel: text(data.businessModel, 40) || null,
        basis: selected.basis, asOf: '', selectedEnd: selected.end || 'latest',
        period: currentPeriod, comparisonPeriod: beforePeriod,
        checkedAt: timestamp(metadata.revalidatedAt || metadata.fetchedAt), retrievedAt: timestamp(metadata.fetchedAt),
        calculatedAt: timestamp(data.observedAt), freshUntil: timestamp(metadata.expiresAt),
        stale: Boolean(envelope.stale || Date.parse(metadata.expiresAt) <= at),
        metrics, sourceCatalog: sources,
        coverage: { displayedMetrics: metrics.length, availableMetrics: metrics.filter(value => value.value !== null).length,
          reportedMetrics: metrics.filter(value => value.classification === 'reported').length,
          calculatedMetrics: metrics.filter(value => value.classification === 'calculated').length,
          comparableMetrics: metrics.filter(value => value.change.delta !== null).length,
          sourceCount: sources.length, sourceInputsOmitted: 0, preparedHistoryPeriods: data.periods.length },
        limitations: ['Normalized standard SEC XBRL concepts, not a complete reproduction of the filed financial statements. Missing values are not zero.',
          'Values are unscaled USD, reported per-share units, percentages or ratios as labeled. Balance-sheet inputs are point-in-time observations; income and cash-flow inputs cover their stated durations.',
          'The latest filed values in the prepared model are used, including subsequent comparative revisions. Selecting an older reporting end does not create an as-filed historical vintage.',
          'Year-over-year changes require compatible periods. Percentage growth is not calculated from a zero or negative base; percentage-valued metrics change in percentage points.',
          'Reported inputs, calculated metrics and source-check dates remain separate. CFTC positioning, market prices and personal research assumptions are outside this summary.',
          ...(data.lensNote ? [text(data.lensNote, 800)] : [])], ...urls(selected) };
      if (Buffer.byteLength(JSON.stringify(result)) > PUBLIC_ANALYSIS_MAX_BYTES) return missing('The prepared evidence exceeds the compact public summary limit. The complete model remains available in the interactive workspace.');
      return result;
    } catch { return missing('The prepared evidence could not be represented completely within this compact summary. The interactive workspace retains the full financial model.'); }
  };
}
export const readPublicAnalysis = createPublicAnalysisReader();
