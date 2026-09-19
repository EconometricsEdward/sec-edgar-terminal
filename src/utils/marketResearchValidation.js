import { MARKET_SECTOR_COMPANY_VERSION, MARKET_SECTOR_COMPANY_METRICS,
  MARKET_SECTOR_COMPANY_SORTS, MARKET_SECTOR_COMPANY_PAGE_SIZE } from './marketSectorCompanies.js';

const FACTOR_METRIC_KEYS = [
  'revenueGrowth', 'netMargin', 'operatingMargin', 'freeCashFlowMargin', 'equityToAssets', 'cashToAssets',
];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validMetricMap(value) {
  return record(value) && FACTOR_METRIC_KEYS.every((key) => Object.hasOwn(value, key)
    && (value[key] === null || Number.isFinite(value[key])));
}

function validFactorSourceAccessions(value, metrics) {
  return Array.isArray(value)
    && value.every((accession) => /^\d{10}-\d{2}-\d{6}$/.test(accession || ''))
    && new Set(value).size === value.length
    && (!FACTOR_METRIC_KEYS.some((key) => Number.isFinite(metrics[key])) || value.length > 0);
}

function validFactorSourceMasks(value, accessions, metrics) {
  if (!Array.isArray(value) || value.length !== FACTOR_METRIC_KEYS.length) return false;
  const limit = 1n << BigInt(accessions.length);
  return value.every((mask, index) => {
    if (typeof mask !== 'string' || !/^[0-9a-f]+$/.test(mask)) return false;
    const bits = BigInt(`0x${mask}`);
    return bits < limit && (metrics[FACTOR_METRIC_KEYS[index]] === null || bits > 0n);
  });
}

function validComparisonPoint(point) {
  return record(point)
    && validDate(point.end)
    && validDate(point.filed)
    && (point.acceptedAt === null || validDate(point.acceptedAt))
    && typeof point.form === 'string'
    && point.form.length > 0
    && point.form.length <= 40
    && /^\d{10}-\d{2}-\d{6}$/.test(point.accession || '')
    && (point.source === undefined || point.source === null || /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/$/.test(point.source))
    && validMetricMap(point.metrics)
    && validFactorSourceAccessions(point.factorSourceAccessions, point.metrics)
    && validFactorSourceMasks(point.factorSourceMasks, point.factorSourceAccessions, point.metrics);
}

function validFilingComparison(comparison) {
  if (comparison === null) return true;
  if (!record(comparison) || comparison.pointInTime !== true
    || !record(comparison.cutoff)
    || !validDate(comparison.cutoff.filed)
    || (comparison.cutoff.acceptedAt !== null && !validDate(comparison.cutoff.acceptedAt))
    || !/^\d{10}-\d{2}-\d{6}$/.test(comparison.cutoff.accession || '')
    || !validComparisonPoint(comparison.current)
    || comparison.current.accession !== comparison.cutoff.accession
    || !validMetricMap(comparison.changes)) return false;
  if (comparison.prior === null) return comparison.gapDays === null;
  return validComparisonPoint(comparison.prior)
    && Number.isSafeInteger(comparison.gapDays)
    && comparison.gapDays >= 350
    && comparison.gapDays <= 380;
}

function validCompany(company, comparisons = true) {
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
    && Object.hasOwn(company.reports, 'ttm')
    && (!comparisons || (record(company.filingComparisons)
    && Object.hasOwn(company.filingComparisons, 'annual')
    && Object.hasOwn(company.filingComparisons, 'ttm')
    && validFilingComparison(company.filingComparisons.annual)
    && validFilingComparison(company.filingComparisons.ttm)));
}

