// Browser-safe contract for the JSON returned by companyOwnership. Keep the
// projector's server dependencies out of the client bundle.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteOrNull = value => value === null || typeof value === 'number' && Number.isFinite(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const secSource = value => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.sec.gov'
      && url.pathname.startsWith('/Archives/edgar/data/') && !url.username && !url.password;
  } catch { return false; }
};

function validPredecessor(value) {
  // JSON projections explicitly use null for an ordinary issuer or position.
  // Older responses may omit this optional field entirely.
  if (value === null || value === undefined) return true;
  return record(value) && typeof value.name === 'string' && value.name.trim().length > 0
    && typeof value.cik === 'string' && /^\d{1,10}$/.test(value.cik)
    && date(value.effectiveDate) && secSource(value.sourceUrl);
}

export function validCompanyOwnershipPayload(body) {
  if (!record(body)) return false;
  return body.schemaVersion === 'edgar.company-ownership.v1' && typeof body.ticker === 'string'
    && (typeof body.asOf === 'string' || body.asOf === null) && (typeof body.checkedAt === 'string' || body.checkedAt === null)
    && record(body.identity) && ['reported-match', 'unavailable'].includes(body.identity.status)
    && Array.isArray(body.identity.cusips) && body.identity.cusips.every(cusip => typeof cusip === 'string')
    && typeof body.identity.note === 'string' && validPredecessor(body.identity.predecessor)
    && Array.isArray(body.funds) && Array.isArray(body.managers) && record(body.coverage)
    && ['fundsChecked', 'fundsAvailable', 'managersChecked', 'managersAvailable', 'excludedAfterCutoff'].every(key => Number.isFinite(body.coverage[key]))
    && Array.isArray(body.coverage.notPrepared) && body.coverage.notPrepared.every(row => record(row) && typeof row.id === 'string' && typeof row.name === 'string' && typeof row.url === 'string')
    && Array.isArray(body.limitations) && body.limitations.every(note => typeof note === 'string')
    && [...body.funds, ...body.managers].every(row => record(row) && typeof row.id === 'string' && typeof row.name === 'string'
      && typeof row.reportDate === 'string' && typeof row.filingDate === 'string' && typeof row.checkedAt === 'string'
      && secSource(row.sourceUrl) && typeof row.researchUrl === 'string' && typeof row.denominatorLabel === 'string'
      && validPredecessor(row.predecessor)
      && finiteOrNull(row.valueUsd) && finiteOrNull(row.weightPct) && finiteOrNull(row.shares) && finiteOrNull(row.denominatorUsd)
      && Array.isArray(row.positions) && row.positions.every(position => record(position) && typeof position.cusip === 'string'
        && typeof position.name === 'string' && typeof position.classTitle === 'string' && finiteOrNull(position.shares) && finiteOrNull(position.valueUsd)));
}
