function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validCompany(company) {
  return record(company)
    && typeof company.version === 'string'
    && typeof company.ticker === 'string'
    && typeof company.name === 'string'
    && typeof company.cik === 'string'
    && ['string', 'number'].includes(typeof company.sic)
    && validDate(company.observedAt)
    && Array.isArray(company.cohorts)
    && company.cohorts.every((cohort) => typeof cohort === 'string')
    && record(company.metrics)
    && record(company.metrics.annual)
    && record(company.metrics.ttm)
    && record(company.reports)
    && Object.hasOwn(company.reports, 'annual')
    && Object.hasOwn(company.reports, 'ttm');
}

function validCohort(cohort) {
  return record(cohort)
    && ['id', 'label', 'title', 'description', 'disclosureTerms']
      .every((key) => typeof cohort[key] === 'string')
    && Array.isArray(cohort.tickers)
    && cohort.tickers.every((ticker) => typeof ticker === 'string');
}

function validStats(stats) {
  return record(stats)
    && Number.isFinite(stats.count)
    && (stats.median === null || Number.isFinite(stats.median));
}

function validObservation(observation) {
  return record(observation)
    && validDate(observation.observedAt)
    && Number.isFinite(observation.companies)
    && Array.isArray(observation.tickers)
    && observation.tickers.every((ticker) => typeof ticker === 'string')
    && validStats(observation.revenueGrowth)
    && validStats(observation.netMargin);
}

/** Validate the fields consumed by the Market UI before trusting a shared snapshot. */
export function isMarketAtlas(value, expectedVersion) {
  return record(value)
    && (expectedVersion === undefined || value.version === expectedVersion)
    && validDate(value.generatedAt)
    && Number.isSafeInteger(value.requested)
    && value.requested >= 0
    && Array.isArray(value.companies)
    && value.companies.every(validCompany)
    && Array.isArray(value.cohorts)
    && value.cohorts.every(validCohort)
    && Array.isArray(value.failures)
    && Array.isArray(value.observations)
    && value.observations.every(validObservation)
    && typeof value.historyPersistence === 'boolean';
}
