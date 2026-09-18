// Small shared contract prevents warm/client caches serving an older mapping.
export const COMPANY_CONCENTRATIONS_VERSION = 'company-concentrations-v3';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const group = value => record(value) && typeof value.id === 'string' && Array.isArray(value.rows) && value.rows.length > 0
  && value.rows.every(row => record(row) && typeof row.id === 'string' && Number.isFinite(row.value)
    && (row.share === null || Number.isFinite(row.share)) && record(row.fact) && row.fact.value === row.value
    && typeof row.fact.sourceUrl === 'string');
export function matchesCompanyConcentrations(body, ticker, basis = 'ttm', asOf = '') {
  return Boolean(record(body) && body.schemaVersion === COMPANY_CONCENTRATIONS_VERSION && body.ticker === ticker
    && body.basis === basis && (body.asOf || '') === (asOf || '')
    && ['ready', 'no_matches', 'no_filing'].includes(body.status)
    && Array.isArray(body.revenue) && body.revenue.every(group) && Array.isArray(body.credit) && body.credit.every(group)
    && (body.funding === null || group(body.funding)));
}
