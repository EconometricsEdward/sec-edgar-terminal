import { CFTC_FAMILIES, CFTC_HISTORY_WINDOWS, CFTC_REPORT_BASIS, cftcDate, cftcGroup, isCftcContractCode, isCftcFamily } from './cftc.js';
import { isCftcEnabled } from './cftcFeature.js';
import { MARKET_METRICS } from './marketResearch.js';
import { MARKET_SECTOR_COMPANY_SORTS, pageMarketSectorCompanies, parseMarketSectorCompaniesQuery } from './marketSectorCompanies.js';
import { isMarketSectorCompaniesPage } from './marketResearchValidation.js';
import { QUANT_GROUPS } from './quantGroups.js';

const ORIGIN = 'https://secedgarterminal.com';
const blank = (description, maxLength = 100) => ({ type: 'string', maxLength, description });
const choice = (values, description) => ({ type: 'string', enum: ['', ...values], description });
const metricDefinitions = new Map(MARKET_METRICS.map(metric => [metric.key, metric]));
const sectorId = value => {
  const normalized = value.trim().toLowerCase();
  const known = QUANT_GROUPS.find(group => [group.id, group.label].some(label => label.toLowerCase() === normalized));
  return known?.id || (normalized.startsWith('sector-') ? normalized
    : `sector-${normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);
};
const sample = (rows, max) => rows.length <= max ? rows : Array.from({ length: max }, (_, index) => rows[Math.round(index * (rows.length - 1) / (max - 1))]);

/** Compact, read-only projections of the same prepared Market data used by the
 * page. No SEC company crawl or CFTC refresh is started by either tool. */
export function createMarketChatTools(api) {
  const { tool, read, addSource, fail, unavailable, txt, finite, context = {}, dependencies = {}, publicJson, preview = false } = api;
  const page = new URLSearchParams(context.query || '');
  const hint = (key, fallback = '') => context[key] || page.get(key) || fallback;
  const sectorReader = dependencies.sectorCompanies || (async (selection, signal) => {
    if (preview) return (await publicJson('/api/market-sector-companies', selection, signal, 256 * 1024)).payload;
    const { readMarketServingView } = await import('./marketBriefingServer.js');
    signal.throwIfAborted();
    return pageMarketSectorCompanies(await readMarketServingView('sectorCompanies'), selection);
  });
  const historyReader = dependencies.cftcHistory || (async (selection, signal) => {
    if (preview) return (await publicJson('/api/v1/cftc/history', { family: selection.family, contract: selection.code,
      group: selection.group, date: selection.reportDate, window: selection.window, prepared: 'true' }, signal, 4 * 1024 * 1024)).payload;
    const { loadCftcHistory } = await import('./cftcServer.js');
    return loadCftcHistory({ ...selection, preparedOnly: true, signal });
  });
  const catalogReader = dependencies.cftc || (async (family, signal) => {
    if (preview) return (await publicJson('/api/v1/cftc/markets', { family }, signal, 4 * 1024 * 1024)).payload;
    return (await import('./cftcServer.js')).loadCftcMarkets({ family, preparedOnly: true, signal });
  });
  return {
    sector_companies: tool('Rank or search companies within one Market sector using the complete prepared sector before pagination. Reuses the exact selected company metric, direction, search and page when inputs are blank. Financial fundamentals, not stock returns; percentage values are percentage points, not fractions.', {
      sector: blank('Exact sector name or sector-ID; blank uses the selected sector.'),
      basis: choice(['annual', 'ttm'], 'Blank uses the selected reporting basis, otherwise TTM.'),
      metric: choice(MARKET_SECTOR_COMPANY_SORTS, 'Ranking metric; blank uses the selected company metric, otherwise revenueGrowth.'),
      direction: choice(['asc', 'desc'], 'Ascending for weakest/smallest, descending for strongest/largest; blank uses selected direction.'),
      query: blank('Name/ticker search inside the sector. Blank uses selected search; * explicitly clears that search.'),
      page: blank('Positive page number, at most 9999. Blank uses selected page.', 4),
    }, 'Reading sector companies', async input => {
      const selectedSector = input.sector.trim() || hint('sector', hint('cohort'));
      if (!selectedSector || selectedSector === 'all') return { status: 'needs_selection', message: 'Choose one sector. Use market_summary to list prepared sector names and identifiers.' };
      let selection;
      try {
        selection = parseMarketSectorCompaniesQuery(new URLSearchParams({ sector: sectorId(selectedSector), basis: input.basis || hint('basis', 'ttm'),
          sort: input.metric || hint('companyMetric', 'revenueGrowth'), direction: input.direction || hint('companyDirection', 'desc'),
          query: input.query.trim() === '*' ? '' : input.query.trim() || hint('companyQuery'), page: input.page.trim() || String(hint('companyPage', '1')) }));
      } catch { throw fail('Choose a valid sector, annual/TTM basis, ranking metric, direction and page.'); }
      const result = await read(`sector-companies:${JSON.stringify(selection)}`, signal => sectorReader(selection, signal));
      if (!isMarketSectorCompaniesPage(result, selection)) throw fail('The sector data did not match the requested sector, basis or ranking.', 'SOURCE_IDENTITY_MISMATCH');
      const params = new URLSearchParams({ tab: 'sectors', cohort: selection.sector, basis: selection.basis,
        companyMetric: selection.sort, companyDirection: selection.direction, companyPage: String(result.page) });
      if (selection.query) params.set('companyQuery', selection.query);
      const source = addSource('EDGAR Terminal · Sector companies', `${ORIGIN}/market?${params}`, result.generatedAt);
      if (!source) return unavailable('The prepared sector source could not be cited.');
      const definition = metricDefinitions.get(selection.sort);
      return { status: 'ready', selection, snapshotAt: result.generatedAt, page: result.page, pageSize: result.pageSize,
        matchedCompanies: result.total, sectorCompanies: result.sectorTotal, availableCount: result.availableCount,
        metric: { key: selection.sort, label: definition?.label || 'Ticker', unit: definition?.unit || 'text', formula: definition?.formula || null },
        range: result.range, sourceIds: [source],
        units: 'pct values are percentage points (12.5 = 12.5%), ratio values are multiples, USD values are whole dollars. Null is unavailable, never zero.',
        scope: 'Ranked within the prepared SEC company sector and any stated search filter, before pagination. Each company has its own fiscal end; snapshot time is not a common financial period. Filing-based fundamentals, not stock-price returns. Row order is deterministic and equal metric values can share economic rank.',
        companies: result.companies.map((company, index) => ({ position: (result.page - 1) * result.pageSize + index + 1,
          ticker: company.ticker, name: txt(company.name, 120), cik: company.cik, report: company.report,
          revenueBasis: txt(company.revenueBasis, 160) || null,
          value: selection.sort === 'ticker' ? company.ticker : finite(company.metrics[selection.sort]),
          status: selection.sort === 'ticker' || finite(company.metrics[selection.sort]) !== null ? 'available' : 'unavailable',
          sourceIds: [source] })),
      };
    }),
    cftc_history: tool('Read an exact prepared CFTC contract, trader group, report date and history window from any page. Blank fields use the current Market selection. Accepts a verified contract code or a contract name to resolve against the full prepared catalog. Historical dates must match an actual report. Never starts a CFTC download on an unprepared chart.', {
      family: choice(['tff', 'disaggregated'], 'Report family; blank uses the current family, otherwise TFF.'),
      contract: blank('CFTC contract code or contract name; blank uses selected contract.', 120),
      group: blank('Trader group ID from this family; blank uses the selected group or leveraged-funds/managed-money default.', 40),
      date: blank('Exact report date YYYY-MM-DD, or latest; blank uses selected date, otherwise latest.', 10),
      window: choice(Object.keys(CFTC_HISTORY_WINDOWS), 'Historical window; blank uses selected history window, otherwise 5y.'),
    }, 'Reading selected CFTC history', async input => {
      if (!(dependencies.cftcEnabled || isCftcEnabled)()) return unavailable('CFTC research is currently disabled.');
      const family = input.family || hint('family', 'tff');
      const contract = input.contract.trim() || hint('contract');
      const group = input.group.trim() || hint('group', family === 'tff' ? 'leveraged-funds' : 'managed-money');
      const reportDate = input.date.trim() || hint('date', 'latest'), window = input.window || hint('history', '5y');
      const { isCftcPublicReportDate, validHistoryResponse } = await import('./cftcServer.js');
      if (!isCftcFamily(family) || !cftcGroup(family, group) || !Object.hasOwn(CFTC_HISTORY_WINDOWS, window)
        || reportDate !== 'latest' && (cftcDate(reportDate) !== reportDate || !isCftcPublicReportDate(reportDate))) throw fail('Choose a valid CFTC family, trader group, report date within the retained six-year range, and history window.');
      let code = contract.toUpperCase();
      if (!isCftcContractCode(code) || !/[0-9+]/.test(code)) {
        const catalog = await read(`cftc:${family}`, signal => catalogReader(family, signal));
        if (catalog?.report_family !== family || catalog?.report_basis !== CFTC_REPORT_BASIS || !Array.isArray(catalog.catalog)) throw fail('The prepared CFTC catalog did not match this report family.', 'SOURCE_IDENTITY_MISMATCH');
        const terms = contract.toLowerCase().split(/\s+/).filter(Boolean);
        const choices = catalog.catalog.filter(item => isCftcContractCode(item.code) && terms.every(term =>
          `${item.code} ${item.label || ''} ${item.contractName || ''} ${item.marketName || ''}`.toLowerCase().includes(term)));
        const exact = choices.filter(item => [item.code, item.label, item.contractName, item.marketName].some(name => typeof name === 'string' && name.toLowerCase() === contract.toLowerCase()));
        const matches = exact.length ? exact : choices;
        if (matches.length !== 1 || !contract) return { status: 'needs_selection', family,
          message: matches.length ? 'Choose the intended CFTC contract before interpreting its positions.' : 'No contract matched this family. Supply the contract code from CFTC Positioning or choose another family.',
          choices: matches.slice(0, 12).map(item => ({ id: item.code, code: item.code, name: txt(item.label || item.contractName || item.marketName, 120) })), truncated: matches.length > 12 };
        code = matches[0].code;
      }
      const selection = { family, code, group, reportDate, window };
      let result;
      try { result = await read(`cftc-history:${JSON.stringify(selection)}`, signal => historyReader(selection, signal)); }
      catch (error) {
        if (error.code === 'CFTC_REPORT_NOT_PREPARED' || error.status === 404) return unavailable('This exact contract, trader group, date and window does not have a prepared chart yet. Open CFTC Positioning for available coverage; no source download was started by chat.', 'SOURCE_NOT_PREPARED', { selection });
        throw error;
      }
      const actualDate = result?.selection?.report_date;
      if (!actualDate || reportDate !== 'latest' && actualDate !== reportDate
        || !validHistoryResponse(result, family, code, group, actualDate, window, Date.now())) throw fail('The CFTC chart did not match the requested contract, group, report date, or verified calculations.', 'SOURCE_IDENTITY_MISMATCH');
      const params = new URLSearchParams({ tab: 'positioning', family, contract: code, group, date: actualDate, history: window });
      const sourceIds = [addSource(`CFTC · ${txt(result.selected.contractName || result.selected.marketName, 100)} · ${cftcGroup(family, group).label}`,
        result.source.history_url || result.source.url || CFTC_FAMILIES[family].sourceUrl, actualDate),
      addSource('EDGAR Terminal · Selected CFTC chart', `${ORIGIN}/market?${params}`, actualDate)].filter(Boolean);
      if (!sourceIds.length) return unavailable('The prepared CFTC history could not be cited.');
      const selected = result.selected, participant = selected.groups[group];
      const history = result.history;
      const valid = history.filter(point => finite(point.netPctOi) !== null);
      const min = valid.reduce((best, point) => !best || point.netPctOi < best.netPctOi ? point : best, null);
      const max = valid.reduce((best, point) => !best || point.netPctOi > best.netPctOi ? point : best, null);
      const first = history[0], last = history.at(-1);
      const endpoint = point => ({ date: point?.reportDate || null, netContracts: finite(point?.net), netPctOi: finite(point?.netPctOi) });
      return { status: 'ready', sourceStatus: result.status, selection: { ...selection, actualDate }, sourceIds,
        market: { name: txt(selected.contractName || selected.marketName, 120), exchange: txt(selected.exchange, 100), contractUnits: txt(selected.units, 100) },
        freshness: result.freshness, retrievedAt: result.retrieved_at, coverage: result.coverage, warning: txt(result.refresh_warning, 300) || null,
        units: 'Positions are numbers of contracts, not dollars. Net/OI and percentile are percentages (12.5 = 12.5%); Net/OI changes are percentage points. Null means unavailable, never zero.',
        scope: 'Aggregate trader-category futures-only positioning, not the selected company’s holdings, hedge coverage, or a prediction of prices. Comparisons exclude all reports after the selected report date.',
        selected: { reportDate: actualDate, openInterest: finite(selected.openInterest), long: finite(participant.long), short: finite(participant.short),
          spreading: finite(participant.spreading), net: finite(participant.net), netPctOi: finite(participant.netPctOi),
          oneWeekChange: finite(selected.oneWeekChange), oneWeekNetPctChange: finite(selected.oneWeekNetPctChange),
          fourWeekChange: finite(selected.fourWeekChange), fourWeekNetPctChange: finite(selected.fourWeekNetPctChange),
          previousAvailableDate: selected.previousAvailableDate, previousAvailableChange: finite(selected.previousAvailableChange),
          previousAvailableElapsedDays: finite(selected.previousAvailableElapsedDays) },
        percentile: result.percentile, shorterPercentiles: result.shorter_percentiles,
        historicalRange: { first: endpoint(first), latest: endpoint(last), minimumNetPctOi: endpoint(min), maximumNetPctOi: endpoint(max),
          netContractsChange: finite(first.net) !== null && finite(last.net) !== null ? last.net - first.net : null,
          netPctOiChange: finite(first.netPctOi) !== null && finite(last.netPctOi) !== null ? last.netPctOi - first.netPctOi : null,
          note: 'Changes compare the actual first and last dates in retained compatible history. Extrema are calculated across every retained observation before sampling; endpoint changes do not establish a continuous trend.' },
        history: sample(history, 24).map(point => ({ date: point.reportDate, net: finite(point.net), netPctOi: finite(point.netPctOi),
          openInterest: finite(point.openInterest), unavailable: point.derivedUnavailable, sourceIds })),
        historySampled: history.length > 24, historyObservations: history.length,
        historyNote: history.length > 24 ? 'Evenly sampled dated observations include the first and selected dates. Intervening observations are omitted; use the linked chart for the complete series.' : 'All retained dated observations are shown.',
      };
    }),
  };
}
