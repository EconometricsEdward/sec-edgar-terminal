import { CHANGE_THRESHOLDS, UNIVERSE_METRICS, changeDirection, finite } from './marketFundamentals.js';

export function filingEligibility(row, metric) {
  const definition = UNIVERSE_METRICS.find(item => item.key === metric);
  if (!definition || definition.population === 'operating' && row.financial) return 'excluded';
  const value = row.metrics?.[metric];
  return value && [value.current, value.prior, value.change].every(finite) ? 'paired' : 'missing';
}

/** Snapshot-only diagnostics: no refetching, imputation, or changes to the paired sample. */
export function universeResearchChecks(rows, metric) {
  const eligibility = ['paired', 'missing', 'excluded'].map(id => ({ id, tickers: rows.filter(row => filingEligibility(row, metric) === id).map(row => row.ticker) }));
  const pairs = rows.filter(row => filingEligibility(row, metric) === 'paired');
  const sensitivity = CHANGE_THRESHOLDS.map(threshold => {
    let higher = 0, lower = 0;
    for (const row of pairs) {
      const direction = changeDirection(row.metrics[metric].change, threshold);
      if (direction === 'higher') higher++;
      if (direction === 'lower') lower++;
    }
    return { threshold, eligible: pairs.length, higher, lower, neutral: pairs.length - higher - lower, balance_pct: pairs.length ? 100 * (higher - lower) / pairs.length : null };
  });
  return { version: '2.0.0', metric, population: rows.length, eligibility, sensitivity, definitions: {
    eligibility: 'Comparable pairs require finite current, prior and change values. Operating-only measures exclude financial/property/investment issuers. Missing and excluded are separate populations.',
    sensitivity: 'Fixed paired sample at direction bands 0, 0.5 and 1 percentage points. Neutral values remain in the denominator; net balance = 100 × (higher − lower) / eligible.',
  } };
}

export function matchesResearchScreen(row, screen, metric) {
  if (screen.startsWith('eligibility:')) return filingEligibility(row, metric) === screen.slice(12);
  return true;
}

export function researchCsvCell(value) {
  if (value == null) return '""';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const raw = String(value);
  const safe = /^\s*[=+@-]/.test(raw) || /^[\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