/** Validate a full per-company SEC research record before trusting shared cache data. */
export function isMarketCompany(value, expectedVersion, expectedTicker) {
  return validCompany(value, false)
    && (expectedVersion === undefined || value.version === expectedVersion)
    && (expectedTicker === undefined || value.ticker === expectedTicker)
    && record(value.evidence)
    && Array.isArray(value.evidence.annual)
    && Array.isArray(value.evidence.ttm);
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
    && value.companies.every(company => validCompany(company))
    && Array.isArray(value.cohorts)
    && value.cohorts.every(validCohort)
    && Array.isArray(value.failures)
    && Array.isArray(value.observations)
    && value.observations.every(validObservation)
    && typeof value.historyPersistence === 'boolean';
}

/** Separate compact display contract; never accepted as a full research atlas. */
export function isMarketOverview(value) {
  return record(value) && value.version === 'market-research-v3' && value.viewVersion === 'market-overview-v1'
    && validDate(value.generatedAt) && Number.isSafeInteger(value.requested) && value.requested > 0
    && Array.isArray(value.companies) && value.companies.length > 0 && value.companies.length <= value.requested
    && value.companies.every(company => validCompany(company, false)
      && ['annual', 'ttm'].every(basis => Object.values(company.metrics[basis]).every(v => v === null || Number.isFinite(v))))
    && new Set(value.companies.map(c => c.cik)).size === value.companies.length
    && Array.isArray(value.cohorts) && value.cohorts.every(validCohort)
    && Array.isArray(value.themes) && value.themes.every(validCohort)
    && Array.isArray(value.failures) && Array.isArray(value.observations) && value.observations.every(validObservation)
    && typeof value.historyPersistence === 'boolean'
    && (!value.coverage || (record(value.coverage)
      && typeof value.coverage.membership_id === 'string'
      && value.coverage.target_issuers === value.requested
      && value.coverage.loaded_issuers === value.companies.length
      && value.coverage.missing_issuers === value.requested - value.companies.length
      && Array.isArray(value.coverage.sources) && value.coverage.sources.length > 0
      && value.coverage.sources.every(source => record(source) && typeof source.fund === 'string'
        && validDate(source.as_of) && typeof source.url === 'string' && source.url.startsWith('https://'))
      && value.companies.every(company => typeof company.sector === 'string'
        && value.cohorts.filter(cohort => company.cohorts.includes(cohort.id)).length === 1)));
}

const BRIEFING_METRICS = ['revenueGrowth', 'netMargin', 'cashFlowMargin', 'capexIntensity', 'equityToAssets', 'netIncome'];
const count = value => Number.isSafeInteger(value) && value >= 0;
function validBriefingStats(stats, total) {
  return record(stats) && stats.total === total && count(stats.count) && stats.count <= total
    && count(stats.positive) && count(stats.negative) && stats.positive + stats.negative <= stats.count
    && (stats.count === 0 ? stats.median === null && stats.mean === null && stats.positivePct === null
      : Number.isFinite(stats.median) && Number.isFinite(stats.mean)
        && Math.abs(stats.positivePct - stats.positive / stats.count * 100) < 1e-8);
}
function validBriefingMetrics(metrics, total) {
  return record(metrics) && BRIEFING_METRICS.every(key => validBriefingStats(metrics[key], total));
}
function validIndustry(industry, withMetrics = false) {
  return record(industry) && /^\d{4}$/.test(industry.code) && typeof industry.label === 'string'
    && typeof industry.known === 'boolean' && count(industry.count) && industry.count > 0
    && (!withMetrics || validBriefingMetrics(industry.metrics, industry.count));
}
function validBriefingSummary(summary, generatedAt) {
  if (!record(summary) || summary.generatedAt !== generatedAt
    || !['companyCount', 'sectorCount', 'industryCount', 'missingSectorCount', 'missingIndustryCount',
      'unknownIndustryCount', 'unknownIndustryCompanyCount', 'olderReports'].every(key => count(summary[key]))
    || summary.companyCount === 0 || summary.olderReports > summary.companyCount
    || !Array.isArray(summary.sectors) || summary.sectors.length !== summary.sectorCount
    || !Array.isArray(summary.industries) || summary.industries.length !== summary.industryCount
    || !summary.industries.every(industry => validIndustry(industry))
    || new Set(summary.industries.map(industry => industry.code)).size !== summary.industryCount
    || !validBriefingMetrics(summary.metrics, summary.companyCount)
    || !['growth', 'profit', 'cash'].every(key => validBriefingStats(summary[key], summary.companyCount))
    || summary.classificationSource !== 'https://www.sec.gov/search-filings/standard-industrial-classification-sic-code-list') return false;
  if (!summary.sectors.every(sector => record(sector) && /^sector-[a-z0-9-]+$/.test(sector.id)
    && typeof sector.label === 'string' && count(sector.count) && sector.count > 0
    && (sector.targetCount === null || count(sector.targetCount))
    && count(sector.missingIndustryCount) && Array.isArray(sector.industries)
    && sector.industries.every(industry => validIndustry(industry))
    && sector.industries.reduce((sum, industry) => sum + industry.count, sector.missingIndustryCount) === sector.count
    && validBriefingMetrics(sector.metrics, sector.count))) return false;
  return new Set(summary.sectors.map(sector => sector.id)).size === summary.sectorCount
    && summary.sectors.reduce((sum, sector) => sum + sector.count, summary.missingSectorCount) === summary.companyCount
    && summary.industries.reduce((sum, industry) => sum + industry.count, summary.missingIndustryCount) === summary.companyCount
    && (summary.reportRange === null || record(summary.reportRange) && validDate(summary.reportRange.earliest)
      && validDate(summary.reportRange.latest) && summary.reportRange.earliest <= summary.reportRange.latest
      && count(summary.reportRange.count) && summary.reportRange.count <= summary.companyCount);
}

