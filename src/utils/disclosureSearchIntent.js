import { parseDisclosureQuery, quoteTerm } from './disclosureQuery.js';
import { SECTION_OPTIONS } from './disclosureResearch.js';

// Deliberately deterministic: suggestions never silently replace a company or
// spelling, and every expanded term is returned with the interpreted query.
export const DISCLOSURE_SEARCH_INTENT_VERSION = 1;
const FORMS = ['10-K', '10-Q', '8-K', '20-F', '40-F', '6-K', 'S-1', 'S-3', 'S-4', 'DEF 14A', 'DEFM14A', 'N-CSR', 'NPORT-P'];
const SECTIONS = new Set(SECTION_OPTIONS.map(([id]) => id));
const RESERVED_SYMBOLS = new Set('A AI ALL AM AN AND ARE AS AT BE BOND BONDS BY CAN CASH CEO CFO CHAIN CLOSE CO COST CREDIT DAY DAYS DEBT DO EPS EQUITY FOR FROM FUND FUNDS GAAP GAS GO GOLD HAS IN INCOME IPO IS IT LOSS LOW MAY MONTH NET NEW NO NOT NOW OF OIL ON ONE OPEN OR OUT PRICE PRICES RATE RATES RISK ROE RUN SEC SEE SHARE SHARES SILVER SO STOCK STOCKS SUPPLY TAX TAXES THE TO TOTAL TRUE UNIT UNITS VALUE WAS WE WITH YEAR YIELD'.split(' '));
const GENERIC_NAMES = new Set('american america australia bank brazil business canada capital central china chinese company continental energy enterprise enterprises europe european financial first france germany global group holdings income india industrial industries industry international investment investments israel japan kingdom mexico national new north northern pacific partners resources russia securities south southern state states taiwan technology technologies united western'.split(' '));
const SUFFIXES = /\b(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|llc|lp|sa|ag|nv|se)\s*$/;
const dateString = value => new Date(value).toISOString().slice(0, 10);
const normalized = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unique = values => [...new Set(values)];
const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_SEARCH_INTENT' }); };
const realDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && dateString(value) === value;

export const DISCLOSURE_SEARCH_TOPICS = [
  { label: 'Cybersecurity', aliases: ['cybersecurity risks', 'cyber security risks', 'cyber risks', 'cybersecurity', 'cyber security'], terms: ['cybersecurity', 'cyber security', 'information security'] },
  { label: 'Data breaches', aliases: ['data breaches', 'data breach'], terms: ['data breach', 'data breaches', 'security breach'] },
  { label: 'Supply chain', aliases: ['supply chain risks', 'supply chain disruptions', 'supply chains', 'supply chain'], terms: ['supply chain', 'supply chains', 'supplier disruption'] },
  { label: 'Covenant breaches', aliases: ['debt covenant breaches', 'debt covenant breach', 'covenant breaches', 'covenant breach'], groups: [['covenant', 'covenants'], ['breach', 'breaches', 'breached']] },
  { label: 'Debt repayment', aliases: ['debt repayment problems', 'debt repayment difficulties'], terms: ['covenant breach', 'payment default', 'refinancing risk', 'inability to repay'] },
  { label: 'Material weaknesses', aliases: ['material weaknesses', 'material weakness'], terms: ['material weakness', 'material weaknesses'] },
  { label: 'Internal controls', aliases: ['internal controls', 'internal control'], terms: ['internal control', 'internal controls', 'control deficiency'] },
  { label: 'Going concern', aliases: ['going concern risks', 'going concern'], terms: ['going concern', 'substantial doubt'] },
  { label: 'Customer concentration', aliases: ['customer concentration', 'concentrated customers'], terms: ['customer concentration', 'major customer', 'largest customer'] },
  { label: 'Refinancing', aliases: ['refinancing risks', 'refinancing risk', 'refinancing'], terms: ['refinancing', 'refinance'] },
  { label: 'Liquidity', aliases: ['liquidity risks', 'liquidity risk', 'liquidity'], terms: ['liquidity', 'cash runway'] },
  { label: 'Litigation', aliases: ['lawsuits', 'lawsuit', 'litigation'], terms: ['litigation', 'lawsuit', 'lawsuits'] },
  { label: 'Impairments', aliases: ['goodwill impairments', 'goodwill impairment'], terms: ['goodwill impairment', 'impairment of goodwill'] },
  { label: 'Restructuring', aliases: ['layoffs', 'layoff', 'workforce reductions'], terms: ['layoffs', 'workforce reduction', 'reduction in force'] },
  { label: 'Artificial intelligence', aliases: ['artificial intelligence', 'ai risks', 'ai'], terms: ['artificial intelligence', 'generative AI', 'machine learning'] },
  { label: 'Climate risks', aliases: ['climate risks', 'climate risk'], terms: ['climate risk', 'climate change', 'physical risk', 'transition risk'] },
  { label: 'Risk disclosures', aliases: ['risks', 'risk'], terms: ['risk', 'risks'] },
];

