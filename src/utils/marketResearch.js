export const MARKET_VERSION = 'market-research-v1';
export const MARKET_SAVED_KEY = 'edgar:market-research:v1';
export const MARKET_METRICS = [
  { key: 'revenueGrowth', label: 'Revenue growth', unit: 'pct', formula: '(Revenue / prior-year revenue − 1) × 100', inputs: ['revenue'], growth: true },
  { key: 'netMargin', label: 'Net margin', unit: 'pct', formula: 'Net income / revenue × 100', inputs: ['netIncome', 'revenue'] },
  { key: 'operatingMargin', label: 'Operating margin', unit: 'pct', formula: 'Operating income / revenue × 100', inputs: ['operatingIncome', 'revenue'] },
  { key: 'cashFlowMargin', label: 'Operating cash flow / revenue', unit: 'pct', formula: 'Operating cash flow / revenue × 100', inputs: ['operatingCashFlow', 'revenue'] },
  { key: 'freeCashFlowMargin', label: 'Free cash flow / revenue', unit: 'pct', formula: '(Operating cash flow − |PP&E purchases|) / revenue × 100', inputs: ['operatingCashFlow', 'capex', 'revenue'] },
  { key: 'capexIntensity', label: 'Capex / revenue', unit: 'pct', formula: '|PP&E purchases| / revenue × 100', inputs: ['capex', 'revenue'] },
  { key: 'equityToAssets', label: 'Book equity / assets', unit: 'pct', formula: 'Stockholders’ equity / assets × 100', inputs: ['stockholdersEquity', 'totalAssets'] },
  { key: 'liabilitiesToAssets', label: 'Liabilities / assets', unit: 'pct', formula: 'Liabilities / assets × 100', inputs: ['totalLiabilities', 'totalAssets'] },
  { key: 'cashToAssets', label: 'Cash / assets', unit: 'pct', formula: 'Tagged cash and cash equivalents / assets × 100', inputs: ['cash', 'totalAssets'] },
  { key: 'revenue', label: 'Revenue', unit: 'usd', inputs: ['revenue'] },
  { key: 'totalAssets', label: 'Total assets', unit: 'usd', inputs: ['totalAssets'] },
  { key: 'netIncome', label: 'Net income', unit: 'usd', inputs: ['netIncome'] },
];

