import { SITE_TOOLS, safeInternalPath, normalizeCikIdentifier } from './siteRoutes.js';
import { MAX_COMPARE_COMPANIES } from './compareLimits.js';
import { CFTC_LAUNCH_CATALOG } from './cftc.js';
import { DISCLOSURE_TOPIC_LABELS, disclosureSearchPath } from './searchRouter.js';
import { normalizeBrokerDealerForm } from './brokerDealerForms.js';
import { brokerDealerSearchForm, BROKER_DEALER_SEARCH_PATTERN } from './brokerDealerSearch.js';

// Navigation is deterministic. A suggested spelling or an ambiguous legal name
// can never silently select a different issuer. Directory work is shared across
// keystrokes; no network request or filing download belongs in this planner.
const directoryCache = new WeakMap();
const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’']s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unique = values => [...new Set(values)];
const GENERIC = new Set('american america bank business capital company energy enterprise enterprises financial first fund global group holdings income industrial industries industry international investment investments mutual national new north northern partners resources securities south southern state states technology technologies united western'.split(' '));
const RESERVED = new Set('A AI ALL AM AN AND ARE AS AT BE BOND BONDS BY CAN CASH CEO CFO CO COST CREDIT DATA DAY DAYS DEBT DO EPS EQUITY FOR FROM FUND FUNDS GAAP GAS GO GOLD HAS IN INCOME IPO IS IT LOSS LOW MAY MONTH NET NEW NO NOT NOW OF OIL ON ONE OPEN OR OUT PRICE PRICES RATE RATES RISK ROE RUN SEC SEE SHARE SHARES SILVER SO STOCK STOCKS SUPPLY TAX TAXES THE TO TOTAL TRUE UNIT UNITS VALUE WAS WE WITH YEAR YIELD'.split(' '));
const TOPIC_PATTERN = /\b(?:cybersecurity|cyber security|data breach(?:es)?|supply chains?|covenants?|material weaknesses|internal controls?|going concern|customer concentration|refinancing|litigation|lawsuits?|impairments?|restructuring|layoffs?|artificial intelligence|ai|climate|tariffs?|inflation|liquidity|privacy|semiconductors?|geopolitical|disclos(?:e[ds]?|ures?)|mentions?|say|saying|said|capital expenditures?|capex|debt maturit(?:y|ies)|debt repayments?|executive compensation|stock based compensation|share based compensation|bankruptc(?:y|ies)|defaults?|dividends?|share repurchases?|stock buybacks?|pensions?|goodwill|revenue recognition|related party|contingent liabilities|interest rate risk|foreign exchange risk|hedging|derivatives|credit losses|loan losses|loan loss reserves|nonperforming loans|commercial real estate|net interest margin|regulatory capital)\b/i;
const QUESTION_PATTERN = /^(?:what|which|who|why|how|when|where|tell me|find companies|companies (?:that|with|mentioning)|search (?:for|disclosures))\b/i;
const SUFFIX = /\s+(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|llc|l l c|lp|l p|sa|ag|nv|se)$/;

function directoryIndex(map) {
  if (!map || typeof map !== 'object') return { records: [], symbols: new Map(), names: new Map(), searchableNames: new Map(), maxAliasWords: 0 };
  if (directoryCache.has(map)) return directoryCache.get(map);
  const records = [], symbols = new Map(), names = new Map(), prefixes = new Map();
  const add = (target, alias, record) => {
    if (alias.length < 2) return;
    const entries = target.get(alias);
    // Eight explicit choices establish ambiguity without retaining thousands
    // of duplicate fund-family or generic-prefix entries for the same name.
    if (!entries) target.set(alias, [record]);
    else if (entries.length < 8 && !entries.some(entry => entry.ticker === record.ticker)) entries.push(record);
  };
  for (const [key, value] of Object.entries(map).slice(0, 100000)) {
    const ticker = String(value?.ticker || key).trim().toUpperCase();
    const name = typeof value?.name === 'string' ? value.name.trim() : '';
    const cik = normalizeCikIdentifier(String(value?.cik || ''));
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker) || /^\d+$/.test(ticker) || !cik || !name || name.length > 1000) continue;
    const record = { ticker, name, cik, isFund: Boolean(value.isFund) };
    const full = normalize(name);
    let core = full, previous;
    do { previous = core; core = core.replace(SUFFIX, '').trim(); } while (core !== previous);
    records.push({ ...record, normalizedName: full, core, words: core.split(' ') });
    symbols.set(ticker, record);
    add(names, full, record);
    add(names, core, record);
    const words = core.split(' ');
    for (let count = 1; !record.isFund && count < Math.min(words.length, 3); count++) {
      const alias = words.slice(0, count).join(' ');
      if (alias.length >= 4 && words.slice(0, count).some(word => word.length >= 4 && !GENERIC.has(word) && !RESERVED.has(word.toUpperCase()))) add(prefixes, alias, record);
    }
    // Familiar brands only attach to the verified SEC identity. Share classes
    // remain separate choices (e.g. GOOG and GOOGL), even with one issuer CIK.
    if (cik === '0001652044') add(prefixes, 'google', record);
    if (cik === '0001326801') add(prefixes, 'facebook', record);
  }
  for (const [alias, entries] of prefixes) if (!names.has(alias)) names.set(alias, entries);
  const searchableNames = new Map([...names].filter(([alias]) => alias.length >= 4 && !GENERIC.has(alias) && !RESERVED.has(alias.toUpperCase())));
  let maxAliasWords = 0;
  for (const alias of searchableNames.keys()) maxAliasWords = Math.min(30, Math.max(maxAliasWords, alias.split(' ').length));
  const result = { records, symbols, names, searchableNames, maxAliasWords };
  directoryCache.set(map, result);
  return result;
}