const directoryIndexes = new WeakMap();
const TOPIC_WORDS = new Set(DISCLOSURE_SEARCH_TOPICS.flatMap(topic => topic.aliases.flatMap(alias => alias.split(' '))).concat('earnings revenue margin default credit debt annual quarterly financial statements impairment'.split(' ')));
function companyIndex(companies) {
  if (!companies || typeof companies !== 'object') return { symbols: new Map(), names: new Map(), records: [] };
  if (directoryIndexes.has(companies)) return directoryIndexes.get(companies);
  const entries = Array.isArray(companies) ? companies.map(value => [value?.ticker, value]) : Object.entries(companies);
  const symbols = new Map(), names = new Map(), prefixes = new Map(), records = [];
  function addName(alias, entry, target = names) {
    if (alias.length < 4 || GENERIC_NAMES.has(alias)) return;
    if (!target.has(alias)) target.set(alias, new Map());
    target.get(alias).set(entry.cik, entry);
  }
  for (const [key, value] of entries.slice(0, 100000)) {
    const ticker = String(value?.ticker || key || '').toUpperCase();
    const cik = String(value?.cik ?? value?.cik_str ?? '');
    const name = String(value?.name || value?.title || '').trim();
    if (!/^[A-Z][A-Z0-9.-]{0,19}$/.test(ticker) || !/^\d{1,10}$/.test(cik) || Number(cik) <= 0 || !name || name.length > 1000) continue;
    const entry = { ticker, cik: cik.padStart(10, '0'), name };
    symbols.set(ticker, entry); records.push(entry);
    const full = normalized(name);
    addName(full, entry);
    let core = full, previous;
    do { previous = core; core = core.replace(SUFFIXES, '').trim(); } while (previous !== core);
    addName(core, entry);
    // Distinctive first names are useful, but collisions stay unresolved.
    const coreWords = core.split(' '), first = coreWords[0];
    if (first.length >= 5 && !GENERIC_NAMES.has(first) && !TOPIC_WORDS.has(first)) addName(first, entry, prefixes);
    for (let count = 2; count < coreWords.length; count++) {
      const words = coreWords.slice(0, count);
      if (words.some(word => word.length >= 4 && !GENERIC_NAMES.has(word) && !TOPIC_WORDS.has(word) && !RESERVED_SYMBOLS.has(word.toUpperCase()))) addName(words.join(' '), entry, prefixes);
    }
  }
  // An exact issuer name wins over another issuer's inferred first-word alias:
  // Apple Inc. must not become ambiguous with Apple Hospitality REIT.
  for (const [alias, entries] of prefixes) if (!names.has(alias)) names.set(alias, entries);
  const index = { symbols, names, records };
  directoryIndexes.set(companies, index);
  return index;
}

