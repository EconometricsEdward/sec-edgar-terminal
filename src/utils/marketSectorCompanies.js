import { MARKET_PERIOD_INTEGRITY_VERSION, withholdInvalidMarketPeriods } from './marketPeriodIntegrity.js';

export const MARKET_SECTOR_COMPANY_VERSION = 'market-sector-companies-v1';
export const MARKET_SECTOR_COMPANY_PAGE_SIZE = 25;
export const MARKET_SECTOR_COMPANY_METRICS = Object.freeze([
  'revenueGrowth', 'netMargin', 'operatingMargin', 'cashFlowMargin', 'freeCashFlowMargin',
  'debtToAssets', 'liabilitiesToAssets', 'currentRatio', 'cashToAssets', 'interestCoverage',
  'equityToAssets', 'totalAssets', 'revenue',
]);
export const MARKET_SECTOR_COMPANY_SORTS = Object.freeze(['ticker', ...MARKET_SECTOR_COMPANY_METRICS]);
const BASES = ['ttm', 'annual'];
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value));
const validSector = value => typeof value === 'string' && value.trim()
  && !/^(unknown|unclassified|unavailable|n\/a|sector not covered)$/i.test(value.trim());
const tickerKey = value => value.toLowerCase().replaceAll('.', '-');
const companyOrder = (a, b) => a.ticker.localeCompare(b.ticker, 'en') || a.cik.localeCompare(b.cik, 'en');

/** Use the same disjoint primary-sector assignment as the prepared Market briefing. */
function sectorIdentity(company, overview) {
  const cohorts = overview.cohorts || [];
  const primary = cohorts.filter(cohort => cohort.id.startsWith('sector-'));
  const matches = primary.filter(cohort => company.cohorts?.includes(cohort.id));
  const label = validSector(company.sector) ? company.sector.trim()
    : matches.length === 1 && validSector(matches[0].label) ? matches[0].label : null;
  if (!label) return '';
  const cohort = primary.find(row => row.label === label)
    || (overview.coverage ? cohorts.find(row => row.label === label) : null);
  return cohort?.id || `sector-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

function compactReport(report) {
  if (!report || !validDate(report.end)) return null;
  return { end: report.end, filed: validDate(report.filed) ? report.filed : null,
    form: typeof report.form === 'string' && report.form.length > 0 && report.form.length <= 40 ? report.form : null,
    accession: /^\d{10}-\d{2}-\d{6}$/.test(report.accession || '') ? report.accession : null };
}

/** A shared scalar-only projection; visitors never receive a full research atlas. */
export function buildMarketSectorCompanies(overview) {
  const issuers = new Map();
  for (const original of overview.companies) {
    const company = withholdInvalidMarketPeriods(original);
    const cik = String(company.cik).replace(/^0+/, '').padStart(10, '0');
    issuers.set(cik, { ticker: company.ticker, name: company.name, cik,
      sic: String(company.sic ?? ''), sectorId: sectorIdentity(company, overview),
      ...(company.revenueBasis ? { revenueBasis: company.revenueBasis } : {}),
      metrics: Object.fromEntries(BASES.map(basis => [basis, Object.fromEntries(
        MARKET_SECTOR_COMPANY_METRICS.map(key => [key, Number.isFinite(company.metrics?.[basis]?.[key])
          ? company.metrics[basis][key] : null]),
      )])),
      reports: Object.fromEntries(BASES.map(basis => [basis, compactReport(company.reports?.[basis])])),
    });
  }
  return { version: MARKET_SECTOR_COMPANY_VERSION, generatedAt: overview.generatedAt,
    periodIntegrityVersion: MARKET_PERIOD_INTEGRITY_VERSION,
    companies: [...issuers.values()].sort(companyOrder) };
}

export function parseMarketSectorCompaniesQuery(params) {
  const allowed = ['sector', 'basis', 'query', 'sort', 'direction', 'page'];
  if ([...params.keys()].some(key => !allowed.includes(key))
    || allowed.some(key => params.getAll(key).length > 1)) throw new Error('Use sector, basis, query, sort, direction and page to browse sector companies.');
  const sector = params.get('sector') || '';
  const basis = params.get('basis') || 'ttm';
  const query = (params.get('query') || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const sort = params.get('sort') || 'revenueGrowth';
  const direction = params.get('direction') || 'desc';
  const rawPage = params.get('page') || '1';
  if (!/^sector-[a-z0-9-]{1,70}$/.test(sector) || !BASES.includes(basis)
    || query.length > 100 || !MARKET_SECTOR_COMPANY_SORTS.includes(sort)
    || !['asc', 'desc'].includes(direction) || !/^[1-9]\d{0,3}$/.test(rawPage)) {
    throw new Error('Choose a valid sector, reporting basis, metric, direction and page.');
  }
  return { sector, basis, query, sort, direction, page: Number(rawPage) };
}

/** Filter and rank the complete selected sector before producing a bounded page. */
export function pageMarketSectorCompanies(snapshot, { sector, basis = 'ttm', query = '', sort = 'revenueGrowth', direction = 'desc', page = 1 }) {
  const rows = snapshot.companies.filter(company => company.sectorId === sector);
  if (!rows.length) throw Object.assign(new Error('This sector is not present in the prepared snapshot.'), { status: 404 });
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = rows.filter(company => terms.every(term => `${company.ticker} ${company.name} ${company.sic}`.toLowerCase().includes(term)
    || tickerKey(company.ticker).includes(tickerKey(term))));
  matches.sort((a, b) => {
    if (sort === 'ticker') return (direction === 'asc' ? 1 : -1) * companyOrder(a, b);
    const left = a.metrics[basis][sort], right = b.metrics[basis][sort];
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return Number(!Number.isFinite(left)) - Number(!Number.isFinite(right)) || companyOrder(a, b);
    }
    return (direction === 'asc' ? left - right : right - left) || companyOrder(a, b);
  });
  const values = sort === 'ticker' ? [] : matches.map(company => company.metrics[basis][sort]).filter(Number.isFinite).sort((a, b) => a - b);
  const current = Math.min(page, Math.max(1, Math.ceil(matches.length / MARKET_SECTOR_COMPANY_PAGE_SIZE)));
  return { version: MARKET_SECTOR_COMPANY_VERSION, generatedAt: snapshot.generatedAt,
    sector, basis, query, sort, direction, page: current, pageSize: MARKET_SECTOR_COMPANY_PAGE_SIZE,
    total: matches.length, sectorTotal: rows.length, availableCount: sort === 'ticker' ? matches.length : values.length,
    range: values.length ? { min: values[0], max: values[values.length - 1],
      median: (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 } : null,
    companies: matches.slice((current - 1) * MARKET_SECTOR_COMPANY_PAGE_SIZE, current * MARKET_SECTOR_COMPANY_PAGE_SIZE)
      .map(({ metrics, reports, ...company }) => ({ ...company, metrics: metrics[basis], report: reports[basis] })),
  };
}
