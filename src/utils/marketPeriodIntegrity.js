import { validFinancialPeriodDates } from './financialPeriodDates.js';

export const MARKET_PERIOD_INTEGRITY_VERSION = 1;
const bases = ['annual', 'ttm'];
const invalid = period => period != null && !validFinancialPeriodDates(period);

/** Recalculate only affected checkpoints, without invalidating the whole universe. */
export function hasInvalidMarketPeriods(company) {
  return bases.some(basis => invalid(company?.reports?.[basis])
    || Array.isArray(company?.evidence?.[basis]) && company.evidence[basis].some(point => invalid(point?.period))
    || invalid(company?.filingComparisons?.[basis]?.current)
    || invalid(company?.filingComparisons?.[basis]?.prior));
}

/** Legacy scalar snapshots cannot supply a replacement quarter. Withhold that
 * basis until its scheduled recalculation, retaining identity and valid bases. */
export function withholdInvalidMarketPeriods(company) {
  const affected = bases.filter(basis => invalid(company?.reports?.[basis]));
  if (!affected.length) return company;
  return { ...company,
    reports: { ...company.reports, ...Object.fromEntries(affected.map(basis => [basis, null])) },
    metrics: { ...company.metrics, ...Object.fromEntries(affected.map(basis => [basis,
      Object.fromEntries(Object.keys(company.metrics?.[basis] || {}).map(key => [key, null])),
    ])) },
  };
}

export function sanitizeMarketOverviewPeriods(overview) {
  const companies = overview.companies.map(withholdInvalidMarketPeriods);
  return companies.some((company, index) => company !== overview.companies[index]) ? { ...overview, companies } : overview;
}