/** Optional idle preparation when the SEC directory arrives. This shares the
 * same WeakMap entry as typing, so preparation never builds a second index. */
export function prepareGlobalSearchIndex(tickerMap) {
  directoryIndex(tickerMap);
}

function item(path, label, description, type, group = 'Best match', query) {
  const safe = safeInternalPath(path);
  return safe ? { id: `${type}:${safe}`, label, description, path: safe, type, group, ...(query ? { query } : {}) } : null;
}
function disclosureItem(raw, group = 'Search disclosures') {
  return item(disclosureSearchPath(raw), `Search disclosures for “${raw}”`, 'Find original filing passages across SEC companies', 'disclosures', group, raw);
}
function entityItems(entry, group = 'Company tools') {
  const { ticker, name } = entry;
  if (entry.isFund) return [item(`/fund/${ticker}`, `${ticker} · ${name}`, 'Fund portfolio and reported holdings', 'fund', group)];
  return [
    item(`/analysis/${ticker}`, `${ticker} · ${name}`, 'Financial statements, ratios and company research', 'analysis', group),
    item(`/filings/${ticker}`, `${ticker} SEC filings`, 'Annual, quarterly and current reports', 'filings', group),
    item(`/risk?ticker=${ticker}`, `${ticker} risk profile`, 'Credit, liquidity and business exposures', 'risk', group),
    item(`/disclosures?tickers=${ticker}`, `${ticker} disclosure research`, 'Choose a topic and search this company’s filing passages', 'disclosures', group),
  ];
}
function finish(plan) {
  const seen = new Set();
  plan.items = plan.items.filter(Boolean).filter(entry => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path); return true;
  }).slice(0, 10);
  if (plan.directPath && !safeInternalPath(plan.directPath)) plan.directPath = null;
  return plan;
}
function initialPlan() { return { items: [], directPath: null, lookupQuery: '', filingIntent: '', message: '', entity: null, needsDirectory: false }; }

function annualFilerIntent(raw) {
  const formMatch = raw.match(/\b(?:form\s+)?x[\s-]*17[\s-]*a[\s-]*5(?:\s*\/\s*a)?\b/i);
  const brokerReport = raw.match(BROKER_DEALER_SEARCH_PATTERN);
  const annualReport = raw.match(/\bannual\s+reports?\b/i);
  const match = formMatch || brokerReport || annualReport;
  if (!match) return null;
  const filingIntent = formMatch ? normalizeBrokerDealerForm(formMatch[0]) : brokerReport ? 'X-17A-5' : 'annual';
  const name = raw.replace(match[0], ' ').replace(/^(?:please\s+)?(?:open|find|show me|show|search for)\s+/i, '')
    .replace(/^\s*(?:for|of)\s+/i, '').replace(/\s+(?:for|of)\s*$/i, '').trim().replace(/\s+/g, ' ');
  return { filingIntent, name };
}

