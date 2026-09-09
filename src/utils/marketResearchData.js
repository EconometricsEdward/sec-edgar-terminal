import { buildMetricRow, extractAnnualPeriods, extractQuarterlyPeriods } from './xbrlParser.js';
import { withPeriodKind, daysBetween, selectFinancialFact, sourceDocumentUrl } from './xbrlPeriods.js';
import { classifyIndustry, INDUSTRY_GROUPS } from './industry.js';
import { evidenceSources, evidenceCalculations } from './researchEvidence.js';
import { MARKET_METRICS, MARKET_VERSION, isNumber } from './marketResearch.js';

const INPUTS = [...new Set(MARKET_METRICS.flatMap((m) => m.inputs))];
const percent = (a, b) => isNumber(a) && isNumber(b) && b > 0 ? a / b * 100 : null;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const ACCEPTANCE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const FACTOR_METRIC_KEYS = [
  'revenueGrowth', 'netMargin', 'operatingMargin', 'freeCashFlowMargin', 'equityToAssets', 'cashToAssets',
];
const FACTOR_METRIC_KEY_SET = new Set(FACTOR_METRIC_KEYS);

function normalizedAcceptance(value) {
  if (typeof value !== 'string' || !ACCEPTANCE_TIMESTAMP.test(value.trim()) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Map SEC submissions' parallel arrays into a small accession -> acceptance-time index. */
export function marketAcceptanceTimes(submissions) {
  const recent = submissions?.filings?.recent;
  if (!Array.isArray(recent?.accessionNumber) || !Array.isArray(recent?.acceptanceDateTime)) return {};
  const result = {};
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const accession = recent.accessionNumber[i];
    const acceptedAt = normalizedAcceptance(recent.acceptanceDateTime[i]);
    if (ACCESSION.test(accession || '') && acceptedAt) result[accession] = acceptedAt;
  }
  return result;
}

// Revenue denominators must represent the full business, never a partial gross
// interest or premium line from the general statement display's fallbacks.
export function marketRevenuePoint(facts, period, sic) {
  const industry = classifyIndustry(sic);
  if (industry === INDUSTRY_GROUPS.BANKING) {
    const direct = selectFinancialFact(facts, ['RevenuesNetOfInterestExpense'], period);
    if (direct) return direct;
    const interest = buildMetricRow(facts, 'netInterestIncome', '', [period], 'currency', sic).values[0];
    const other = buildMetricRow(facts, 'noninterestIncome', '', [period], 'currency', sic).values[0];
    if (!isNumber(interest.value) || !isNumber(other.value)) return { value: null, classification: 'unavailable' };
    return { value: interest.value + other.value, classification: 'calculated', formula: 'Net interest income + noninterest income',
      sources: [...evidenceSources(interest), ...evidenceSources(other)],
      calculations: [interest, other].flatMap((p) => [...evidenceCalculations(p), ...(p.formula ? [{ value: p.value, formula: p.formula, start: period.start, end: period.end, unit: 'USD' }] : [])]) };
  }
  if (industry === INDUSTRY_GROUPS.INSURANCE) return selectFinancialFact(facts, ['Revenues', 'Revenue'], period) || { value: null, classification: 'unavailable' };
  return buildMetricRow(facts, 'revenue', '', [period], 'currency', sic).values[0];
}
export function marketPeriodMetrics(inputs, priorInputs) {
  const v = (key) => inputs[key]?.value ?? null;
  const previous = priorInputs?.revenue?.value;
  return {
    revenueGrowth: isNumber(v('revenue')) && isNumber(previous) && previous > 0 ? (v('revenue') / previous - 1) * 100 : null,
    netMargin: percent(v('netIncome'), v('revenue')), operatingMargin: percent(v('operatingIncome'), v('revenue')),
    cashFlowMargin: percent(v('operatingCashFlow'), v('revenue')),
    freeCashFlowMargin: percent(isNumber(v('operatingCashFlow')) && isNumber(v('capex')) ? v('operatingCashFlow') - Math.abs(v('capex')) : null, v('revenue')),
    capexIntensity: percent(isNumber(v('capex')) ? Math.abs(v('capex')) : null, v('revenue')),
    equityToAssets: percent(v('stockholdersEquity'), v('totalAssets')), liabilitiesToAssets: percent(v('totalLiabilities'), v('totalAssets')),
    cashToAssets: percent(v('cash'), v('totalAssets')), revenue: v('revenue'), totalAssets: v('totalAssets'), netIncome: v('netIncome'),
  };
}

function buildBasis(facts, periods, sic, limit) {
  const rows = Object.fromEntries(INPUTS.map((key) => [key, key === 'revenue' ? periods.map((p) => marketRevenuePoint(facts, p, sic)) : buildMetricRow(facts, key, key, periods, 'currency', sic).values]));
  const points = periods.map((period, i) => ({ period, inputs: Object.fromEntries(INPUTS.map((key) => {
    const point = rows[key][i];
    return [key, { value: point.value, classification: point.classification || 'unavailable', formula: point.formula || null,
      sources: evidenceSources(point), calculations: evidenceCalculations(point) }];
  })) }));
  return points.slice(0, limit).map((point) => {
    const prior = points.find((p) => {
      const gap = daysBetween(p.period.end, point.period.end);
      return gap >= 350 && gap <= 380;
    });
    return { ...point, priorRevenue: prior ? { period: prior.period, ...prior.inputs.revenue } : null,
      metrics: marketPeriodMetrics(point.inputs, prior?.inputs) };
  });
}

function sourceKnownAtCutoff(source, cutoff, acceptanceTimes) {
  if (!source || typeof source !== 'object' || !ACCESSION.test(source.accession || '') || typeof source.filed !== 'string') return false;
  if (source.filed < cutoff.filed) return true;
  if (source.filed > cutoff.filed) return false;
  if (source.accession === cutoff.accession) return true;
  const sourceAcceptedAt = acceptanceTimes?.[source.accession] || null;
  return Boolean(sourceAcceptedAt && cutoff.acceptedAt && sourceAcceptedAt <= cutoff.acceptedAt);
}

function compactSource(source, cik, acceptanceTimes) {
  return {
    accession: source.accession,
    filed: source.filed,
    acceptedAt: acceptanceTimes?.[source.accession] || null,
    form: source.form || null,
    start: source.start || null,
    end: source.end || null,
    taxonomy: source.taxonomy || null,
    tag: source.tag || null,
    unit: source.unit || null,
    value: isNumber(source.value) ? source.value : null,
    source: sourceDocumentUrl(cik, source),
  };
}

function metricSources(point, definition) {
  const sources = definition.inputs.flatMap((input) => evidenceSources(point?.inputs?.[input]));
  if (definition.key === 'revenueGrowth') sources.push(...evidenceSources(point?.priorRevenue));
  const seen = new Set();
  return sources.filter((source) => {
    const key = [source.accession, source.tag, source.unit, source.start || '', source.end, source.value].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pointInTimeMetrics(point, cutoff, acceptanceTimes) {
  const metrics = {};
  const sources = {};
  for (const definition of MARKET_METRICS) {
    const value = point?.metrics?.[definition.key];
    const rawSources = metricSources(point, definition);
    const eligible = rawSources.length > 0
      && rawSources.every((source) => sourceKnownAtCutoff(source, cutoff, acceptanceTimes));
    metrics[definition.key] = isNumber(value) && eligible ? value : null;
    if (FACTOR_METRIC_KEY_SET.has(definition.key)) {
      sources[definition.key] = eligible
        ? rawSources.map((source) => compactSource(source, cutoff.cik, acceptanceTimes))
        : [];
    }
  }
  return { metrics, metricSources: sources };
}

function comparisonPoint(point, cutoff, acceptanceTimes) {
  if (!point?.period) return null;
  const { end, filed, form, accession } = point.period;
  const pointInTime = pointInTimeMetrics(point, cutoff, acceptanceTimes);
  return {
    end,
    filed,
    acceptedAt: acceptanceTimes?.[accession] || null,
    form,
    accession,
    source: sourceDocumentUrl(cutoff.cik, { accession }),
    metrics: pointInTime.metrics,
    metricSources: pointInTime.metricSources,
  };
}

function closestYearComparison(points, cutoff, acceptanceTimes) {
  const currentPoint = points[0];
  if (!currentPoint) return null;
  const candidates = points.slice(1).flatMap((point) => {
    const gapDays = daysBetween(point.period.end, currentPoint.period.end);
    return gapDays >= 350 && gapDays <= 380 ? [{ point, gapDays }] : [];
  }).sort((a, b) => Math.abs(a.gapDays - 365) - Math.abs(b.gapDays - 365)
    || b.point.period.end.localeCompare(a.point.period.end));
  const selected = candidates[0] || null;
  const current = comparisonPoint(currentPoint, cutoff, acceptanceTimes);
  const prior = selected ? comparisonPoint(selected.point, cutoff, acceptanceTimes) : null;
  const changes = Object.fromEntries(MARKET_METRICS.map(({ key }) => {
    const currentValue = current.metrics[key];
    const priorValue = prior?.metrics?.[key];
    return [key, isNumber(currentValue) && isNumber(priorValue) ? currentValue - priorValue : null];
  }));
  return {
    pointInTime: true,
    cutoff: { filed: cutoff.filed, acceptedAt: cutoff.acceptedAt, accession: cutoff.accession },
    current,
    prior,
    gapDays: selected?.gapDays ?? null,
    changes,
  };
}

function periodsForBasis(facts, basis, asOf = undefined) {
  return basis === 'annual'
    ? extractAnnualPeriods(facts, asOf).slice(0, 6)
    : withPeriodKind(extractQuarterlyPeriods(facts, asOf).slice(0, 10), 'ttm');
}

function pointInTimeComparison(facts, sic, basis, cik, acceptanceTimes) {
  const discovered = periodsForBasis(facts, basis);
  const eventPeriod = discovered[0];
  if (!eventPeriod) return null;
  const cutoff = {
    cik,
    filed: eventPeriod.filed,
    accession: eventPeriod.accession,
    acceptedAt: acceptanceTimes?.[eventPeriod.accession] || null,
  };
  const asFiledPoints = buildBasis(facts, periodsForBasis(facts, basis, eventPeriod.filed), sic, basis === 'annual' ? 5 : 6);
  const current = asFiledPoints.find((point) => (
    point.period.end === eventPeriod.end && point.period.accession === eventPeriod.accession
  ));
  if (!current) return null;
  return closestYearComparison(
    [current, ...asFiledPoints.filter((point) => point !== current)],
    cutoff,
    acceptanceTimes,
  );
}

export function buildMarketCompany({ ticker, cik, name, sic, facts, acceptanceTimes = {} }, cohorts, observedAt = new Date().toISOString()) {
  const annual = buildBasis(facts, extractAnnualPeriods(facts).slice(0, 6), sic, 5);
  const ttm = buildBasis(facts, withPeriodKind(extractQuarterlyPeriods(facts).slice(0, 10), 'ttm'), sic, 6);
  if (!annual.length && !ttm.length) throw new Error('No supported annual or quarterly financial contexts.');
  const metrics = { annual: annual[0]?.metrics || {}, ttm: ttm[0]?.metrics || {} };
  const reports = { annual: annual[0]?.period || null, ttm: ttm[0]?.period || null };
  const filingComparisons = {
    annual: pointInTimeComparison(facts, sic, 'annual', cik, acceptanceTimes),
    ttm: pointInTimeComparison(facts, sic, 'ttm', cik, acceptanceTimes),
  };
  return { version: MARKET_VERSION, ticker, cik, name, sic, cohorts, observedAt, metrics, reports, filingComparisons,
    revenueBasis: classifyIndustry(sic) === INDUSTRY_GROUPS.BANKING ? 'Bank net revenue after interest expense' : 'Reported total revenue', evidence: { annual, ttm } };
}

function summaryComparisonPoint(point) {
  if (!point) return null;
  const { metricSources, metrics: _metrics, source: _source, ...rest } = point;
  const metrics = Object.fromEntries(FACTOR_METRIC_KEYS.map((key) => [key, point.metrics?.[key] ?? null]));
  const factorSourceAccessions = [...new Set(FACTOR_METRIC_KEYS.flatMap((key) => (
    metricSources?.[key] || []
  )).map((source) => source.accession).filter((accession) => ACCESSION.test(accession || '')))];
  const factorSourceMasks = FACTOR_METRIC_KEYS.map((key) => {
    const indexes = [...new Set((metricSources?.[key] || []).map((source) => factorSourceAccessions.indexOf(source.accession)).filter((index) => index >= 0))];
    return indexes.reduce((mask, index) => mask | (1n << BigInt(index)), 0n).toString(16);
  });
  return {
    ...rest,
    metrics,
    factorSourceAccessions,
    factorSourceMasks,
  };
}

function summaryComparison(comparison) {
  return comparison ? {
    ...comparison,
    current: summaryComparisonPoint(comparison.current),
    prior: summaryComparisonPoint(comparison.prior),
    changes: Object.fromEntries(FACTOR_METRIC_KEYS.map((key) => [key, comparison.changes?.[key] ?? null])),
  } : null;
}

export function marketCompanySummary(company) {
  const { evidence: _evidence, ...summary } = company;
  return {
    ...summary,
    filingComparisons: {
      annual: summaryComparison(company.filingComparisons?.annual),
      ttm: summaryComparison(company.filingComparisons?.ttm),
    },
  };
}
