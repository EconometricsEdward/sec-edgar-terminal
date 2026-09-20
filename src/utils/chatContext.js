import { SITE_TOOLS, activeTool, entityFromRoute, normalizeCikIdentifier, safeInternalPath } from './siteRoutes.js';
import { QUANT_GROUPS } from './quantGroups.js';

const EXTRA_PATHS = new Set(['/market/positioning', '/market/factors', '/workspace/demo', '/workspace/demo/changes', '/workspace/portfolio-guide']);
const ANALYSIS_VIEWS = {
  overview: 'Overview', statements: 'Statements', changes: 'Changes', trends: 'Growth & trends',
  cash: 'Cash quality', capital: 'Capital & funding', drivers: 'Return drivers', cftc: 'CFTC context',
  scenarios: 'Scenarios', formula: 'Custom ratios', checks: 'Sources & checks',
};
const MARKET_TABS = { overview: 'Market Briefing', positioning: 'CFTC Positioning', sectors: 'Sector Performance' };
const FUND_TABS = { overview: 'Overview', holdings: 'Holdings', sources: 'Sources' };
const MANAGER_VIEWS = { overview: 'Overview', holdings: 'Holdings', changes: 'Quarterly changes', history: 'Portfolio history', markets: 'Market connections', filings: 'Filings & evidence', compare: 'Compare managers' };
const FUND_VIEWS = { discover: 'Discover funds', security: 'Security search', compare: 'Compare funds', allocation: 'Allocation', changes: 'Changes', '13f': '13F managers' };
const RISK_VIEWS = { overview: 'Overview', exposures: 'Company exposures', fcm: 'FCM capital' };
const MARKET_COMPANY_METRICS = ['revenueGrowth', 'netMargin', 'operatingMargin', 'cashFlowMargin', 'freeCashFlowMargin', 'debtToAssets', 'liabilitiesToAssets', 'currentRatio', 'cashToAssets', 'interestCoverage', 'equityToAssets', 'totalAssets', 'revenue', 'ticker'];
const COMPARE_METRICS = ['totalAssets', 'stockholdersEquity', 'netIncome', 'roe', 'roa', 'equityAssets', 'revenue', 'operatingIncome', 'operatingMargin', 'netMargin', 'cash', 'operatingCashFlow', 'freeCashFlow', 'cashAssets', 'currentRatio', 'debtAssets', 'netInterestIncome', 'noninterestIncome', 'bankRevenue', 'deposits', 'loans', 'loanDeposits', 'allowanceLoans', 'provisionLoans', 'efficiency', 'premiumsEarned', 'investmentIncome'];
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number(value.slice(0, 4)) > 0
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** Only allowlisted public route settings enter the prompt. Search filters are
 * untrusted user text, never instructions. Never forward arbitrary query keys,
 * fragment state, page HTML, uploaded holdings or browser storage. This is
 * URL context only: accepted selections are hints, not verified page values. */