const TOOL_ALIASES = [
  ['workspace', /^(?:research hub|workspace|portfolios?|portfolio research|my research|saved research)$/],
  ['filings', /^(?:filings?|sec filings?|annual reports?|quarterly reports?|10 k|10 q|8 k)$/],
  ['analysis', /^(?:analysis|financials?|financial analysis|financial statements?|company analysis|ratios)$/],
  ['risk', /^(?:risk|risk analysis|risk profile|credit risk|risk dashboard)$/],
  ['compare', /^(?:compare|comparison|compare companies|company comparison)$/],
  ['fund', /^(?:funds?|etfs?|fund holdings|fund research|mutual funds?)$/],
  ['disclosures', /^(?:disclosures?|disclosure research|disclosure search|search disclosures)$/],
  ['market', /^(?:market|markets|market research|market overview|market briefing|macro|macroeconomics|macro market)$/],
  ['about', /^(?:about(?: (?:the )?(?:site|edgar terminal|sec edgar terminal))?|help|guide|research guide|how to use|help me get started)$/],
  ['home', /^(?:home|homepage|start)$/],
];
function toolMatch(raw, cftcEnabled) {
  const q = normalize(raw).replace(/^(?:open|go to|take me to|show me|find) (?:the )?/, '');
  const brokerForm = brokerDealerSearchForm(raw.replace(/^(?:open|go to|take me to|show me|find)\s+(?:the\s+)?/i, ''));
  if (brokerForm) return item(`/filings?form=${brokerForm}`, 'Broker-dealer filings · X-17A-5', 'Find public filings by legal name or CIK; confidential FOCUS reports are not included', 'filings');
  if (/^(?:13f|13f holdings|13f managers|managers|institutional managers|hedge funds?)$/.test(q)) return item('/fund?view=13f', 'Institutional managers · 13F', 'Find investment managers and their disclosed holdings', 'fund');
  if (/^(?:compare funds|fund comparison|etf comparison|compare etfs)$/.test(q)) return item('/fund?view=compare', 'Compare fund portfolios', 'Compare up to four registered funds', 'compare');
  if (/^(?:compare managers|manager comparison|compare hedge funds|13f comparison)$/.test(q)) return item('/fund?view=13f&managerView=compare', 'Compare institutional managers', 'Shared positions and reported portfolio exposures', 'compare');
  if (/^(?:(?:stock|company|financial|fundamental) )?(?:screener|screen|screening)$/.test(q)) return item('/market?tab=sectors', 'Sector Performance', 'Compare sector fundamentals across the covered SEC universe', 'market');
  if (/^(?:sectors?|sector performance|sector comparison|sector heatmap|fundamental lab)$/.test(q)) return item('/market?tab=sectors', 'Sector Performance', 'Compare growth, profitability and cash generation across sectors', 'market');
  if (/^(?:fcm|fcm capital|futures commission merchants?)$/.test(q) && cftcEnabled) return item('/risk?view=fcm', 'Futures commission merchant capital', 'CFTC capital and customer-funds research', 'risk');
  for (const [id, pattern] of TOOL_ALIASES) if (pattern.test(q)) {
    const tool = SITE_TOOLS.find(entry => entry.id === id);
    return item(tool.href, tool.label, tool.description, id);
  }
  return null;
}

const MARKET_ALIASES = {
  '13874A': ['s p 500', 'sp 500', 'sp500', 's p', 'e mini s p 500'],
  '209742': ['nasdaq', 'nasdaq 100'], '239742': ['russell', 'russell 2000'],
  '043602': ['10 year treasury', '10 year treasuries', '10 year note', 'treasury 10 year'],
  '042601': ['2 year treasury', '2 year treasuries', '2 year note'], '020601': ['treasury bond'],
  '134741': ['sofr'], '099741': ['euro', 'eur'], '097741': ['yen', 'jpy'], '096742': ['british pound', 'gbp'],
  '1170E1': ['vix'], '133741': ['bitcoin', 'btc'], '146021': ['ether', 'ethereum', 'eth'],
  '067651': ['oil', 'crude oil', 'wti', 'wti crude'], '023651': ['natural gas'],
  '088691': ['gold'], '084691': ['silver'], '085692': ['copper'],
  '002602': ['corn'], '001602': ['wheat'], '005602': ['soybeans'], '057642': ['cattle'], '083731': ['coffee'], '073732': ['cocoa'], '033661': ['cotton'],
};
const markets = CFTC_LAUNCH_CATALOG.map(entry => ({ ...entry, aliases: unique([normalize(entry.label), ...(MARKET_ALIASES[entry.code] || [])]) }));
function marketMatches(query) {
  const q = ` ${normalize(query)} `;
  return markets.filter(market => market.aliases.some(alias => q.includes(` ${alias} `)));
}
function marketItem(market, group = 'Market research') {
  const params = new URLSearchParams({ tab: 'positioning', family: market.family, contract: market.code, group: market.family === 'tff' ? 'leveraged-funds' : 'managed-money' });
  return item(`/market?${params}`, `${market.label} positioning`, 'CFTC futures positioning and historical context', 'market', group);
}