function baseSettings(settings, today) {
  const forms = (Array.isArray(settings.forms) ? settings.forms : String(settings.forms || '10-K,10-Q,8-K').split(',')).map(value => value.trim());
  if (!forms.length || forms.some(form => !FORMS.includes(form))) fail('Choose supported SEC filing forms.');
  const start = settings.start || `${Number(today.slice(0, 4)) - 5}-01-01`, end = settings.end || today;
  if (!realDate(start) || !realDate(end) || start > end || start < '2001-01-01' || end > today) fail('Choose a valid filing-date window between 2001 and today.');
  const section = settings.section || 'all', scope = settings.scope || 'paragraph';
  if (!SECTIONS.has(section)) fail('Choose a supported filing section.');
  if (!['paragraph', 'document'].includes(scope)) fail('Choose paragraph or document matching.');
  const tickers = String(settings.tickers || '').trim();
  if (tickers.length > 500 || tickers && tickers.split(',').some(value => !/^(?:[A-Za-z][A-Za-z0-9.-]{0,19}|\d{1,10})$/.test(value.trim()))) fail('Use comma-separated company tickers or SEC CIKs in the company filter.');
  if (tickers && unique(tickers.split(',')).length > 5) fail('Search up to 5 companies at a time.');
  const depth = settings.depth == null || settings.depth === '' ? 8 : Number(settings.depth);
  if (!Number.isInteger(depth) || depth < 1 || depth > 12) fail('Review between 1 and 12 filings per company.');
  const comparison = settings.comparison || 'none';
  if (!['none', 'annual-season', 'previous-report'].includes(comparison)) fail('Choose a supported filing comparison.');
  return { query: '', tickers: tickers.toUpperCase(), mode: 'index', forms: unique(forms).join(','), start, end, section, scope, comparison, depth, amendments: settings.amendments === true || settings.amendments === 'true' };
}

export function preservesDisclosureSearchSyntax(raw, style = 'smart') {
  return style === 'exact' || /\b(?:AND|OR|NOT)\b|["()]|(?:^|\s)-[\p{L}\p{N}]/u.test(raw);
}

function extractDateWindow(text, settings, today, warnings) {
  const year = Number(today.slice(0, 4));
  let found = false;
  const assign = (start, end) => {
    if (found) fail('Use one explicit filing-date window, or set the date filters.');
    if (end > today && end.slice(0, 4) === today.slice(0, 4) && end.endsWith('-12-31')) end = today;
    if (!realDate(start) || !realDate(end) || start > end || start < '2001-01-01' || end > today) fail('The requested filing-date window must fall between 2001 and today.');
    settings.start = start; settings.end = end; found = true;
  };
  const prefix = '(?:\\b(?:filings?|reports?)\\s+(?:filed\\s+)?(?:from|in|during|between|for|since)|\\bfiled\\s+(?:from|in|during|between|since))';
  text = text.replace(new RegExp(`${prefix}\\s+(\\d{4}(?:-\\d{2}-\\d{2})?)\\s+(?:to|through|and|until)\\s+(\\d{4}(?:-\\d{2}-\\d{2})?)\\b`, 'gi'), (_, a, b) => {
    assign(a.length === 4 ? `${a}-01-01` : a, b.length === 4 ? `${b}-12-31` : b); return ' ';
  });
  text = text.replace(new RegExp(`${prefix}\\s+(\\d{4}(?:-\\d{2}-\\d{2})?)\\b`, 'gi'), (match, value) => {
    const since = /\bsince\b/i.test(match);
    assign(value.length === 4 ? `${value}-01-01` : value, since ? today : value.length === 4 ? `${value}-12-31` : value); return ' ';
  });
  text = text.replace(/\b(?:filings?|reports?|filed)\s+(?:(?:from|in|during|for)\s+)?(last|this)\s+year\b/gi, (_, relative) => {
    const selected = relative.toLowerCase() === 'last' ? year - 1 : year;
    assign(`${selected}-01-01`, selected === year ? today : `${selected}-12-31`); return ' ';
  });
  text = text.replace(/\b(?:filings?|reports?|filed)\s+(?:(?:from|in|during)\s+)?(?:the\s+)?(?:last|past)\s+(\d{1,3})\s+(days?|months?|years?)\b/gi, (_, amount, unit) => {
    const value = Number(amount), date = new Date(`${today}T00:00:00Z`);
    if (value < 1) fail('Use a positive number for the filing-date window.');
    if (/^day/i.test(unit)) date.setUTCDate(date.getUTCDate() - value);
    else if (/^month/i.test(unit)) { const day = date.getUTCDate(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - value); date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate())); }
    else { const month = date.getUTCMonth(); date.setUTCFullYear(date.getUTCFullYear() - value); if (date.getUTCMonth() !== month) date.setUTCDate(0); }
    assign(dateString(date), today); return ' ';
  });
  if (/\b(?:fiscal|fy|quarter|q[1-4])\s*\d{2,4}\b|\b(?:19|20)\d{2}\b/i.test(text)) warnings.push('Unqualified years and fiscal periods remain search terms. Use “filings from 2025” or the date filters to select filing dates.');
  return text;
}

