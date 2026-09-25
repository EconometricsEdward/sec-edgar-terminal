import { searchFundHoldings } from './fundSecuritySearch.js';
import { compareFundPortfolios } from './fundComparison.js';
import { fundCsv, fundEvidence, normalizeSecurityIdentity } from './fundSecurity.js';

// Compare complete portfolios once, then paginate the finished security matrix.
// Missing reports never reduce the denominator for "held by all" or prove uniqueness.
export function compareAllFundHoldings(portfolios = [], { tickers = portfolios.map(f => f.ticker), scope = 'all', query = '', sort = 'shared', fund = '' } = {}) {
  // A derivative may carry its underlying's identifier. Do not present it as
  // the same holding as the physical stock or bond (or another contract).
  const derivative = holding => /^D(IR|CR|FE|E|CO|O)$/.test(holding.assetCat || '');
  const searched = searchFundHoldings(portfolios.map(p => ({ ...p, holdings: p.holdings.map(h => derivative(h) ? { ...h, cusip: null, isin: null } : h) })));
  const complete = portfolios.length === tickers.length && tickers.every(ticker => portfolios.some(p => p.ticker === ticker));
  const pairs = compareFundPortfolios(portfolios).pairs;
  const words = String(query).trim().toLowerCase().slice(0, 100).split(/\s+/).filter(Boolean);
  const allRows = searched.rows.map(row => {
    const original = row.funds.length === 1 && row.funds[0].positions.length === 1
      ? portfolios.find(p => p.ticker === row.funds[0].ticker)?.holdings[row.funds[0].positions[0].holdingIndex] : null;
    return ({
    key: row.key, name: row.name, ids: row.ids, identityStatus: row.identityStatus,
    fundCount: row.fundCount,
    kind: row.identityStatus !== 'matched-identifiers' ? 'unmatched' : row.fundCount === tickers.length ? 'every' : row.fundCount > 1 ? 'shared' : complete ? 'unique' : 'unconfirmed',
    searchText: [row.name, ...row.ids, ...(original ? normalizeSecurityIdentity(original).ids : []), ...row.funds.flatMap(f => f.positions.flatMap(p => [p.title || '', p.tickerSymbol || '']))].join(' ').toLowerCase(),
    matchNote: original && derivative(original) ? 'Derivative contract · kept separate from underlying securities' : null,
    funds: row.funds.map(({ ticker, value, knownValue, missingValueCount, pctOfNav, knownWeight, missingWeightCount, positionCount }) =>
      ({ ticker, value, knownValue, missingValueCount, pctOfNav, knownWeight, missingWeightCount, positionCount })),
  }); });
  const shared = allRows.filter(row => row.fundCount > 1);
  const every = allRows.filter(row => row.kind === 'every');
  const unique = allRows.filter(row => row.kind === 'unique');
  const largestWeight = row => Math.max(0, ...row.funds.map(f => Math.abs(f.pctOfNav ?? f.knownWeight ?? 0)));
  const largestValue = row => Math.max(0, ...row.funds.map(f => Math.abs(f.value ?? f.knownValue ?? 0)));
  const rows = allRows.filter(row => (!fund || row.funds.some(f => f.ticker === fund))
    && (scope === 'all' || scope === 'shared' && row.fundCount > 1 || scope === row.kind)
    && words.every(word => row.searchText.includes(word)))
    .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'value' ? largestValue(b) - largestValue(a)
      : sort === 'weight' ? largestWeight(b) - largestWeight(a) : b.fundCount - a.fundCount || largestWeight(b) - largestWeight(a)) || a.key.localeCompare(b.key))
    .map(({ searchText: _searchText, ...row }) => row);
  return {
    available: portfolios.length > 0, complete, tickers, scope, query, sort, fund, rows, pairs,
    counts: { total: allRows.length, shared: portfolios.length > 1 ? shared.length : null, every: complete ? every.length : null, unique: complete ? unique.length : null,
      unmatched: allRows.filter(row => row.kind === 'unmatched').length },
    funds: portfolios.map(p => ({ ...fundEvidence(p), netAssets: p.fundInfo?.netAssets ?? null, positions: p.summary?.count ?? p.holdings.length })),
    sharedSeries: searched.sharedSeries,
    methodology: 'Holdings match through unambiguous CUSIP and ISIN identifiers, never names alone. Values are reported USD fair values; weights are percentages of each fund’s NAV. Positions aggregate within each fund only, including signed weights. Missing values stay unavailable. Unidentified or conflicting securities remain separate and cannot establish uniqueness. Overlap uses the smaller positive NAV weight for each matched, explicitly long, non-derivative security, without renormalization. Derivative fair values are not notional exposure. There is no look-through into other funds.',
  };
}

export function multiFundComparisonCsv(result) {
  return fundCsv([
    ['Research', 'All selected fund holdings'], ['Methodology', result.methodology],
    ['Scope', result.scope, 'Query', result.query, 'Sort', result.sort],
    ...result.funds.map(f => ['Fund', f.ticker, 'NAV USD', f.netAssets, 'Portfolio date', f.asOf, 'Filed', f.filingDate, 'Source', f.sourceUrl]),
    ...(result.errors || []).map(f => ['Unavailable fund', f.ticker, f.message]), [],
    ['Holding', 'Identifiers', 'Match status', 'Funds holding', ...result.tickers.flatMap(t => [`${t} presence`, `${t} NAV weight %`, `${t} value USD`, `${t} known weight subtotal %`, `${t} known value subtotal USD`])],
    ...result.rows.map(row => [row.name, row.ids.join('; '), row.kind, row.fundCount, ...result.tickers.flatMap(t => {
      const p = row.funds.find(f => f.ticker === t);
      return p ? ['Reported', p.pctOfNav, p.value, p.knownWeight, p.knownValue]
        : [result.funds.some(f => f.ticker === t) ? 'No matched position' : 'Report unavailable', null, null, null, null];
    })]),
  ]);
}