function exactEntities(value, index) {
  const raw = String(value || '').trim();
  const symbol = raw.replace(/^(?:ticker:\s*|\$)/i, '').toUpperCase();
  if (index.symbols.has(symbol)) return [index.symbols.get(symbol)];
  return [...(index.names.get(normalize(raw))?.values() || [])];
}
function findEntity(raw, index) {
  const exact = exactEntities(raw, index);
  if (exact.length) return { matches: exact, remaining: '', exact: true };
  const q = normalize(raw);
  const words = q.split(' '), spans = [];
  // Match spans from this bounded query against the prepared index. Iterating
  // the entire SEC directory here would make every keystroke more expensive.
  for (let start = 0; start < words.length; start++) {
    let alias = '';
    for (let end = start; end < Math.min(words.length, start + index.maxAliasWords); end++) {
      alias += `${end === start ? '' : ' '}${words[end]}`;
      const entries = index.searchableNames.get(alias);
      if (entries) spans.push({ alias, start, end, entries: [...entries.values()] });
    }
  }
  spans.sort((a, b) => b.alias.length - a.alias.length);
  const found = [];
  for (const span of spans) if (!found.some(entry => entry.start <= span.start && entry.end >= span.end)) found.push(span);
  const symbols = [...raw.matchAll(/(?:^|\s)(\$?[A-Za-z][A-Za-z0-9.-]{0,19})(?=\s|$|[,;?!])/g)].flatMap(match => {
    const token = match[1], upper = token.replace(/^\$/, '').toUpperCase();
    if (!index.symbols.has(upper) || (!token.startsWith('$') && RESERVED.has(upper))) return [];
    return [{ alias: normalize(token), entries: [index.symbols.get(upper)] }];
  });
  const matches = [...new Map([...found, ...symbols].flatMap(entry => entry.entries).map(entry => [entry.ticker, entry])).values()];
  let remaining = q;
  for (const match of [...found, ...symbols]) remaining = remaining.replace(new RegExp(`(?:^| )${escape(match.alias)}(?= |$)`, 'g'), ' ').trim();
  return { matches, remaining: remaining.replace(/\s+/g, ' '), exact: false, ambiguous: found.some(entry => entry.entries.length > 1) };
}

function comparePlan(raw, index, plan) {
  const text = raw.replace(/^compare\s+/i, '').replace(/\s+(?:against|versus|vs\.?)\s+/gi, ' | ');
  const explicit = /^compare\b/i.test(raw) || /\s(?:vs\.?|versus|against)\s/i.test(raw);
  const legalSuffix = /,\s*(?:l\.?l\.?c\.?|l\.?p\.?|inc\.?|ltd\.?|corp\.?|plc\.?|group|holdings|capital|partners)\s*$/i.test(raw)
    && !raw.split(',').every(part => index.symbols.has(part.trim().toUpperCase()));
  const tickerList = !legalSuffix && raw.includes(',') && raw.split(',').every((part, i, parts) => /^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$/.test(part.trim()) || !part.trim() && i === parts.length - 1);
  const spaceList = raw.trim().split(/\s+/).length >= 2 && raw.trim().split(/\s+/).every(token => index.symbols.has(token.toUpperCase()));
  if (!explicit && !tickerList && !spaceList) return false;
  const parts = (spaceList ? raw.trim().split(/\s+/) : text.split(/\s*\|\s*|\s*,\s*|\s+and\s+|\s*&\s*/i)).map(part => part.trim()).filter(Boolean);
  const selections = parts.map(part => exactEntities(part, index));
  const unresolved = parts.filter((_, i) => selections[i].length !== 1);
  if (unresolved.length) {
    plan.message = `Choose an exact company or fund for ${unresolved.join(', ')} before comparing.`;
    const active = selections.findLastIndex(entries => entries.length !== 1);
    const choices = selections[active].length ? selections[active].map(entry => entityItems(entry, 'Complete comparison')[0]) : suggestionEntries(parts[active], index);
    plan.items = choices.map(choice => {
      const ticker = choice.path.split(/[/?]/)[2];
      const input = parts.map((part, position) => position === active ? ticker : selections[position].length === 1 ? selections[position][0].ticker : part).join(', ');
      return { ...choice, label: `Add ${ticker} to comparison`, description: choice.label, group: 'Complete comparison', input };
    });
    return true;
  }
  const entries = [...new Map(selections.flat().map(entry => [entry.ticker, entry])).values()];
  if (entries.length < 2) { plan.message = 'Choose at least two different companies or funds to compare.'; return true; }
  const funds = entries.filter(entry => entry.isFund);
  if (funds.length && funds.length !== entries.length) {
    plan.message = 'Compare companies with companies, or registered funds with funds.';
    plan.items = entries.map(entry => entityItems(entry, 'Research separately')[0]); return true;
  }
  const max = funds.length ? 4 : MAX_COMPARE_COMPANIES;
  if (entries.length > max) { plan.message = `Compare up to ${max} ${funds.length ? 'funds' : 'companies'} at a time.`; return true; }
  const tickers = entries.map(entry => entry.ticker).join(',');
  const path = funds.length ? `/fund?view=compare&tickers=${tickers}` : `/compare/${tickers}`;
  plan.items = [item(path, `Compare ${entries.map(entry => entry.ticker).join(' and ')}`, funds.length ? 'Reported fund holdings and portfolio overlap' : 'Financial statements, ratios and company comparisons', 'compare')];
  plan.directPath = path;
  return true;
}

