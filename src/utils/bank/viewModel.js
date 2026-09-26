import { BANK_METRICS } from './definitions.js';
import { CREDIT_SEGMENTS, EXPOSURE_LENSES } from './exposureDefinitions.js';

export const GROUPS = ['Capital', 'Credit quality', 'Funding', 'Earnings', 'Overview'];
export const PENDING = new Set(['queued', 'running', 'retry']);
export function quarterLabel(date) {
  return /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(date || '') ? `Q${Math.ceil(Number(date.slice(5, 7)) / 3)} ${date.slice(0, 4)}` : date || 'Unavailable';
}
export function bankReport(state, rssd, period) {
  return state?.reports?.find(r => String(r.id_rssd) === String(rssd) && r.report_date === period) || null;
}
export function bankMetric(state, rssd, period, key, basis = 'ytd') {
  const report = bankReport(state, rssd, period);
  const def = BANK_METRICS.find(m => m.key === key);
  const metric = report?.metrics?.find(m => m.key === key);
  if (!report?.validation?.passed) return { ...def, value: null, reason: report ? 'financial_review_required' : 'report_not_prepared' };
  if (!metric) return { ...def, value: null, reason: 'item_not_reported' };
  if (metric.period !== 'ytd' || basis !== 'quarterly' || metric.value == null) return metric;
  if (period.endsWith('03-31')) return { ...metric, period: 'quarterly', derived: 'First quarter equals reported year to date.' };
  const priorSuffix = { '06-30': '03-31', '09-30': '06-30', '12-31': '09-30' }[period.slice(5)];
  const priorDate = `${period.slice(0, 4)}-${priorSuffix}`;
  const prior = bankMetric(state, rssd, priorDate, key, 'ytd');
  if (prior.value == null) return { ...metric, period: 'quarterly', value: null, reason: 'previous_ytd_unavailable', derived: `Requires ${quarterLabel(priorDate)} year-to-date data.` };
  return { ...metric, value: metric.value - prior.value, period: 'quarterly', status: 'calculated',
    derived: `${quarterLabel(period)} YTD minus ${quarterLabel(priorDate)} YTD.`, priorDate };
}
export function unavailableReason(metric) {
  if (metric?.reason === 'not_required_under_cblr') return 'Not required under the Community Bank Leverage Ratio framework';
  if (metric?.reason?.startsWith('not_applicable')) return 'Not applicable to this Call Report form';
  if (metric?.reason === 'previous_ytd_unavailable') return 'Previous quarter’s YTD figure is outside the prepared history or unavailable';
  if (metric?.reason === 'financial_review_required') return 'Financial checks require review';
  if (metric?.reason === 'report_not_prepared') return 'No prepared Call Report for this period';
  if (metric?.reason === 'ratio_inputs_unavailable') return 'A required ratio component is unavailable';
  if (metric?.reason === 'ratio_denominator_nonpositive') return 'Ratio requires a positive denominator';
  return 'Not reported on the required basis';
}
export function formatBankMetric(metric, { exact = false } = {}) {
  if (metric?.value == null || !Number.isFinite(metric.value)) return metric?.reason?.startsWith('not_') ? 'N/A' : 'Unavailable';
  if (metric.unit === 'percent') return `${metric.value.toFixed(exact ? 4 : 2)}%`;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: exact ? 3 : 1, maximumFractionDigits: exact ? 3 : 1 }).format(metric.value / 1e6);
}
export function metricChange(current, previous) {
  if (current?.value == null || previous?.value == null) return null;
  if (current.unit === 'percent') return { value: current.value - previous.value, unit: 'pp' };
  if (previous.value <= 0) return null;
  return { value: (current.value / previous.value - 1) * 100, unit: '%' };
}
export function bankHref(rssd, { view = 'overview', peers = [], period, metric, basis, panel, lens, category, exposure, segment } = {}) {
  const query = new URLSearchParams();
  if (view !== 'overview') query.set('view', view);
  if (peers.length) query.set('peers', peers.join(','));
  if (period) query.set('period', period);
  if (metric) query.set('metric', metric);
  if (basis === 'quarterly' || basis === 'ytd') query.set('basis', basis);
  if (view === 'exposures') {
    if (EXPOSURE_LENSES.includes(exposure)) query.set('exposure', exposure);
    if (CREDIT_SEGMENTS.some(s => s.key === segment)) query.set('segment', segment);
  }
  if (view === 'compare' && ['benchmarks','selected'].includes(panel)) query.set('panel', panel);
  if (view === 'compare' && panel !== 'selected') {
    if(lens === 'camels') query.set('lens',lens);
    if(['capital','assetQuality','operations','earnings','liquidity','sensitivity'].includes(category)) query.set('category',category);
  }
  return `/analysis/banks/${rssd}${query.size ? `?${query}` : ''}`;
}
export function bankPageOptions(rssd, query = {}) {
  const peers = typeof query.peers === 'string' ? [...new Set(query.peers.split(',').filter(id => /^[1-9]\d{0,9}$/.test(id) && id !== String(rssd)))].slice(0, 3) : [];
  return { view: ['compare', 'trends', 'exposures'].includes(query.view) ? query.view : 'overview', peers,
    exposure: EXPOSURE_LENSES.includes(query.exposure) ? query.exposure : 'credit',
    segment: CREDIT_SEGMENTS.some(s => s.key === query.segment) ? query.segment : 'cre',
    panel: ['benchmarks','selected'].includes(query.panel) ? query.panel : peers.length ? 'selected' : 'benchmarks',
    lens: query.lens==='camels'?'camels':'peers',
    category: ['capital','assetQuality','operations','earnings','liquidity','sensitivity'].includes(query.category)?query.category:'core',
    period: typeof query.period === 'string' && /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(query.period) ? query.period : '',
    metric: BANK_METRICS.some(m => m.key === query.metric) ? query.metric : 'assets',
    basis: ['quarterly', 'ytd'].includes(query.basis) ? query.basis : query.view === 'trends' ? 'quarterly' : 'ytd' };
}
