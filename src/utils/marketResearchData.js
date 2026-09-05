import { buildMetricRow, extractAnnualPeriods, extractQuarterlyPeriods } from './xbrlParser.js';
import { withPeriodKind, daysBetween } from './xbrlPeriods.js';
import { evidenceSources, evidenceCalculations } from './researchEvidence.js';
import { MARKET_METRICS, MARKET_VERSION, isNumber } from './marketResearch.js';

const INPUTS = [...new Set(MARKET_METRICS.flatMap((m) => m.inputs))];
const percent = (a, b) => isNumber(a) && isNumber(b) && b > 0 ? a / b * 100 : null;
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
  const rows = Object.fromEntries(INPUTS.map((key) => [key, buildMetricRow(facts, key, key, periods, 'currency', sic).values]));
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

export function buildMarketCompany({ ticker, cik, name, sic, facts }, cohorts, observedAt = new Date().toISOString()) {
  const annual = buildBasis(facts, extractAnnualPeriods(facts).slice(0, 6), sic, 5);
  const ttm = buildBasis(facts, withPeriodKind(extractQuarterlyPeriods(facts).slice(0, 10), 'ttm'), sic, 6);
  if (!annual.length && !ttm.length) throw new Error('No supported annual or quarterly financial contexts.');
  const metrics = { annual: annual[0]?.metrics || {}, ttm: ttm[0]?.metrics || {} };
  const reports = { annual: annual[0]?.period || null, ttm: ttm[0]?.period || null };
  return { version: MARKET_VERSION, ticker, cik, name, sic, cohorts, observedAt, metrics, reports, evidence: { annual, ttm } };
}
export function marketCompanySummary(company) {
  const { evidence: _evidence, ...summary } = company;
  return summary;
}