function companyIntent(entry, remaining, raw, cftcEnabled) {
  if (!remaining) return null;
  const q = remaining.replace(/^(?:please )?(?:show me|show|open|go to|find|tell me|what is|what are|how much is|how much are)\s+/, '').replace(/\b(?:the|its|their|for|of|s)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const company = entry.ticker;
  if (entry.isFund) {
    if (/^(?:(?:fund|etf|portfolio|reported)\s+)*(?:holdings|portfolio|positions|fund|etf|analysis|overview|performance)$/.test(q)) return entityItems(entry, 'Best match')[0];
    return null;
  }
  if (TOPIC_PATTERN.test(q) && !/^(?:liquidity|liquidity risk|liquidity risks)$/.test(q) || /\bchina\b/.test(q)) return disclosureItem(raw, 'Best match');
  if (/^(?:(?:commodity|market|business) )?exposures?$/.test(q) && cftcEnabled) return item(`/risk?ticker=${company}&view=exposures`, `${company} business exposures`, 'Company disclosures connected to relevant market context', 'risk');
  if (/^(?:cftc|futures exposure|commodity risk)$/.test(q) && cftcEnabled) return item(`/risk?ticker=${company}&view=exposures&exposurePanel=markets`, `${company} business exposures · Market links`, 'Company disclosures and aggregate CFTC futures positioning', 'risk');
  if (/^(?:stress|stress test|stress testing)$/.test(q)) return item(`/risk?ticker=${company}`, `${company} risk profile`, 'Review financial resilience, trends and source evidence', 'risk');
  if (/^(?:(?:credit|liquidity|financial|company|business) )?risk(?:s| profile| analysis)?$/.test(q) || q === 'liquidity') return item(`/risk?ticker=${company}`, `${company} risk profile`, 'Credit, liquidity and business exposures', 'risk');
  const brokerIntent = annualFilerIntent(raw);
  const filing = brokerIntent?.filingIntent.startsWith('X-17A-5') || /\b(?:10\s*k|10\s*q|8\s*k|20\s*f|40\s*f|6\s*k|s\s*1|def\s*14a|annual reports?|quarterly reports?|current reports?|sec filings?|filings?|proxy|insider filings?|form 4)\b/.test(q);
  if (filing) {
    const params = new URLSearchParams();
    const form = q.match(/\b(10\s*k|10\s*q|8\s*k|20\s*f|40\s*f|6\s*k|s\s*1|def\s*14a)\b/)?.[1];
    if (brokerIntent?.filingIntent.startsWith('X-17A-5')) params.set('form', brokerIntent.filingIntent);
    else if (form) params.set('form', /^def/.test(form) ? 'DEF 14A' : form.replace(/\s+/g, '').replace(/^(\d+|s)([a-z0-9])$/, '$1-$2').toUpperCase());
    else if (/annual report/.test(q)) params.set('family', 'annual');
    else if (/quarterly report/.test(q)) params.set('family', 'quarterly');
    else if (/current report/.test(q)) params.set('family', 'current');
    else if (/proxy/.test(q)) params.set('family', 'proxy');
    else if (/insider|form 4/.test(q)) params.set('family', 'insider');
    const years = unique(q.match(/\b20\d{2}\b/g) || []);
    if (years.length === 1) { params.set('start', `${years[0]}-01-01`); params.set('end', `${years[0]}-12-31`); }
    return item(`/filings/${company}${params.size ? `?${params}` : ''}`, `${company} ${params.get('form') || 'SEC'} filings`, `Original SEC reports${years.length === 1 ? ` · filed in ${years[0]}` : ''}`, 'filings');
  }
  let view = '', statement = '';
  if (/\b(?:balance sheet|assets|liabilities|equity)\b/.test(q)) { view = 'statements'; statement = 'balance'; }
  else if (/\b(?:cash flow|cashflow|free cash flow|cash conversion)\b/.test(q)) view = 'cash';
  else if (/\b(?:ratios|roe|roa|profit margins?|debt ratios?)\b/.test(q)) { view = 'statements'; statement = 'ratios'; }
  else if (/\b(?:revenue|earnings|net income|operating income|income statement|profit|sales)\b/.test(q)) { view = 'statements'; statement = 'income'; }
  else if (/\b(?:financials|financial statements|annual financials|quarterly financials|financial measures)\b/.test(q)) view = 'statements';
  else if (/^(?:changes|what changed|recent changes)$/.test(q)) view = 'changes';
  else if (/^(?:trends|growth trends|historical growth)$/.test(q)) view = 'trends';
  else if (/^(?:capital allocation|capital efficiency)$/.test(q)) view = 'capital';
  else if (/^(?:analysis|financial analysis|overview|company overview)$/.test(q)) view = 'overview';
  if (!view) return null;
  const params = new URLSearchParams({ view });
  if (statement) params.set('statement', statement);
  if (/\bquarterly\b/.test(q)) params.set('basis', 'quarter');
  else if (/\bytd\b|year to date/.test(q)) params.set('basis', 'ytd');
  else if (/\bttm\b|trailing twelve months|trailing 12 months/.test(q)) params.set('basis', 'ttm');
  const label = statement === 'balance' ? 'balance sheet' : statement === 'income' ? 'income statement' : statement === 'ratios' ? 'financial ratios' : view === 'cash' ? 'cash flow analysis' : view === 'changes' ? 'filing changes' : view === 'trends' ? 'financial trends' : view === 'capital' ? 'capital allocation' : 'financial analysis';
  return item(`/analysis/${company}?${params}`, `${company} ${label}`, 'SEC financial data with source references', 'analysis');
}

function suggestionEntries(raw, index) {
  const q = normalize(raw), upper = raw.trim().toUpperCase();
  if (q.length < 2) return [];
  const scored = index.records.flatMap(entry => {
    const score = entry.ticker === upper ? 1000 : entry.ticker.startsWith(upper) ? 900 - entry.ticker.length : entry.core === q ? 850 : entry.core.startsWith(q) ? 800 - entry.core.length : entry.words.some(word => word.startsWith(q)) ? 600 : entry.normalizedName.includes(q) ? 400 : 0;
    return score ? [{ entry, score }] : [];
  }).sort((a, b) => b.score - a.score || a.entry.ticker.localeCompare(b.entry.ticker));
  if (scored.length) return scored.slice(0, 5).map(({ entry }) => entityItems(entry, 'Companies and funds')[0]);
  // One-edit spelling suggestions are offered, never automatically navigated.
  if (!/^[a-z]{4,20}$/.test(q)) return [];
  const oneEdit = (a, b) => {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a[i] === b[j + 1] && a[i + 1] === b[j] && a.length === b.length) { i += 2; j += 2; }
      else if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
    return edits + Number(i < a.length || j < b.length) <= 1;
  };
  return index.records.filter(entry => entry.core.length >= 4 && oneEdit(q, entry.core)).slice(0, 3).map(entry => ({ ...entityItems(entry, 'Did you mean?')[0], description: `Possible spelling match · ${entry.name}` }));
}