/** A separate aggregate contract: thousands of company records never hydrate the page. */
export function isMarketBriefing(value) {
  return record(value) && value.version === 'market-briefing-v1' && validDate(value.generatedAt)
    && count(value.requested) && value.requested > 0 && count(value.failureCount)
    && record(value.summaries) && ['annual', 'ttm'].every(basis => validBriefingSummary(value.summaries[basis], value.generatedAt))
    && value.summaries.annual.companyCount === value.summaries.ttm.companyCount
    && value.summaries.ttm.companyCount <= value.requested
    && (!value.coverage || record(value.coverage) && value.coverage.target_issuers === value.requested
      && value.coverage.loaded_issuers === value.summaries.ttm.companyCount
      && value.coverage.missing_issuers === value.requested - value.summaries.ttm.companyCount
      && Array.isArray(value.coverage.sources) && value.coverage.sources.every(source => record(source)
        && typeof source.fund === 'string' && validDate(source.as_of) && /^https:\/\//.test(source.url)));
}

export function isMarketDirectory(value) {
  return record(value) && value.version === 'market-directory-v1' && validDate(value.generatedAt)
    && count(value.failureCount) && Array.isArray(value.companies) && value.companies.length > 0
    && value.companies.every(company => record(company) && /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(company.ticker)
      && typeof company.name === 'string' && company.name.length > 0 && /^\d{1,10}$/.test(company.cik)
      && Number(company.cik) > 0 && typeof company.sector === 'string' && typeof company.sectorId === 'string')
    && new Set(value.companies.map(company => String(Number(company.cik)))).size === value.companies.length;
}

export function isMarketIndustries(value) {
  return record(value) && value.version === 'market-industries-v1' && validDate(value.generatedAt)
    && record(value.bases) && ['annual', 'ttm'].every(basis => Array.isArray(value.bases[basis])
      && value.bases[basis].every(sector => record(sector) && /^sector-[a-z0-9-]+$/.test(sector.id)
        && count(sector.missingIndustryCount) && Array.isArray(sector.industries)
        && sector.industries.every(industry => validIndustry(industry, true))));
}

function validSectorCompanyIdentity(company) {
  return record(company) && /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(company.ticker)
    && typeof company.name === 'string' && company.name.length > 0
    && /^\d{10}$/.test(company.cik) && Number(company.cik) > 0
    && typeof company.sic === 'string' && company.sic.length <= 4
    && typeof company.sectorId === 'string' && /^(|sector-[a-z0-9-]{1,70})$/.test(company.sectorId)
    && (company.revenueBasis === undefined || typeof company.revenueBasis === 'string');
}
function validSectorCompanyMetrics(metrics) {
  return record(metrics) && Object.keys(metrics).length === MARKET_SECTOR_COMPANY_METRICS.length
    && MARKET_SECTOR_COMPANY_METRICS.every(key => Object.hasOwn(metrics, key)
      && (metrics[key] === null || Number.isFinite(metrics[key])));
}
function validSectorCompanyReport(report) {
  return report === null || record(report) && validDate(report.end)
    && (report.filed === null || validDate(report.filed))
    && (report.form === null || typeof report.form === 'string' && report.form.length > 0 && report.form.length <= 40)
    && (report.accession === null || /^\d{10}-\d{2}-\d{6}$/.test(report.accession));
}

/** Durable scalar-only contract, kept separate from the full filing research atlas. */
export function isMarketSectorCompanies(value) {
  return record(value) && value.version === MARKET_SECTOR_COMPANY_VERSION && validDate(value.generatedAt)
    && Array.isArray(value.companies) && value.companies.length > 0
    && value.companies.every(company => validSectorCompanyIdentity(company)
      && record(company.metrics) && record(company.reports)
      && ['ttm', 'annual'].every(basis => validSectorCompanyMetrics(company.metrics[basis])
        && validSectorCompanyReport(company.reports[basis])))
    && new Set(value.companies.map(company => company.cik)).size === value.companies.length;
}

/** Validate a page and bind it to the exact request so stale sector/basis responses cannot render. */
export function isMarketSectorCompaniesPage(value, selection) {
  if (!record(value) || value.version !== MARKET_SECTOR_COMPANY_VERSION || !validDate(value.generatedAt)
    || !/^sector-[a-z0-9-]{1,70}$/.test(value.sector) || !['ttm', 'annual'].includes(value.basis)
    || typeof value.query !== 'string' || value.query.length > 100
    || !MARKET_SECTOR_COMPANY_SORTS.includes(value.sort) || !['asc', 'desc'].includes(value.direction)
    || value.pageSize !== MARKET_SECTOR_COMPANY_PAGE_SIZE || !count(value.total)
    || !count(value.sectorTotal) || value.sectorTotal === 0 || value.total > value.sectorTotal
    || !count(value.availableCount) || value.availableCount > value.total
    || !Number.isSafeInteger(value.page) || value.page < 1
    || value.page > Math.max(1, Math.ceil(value.total / MARKET_SECTOR_COMPANY_PAGE_SIZE))
    || !Array.isArray(value.companies)
    || value.companies.length !== Math.min(MARKET_SECTOR_COMPANY_PAGE_SIZE,
      Math.max(0, value.total - (value.page - 1) * MARKET_SECTOR_COMPANY_PAGE_SIZE))
    || !value.companies.every(company => validSectorCompanyIdentity(company) && company.sectorId === value.sector
      && validSectorCompanyMetrics(company.metrics) && validSectorCompanyReport(company.report))
    || new Set(value.companies.map(company => company.cik)).size !== value.companies.length) return false;
  if (value.sort === 'ticker') {
    if (value.range !== null || value.availableCount !== value.total) return false;
  } else if (value.availableCount === 0) {
    if (value.range !== null) return false;
  } else if (!record(value.range) || !['min', 'max', 'median'].every(key => Number.isFinite(value.range[key]))
    || value.range.min > value.range.median || value.range.median > value.range.max) return false;
  return !selection || value.sector === selection.sector && value.basis === selection.basis
    && value.query === (selection.query || '').trim().replace(/\s+/g, ' ').toLowerCase()
    && value.sort === selection.sort && value.direction === selection.direction
    && value.page === Math.min(selection.page, Math.max(1, Math.ceil(value.total / MARKET_SECTOR_COMPANY_PAGE_SIZE)));
}
