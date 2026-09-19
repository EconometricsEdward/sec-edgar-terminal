import { buildMarketMacroSummary } from './marketMacroSummary.js';

export const MARKET_BRIEFING_VERSION = 'market-briefing-v1';
export const MARKET_DIRECTORY_VERSION = 'market-directory-v1';
export const MARKET_INDUSTRIES_VERSION = 'market-industries-v1';
export const MARKET_DIRECTORY_PAGE_SIZE = 50;

/** Sector/industry aggregates have bounded size regardless of issuer count. */
export function buildMarketBriefing(overview) {
  return {
    version: MARKET_BRIEFING_VERSION, generatedAt: overview.generatedAt,
    requested: overview.requested, ...(overview.coverage ? { coverage: overview.coverage } : {}),
    summaries: Object.fromEntries(['ttm', 'annual'].map(basis => {
      const summary = buildMarketMacroSummary(overview, basis);
      return [basis, { ...summary, sectors: summary.sectors.map(sector => ({ ...sector,
        industries: sector.industries.map(({ metrics: _metrics, ...industry }) => industry),
      })) }];
    })),
    failureCount: overview.failures.length,
    ...(overview.historyNote ? { historyNote: overview.historyNote } : {}),
    ...(overview.cache ? { cache: overview.cache } : {}),
  };
}

export function buildMarketIndustries(overview) {
  return { version: MARKET_INDUSTRIES_VERSION, generatedAt: overview.generatedAt,
    bases: Object.fromEntries(['ttm', 'annual'].map(basis => [basis,
      buildMarketMacroSummary(overview, basis).sectors.map(({ id, industries, missingIndustryCount }) => ({ id, industries, missingIndustryCount })),
    ])),
  };
}

/** Only the directory's visible identity fields; no financial arrays or histories. */
export function buildMarketDirectory(overview) {
  const sectors = new Map(overview.cohorts.map(sector => [sector.id, sector.label]));
  return { version: MARKET_DIRECTORY_VERSION, generatedAt: overview.generatedAt,
    failureCount: overview.failures.length,
    companies: overview.companies.map(company => ({
      ticker: company.ticker, name: company.name, cik: company.cik,
      sector: company.sector || company.cohorts.map(id => sectors.get(id)).find(Boolean) || 'Unclassified',
      sectorId: company.cohorts.find(id => id.startsWith('sector-')) || '',
      ...(company.revenueBasis ? { revenueBasis: company.revenueBasis } : {}),
    })).sort((a, b) => a.ticker.localeCompare(b.ticker)),
  };
}

export function parseMarketDirectoryQuery(params) {
  if ([...params.keys()].some(key => !['query', 'sector', 'page'].includes(key))
    || ['query', 'sector', 'page'].some(key => params.getAll(key).length > 1)) throw new Error('Use query, sector and page to browse companies.');
  const query = (params.get('query') || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const sector = params.get('sector') || 'all';
  const rawPage = params.get('page') || '1';
  if (query.length > 100 || !/^(all|sector-[a-z0-9-]{1,70})$/.test(sector)
    || !/^[1-9]\d{0,3}$/.test(rawPage)) throw new Error('Choose a valid company search and page.');
  return { query, sector, page: Number(rawPage) };
}

export function pageMarketDirectory(directory, { query = '', sector = 'all', page = 1 } = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const tickerKey = value => value.toLowerCase().replaceAll('.', '-');
  const matches = directory.companies.filter(company => (sector === 'all' || company.sectorId === sector)
    && terms.every(term => `${company.ticker} ${company.name} ${company.sector}`.toLowerCase().includes(term)
      || tickerKey(company.ticker).includes(tickerKey(term))));
  // An exact ticker wins over a name substring without changing stable pagination.
  if (query) matches.sort((a, b) => Number(tickerKey(b.ticker) === tickerKey(query)) - Number(tickerKey(a.ticker) === tickerKey(query))
    || Number(tickerKey(b.ticker).startsWith(tickerKey(query))) - Number(tickerKey(a.ticker).startsWith(tickerKey(query)))
    || a.ticker.localeCompare(b.ticker));
  const current = Math.min(page, Math.max(1, Math.ceil(matches.length / MARKET_DIRECTORY_PAGE_SIZE)));
  return { version: MARKET_DIRECTORY_VERSION, generatedAt: directory.generatedAt,
    query, sector, page: current, pageSize: MARKET_DIRECTORY_PAGE_SIZE, total: matches.length,
    failureCount: directory.failureCount,
    companies: matches.slice((current - 1) * MARKET_DIRECTORY_PAGE_SIZE, current * MARKET_DIRECTORY_PAGE_SIZE),
  };
}
