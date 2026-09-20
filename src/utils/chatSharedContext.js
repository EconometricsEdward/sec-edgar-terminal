// Explicit user attachments only. Keep this boundary independent of financial
// loaders so opening chat does not load the scenario calculation bundle.
const LIMITS = {
  scenarioRevenue: [-50, 50], scenarioMargin: [-20, 20], scenarioLoss: [0, 20], scenarioFunding: [0, 50],
  scenarioVariableCost: [0, 100], scenarioCostChange: [-50, 50], scenarioCashAvailable: [0, 100],
  scenarioReplacementFunding: [0, 50], scenarioTaxRate: [0, 60], scenarioWorkingCapital: [-50, 50],
  scenarioCapexChange: [-100, 100], scenarioBorrowing: [0, 100], scenarioDebtRepayment: [0, 100], scenarioBorrowRate: [0, 30],
};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ticker = value => typeof value === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && value.slice(0, 4) !== '0000' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  && value <= new Date().toISOString().slice(0, 10);
const weight = value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Returns a fresh, strictly shaped snapshot or null. No names, raw files,
 * account identifiers, generated instructions, or financial results accepted. */
export function normalizeSharedChatContext(value) {
  if (value?.kind === 'portfolio') {
    if (!exact(value, ['kind', 'holdings', 'totalHoldings', 'coverageWeight']) || !Array.isArray(value.holdings)
      || !value.holdings.length || value.holdings.length > 25 || !Number.isInteger(value.totalHoldings)
      || value.totalHoldings < value.holdings.length || value.totalHoldings > 100 || !weight(value.coverageWeight)) return null;
    if (value.holdings.some(row => !exact(row, ['ticker', 'weight']) || !ticker(row.ticker) || !weight(row.weight))
      || new Set(value.holdings.map(row => row.ticker)).size !== value.holdings.length) return null;
    const weighted = value.holdings.every(row => row.weight !== null);
    const total = value.holdings.reduce((sum, row) => sum + (row.weight ?? 0), 0);
    if (value.coverageWeight !== null && (!weighted || Math.abs(total - value.coverageWeight) > 1e-6)) return null;
    if (!weighted && value.coverageWeight !== null) return null;
    return { kind: 'portfolio', holdings: value.holdings.map(row => ({ ticker: row.ticker, weight: row.weight })), totalHoldings: value.totalHoldings, coverageWeight: value.coverageWeight };
  }
  if (value?.kind === 'analysis-scenario') {
    if (!exact(value, ['kind', 'ticker', 'basis', 'end', 'asOf', 'assumptions']) || !ticker(value.ticker)
      || !['annual', 'quarter', 'ttm', 'ytd'].includes(value.basis) || !date(value.end)
      || !(value.asOf === '' || date(value.asOf)) || !exact(value.assumptions, [...Object.keys(LIMITS), 'scenarioModel', 'scenarioCashMode'])) return null;
    if (!['margin', 'cost'].includes(value.assumptions.scenarioModel) || !['independent', 'connected'].includes(value.assumptions.scenarioCashMode)) return null;
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      const number = value.assumptions[key];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) return null;
    }
    return { kind: 'analysis-scenario', ticker: value.ticker, basis: value.basis, end: value.end, asOf: value.asOf, assumptions: { ...value.assumptions } };
  }
  return null;
}

/** Uses only the current allocation calculation and public ticker identifiers.
 * Account labels, row names, amounts and uploaded metadata are never copied. */
export function buildSharedPortfolio(rows, summary) {
  const combined = new Map();
  const included = (rows || []).slice(0, 100).filter(row => !row.excluded && !row.mergedInto && row.duplicateChoice !== 'remove');
  for (const row of included) {
    const symbol = String(row.resolution?.ticker || row.input?.ticker || '').trim().toUpperCase();
    if (!ticker(symbol)) continue;
    const allocation = summary?.allocations?.find(item => item.rowId === row.id);
    const fraction = typeof allocation?.weightPct === 'number' && Number.isFinite(allocation.weightPct) ? allocation.weightPct / 100 : null;
    const old = combined.get(symbol);
    combined.set(symbol, old ? { ticker: symbol, weight: old.weight === null || fraction === null ? null : Number((old.weight + fraction).toFixed(12)) } : { ticker: symbol, weight: fraction === null ? null : Number(fraction.toFixed(12)) });
  }
  const all = [...combined.values()].sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1));
  const holdings = all.slice(0, 25);
  const coverageWeight = holdings.every(row => row.weight !== null) ? Number(holdings.reduce((sum, row) => sum + row.weight, 0).toFixed(10)) : null;
  return normalizeSharedChatContext({ kind: 'portfolio', holdings, totalHoldings: included.length, coverageWeight });
}
