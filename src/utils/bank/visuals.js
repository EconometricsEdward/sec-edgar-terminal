import { BANK_METRICS } from './definitions.js';
import { bankMetric, quarterLabel } from './viewModel.js';

export const BANK_COLORS = ['#67c8ff', '#b5a0ff', '#56d8b4', '#f4b76c'];
export const METRIC_COLORS = { assets: '#67c8ff', loans: '#b5a0ff', deposits: '#56d8b4', net_income: '#67c8ff', net_interest_income: '#f4b76c', leverage_ratio: '#56d8b4', cet1_ratio: '#67c8ff', total_capital_ratio: '#b5a0ff', nonperforming_ratio: '#f4b76c', allowance_ratio: '#b5a0ff' };
export const VISUAL_RATIOS = [
  { key: 'loans_to_deposits', label: 'Loans / deposits', numerator: ['loans'], denominator: 'deposits', formula: 'Loans and leases before allowance ÷ total deposits × 100.' },
  { key: 'nonperforming_ratio', label: 'Nonperforming loans / loans', numerator: ['nonaccrual', 'past_due_90'], denominator: 'loans', formula: '(Nonaccrual loans + 90+ days past due, still accruing) ÷ loans before allowance × 100.' },
  { key: 'allowance_ratio', label: 'Allowance / HFI loans', numerator: ['allowance'], denominator: 'loans_hfi', formula: 'Allowance on loans and leases ÷ loans held for investment × 100.' },
  { key: 'brokered_ratio', label: 'Brokered / domestic deposits', numerator: ['brokered_deposits'], denominator: 'domestic_deposits', formula: 'Brokered deposits ÷ domestic deposits × 100. Both components use domestic offices.' },
].map(def => ({ ...def, unit: 'percent', period: 'instant' }));
export const VISUAL_METRICS = [...BANK_METRICS, ...VISUAL_RATIOS];
export function visualMetric(state, rssd, date, key, basis = 'quarterly') {
  const def = VISUAL_RATIOS.find(m => m.key === key);
  if (!def) return bankMetric(state, rssd, date, key, basis);
  const parts = [...def.numerator, def.denominator].map(k => bankMetric(state, rssd, date, k));
  if (parts.some(m => !Number.isFinite(m?.value))) return { ...def, value: null, reason: 'ratio_inputs_unavailable' };
  const denominator = parts.at(-1).value;
  if (denominator <= 0) return { ...def, value: null, reason: 'ratio_denominator_nonpositive' };
  return { ...def, value: parts.slice(0, -1).reduce((sum, m) => sum + m.value, 0) / denominator * 100, derived: def.formula };
}
export function chartPoints(state, rssd, keys, basis = 'quarterly') {
  return [...(state.periods || [])].sort().map(date => {
    const point = { date, label: quarterLabel(date) };
    for (const key of keys) {
      const metric = visualMetric(state, rssd, date, key, basis);
      point[key] = Number.isFinite(metric?.value) ? metric.value / (metric.unit === 'percent' ? 1 : 1e6) : null;
    }
    return point;
  });
}
export function compactMetric(metric) {
  if (!Number.isFinite(metric?.value)) return metric?.reason?.startsWith('not_') ? 'N/A' : 'Unavailable';
  if (metric.unit === 'percent') return `${metric.value.toFixed(2)}%`;
  return `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(metric.value)}`;
}
export function shortBankName(bank) {
  return bank.legal_name.replace(/,?\s*NATIONAL ASSOCIATION$/i, ' N.A.').replace(/\s+/g, ' ');
}