export function normalizeChatContext(input = {}) {
  const raw = typeof input?.path === 'string' && input.path.length <= 180 ? input.path : '/';
  const directManager = normalizeCikIdentifier(raw.match(/^\/fund\/manager\/(\d{1,10})\/?$/)?.[1]);
  const path = directManager ? `/fund/manager/${directManager}`
    : raw === '/crypto' ? '/disclosures' : !/[?#]/.test(raw) && (EXTRA_PATHS.has(raw) ? raw : safeInternalPath(raw)) || '/';
  const section = activeTool(path) || 'home';
  let label = SITE_TOOLS.find(tool => tool.id === section)?.label || 'Home';
  const parsed = new URLSearchParams(typeof input?.query === 'string' && input.query.length <= 2000 ? input.query : '');
  const clean = new URLSearchParams();
  const single = key => parsed.getAll(key).length === 1 ? parsed.get(key) : '';
  const choice = (key, values) => { const value = single(key); if (values.includes(value)) clean.set(key, value); return clean.get(key) || ''; };
  const text = (key, limit = 120) => { const value = single(key).trim(); if (value && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)) clean.set(key, value); };
  const accession = key => { if (/^\d{10}-\d{2}-\d{6}$/.test(single(key))) clean.set(key, single(key)); };
  const positiveInteger = (key, max = 10000) => { const value = single(key); if (/^[1-9]\d{0,4}$/.test(value) && Number(value) <= max) clean.set(key, value); };
  const date = (key, latest = false, noFuture = false) => {
    const value = single(key);
    if (latest && value === 'latest' || validDate(value) && (!noFuture || value <= new Date().toISOString().slice(0, 10))) clean.set(key, value);
  };
  let sector = '';
  if (section === 'analysis') {
    choice('basis', ['annual', 'quarter', 'ttm', 'ytd']);
    const view = choice('view', Object.keys(ANALYSIS_VIEWS));
    if (view) label += ` · ${ANALYSIS_VIEWS[view]}`;
    choice('statement', ['income', 'balance', 'cashflow', 'ratios']);
    date('end', true); date('asOf', false, true);
  } else if (section === 'market') {
    choice('basis', ['annual', 'ttm']);
    const tab = path === '/market/positioning' ? 'positioning' : path === '/market/factors' ? 'sectors' : choice('tab', Object.keys(MARKET_TABS));
    if (tab) { clean.set('tab', tab); label += ` · ${MARKET_TABS[tab]}`; }
    const cohort = choice('cohort', ['all', ...QUANT_GROUPS.map(group => group.id)]);
    const selected = QUANT_GROUPS.find(group => group.id === cohort);
    if (selected) sector = selected.label;
    choice('metric', ['revenueGrowth', 'netMargin', 'cashFlowMargin', 'capexIntensity', 'equityToAssets']);
    choice('statistic', ['median', 'mean']);
    if (tab === 'sectors') {
      choice('companyMetric', MARKET_COMPANY_METRICS); choice('companyDirection', ['asc', 'desc']);
      text('companyQuery', 100); positiveInteger('companyPage');
    }
    if (tab === 'positioning') {
      const family = choice('family', ['tff', 'disaggregated']);
      const contract = single('contract').trim().toUpperCase();
      if (/^[A-Z0-9+]{3,12}$/.test(contract)) clean.set('contract', contract);
      choice('group', family === 'disaggregated' ? ['producer-merchant', 'swap-dealers', 'managed-money', 'other-reportables', 'non-reportables'] : ['dealer', 'asset-manager', 'leveraged-funds', 'other-reportables', 'non-reportables']);
      date('date', true, true);
      choice('history', ['1y', '3y', '5y']); choice('display', ['net-oi', 'percentile']);
    }
  } else if (section === 'fund') {
    if (directManager) {
      label += ' · 13F manager';
      if (/^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(single('period'))) date('period', false, true);
    } else if (path === '/fund') {
      const view = choice('view', Object.keys(FUND_VIEWS));
      if (view) label += ` · ${FUND_VIEWS[view]}`;
      if (view === 'changes') {
        const ticker = single('changeTicker').trim().toUpperCase();
        if (/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)) clean.set('changeTicker', ticker);
        accession('changeBefore'); accession('changeAfter'); text('changeQuery', 100);
        choice('changeScope', ['all', 'added', 'removed', 'changed']);
      }
      if (view === '13f') {
        const managerCik = normalizeCikIdentifier(single('managerCik'));
        if (managerCik) clean.set('managerCik', managerCik);
        choice('managerView', Object.keys(MANAGER_VIEWS));
        if (/^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(single('managerPeriod'))) date('managerPeriod', false, true);
        if (clean.get('managerView') === 'compare') {
          const peers = single('managerCompare').split(',').map(normalizeCikIdentifier);
          if (peers.length >= 2 && peers.length <= 4 && peers.every(Boolean) && new Set(peers).size === peers.length) clean.set('managerCompare', peers.join(','));
          if (/^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(single('managerComparePeriod'))) date('managerComparePeriod', false, true);
        }
      }
    } else {
      const tab = choice('tab', Object.keys(FUND_TABS));
      if (tab) label += ` · ${FUND_TABS[tab]}`;
      if (/^\d{10}-\d{2}-\d{6}$/.test(single('accession'))) clean.set('accession', single('accession'));
    }
  } else if (section === 'risk') {
    choice('basis', ['annual', 'ttm']);
    const view = choice('view', Object.keys(RISK_VIEWS)) || choice('tab', Object.keys(RISK_VIEWS));
    if (view) label += ` · ${RISK_VIEWS[view]}`;
    date('asOf', false, true);
  } else if (section === 'compare') {
    choice('basis', ['annual', 'quarter', 'ttm']); choice('alignment', ['common', 'latest']);
    choice('view', ['table', 'trends', 'map', 'changes', 'quality']);
    choice('tableMode', ['reported', 'common-size', 'formula', 'changes']);
    choice('lens', ['auto', 'common', 'banking', 'corporate', 'insurance']);
    for (const key of ['metric', 'x', 'y', 'movementMetric']) choice(key, COMPARE_METRICS);
    choice('sort', ['peers', ...COMPARE_METRICS]); choice('descending', ['true', 'false']);
    choice('mode', ['absolute', 'indexed']); choice('years', ['3', '5', '10']);
    for (const key of ['period', 'movementFrom']) if (/^(latest|previous|(19|20)\d{2}(-Q[1-4])?)$/.test(single(key))) clean.set(key, single(key));
    date('end', true); date('asOf', false, true);
    for (const key of ['focus', 'benchmark']) { const value = single(key); if (/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(value) || ['median', 'peers'].includes(value)) clean.set(key, value); }
    const metrics = single('metrics').split(',');
    if (metrics.length <= COMPARE_METRICS.length && metrics.every(value => COMPARE_METRICS.includes(value))) clean.set('metrics', [...new Set(metrics)].join(','));
    const excluded = single('excluded').split(',');
    if (excluded.length <= 12 && excluded.every(value => /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(value))) clean.set('excluded', [...new Set(excluded)].join(','));
  } else if (section === 'filings') {
    choice('view', ['document', 'changes', 'list', 'timeline', 'notebook']);
    accession('accession'); accession('prior'); date('filed'); date('priorFiled');
    for (const key of ['archive', 'priorArchive']) if (/^CIK\d{10}-submissions-\d{1,6}\.json$/.test(single(key))) clean.set(key, single(key));
    if (/^(all|other|risk|mda|notes|8k:\d\.\d{2})$/.test(single('section'))) clean.set('section', single('section'));
    const form = single('form'); if (/^(all|[A-Z0-9][A-Z0-9 /-]{0,19})$/.test(form)) clean.set('form', form);
    text('query', 200); date('start'); date('end'); positiveInteger('page');
  } else if (section === 'disclosures') {
    date('start'); date('end'); text('query', 200);
  } else if (section === 'workspace') {
    choice('view', ['overview', 'portfolios']);
    choice('portfolioTab', ['analytics', 'research', 'changes', 'allocation', 'filings', 'disclosures', 'ownership', 'exports']);
    choice('analyticsArea', ['overview', 'concentration', 'financial', 'coverage']);
    choice('holdingsMode', ['screen', 'all']);
  }
  const identityKeys = section === 'risk' ? ['ticker', 'symbol'] : section === 'disclosures' ? ['tickers', 'focus', 'ticker', 'cik', 'company'] : [];
  const present = identityKeys.filter(key => parsed.has(key));
  // Do not promote a secondary alias after dropping a conflicting, repeated,
  // free-form or multi-entity primary parameter.
  const identities = present.map(key => {
    const value = single(key).trim();
    if (key === 'company' && value !== value.toUpperCase()) return '';
    return /^[A-Z0-9][A-Z0-9.-]{0,14}$/i.test(value) ? normalizeCikIdentifier(value) || value.toUpperCase() : '';
  });
  if (identities.length && identities.every(Boolean) && new Set(identities).size === 1)
    present.forEach((key, index) => clean.set(key, identities[index]));
  const entity = directManager ? { kind: 'filer', ticker: directManager }
    : section === 'risk' && (clean.get('view') || clean.get('tab')) === 'fcm' ? null : entityFromRoute(path, clean);
  const managerCik = section === 'fund' && entity?.kind === 'filer' ? entity.ticker : '';
  return {
    path, query: clean.toString(), label, section,
    company: entity?.kind === 'company' || section !== 'fund' && entity?.kind === 'filer' ? entity.ticker : '',
    fund: entity?.kind === 'fund' ? entity.ticker : '',
    managerCik, basis: clean.get('basis') || (['market', 'risk'].includes(section) ? 'ttm' : ['analysis', 'compare'].includes(section) ? 'annual' : ''), view: directManager ? '13f' : clean.get('view') || '', sector,
    tab: clean.get('tab') || '', end: clean.get('end') || '', asOf: clean.get('asOf') || '',
    managerPeriod: clean.get('managerPeriod') || clean.get('period') || '', managerView: clean.get('managerView') || '',
    managerCompare: clean.get('managerCompare') ? clean.get('managerCompare').split(',') : [], managerComparePeriod: clean.get('managerComparePeriod') || '',
    changeTicker: clean.get('changeTicker') || '', changeBefore: clean.get('changeBefore') || '', changeAfter: clean.get('changeAfter') || '', changeQuery: clean.get('changeQuery') || '',
    accession: clean.get('accession') || '', family: clean.get('family') || '', date: clean.get('date') || '',
    compareTickers: section === 'compare' && path.startsWith('/compare/') ? path.slice('/compare/'.length).split(',') : [],
    alignment: clean.get('alignment') || (section === 'compare' ? 'common' : ''), period: clean.get('period') || '',
    metric: clean.get('metric') || '', statistic: clean.get('statistic') || '', cohort: clean.get('cohort') || '',
    companyMetric: clean.get('companyMetric') || '', companyDirection: clean.get('companyDirection') || '',
    companyQuery: clean.get('companyQuery') || '', companyPage: Number(clean.get('companyPage')) || 1,
    contract: clean.get('contract') || '', group: clean.get('group') || '', history: clean.get('history') || '',
    prior: clean.get('prior') || '', filed: clean.get('filed') || '', priorFiled: clean.get('priorFiled') || '',
    archive: clean.get('archive') || '', priorArchive: clean.get('priorArchive') || '',
    filingSection: clean.get('section') || '', filingPage: Number(clean.get('page')) || 1,
    searchQuery: clean.get('query') || '', form: clean.get('form') || '', start: clean.get('start') || '',
    portfolioTab: clean.get('portfolioTab') || '', analyticsArea: clean.get('analyticsArea') || '',
  };
}

