import { CHANGE_THRESHOLDS, UNIVERSE_METRICS, changeDirection, finite } from './marketFundamentals.js';

export const BETA_READINGS = [
  ['above_one', 'Interval entirely above 1'],
  ['below_one', 'Positive interval entirely below 1'],
  ['inverse', 'Interval entirely below 0'],
  ['includes_zero', 'Interval includes 0'],
  ['includes_one', 'Positive interval includes 1'],
  ['unavailable', 'Valid interval unavailable'],
];

export function betaReading(exposure) {
  const interval = exposure?.beta_interval;
  if (!finite(exposure?.beta) || !Array.isArray(interval) || interval.length !== 2 ||
      !interval.every(finite) || interval[0] > interval[1] ||
      exposure.beta < interval[0] || exposure.beta > interval[1]) return 'unavailable';
  const [lo, hi] = interval;
  if (hi < 0) return 'inverse';
  if (lo <= 0) return 'includes_zero';
  if (lo > 1) return 'above_one';
  if (hi < 1) return 'below_one';
  return 'includes_one';
}

export function filingEligibility(row, metric) {
  const definition = UNIVERSE_METRICS.find(m => m.key === metric);
  if (!definition || (definition.population === 'operating' && row.financial)) return 'excluded';
  const m = row.metrics?.[metric];
  return m && [m.current, m.prior, m.change].every(finite) ? 'paired' : 'missing';
}

/** Snapshot-only diagnostics: no refetching, imputation, or changes to the paired sample. */
export function universeResearchChecks(rows, metric) {
  const eligibility = ['paired', 'missing', 'excluded'].map(id => ({
    id, tickers: rows.filter(row => filingEligibility(row, metric) === id).map(row => row.ticker),
  }));
  const pairs = rows.filter(row => filingEligibility(row, metric) === 'paired');
  const sensitivity = CHANGE_THRESHOLDS.map(threshold => {
    let higher = 0, lower = 0;
    for (const row of pairs) {
      const direction = changeDirection(row.metrics[metric].change, threshold);
      if (direction === 'higher') higher++;
      if (direction === 'lower') lower++;
    }
    return { threshold, eligible: pairs.length, higher, lower, neutral: pairs.length - higher - lower,
      balance_pct: pairs.length ? 100 * (higher - lower) / pairs.length : null };
  });
  const beta = BETA_READINGS.map(([id, label]) => ({ id, label, tickers: [] }));
  const buckets = new Map(beta.map(item => [item.id, item.tickers]));
  for (const row of rows) buckets.get(betaReading(row.exposure)).push(row.ticker);
  return { version: '1.0.0', metric, population: rows.length, eligibility, sensitivity, beta,
    definitions: {
      eligibility: 'Comparable pairs require finite current, prior and change values. Operating-only measures exclude financial/property/investment issuers. Missing and excluded are separate populations.',
      sensitivity: 'Fixed paired sample at direction bands 0, 0.5 and 1 percentage points. Neutral values remain in the denominator; net balance = 100 × (higher − lower) / eligible.',
      beta: 'Individual 95% HAC slope intervals, without multiple-comparison adjustment. Intervals including zero take precedence over intervals including one. Missing, nonfinite, reversed or point-excluding intervals are unavailable.',
    } };
}

export function matchesResearchScreen(row, screen, metric) {
  if (screen.startsWith('eligibility:')) return filingEligibility(row, metric) === screen.slice(12);
  if (screen.startsWith('beta:')) return betaReading(row.exposure) === screen.slice(5);
  return true;
}

export function researchCsvCell(value) {
  const raw = String(value ?? '');
  const safe = typeof value === 'string' && (/^\s*[=+@-]/.test(raw) || /^[\t\r\n]/.test(raw)) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
