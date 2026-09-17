import { CFTC_FAMILIES, cftcDate } from './cftc.js';
import { MARKET_LENSES } from './marketCohorts.js';
import { QUANT_GROUPS } from './quantGroups.js';

export const MARKET_VERSION = 'market-research-v3';
// The production prewarmer runs daily. Keep one hour of scheduling margin so
// ordinary visitors consume the shared snapshot instead of rebuilding the
// full SEC universe between scheduled runs.
export const MARKET_ATLAS_FRESH_MS = 25 * 60 * 60 * 1000;
export const MARKET_SAVED_KEY = 'edgar:market-research:v1';
export const MARKET_PROVIDER_RETIREMENT_NOTICE = 'A saved Market view now opens the macro market summary or Sector Performance. Retired price, return, and proxy settings were removed; legacy SEC filters, watchlist, baselines, and notes remain in saved data.';
const RETIRED_MARKET_FIELDS = new Set([
  'price_through', 'price_sample', 'price_status', 'price_source', 'price_basis', 'price_model_observations',
  'exposure', 'event', 'co_movement', 'associations', 'sector_proxy', 'market_beta', 'downside_beta', 'sector_beta',
  'residual_volatility', 'response_z', 'price_response_z', 'post_filing_response', 'evidence_gap',
]);
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
export const DEFAULT_MARKET_VIEW = {
  tab: 'overview', basis: 'ttm', cohort: 'all', query: '', screen: 'all', sort: 'revenueGrowth', direction: 'desc',
  metric: 'revenueGrowth', statistic: 'median', selected: [], quantThreshold: 0,
  cftcFamily: 'tff', cftcContract: '13874A', cftcGroup: 'leveraged-funds', cftcDate: 'latest', cftcHistory: '5y', cftcDisplay: 'net-oi',
};
// Active sector controls are narrower than the legacy saved-data schema.
export const MARKET_ACTIVE_METRIC_KEYS = Object.freeze(['revenueGrowth', 'netMargin', 'cashFlowMargin', 'capexIntensity', 'equityToAssets']);
export function activeMarketMetric(metric) {
  return MARKET_ACTIVE_METRIC_KEYS.includes(metric) ? metric : DEFAULT_MARKET_VIEW.metric;
}
export const CFTC_HISTORY_REPORTS = Object.freeze({ '1y': 52, '3y': 156, '5y': 260 });
const MARKET_VIEW_KEYS = new Set(['tab', 'basis', 'cohort', 'q', 'screen', 'sort', 'direction', 'metric', 'statistic', 'peers', 'cutoff', 'family', 'contract', 'group', 'date', 'history', 'display']);
const RETIRED_PRICE_VIEW_KEYS = ['asset', 'window', 'proxy'];
const RETIRED_COMPANY_VIEW_KEYS = ['q', 'screen', 'sort', 'direction', 'peers', 'cutoff'];
const RETIRED_MARKET_VIEW_KEYS = [...RETIRED_PRICE_VIEW_KEYS, ...RETIRED_COMPANY_VIEW_KEYS];
export function activeMarketTab(tab) {
  if (['factors', 'fundamentals', 'companies'].includes(tab)) return 'sectors';
  return ['overview', 'positioning', 'sectors'].includes(tab) ? tab : 'overview';
}
const MARKET_VIEW_QUERY_MAX = 2048;
export const MARKET_COHORT_IDS = Object.freeze([...MARKET_LENSES, ...QUANT_GROUPS].map(item => item.id));
export function parseMarketView(query, cohortIds = MARKET_COHORT_IDS) {
  const p = new URLSearchParams(query);
  const choice = (key, options, fallback) => options.includes(p.get(key)) ? p.get(key) : fallback;
  const rawTab = p.get('tab');
  const legacySectorTab = ['factors', 'fundamentals', 'companies'].includes(rawTab);
  const selectedCohort = choice('cohort', ['all', ...cohortIds], 'all');
  const family = choice('family', ['tff', 'disaggregated'], DEFAULT_MARKET_VIEW.cftcFamily);
  const contract = (p.get('contract') || (family === 'tff' ? '13874A' : '067651')).trim().toUpperCase();
  const groupOptions = family === 'tff' ? ['dealer', 'asset-manager', 'leveraged-funds', 'other-reportables', 'non-reportables'] : ['producer-merchant', 'swap-dealers', 'managed-money', 'other-reportables', 'non-reportables'];
  return { tab: activeMarketTab(rawTab), basis: choice('basis', ['annual', 'ttm'], 'ttm'),
    cohort: legacySectorTab && !selectedCohort.startsWith('sector-') ? 'all' : selectedCohort, query: '',
    screen: 'all', sort: 'revenueGrowth', direction: 'desc', metric: activeMarketMetric(p.get('metric')),
    statistic: choice('statistic', ['median', 'mean'], 'median'),
    selected: [], quantThreshold: 0,
    cftcFamily: family, cftcContract: /^[A-Z0-9+]{3,12}$/.test(contract) ? contract : family === 'tff' ? '13874A' : '067651',
    cftcGroup: choice('group', groupOptions, family === 'tff' ? 'leveraged-funds' : 'managed-money'),
    cftcDate: p.get('date') === 'latest' || p.has('date') && cftcDate(p.get('date')) === p.get('date') ? p.get('date') : 'latest',
    cftcHistory: choice('history', ['1y', '3y', '5y'], '5y'), cftcDisplay: choice('display', ['net-oi', 'percentile'], 'net-oi'),
  };
}
export function marketViewQuery(view) {
  const p = new URLSearchParams();
  const tab = activeMarketTab(view.tab);
  if (tab !== DEFAULT_MARKET_VIEW.tab) p.set('tab', tab);
  for (const key of ['basis', 'cohort', 'metric', 'statistic']) {
    const value = key === 'metric' ? activeMarketMetric(view.metric) : view[key];
    if (value != null && value !== DEFAULT_MARKET_VIEW[key]) p.set(key, value);
  }
  if (view.tab === 'positioning') {
    p.set('family', view.cftcFamily);
    p.set('contract', view.cftcContract);
    p.set('group', view.cftcGroup);
    if (view.cftcDate !== 'latest') p.set('date', view.cftcDate);
    p.set('history', view.cftcHistory);
    p.set('display', view.cftcDisplay);
  }
  return p.toString();
}
export function marketViewPath(view) {
  const query = marketViewQuery(view);
  return `/market${query ? `?${query}` : ''}`;
}
export function marketViewForCftcAvailability(view, cftcEnabled = true) {
  return !cftcEnabled && view?.tab === 'positioning' ? { ...view, tab: 'overview' } : view;
}
export function isCftcPositioningPath(path) {
  if (typeof path !== 'string') return false;
  let url;
  try { url = new URL(path, 'https://secedgarterminal.com'); } catch { return false; }
  if (url.origin !== 'https://secedgarterminal.com') return false;
  return url.pathname === '/market/positioning'
    || (url.pathname === '/market' && url.searchParams.getAll('tab').includes('positioning'));
}
export function marketSavedViewsForCftcAvailability(views, cohortIds = MARKET_COHORT_IDS, cftcEnabled = true) {
  if (!Array.isArray(views)) return [];
  return views.map((view, index) => ({ view, index }))
    .filter(({ view }) => cftcEnabled || parseMarketView(view?.query || '', cohortIds).tab !== 'positioning');
}
export function marketViewHistoryMode(current, next, forcePush = false) {
  if (marketViewPath(current) === marketViewPath(next)) return null;
  return forcePush || current.tab !== next.tab ? 'pushState' : 'replaceState';
}
export function migrateMarketViewQuery(query) {
  const params = new URLSearchParams(query);
  let migrated = false;
  const oldTab = params.get('tab');
  const hadPriceView = RETIRED_PRICE_VIEW_KEYS.some(key => params.has(key));
  if (['factors', 'fundamentals', 'companies', 'saved'].includes(oldTab) || hadPriceView) {
    const tab = hadPriceView && !['positioning', 'sectors'].includes(oldTab) ? 'sectors' : activeMarketTab(oldTab);
    if (tab === 'overview') params.delete('tab'); else params.set('tab', tab);
    if (tab === 'sectors' && params.has('cohort') && !params.get('cohort').startsWith('sector-')) params.delete('cohort');
    migrated = true;
  }
  for (const key of RETIRED_MARKET_VIEW_KEYS) if (params.has(key)) { params.delete(key); migrated = true; }
  if (params.has('metric') && !MARKET_ACTIVE_METRIC_KEYS.includes(params.get('metric'))) { params.delete('metric'); migrated = true; }
  return { query: params.toString(), migrated };
}
export function migrateMarketPath(path) {
  if (typeof path !== 'string') return { path, migrated: false };
  let url;
  try { url = new URL(path, 'https://secedgarterminal.com'); } catch { return { path, migrated: false }; }
  if (url.origin !== 'https://secedgarterminal.com' || !['/market', '/market/factors'].includes(url.pathname)) return { path, migrated: false };
  const legacyRoute = url.pathname === '/market/factors';
  if (legacyRoute) url.searchParams.set('tab', 'factors');
  const result = migrateMarketViewQuery(url.search);
  return { path: `/market${result.query ? `?${result.query}` : ''}${url.hash}`, migrated: result.migrated || legacyRoute };
}
function stripRetiredMarketFields(value) {
  if (Array.isArray(value)) {
    let migrated = false;
    const output = value.map(item => { const result = stripRetiredMarketFields(item); migrated ||= result.migrated; return result.value; });
    return { value: output, migrated };
  }
  if (!value || typeof value !== 'object') return { value, migrated: false };
  let migrated = false;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (RETIRED_MARKET_FIELDS.has(key)) { migrated = true; continue; }
    const result = stripRetiredMarketFields(child); migrated ||= result.migrated; output[key] = result.value;
  }
  return { value: output, migrated };
}
export function sanitizeMarketBaselines(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { baselines: {}, migrated: false };
  const result = stripRetiredMarketFields(value);
  return { baselines: result.value, migrated: result.migrated };
}
function validSavedViewParams(params, cohortIds) {
  if ([...params.keys()].some(key => !MARKET_VIEW_KEYS.has(key))) return false;
  if ([...MARKET_VIEW_KEYS].some(key => params.getAll(key).length > 1)) return false;
  const allowed = (key, values) => !params.has(key) || values.includes(params.get(key));
  if (!allowed('tab', ['overview', 'positioning', 'sectors', 'companies', 'fundamentals', 'factors', 'saved'])
    || !allowed('basis', ['annual', 'ttm'])
    || !allowed('cohort', ['all', ...cohortIds])
    || !allowed('screen', ['all', 'growth', 'contraction', 'profitable', 'positiveCash', 'losses', 'negativeCash', 'older', 'watchlist'])
    || !allowed('sort', ['ticker', 'filed', ...MARKET_METRICS.map(metric => metric.key)])
    || !allowed('direction', ['asc', 'desc'])
    || !allowed('metric', MARKET_METRICS.map(metric => metric.key))
    || !allowed('statistic', ['median', 'mean'])
    || !allowed('cutoff', ['0', '0.5', '1'])
    || !allowed('family', ['tff', 'disaggregated'])
    || !allowed('history', ['1y', '3y', '5y'])
    || !allowed('display', ['net-oi', 'percentile'])) return false;
  if ((params.get('q') || '').length > 100) return false;
  const peers = params.has('peers') ? params.get('peers').split(',') : [];
  if (peers.length > 5 || new Set(peers).size !== peers.length || peers.some(ticker => !/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker))) return false;
  const family = params.get('family') || DEFAULT_MARKET_VIEW.cftcFamily;
  const contract = (params.get('contract') || '').trim().toUpperCase();
  if (params.has('contract') && !/^[A-Z0-9+]{3,12}$/.test(contract)) return false;
  const groups = family === 'tff' ? ['dealer', 'asset-manager', 'leveraged-funds', 'other-reportables', 'non-reportables'] : ['producer-merchant', 'swap-dealers', 'managed-money', 'other-reportables', 'non-reportables'];
  if (!allowed('group', groups)) return false;
  return !params.has('date') || params.get('date') === 'latest' || cftcDate(params.get('date')) === params.get('date');
}
export function canonicalMarketViewQuery(query, cohortIds = MARKET_COHORT_IDS, { preserveLegacyFilters = false } = {}) {
  if (typeof query !== 'string' || query.length > MARKET_VIEW_QUERY_MAX) return { query: null, migrated: false };
  const original = new URLSearchParams(query);
  const validated = new URLSearchParams(original);
  // Validate old filters before dropping them from active navigation. Corrupt
  // saved research must not silently turn into a different screening rule.
  for (const key of RETIRED_PRICE_VIEW_KEYS) validated.delete(key);
  if (!validSavedViewParams(validated, cohortIds)) return { query: null, migrated: false };
  const migrated = migrateMarketViewQuery(query);
  const params = new URLSearchParams(marketViewQuery(parseMarketView(migrated.query, cohortIds)));
  // Backups retain valid retired company settings; the Market UI never reads
  // these controls and active URLs strip them. No browser store is rewritten.
  if (preserveLegacyFilters) {
    for (const key of [...RETIRED_COMPANY_VIEW_KEYS, 'cohort', 'metric']) if (validated.has(key)) params.set(key, validated.get(key));
    if (['factors', 'fundamentals', 'companies', 'saved'].includes(validated.get('tab'))) params.set('tab', validated.get('tab'));
  }
  return { query: params.toString(), migrated: migrated.migrated };
}
export function marketSavedViewSummary(query, cohortIds = MARKET_COHORT_IDS) {
  const view = parseMarketView(query, cohortIds);
  if (view.tab === 'positioning') {
    const family = CFTC_FAMILIES[view.cftcFamily];
    const group = family.groups.find(item => item.id === view.cftcGroup)?.label || view.cftcGroup;
    return `${family.shortLabel} futures only · CFTC ${view.cftcContract} · ${group} · ${CFTC_HISTORY_REPORTS[view.cftcHistory]} prior reports`;
  }
  const tab = { overview: 'Market briefing', sectors: 'Sector Performance' }[view.tab] || 'Market research';
  return `${tab} · ${view.basis === 'ttm' ? 'Latest TTM' : 'Annual'} SEC fundamentals`;
}
export function cftcPercentileForHistory(group, historyWindow) {
  const required = CFTC_HISTORY_REPORTS[historyWindow] || CFTC_HISTORY_REPORTS['5y'];
  const candidates = [group?.percentile, ...(Array.isArray(group?.shorterPercentiles) ? group.shorterPercentiles : [])];
  return candidates.find(item => item?.required === required) || { value: null, reason: 'insufficient_history', observations: 0, required, comparisonRange: { observations: 0, earliest: null, latest: null } };
}
export function cftcHeatCellDescription({ family, row, group, groupLabel, display, historyWindow }) {
  const percentile = cftcPercentileForHistory(group, historyWindow);
  const value = display === 'percentile' ? percentile.value : group?.netPctOi;
  const valueLabel = Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : 'unavailable';
  const weekly = Number.isFinite(group?.oneWeekNetPctChange) ? `${group.oneWeekNetPctChange > 0 ? '+' : ''}${Number(group.oneWeekNetPctChange).toFixed(1)} percentage points` : 'unavailable';
  const comparisonRange = percentile?.comparisonRange;
  const range = comparisonRange?.earliest && comparisonRange?.latest ? `${comparisonRange.earliest} to ${comparisonRange.latest}` : 'unavailable';
  const observations = comparisonRange?.observations ?? percentile.observations;
  const metric = display === 'percentile' ? `${percentile.required}-prior-report within-series percentile` : 'net as a percentage of open interest';
  return `${family} futures only; ${row.launchLabel || row.contractName}; CFTC ${row.code}; ${row.exchange || 'venue unavailable'}; ${groupLabel}; report ${row.reportDate}; ${metric}: ${valueLabel}; exact-week change in net/open interest: ${weekly}; percentile comparison ${observations} of ${percentile.required} prior reports, ${range}.`;
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
export function parseMarketSaved(raw, cohortIds = MARKET_COHORT_IDS) {
  if (!raw) return { version: 1, watchlist: [], views: [], baselines: {} };
  const saved = JSON.parse(raw);
  if (saved.version !== 1 || !Array.isArray(saved.watchlist) || !Array.isArray(saved.views)) throw new Error('Saved Market research could not be read. Your existing saved data has been preserved.');
  let migrated = false, rejected = Math.max(0, saved.views.length - 12);
  const views = saved.views.slice(0, 12).flatMap(view => {
    if (!view || typeof view.name !== 'string' || !view.name.trim() || typeof view.query !== 'string') { rejected += 1; return []; }
    const result = canonicalMarketViewQuery(view.query, cohortIds, { preserveLegacyFilters: true }); migrated ||= result.migrated;
    if (result.query == null) { rejected += 1; return []; }
    return [{ name: view.name.trim().slice(0, 60), query: result.query }];
  });
  const sanitized = sanitizeMarketBaselines(saved.baselines);
  migrated ||= sanitized.migrated;
  const notices = [];
  if (migrated) notices.push(MARKET_PROVIDER_RETIREMENT_NOTICE);
  else if (typeof saved.migrationNotice === 'string' && (saved.migrationNotice.includes('saved price-model view') || saved.migrationNotice.includes('saved Market view'))) notices.push(MARKET_PROVIDER_RETIREMENT_NOTICE);
  if (rejected) notices.push(`${rejected} saved ${rejected === 1 ? 'view was' : 'views were'} not restored because its filters were unsupported or malformed; no replacement screening rule was applied.`);
  return { version: 1, watchlist: [...new Set(saved.watchlist.filter((t) => typeof t === 'string' && /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(t)))], views,
    baselines: sanitized.baselines,
    ...(notices.length ? { migrationNotice: notices.join(' ') } : {}) };
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
  const scope = [...data.cohorts, ...(data.themes || [])].find((c) => c.id === view.cohort)?.title || 'All covered companies';
  return [`# SEC Market research brief`, `Data observed: ${data.generatedAt}`, `View: ${url}`, `Scope: ${scope} · ${companies.length} companies in this screen`,
    `Basis: ${view.basis === 'ttm' ? 'Quarter-end balances and trailing twelve months' : 'Annual financial statements'}`,
    `Filter: ${view.screen}; search: ${view.query || 'none'}; sort: ${view.sort} ${view.direction}.`, '',
    '## Methodology', `${data.coverage ? `Coverage: ${data.companies.length} of ${data.requested} targeted SEC issuers in the prepared market universe. Each issuer belongs to one primary sector; optional research themes can overlap. Fund holdings are a coverage proxy, not certified current index membership. Sources: ${data.coverage.sources.map(source => `${source.fund} (${source.as_of}): ${source.url}`).join('; ')}.` : 'Curated research cohorts, not the entire stock market. Cohorts can overlap.'} Fiscal ends differ. Missing metrics are excluded from their own denominators. No stock-price, return, credit-rating, or default-probability signals are inferred.`,
    'Flow ratios require positive revenue; growth requires positive revenue for the comparable prior year. Free cash flow is operating cash flow less absolute PP&E purchases. Financial-company cash flows and capital structures require sector-specific interpretation.', '',
    ...MARKET_METRICS.slice(0, 9).map((m) => `${m.label}: ${m.formula}.`), '', '## Companies',
    ...companies.map((c) => `### ${c.ticker} — ${c.name}\nReporting end: ${c.reports[view.basis]?.end || 'Unavailable'}; filed: ${c.reports[view.basis]?.filed || 'Unavailable'}.\n${MARKET_METRICS.map((m) => `${m.label}: ${formatMarket(c.metrics[view.basis]?.[m.key], m.unit)}`).join('; ')}\nSEC facts: https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`),
    '', 'Values are the latest available filing contexts at retrieval, including subsequent revisions. This is not a historical point-in-time backtest. Open company evidence for the raw source values and filing accessions.'].join('\n');
}
/** @param {import('../app/market/marketTypes').MarketData | null} [data] */
export function marketCsv(companies, basis, observedAt, data = null) {
  const cell = (value) => {
    if (isNumber(value)) return String(value);
    const text = String(value ?? '');
    return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
  };
  return [['Ticker', 'Company', 'Basis', 'Report end', 'Filed', 'Data observed', 'Cohorts', ...(data?.coverage ? ['CIK', 'Primary sector', 'Coverage fund', 'SEC checked', 'Facts retrieved', 'Coverage membership'] : []), ...MARKET_METRICS.map((m) => `${m.label} (${m.unit === 'usd' ? 'USD' : '%'})`), 'SEC facts'],
    ...companies.map((c) => [c.ticker, c.name, basis, c.reports[basis]?.end, c.reports[basis]?.filed, observedAt, c.cohorts.join('; '), ...(data?.coverage ? [c.cik, c.sector, c.coverageFund, c.secCheckedAt, c.factsRetrievedAt, data.coverage.membership_id] : []), ...MARKET_METRICS.map((m) => c.metrics[basis]?.[m.key]), `https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`])].map((row) => row.map(cell).join(',')).join('\r\n');
}