export function getChatStarters(context) {
  const page = normalizeChatContext(context);
  if (page.compareTickers.length) return [`Compare ${page.compareTickers.slice(0, 2).join(' and ')} using the selected reporting basis.`, 'Explain the main differences in liquidity and cash generation.', 'Explain how the comparison aligns reporting periods.'];
  if (page.company) return [`Summarize ${page.company}'s latest financial results.`, `What are ${page.company}'s main liquidity and debt trends?`, 'Explain what this page shows.'];
  if (page.fund || page.managerCik) return [`Summarize the ${page.fund || page.managerCik} portfolio.`, 'How concentrated are its reported holdings?', 'Explain the limitations of these fund filings.'];
  if (page.section === 'market') return ['Summarize the market briefing.', 'Which sectors have stronger business fundamentals?', 'What does the latest CFTC positioning show?'];
  return ['Explain what this page shows.', 'Summarize a company from its SEC financials.', 'How do I research a fund on EDGAR Terminal?'];
}

export const CHAT_PAGE_GUIDE = `EDGAR Terminal is a public SEC research website at https://secedgarterminal.com.
Home (/) starts research. Portfolio (/workspace) analyzes user-uploaded portfolios; you cannot see uploaded holdings, saved workspaces or private browser state unless the user explicitly attaches a bounded snapshot with Use this portfolio/scenario in chat. Attached weights and assumptions are user-provided, not verified SEC data. Without an attachment, ask the user which public security they want to discuss.
Filings (/filings or /filings/TICKER) finds original SEC filings. Analysis (/analysis/TICKER) presents normalized SEC financial statements, ratios and trends, with annual, quarter and trailing-twelve-month bases. Risk (/risk?ticker=TICKER) examines reported liquidity, debt, credit and capital, not personalized risk tolerance. Compare (/compare) compares company fundamentals.
Market (/market) has Market Briefing, CFTC Positioning and Sector Performance sections. Its sector performance measures filing-based business fundamentals with equal company weights, NOT stock-price returns or investable index returns. Breadth uses available-company denominators; coverage varies by metric and period. The briefing combines business growth, profitability and cash generation with separate futures positioning. CFTC positions are aggregate contract/trader-category exposures, NOT a company's or fund's own positions, and not a buy/sell signal.
Funds (/fund, /fund/TICKER, or /fund?view=13f&managerCik=CIK) covers N-PORT fund portfolios and 13F institutional managers. They are different filing universes. 13F is lagged reportable holdings, not full assets under management, complete shorts, or a live portfolio. N-PORT coverage depends on publicly available filings and series identity.
Disclosures (/disclosures) searches a bounded index of SEC filing passages; it is not a complete SEC full-text corpus. Reports (/reports) prepares company, N-PORT, 13F or market PDF and Excel downloads; you cannot generate files inside this chat. About (/about) explains methodology, limitations, public sources and site usage.
Opening or closing this assistant does not change the page. The Reading control changes reading preferences. Explain controls and routes without claiming to see selected local tabs, filters, charts or values not supplied by a verified tool.`;