/** Fast, explainable destination planning. Remote SEC filer identities are
 * deliberately merged by the caller, after their source response is verified. */
export function buildGlobalSearch(query, tickerMap, { cftcEnabled = true } = {}) {
  const plan = initialPlan();
  const raw = String(query || '').trim().replace(/\s+/g, ' ');
  if (!raw) return plan;
  if (raw.length > 500 || /[\x00-\x1f\x7f]/.test(String(query || ''))) { plan.message = 'Use a search of up to 500 characters.'; return plan; }
  const explicitTopic = raw.match(/^(?:topic|disclosures?):\s*(.+)$/i);
  if (explicitTopic) {
    plan.items = [disclosureItem(explicitTopic[1], 'Best match')]; plan.directPath = plan.items[0]?.path; return finish(plan);
  }
  const explicitCik = raw.match(/^(?:cik\s*:?\s*)?(\d{1,10})$/i);
  if (explicitCik) {
    const cik = normalizeCikIdentifier(explicitCik[1]);
    if (cik) { plan.items = [item(`/filings/${cik}`, `SEC filings · CIK ${cik}`, 'Open this SEC filer’s reports and source documents', 'filings')]; plan.directPath = plan.items[0].path; }
    else plan.message = 'Enter a positive SEC CIK with at most 10 digits.';
    return finish(plan);
  }
  if (/^(?:cik\s*:?\s*)?\d+$/i.test(raw)) { plan.message = 'Enter a positive SEC CIK with at most 10 digits.'; return plan; }
  const tool = toolMatch(raw, cftcEnabled);
  if (tool) { plan.items = [tool]; plan.directPath = tool.path; return finish(plan); }
  const annualIntent = annualFilerIntent(raw);
  const annualCik = annualIntent?.name.match(/^(?:cik\s*:?\s*)?(\d{1,10})$/i);
  if (annualCik) {
    const cik = normalizeCikIdentifier(annualCik[1]);
    if (cik) {
      const filter = annualIntent.filingIntent === 'annual' ? 'family=annual' : `form=${annualIntent.filingIntent}`;
      const target = `/filings/${cik}?${filter}`;
      plan.items = [item(target, `${annualIntent.filingIntent === 'annual' ? 'Annual reports' : 'Broker-dealer filings'} · CIK ${cik}`, 'Open the requested public SEC filings; document type is checked from the attachment', 'filings')];
      plan.directPath = target;
    } else plan.message = 'Enter a positive SEC CIK with at most 10 digits.';
    return finish(plan);
  }
  const marketIntent = /\b(?:positioning|futures|cftc|cot|commitments of traders)\b/i.test(raw);
  const foundMarkets = cftcEnabled ? marketMatches(raw) : [];
  if (marketIntent && cftcEnabled) {
    // A company mention is handled below; market-only requests can work even
    // when the independent SEC company directory is unavailable.
    const marketOnly = normalize(raw).replace(/\b(?:show me|show|open|latest|historical|history|cftc|cot|commitments of traders|positioning|futures|traders|positions|in|for|the|of)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const exactMarket = foundMarkets.filter(market => market.aliases.includes(marketOnly));
    if (exactMarket.length === 1 || !marketOnly) {
      const best = exactMarket.length ? marketItem(exactMarket[0], 'Best match') : item('/market?tab=positioning', 'CFTC futures positioning', 'Explore markets, trader groups and positioning history', 'market');
      plan.items = [best]; plan.directPath = best.path; return finish(plan);
    }
  }
  const index = directoryIndex(tickerMap);
  const topicTerm = DISCLOSURE_TOPIC_LABELS[raw.toUpperCase()];
  if (!index.records.length) {
    if (annualIntent?.name && annualIntent.name.length <= 160 && !/["():?]/.test(annualIntent.name)) {
      plan.lookupQuery = annualIntent.name;
      plan.filingIntent = annualIntent.filingIntent;
      plan.items = [disclosureItem(raw)];
      plan.message = 'Searching SEC filer names for public reports…';
      return finish(plan);
    }
    // Full topic phrases are independent; short symbol/topic overlaps (AI,
    // BTC, etc.) need the directory before a company can be ruled out.
    if (!/^[A-Za-z0-9.-]{1,10}$/.test(raw) && TOPIC_PATTERN.test(raw) && !QUESTION_PATTERN.test(raw) && raw.split(' ').every(word => word === word.toLowerCase()) && raw.split(' ').length <= 4 && /^(?:cybersecurity risks?|supply chain(?: risks?| disruptions?)?|debt covenant breaches|material weaknesses|internal controls?|going concern|customer concentration|artificial intelligence|climate risks?|data breaches)$/i.test(raw)) {
      plan.items = [disclosureItem(raw, 'Best match')]; plan.directPath = plan.items[0].path;
    } else {
      plan.needsDirectory = true;
      plan.items = [disclosureItem(topicTerm || raw)];
      plan.message = 'Checking company and fund names…';
    }
    return finish(plan);
  }
  if (comparePlan(raw, index, plan)) return finish(plan);
  const command = raw.match(/^(analysis|financials|filings|risk|fund|holdings):\s*(.+)$/i);
  const input = command ? `${command[2]} ${command[1]}` : raw;
  const found = findEntity(input, index);
  if (found.matches.length === 1) {
    const entry = found.matches[0];
    plan.entity = entry;
    const explicitTicker = /^(?:ticker:\s*|\$)/i.test(raw);
    const overlap = found.exact && !explicitTicker && (topicTerm || foundMarkets.length);
    const intent = companyIntent(entry, found.remaining, raw, cftcEnabled);
    const options = entityItems(entry).map(option => !found.exact && option.type === 'disclosures' ? disclosureItem(raw) : option);
    if (intent) { plan.items = [intent, ...options]; plan.directPath = intent.path; }
    else if (found.exact && !overlap) { plan.items = [{ ...options[0], group: 'Best match' }, ...options.slice(1)]; plan.directPath = options[0].path; }
    else if (found.exact) {
      plan.items = [...options, ...(topicTerm ? [disclosureItem(topicTerm)] : []), ...foundMarkets.map(market => marketItem(market))];
      plan.message = 'Choose the company, fund, or research topic you mean.';
    } else {
      plan.items = [disclosureItem(raw, 'Best match'), ...options]; plan.directPath = plan.items[0].path;
    }
    return finish(plan);
  }
  if (found.matches.length > 1 && (found.exact || found.ambiguous)) {
    plan.items = found.matches.slice(0, 6).map(entry => ({ ...(companyIntent(entry, found.remaining, raw, cftcEnabled) || entityItems(entry)[0]), group: 'Choose a company or share class' }));
    plan.items.push(disclosureItem(raw)); plan.message = 'Choose the exact company or share class you want to research.';
    return finish(plan);
  }
  if (found.matches.length > 1) {
    plan.items = [disclosureItem(raw, 'Best match'), ...found.matches.slice(0, 4).map(entry => entityItems(entry)[0])]; plan.directPath = plan.items[0].path; return finish(plan);
  }
  if (topicTerm) {
    plan.items = [disclosureItem(topicTerm, 'Best match'), ...foundMarkets.map(market => marketItem(market))]; plan.directPath = plan.items[0].path; return finish(plan);
  }
  if ((TOPIC_PATTERN.test(raw) || QUESTION_PATTERN.test(raw)) && !/\b(?:llc|ltd|inc|corp|l\.?p\.?)\.?$/i.test(raw)) {
    plan.items = [disclosureItem(raw, 'Best match'), ...foundMarkets.map(market => marketItem(market))]; plan.directPath = plan.items[0].path; return finish(plan);
  }
  plan.items = [...suggestionEntries(raw, index), ...foundMarkets.map(market => marketItem(market)), disclosureItem(raw)];
  const managerAction = raw.match(/^(.+?)\s+(?:13f(?:\s+holdings)?|portfolio holdings|sec filings|holdings|filings)$/);
  const lookup = annualIntent?.name || (managerAction ? managerAction[1].trim() : raw);
  const legalName = /\b(?:llc|ltd|inc|corp|l\.?p\.?)\.?$/i.test(lookup);
  const research = TOPIC_PATTERN.test(raw) || QUESTION_PATTERN.test(raw);
  const nameLike = legalName || !research && (Boolean(annualIntent?.name) || /\b(?:capital|partners|associates|management|advisors|advisers|investments?|holdings)\b/i.test(lookup) || raw.split(' ').length <= 3 || /^[A-Z\d]/.test(raw));
  if (nameLike && lookup.length >= 2 && lookup.length <= 160 && !/["():?]/.test(lookup)) {
    plan.lookupQuery = lookup;
    plan.filingIntent = annualIntent?.filingIntent || '';
    plan.message = plan.items.some(entry => entry.type !== 'disclosures') ? 'Choose a matching company, fund, or SEC filer.' : 'Searching SEC company, broker-dealer and investment-manager names…';
  } else {
    const best = disclosureItem(raw, 'Best match'); plan.items = [best, ...plan.items]; plan.directPath = best.path;
  }
  return finish(plan);
}

/** History labels describe the actual destination instead of displaying URLs. */
export function describeSearchPath(path) {
  const safe = safeInternalPath(path);
  if (!safe) return 'Research destination unavailable';
  const url = new URL(safe, 'https://secedgarterminal.com');
  const [, tool, identifier] = url.pathname.split('/');
  if (tool === 'analysis' && identifier) return `Financial analysis · ${identifier}`;
  if (tool === 'filings' && identifier) return `SEC filings · ${/^\d+$/.test(identifier) ? 'CIK ' : ''}${identifier}`;
  if (tool === 'fund') {
    if (identifier) return `Fund holdings · ${identifier}`;
    if (url.searchParams.get('managerView') === 'compare') return 'Manager portfolio comparison';
    if (url.searchParams.get('view') === '13f') return url.searchParams.get('managerCik') ? 'Manager holdings · SEC 13F' : 'Institutional managers · SEC 13F';
    if (url.searchParams.get('view') === 'compare') return 'Fund portfolio comparison';
    return 'Fund research';
  }
  if (tool === 'risk') return `Risk research${url.searchParams.get('ticker') ? ` · ${url.searchParams.get('ticker')}` : ''}`;
  if (tool === 'disclosures') return 'Disclosure research';
  if (tool === 'compare') return identifier ? `Company comparison · ${identifier.split(',').join(' / ')}` : 'Company comparison';
  if (tool === 'market' && url.searchParams.get('tab') === 'positioning') return 'CFTC market positioning';
  if (tool === 'market' && ['sectors', 'fundamentals', 'factors', 'companies'].includes(url.searchParams.get('tab'))) return 'Sector Performance';
  return SITE_TOOLS.find(entry => entry.href === url.pathname)?.label || 'Research';
}