export const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
export function formatMarket(value, unit = 'pct', digits = 1) {
  if (!isNumber(value)) return '—';
  if (unit === 'usd') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return `${value.toFixed(digits)}%`;
}
export function metricStats(companies, basis, key) {
  const values = companies.map((c) => c.metrics[basis]?.[key]).filter(isNumber).sort((a, b) => a - b);
  const count = values.length;
  return { count, total: companies.length, median: count ? (values[Math.floor((count - 1) / 2)] + values[Math.floor(count / 2)]) / 2 : null,
    mean: count ? values.reduce((sum, value) => sum + value, 0) / count : null,
    positive: values.filter((value) => value > 0).length, negative: values.filter((value) => value < 0).length,
    positivePct: count ? values.filter((value) => value > 0).length / count * 100 : null };
}
export function reportAge(company, basis, observedAt) {
  const end = company.reports[basis]?.end;
  if (!end) return null;
  const days = Math.floor((Date.parse(observedAt) - Date.parse(end)) / 86400000);
  return Number.isFinite(days) ? days : null;
}
export function isOlderReport(company, basis, observedAt) {
  const age = reportAge(company, basis, observedAt);
  return age == null || age > (basis === 'annual' ? 550 : 200);
}
export const DEFAULT_MARKET_VIEW = { tab: 'overview', basis: 'ttm', cohort: 'all', query: '', screen: 'all', sort: 'revenueGrowth', direction: 'desc', metric: 'revenueGrowth', statistic: 'median', selected: [] };
export function parseMarketView(query, cohortIds = []) {
  const p = new URLSearchParams(query);
  const choice = (key, options, fallback) => options.includes(p.get(key)) ? p.get(key) : fallback;
  return { tab: choice('tab', ['overview', 'sectors', 'companies', 'saved'], 'overview'), basis: choice('basis', ['annual', 'ttm'], 'ttm'),
    cohort: choice('cohort', ['all', ...cohortIds], 'all'), query: (p.get('q') || '').slice(0, 100),
    screen: choice('screen', ['all', 'growth', 'contraction', 'profitable', 'positiveCash', 'losses', 'negativeCash', 'older', 'watchlist'], 'all'),
    sort: choice('sort', ['ticker', 'filed', ...MARKET_METRICS.map((m) => m.key)], 'revenueGrowth'),
    direction: choice('direction', ['asc', 'desc'], 'desc'), metric: choice('metric', MARKET_METRICS.map((m) => m.key), 'revenueGrowth'),
    statistic: choice('statistic', ['median', 'mean'], 'median'),
    selected: [...new Set((p.get('peers') || '').split(',').filter((t) => /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(t)))].slice(0, 5) };
}
export function marketViewQuery(view) {
  const p = new URLSearchParams();
  for (const key of ['tab', 'basis', 'cohort', 'screen', 'sort', 'direction', 'metric', 'statistic']) if (view[key] !== DEFAULT_MARKET_VIEW[key]) p.set(key, view[key]);
  if (view.query) p.set('q', view.query);
  if (view.selected.length) p.set('peers', view.selected.join(','));
  return p.toString();
}
export function selectMarketCompanies(companies, view, watchlist, observedAt) {
  const query = view.query.toLowerCase().trim();
  const filtered = companies.filter((c) => {
    if (view.cohort !== 'all' && !c.cohorts.includes(view.cohort)) return false;
    if (query && !`${c.ticker} ${c.name}`.toLowerCase().includes(query)) return false;
    const m = c.metrics[view.basis] || {};
    switch (view.screen) {
      case 'growth': return isNumber(m.revenueGrowth) && m.revenueGrowth > 0;
      case 'contraction': return isNumber(m.revenueGrowth) && m.revenueGrowth < 0;
      case 'profitable': return isNumber(m.netIncome) && m.netIncome > 0;
      case 'positiveCash': return isNumber(m.cashFlowMargin) && m.cashFlowMargin > 0;
      case 'losses': return isNumber(m.netIncome) && m.netIncome < 0;
      case 'negativeCash': return isNumber(m.cashFlowMargin) && m.cashFlowMargin < 0;
      case 'older': return isOlderReport(c, view.basis, observedAt);
      case 'watchlist': return watchlist.includes(c.ticker);
      default: return true;
    }
  });
  return filtered.sort((a, b) => {
    const value = (c) => view.sort === 'ticker' ? c.ticker : view.sort === 'filed' ? c.reports[view.basis]?.filed : c.metrics[view.basis]?.[view.sort];
    const av = value(a), bv = value(b);
    if (av == null && bv == null) return a.ticker.localeCompare(b.ticker);
    if (av == null) return 1;
    if (bv == null) return -1;
    const difference = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return (view.direction === 'asc' ? difference : -difference) || a.ticker.localeCompare(b.ticker);
  });
}
export function parseMarketSaved(raw) {
  if (!raw) return { version: 1, watchlist: [], views: [], baselines: {} };
  const saved = JSON.parse(raw);
  if (saved.version !== 1 || !Array.isArray(saved.watchlist) || !Array.isArray(saved.views)) throw new Error('Saved Market research could not be read. Your existing saved data has been preserved.');
  return { version: 1, watchlist: [...new Set(saved.watchlist.filter((t) => typeof t === 'string' && /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(t)))],
    views: saved.views.filter((v) => typeof v.name === 'string' && typeof v.query === 'string').slice(0, 12),
    baselines: saved.baselines && typeof saved.baselines === 'object' && !Array.isArray(saved.baselines) ? saved.baselines : {} };
}
export function baselineChanges(before, after, basis) {
  if (!before || before.version !== after.version) return [];
  return MARKET_METRICS.flatMap((m) => {
    const oldValue = before.metrics?.[basis]?.[m.key], value = after.metrics?.[basis]?.[m.key];
    if (!isNumber(oldValue) || !isNumber(value) || oldValue === value) return [];
    return [{ key: m.key, label: m.label, unit: m.unit, before: oldValue, after: value, delta: value - oldValue,
      reason: before.reports?.[basis]?.end === after.reports?.[basis]?.end ? 'Updated value for the same period' : 'Different reporting period' }];
  });
}
export function marketTrendPoints(evidence, key, basis) {
  const rows = [...evidence].reverse();
  return rows.flatMap((row, index) => {
    const previous = rows[index - 1];
    const time = Date.parse(row.period.end);
    const priorTime = previous ? Date.parse(previous.period.end) : null;
    const gap = priorTime != null && time - priorTime > (basis === 'annual' ? 400 : 120) * 86400000;
    return [...(gap ? [{ time: (time + priorTime) / 2, label: 'Missing reporting period', value: null }] : []), { time, label: row.period.end, value: row.metrics[key] ?? null }];
  });
}
export function marketBrief(companies, view, data, url) {
  const scope = data.cohorts.find((c) => c.id === view.cohort)?.title || 'All covered companies';
  return [`# SEC Market research brief`, `Data observed: ${data.generatedAt}`, `View: ${url}`, `Scope: ${scope} · ${companies.length} companies in this screen`,
    `Basis: ${view.basis === 'ttm' ? 'Quarter-end balances and trailing twelve months' : 'Annual financial statements'}`,
    `Filter: ${view.screen}; search: ${view.query || 'none'}; sort: ${view.sort} ${view.direction}.`, '',
    '## Methodology', 'Curated cohorts, not the entire stock market. Companies are counted once in the screen and can belong to multiple sectors. Fiscal ends differ. Missing metrics are excluded from their own denominators. No stock-price, return, credit-rating, or default-probability signals are inferred.',
    'Flow ratios require positive revenue; growth requires positive revenue for the comparable prior year. Free cash flow is operating cash flow less absolute PP&E purchases. Financial-company cash flows and capital structures require sector-specific interpretation.', '',
    ...MARKET_METRICS.slice(0, 9).map((m) => `${m.label}: ${m.formula}.`), '', '## Companies',
    ...companies.map((c) => `### ${c.ticker} — ${c.name}\nReporting end: ${c.reports[view.basis]?.end || 'Unavailable'}; filed: ${c.reports[view.basis]?.filed || 'Unavailable'}.\n${MARKET_METRICS.map((m) => `${m.label}: ${formatMarket(c.metrics[view.basis]?.[m.key], m.unit)}`).join('; ')}\nSEC facts: https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`),
    '', 'Values are the latest available filing contexts at retrieval, including subsequent revisions. This is not a historical point-in-time backtest. Open company evidence for the raw source values and filing accessions.'].join('\n');
}
export function marketCsv(companies, basis, observedAt) {
  const cell = (value) => {
    if (isNumber(value)) return String(value);
    const text = String(value ?? '');
    return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
  };
  return [['Ticker', 'Company', 'Basis', 'Report end', 'Filed', 'Data observed', 'Cohorts', ...MARKET_METRICS.map((m) => `${m.label} (${m.unit === 'usd' ? 'USD' : '%'})`), 'SEC facts'],
    ...companies.map((c) => [c.ticker, c.name, basis, c.reports[basis]?.end, c.reports[basis]?.filed, observedAt, c.cohorts.join('; '), ...MARKET_METRICS.map((m) => c.metrics[basis]?.[m.key]), `https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`])].map((row) => row.map(cell).join(',')).join('\r\n');
}