function extractFormsAndSection(text, settings) {
  const forms = [];
  text = text.replace(/\b(?:form\s+)?(10\s*-?\s*[KQ]|8\s*-?\s*K|20\s*-?\s*F|40\s*-?\s*F|6\s*-?\s*K|S\s*-?\s*[134]|DEF\s*14A|DEFM\s*14A|N\s*-?\s*CSR|NPORT\s*-?\s*P)(\/A)?\b/gi, (_, form, amendment) => {
    if (amendment) fail('To include amended filings, choose the base form and enable Include amendments in filters.');
    const compact = form.replace(/[\s-]/g, '').toUpperCase();
    const canonical = FORMS.find(value => value.replace(/[\s-]/g, '') === compact);
    if (canonical) forms.push(canonical);
    return ' ';
  });
  for (const [pattern, values] of [
    [/\bannual reports?\b/gi, ['10-K', '20-F', '40-F']],
    [/\bquarterly reports?\b/gi, ['10-Q']],
    [/\bcurrent reports?\b/gi, ['8-K', '6-K']],
    [/\bproxy statements?\b/gi, ['DEF 14A', 'DEFM14A']],
  ]) text = text.replace(pattern, () => { forms.push(...values); return ' '; });
  if (forms.length) settings.forms = unique(forms).join(',');
  const sections = [];
  for (const [pattern, section] of [
    [/\b(?:in\s+(?:the\s+)?(?:risk factors|item 1a)(?:\s+section)?|risk factors section|item 1a)\b/gi, 'risk'],
    [/\b(?:in\s+(?:the\s+)?(?:md&a|management(?:'s)? discussion and analysis)(?:\s+section)?|md&a section)\b/gi, 'mda'],
    [/\b(?:in\s+(?:the\s+)?(?:financial statement notes|notes to (?:the )?financial statements)|financial statement notes section)\b/gi, 'notes'],
  ]) text = text.replace(pattern, () => { sections.push(section); return ' '; });
  text = text.replace(/\b(?:in\s+(?:the\s+)?)?item\s+(\d\.\d{2})(?:\s+section)?\b/gi, (match, item) => {
    if (!SECTIONS.has(`8k:${item}`)) return match;
    sections.push(`8k:${item}`); return ' ';
  });
  if (unique(sections).length > 1) fail('Search one filing section at a time, or choose All sections.');
  if (sections.length) settings.section = sections[0];
  return text;
}

function extractCompanies(text, index, settings, chips, suggestions, warnings) {
  const selected = [], identities = new Set();
  const add = (identity, identifier) => {
    if (identities.has(identity.cik)) return;
    identities.add(identity.cik); selected.push(identifier);
    chips.push({ key: 'tickers', label: identity.name ? `${identity.name}${identifier === identity.ticker ? ` (${identifier})` : ''}` : `CIK ${identity.cik}`, value: identifier });
  };
  if (/\bCIK\s*[:#]?\s*\d{11}/i.test(text)) fail('An SEC CIK contains at most 10 digits.');
  text = text.replace(/(?:\bCIK\s*[:#]?\s*(\d{1,10})\b|^\s*(0\d{9})\b)/gi, (_, prefixed, padded) => {
    const value = prefixed || padded;
    if (Number(value) <= 0) fail('Enter a positive SEC CIK.');
    const cik = value.padStart(10, '0'); add({ cik }, cik); return ' ';
  });
  text = text.replace(/(?:\$([A-Za-z][A-Za-z0-9.-]{0,19})|\b(?:ticker|symbol)\s*[:=]?\s*([A-Za-z][A-Za-z0-9.-]{0,19})|\b([A-Za-z][A-Za-z0-9.-]{1,19})\b)(?:[’']s\b)?/g, (match, dollar, labelled, bare, offset) => {
    const ticker = String(dollar || labelled || bare).toUpperCase(), entry = index.symbols.get(ticker);
    if (!entry) return match;
    const explicit = dollar || labelled;
    if (!explicit && (RESERVED_SYMBOLS.has(ticker) || bare !== ticker && (ticker.length < 3 || text.slice(0, offset).trim()))) return match;
    add(entry, ticker); return ' ';
  });
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)], occupied = new Set(), spans = [];
  for (let i = 0; i < words.length; i++) {
    if (occupied.has(i)) continue;
    for (let count = Math.min(10, words.length - i); count >= 1; count--) {
      const end = i + count;
      if (Array.from({ length: count }, (_, offset) => i + offset).some(value => occupied.has(value))) continue;
      const alias = words.slice(i, end).map(word => normalized(word[0])).join(' '), matches = index.names.get(alias);
      if (!matches) continue;
      if (matches.size !== 1) {
        for (const entry of [...matches.values()].slice(0, 3)) suggestions.push({ kind: 'company', label: `${entry.name} (${entry.ticker})`, query: text.replace(new RegExp(`\\b${escape(alias)}\\b`, 'i'), entry.ticker), ...entry });
        warnings.push(`“${alias}” matches more than one SEC issuer. Select a company or use its ticker; it remains a search term.`);
        break;
      }
      const entry = [...matches.values()][0]; add(entry, entry.cik);
      for (let offset = i; offset < end; offset++) occupied.add(offset);
      const start = words[i].index, finish = words[end - 1].index + words[end - 1][0].length;
      spans.push([start, finish]); break;
    }
  }
  for (const [start, end] of spans.reverse()) text = `${text.slice(0, start)} ${text.slice(end).replace(/^[’']s\b/i, '')}`;
  if (selected.length > 5) fail('Search up to 5 companies at a time.');
  if (selected.length) settings.tickers = selected.join(',');
  return text;
}

function simplifyLanguage(text) {
  return text
    .replace(/\b(?:please\s+)?(?:can|could|would)\s+you\s+/gi, ' ')
    .replace(/\b(?:show|find|search|give)\s+(?:me\s+)?(?:all\s+)?/gi, ' ')
    .replace(/\bwhat\s+(?:have|do|did|are)\s+(?:companies|issuers|filers)\s+(?:said|say|disclosed|disclose|reported|report|mentioned|mention)\s*(?:about)?/gi, ' ')
    .replace(/\b(?:what|which)\s+(?:companies|issuers|filers)\s+(?:(?:have|are|have been)\s+)?(?:said|saying|disclosed|disclosing|reported|reporting|mentioned|mentioning|mention|disclose|report)\s*(?:about)?/gi, ' ')
    .replace(/\b(?:companies|issuers|filers)\s+(?:(?:that|with)\s+)?(?:(?:have|are)\s+)?(?:mentioning|mention|mentioned|disclosing|disclosed|reporting|reported|discussing|discuss)\s*/gi, ' ')
    .replace(/\b(?:companies|issuers|filers)\s+(?:with|having)\s+/gi, ' ')
    .replace(/\b(?:disclosures?|filings?|reports?)\s+(?:about|on|regarding|mentioning|discussing|containing)\s+/gi, ' ')
    .replace(/\b(?:tell me about|what are|what is|information about|examples of|evidence of)\s+/gi, ' ')
    .replace(/^[\s,.:;!?]+|[\s,.:;!?]+$/g, '')
    .replace(/^(?:(?:about|on|for|from|by|at|in|the|and|of|with|regarding)\b\s*)+|\s+\b(?:in|for|from|by|at|and|the|filings?|reports?|disclosures?)\s*$/gi, ' ')
    .trim();
}

function simplifyResolvedQuestion(text, originalQuery) {
  // Apply issuer-question framing only after a company was actually resolved.
  // Do not strip substantive nouns such as "disclosure controls", "report
  // quality", or "related party transactions" just because they share a word.
  const question = /^(?:please[, ]+)?(?:what|which|how)\s+(?:did|does|do|has|have|had|is|are|was|were)\b/i.test(originalQuery);
  const verbs = '(?:say|says|said|saying|disclose|discloses|disclosed|disclosing|report|reports|reported|reporting|mention|mentions|mentioned|mentioning|discuss|discusses|discussed|discussing|describe|describes|described|describing)';
  const prefix = question ? '(?:(?:what|which|how)\\s+(?:did|does|do|has|have|had|is|are|was|were)\\s+)?' : '';
  const about = question ? '(?:\\s+(?:about|on|regarding))?' : '\\s+(?:about|on|regarding)';
  const framing = new RegExp(`^\\s*${prefix}((?:(?:not|never)\\s+)?)${verbs}${about}\\s+`, 'i');
  return text.replace(framing, '$1')
    .replace(/\b(risks?|exposures?|concerns?)\s+(?:related|relating)\s+to\s+/gi, '$1 ');
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}

/** Lightweight local suggestions; choosing one is always an explicit UI action. */
export function disclosureSearchSuggestions(raw, { companies } = {}) {
  if (typeof raw !== 'string' || raw.length > 1000 || preservesDisclosureSearchSyntax(raw)) return [];
  const text = raw.trim(), lower = normalized(text), results = [];
  for (const topic of DISCLOSURE_SEARCH_TOPICS) {
    if (!lower || topic.aliases.some(alias => alias.startsWith(lower) || lower.length >= 3 && alias.includes(lower))) results.push({ kind: 'topic', label: topic.label, query: topic.aliases[0] });
  }
  const vocabulary = unique(DISCLOSURE_SEARCH_TOPICS.flatMap(topic => topic.aliases.flatMap(alias => alias.split(' ')))).filter(word => word.length >= 5);
  for (const word of text.match(/[a-zA-Z]{5,}/g) || []) {
    if (vocabulary.includes(word.toLowerCase())) continue;
    const candidates = vocabulary.map(candidate => ({ candidate, distance: editDistance(word.toLowerCase(), candidate) })).filter(value => value.distance <= (word.length >= 9 ? 2 : 1)).sort((a, b) => a.distance - b.distance);
    if (candidates.length && (!candidates[1] || candidates[0].distance < candidates[1].distance)) {
      const query = text.replace(new RegExp(`\\b${escape(word)}\\b`, 'i'), candidates[0].candidate);
      results.push({ kind: 'spelling', label: `Did you mean “${query}”?`, query });
    }
  }
  if (companies && lower.length >= 2) {
    const seen = new Set();
    for (const entry of companyIndex(companies).records) {
      if (seen.has(entry.cik) || !(entry.ticker.toLowerCase().startsWith(lower) || normalized(entry.name).startsWith(lower))) continue;
      seen.add(entry.cik); results.push({ kind: 'company', label: `${entry.name} (${entry.ticker})`, query: `${entry.ticker} `, ...entry });
      if (seen.size >= 4) break;
    }
  }
  return results.slice(0, 8);
}

export function interpretDisclosureSearch(raw, { companies, now = new Date(), settings: current = {}, style = 'smart' } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000 || /[\u0000-\u001f\u007f<>]/.test(raw)) fail('Enter a disclosure question or search expression using at most 1,000 characters.');
  if (!['smart', 'exact'].includes(style)) fail('Choose smart or exact search.');
  const today = dateString(now), settings = baseSettings(current, today), warnings = [], chips = [], expansions = [];
  const originalQuery = raw.trim();
  const normalizedQuery = originalQuery.replace(/[“”]/g, '"');
  if (normalizedQuery !== originalQuery) warnings.push('Curly quotation marks were normalized to exact phrase quotes.');
  if (preservesDisclosureSearchSyntax(normalizedQuery, style)) {
    parseDisclosureQuery(normalizedQuery);
    settings.query = normalizedQuery;
    return { version: DISCLOSURE_SEARCH_INTENT_VERSION, originalQuery, query: normalizedQuery, settings, chips: settingsChips(settings, []), expansions, suggestions: [], warnings, style: 'exact' };
  }
  if (/[*~^{}\[\]\\]/.test(originalQuery)) fail('Use literal words and phrases; wildcards and regular expressions are not supported.');
  const suggestions = disclosureSearchSuggestions(originalQuery);
  let text = originalQuery.replace(/[“”]/g, '"').replace(/[?]+$/g, '').trim();
  // Remove date syntax before issuer scanning: years and SEC form numbers are
  // never guessed to be numeric CIKs or operating-company tickers.
  text = extractDateWindow(text, settings, today, warnings);
  text = extractFormsAndSection(text, settings);
  text = simplifyLanguage(text);
  text = extractCompanies(text, companyIndex(companies), settings, chips, suggestions, warnings);
  if (chips.length) text = simplifyResolvedQuestion(text, originalQuery);
  text = simplifyLanguage(text);
  const naturalBranches = text.split(/\s+or\s+/i);
  function compileBranch(source, expand = true) {
    const parts = [], matched = new Set();
    if (expand) for (const topic of DISCLOSURE_SEARCH_TOPICS) {
      const pattern = new RegExp(`\\b(?:${topic.aliases.map(escape).sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi');
      source = source.replace(pattern, (term, offset) => {
        // $AI / ticker: AI always means an explicit company request. If the
        // directory is unavailable, keep that token literal for the warning
        // fallback instead of turning it into an artificial-intelligence topic.
        if (/^ai(?:\s|$)/i.test(term) && (['$', '.'].includes(source[offset - 1]) || /\b(?:ticker|symbol)\s*[:=]?\s*$/i.test(source.slice(0, offset)))) return term;
        if (!matched.has(topic.label)) {
          const groups = topic.groups || [topic.terms];
          parts.push(groups.map(group => `(${group.map(quoteTerm).join(' OR ')})`).join(' AND '));
          expansions.push({ term, alternatives: groups.flat(), label: topic.label });
          matched.add(topic.label);
        }
        return ' ';
      });
    }
    const words = simplifyLanguage(source).match(/[\p{L}\p{N}][\p{L}\p{N}'’./$%-]*/gu) || [];
    // Keep content words (including negation) literal. Stop words are only removed
    // as framing; a "no breach" passage must never be labeled an actual breach.
    for (const word of words) {
      if (['and', 'the', 'about', 'regarding'].includes(word.toLowerCase()) && (parts.length || words.length > 1)) continue;
      if (word.length < 2) { warnings.push(`“${word}” is too short for the filing search and was omitted.`); continue; }
      parts.push(quoteTerm(word));
    }
    if (!parts.length) fail('Add a disclosure topic after the company or filters, such as cybersecurity, liquidity, or material weakness.');
    return parts.join(' AND ');
  }
  const combine = branches => branches.length === 1 ? branches[0] : branches.map(branch => `(${branch})`).join(' OR ');
  let query = combine(naturalBranches.map(branch => compileBranch(branch)));
  try { parseDisclosureQuery(query); }
  catch (error) {
    if (expansions.length && /16 terms|1,000 characters/.test(error.message)) {
      // Keep every user term when expansion exceeds the shared grammar budget.
      query = combine(naturalBranches.map(branch => compileBranch(branch, false)));
      parseDisclosureQuery(query); expansions.length = 0;
      warnings.push('Related terms were omitted to keep this longer search within the query limit.');
    } else throw error;
  }
  settings.query = query;
  return { version: DISCLOSURE_SEARCH_INTENT_VERSION, originalQuery, query, settings, chips: settingsChips(settings, chips), expansions, suggestions: suggestions.slice(0, 8), warnings: unique(warnings), style: 'smart' };
}

function settingsChips(settings, companyChips) {
  return [
    ...(companyChips.length ? companyChips : settings.tickers ? [{ key: 'tickers', label: `Companies: ${settings.tickers}`, value: settings.tickers }] : [{ key: 'tickers', label: 'All SEC filers', value: '' }]),
    { key: 'forms', label: settings.forms.replaceAll(',', ' · '), value: settings.forms },
    { key: 'start', label: `Filed from ${settings.start}`, value: settings.start },
    { key: 'end', label: `Through ${settings.end}`, value: settings.end },
    ...(settings.section !== 'all' ? [{ key: 'section', label: ({ risk: 'Risk factors', mda: 'Management discussion', notes: 'Financial statement notes' })[settings.section] || `Section ${settings.section.replace('8k:', '')}`, value: settings.section }] : []),
    ...(settings.scope === 'document' ? [{ key: 'scope', label: 'Across the document', value: settings.scope }] : []),
  ];
}
