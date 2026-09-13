import { CFTC_LAUNCH_CATALOG, cftcDate } from './cftc.js';
import { buildFilingUrl } from './filingTextParser.js';

export const COMPANY_CFTC_SCHEMA_VERSION = 'edgar.company-cftc-context.v1';
export const COMPANY_CFTC_MAX_TEXT = 1_800_000;
export const COMPANY_CFTC_MAX_LINKS = 8;
const ANNUAL_FORMS = new Set(['10-K', '20-F', '40-F']);

function invalid(message, code) { return Object.assign(new Error(message), { status: 400, code }); }

export function parseCompanyCftcRequest(url, now = new Date()) {
  const params = new URL(url).searchParams;
  for (const key of params.keys()) {
    if (!['ticker', 'asOf'].includes(key)) throw invalid(`Unknown query parameter: ${key}`, 'UNKNOWN_QUERY_PARAMETER');
    if (params.getAll(key).length !== 1) throw invalid(`Query parameter may appear only once: ${key}`, 'DUPLICATE_QUERY_PARAMETER');
  }
  const ticker = (params.get('ticker') || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker)) throw invalid('Provide a valid SEC company ticker.', 'INVALID_TICKER');
  const asOf = params.get('asOf');
  if (asOf !== null && (cftcDate(asOf) !== asOf || asOf < '1994-01-01' || asOf > new Date(now).toISOString().slice(0, 10))) {
    throw invalid('Use asOf=YYYY-MM-DD between 1994 and today for the SEC filing-date cutoff.', 'INVALID_AS_OF');
  }
  return { ticker, asOf };
}

/** Only complete annual reports; an amendment can omit the business/risk text. */
export function companyCftcAnnualFilings(recent, cik, asOf) {
  if (!/^\d{10}$/.test(String(cik))) return [];
  return (Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : []).flatMap((accession, index) => {
    const form = recent.form?.[index], filed = recent.filingDate?.[index], reportDate = recent.reportDate?.[index] || null;
    const primaryDoc = recent.primaryDocument?.[index];
    if (!ANNUAL_FORMS.has(form) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)
      || cftcDate(filed) !== filed || filed > asOf || (reportDate && (cftcDate(reportDate) !== reportDate || reportDate > filed))
      || typeof primaryDoc !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(primaryDoc)) return [];
    return [{ form, accession, filed, reportDate, primaryDoc, url: buildFilingUrl(cik, accession, primaryDoc) }];
  }).sort((a, b) => b.filed.localeCompare(a.filed) || b.accession.localeCompare(a.accession));
}

const COMPANY_LANGUAGE = /\b(?:we|our|us|the company|the group|the bank|the firm|registrant|company's|company’s|firm's|firm’s)\b/i;
const ECONOMIC_LANGUAGE = /\b(?:expos(?:ure|ed)|risk|hedg(?:e|es|ed|ing)|derivatives?|borrowing|borrowings|debt|loans?|deposits?|investments?|securities|revenue|revenues|sales|earnings|income|margins?|costs?|purchas(?:e|es|ed|ing)|produc(?:e|es|ed|ing|tion)|suppl(?:y|ies)|consum(?:e|es|ed|ption)|reserves?|holdings?|held|assets?|prices?|pricing|denominated|operations|settle(?:ment)?|payments?|cash flows?)\b/i;
const CROSS_REFERENCE = /^(?:refer to|see (?:note|item|table|the)|the following table|for (?:further|additional) (?:information|discussion))\b|^(?:the company|the firm)[’']s discussion\b[^.!?]*\bis (?:contained|included|presented)\b/i;
const NEGATIVE_EXPOSURE = /\b(?:no|negligible|immaterial|insignificant)\s+(?:(?:direct|material|significant|meaningful|remaining|commodity|market|financial|price|net|gold|silver|copper|bitcoin|ether|euro|yen|sterling|natural gas|crude oil|interest rate)\s+){0,4}(?:exposure|risk|holdings?|operations|reserves?|purchases?)\b|\b(?:not|never)\s+(?:(?:directly|materially|significantly|currently|ordinarily|typically|economically)\s+){0,3}(?:exposed|affected|sensitive|subject|hold|held|own|purchase|produce|consume|use|trade|invest)\b|\b(?:exposure|risk|holdings?)\b[^.!?]{0,65}\b(?:not material|not significant|immaterial|insignificant|negligible)\b|\b(?:do|does|did)\s+not\s+have\b[^.!?]{0,65}\b(?:exposure|holdings?|reserves?)\b|\b(?:do|does)\s+not\s+(?:believe|expect|consider)\b[^.!?]{0,100}\b(?:material|significant)\b/i;

// Every contract code comes from the existing, verified CFTC launch catalog.
// Rules are research discovery, never an issuer/contract exposure measurement.
const RULES = [
  { id: 'sofr', code: '134741', pattern: /\b(?:SOFR|secured overnight financing rate)\b/i, question: 'How much borrowing reprices with SOFR, and how much is hedged?' },
  { id: 'rates', code: '043602', pattern: /\binterest[- ]rate(?:s| risk)?\b|\bTreasury (?:notes?|bonds?|securities|yields?)\b/i, question: 'Does the disclosed risk relate to short rates, long rates, asset duration, or funding costs?', note: 'The 10-year Treasury contract is broad rates context; its maturity and price response may differ from the company’s exposure.' },
  { id: 'euro', code: '099741', pattern: /\beuros?\b|\bEUR[- ]denominated\b|\bEUR\/(?:USD|GBP)\b/i, exclude: /\beuro (?:disney|area|zone|pean|market)\b/i, question: 'Is the euro relevant to revenue, costs, debt, or translation, and what portion is hedged?' },
  { id: 'yen', code: '097741', pattern: /\b(?:Japanese yen|yen-denominated|JPY-denominated)\b/i, question: 'Does yen exposure arise from revenue, costs, debt, or translation, and what portion is hedged?' },
  { id: 'pound', code: '096742', pattern: /\b(?:British pounds?|pounds? sterling|GBP[- ]denominated|sterling[- ]denominated)\b/i, question: 'Does sterling exposure arise from revenue, costs, debt, or translation, and what portion is hedged?' },
  { id: 'crude', code: '067651', pattern: /\b(?:crude oil|WTI|West Texas Intermediate)\b/i, question: 'Is the company a producer or buyer, and how do its grades, regions, and hedges compare with WTI?', note: 'WTI is a benchmark research link; the filing may describe other crude grades, regions, or pricing arrangements.' },
  { id: 'natural-gas', code: '023651', pattern: /\b(?:natural gas|Henry Hub)\b/i, question: 'Is the company a producer or consumer, and how do regional gas prices and hedging affect the business?', note: 'NYMEX gas positioning supplies U.S. benchmark context; regional and LNG prices can differ.' },
  { id: 'copper', code: '085692', pattern: /\bcopper\b/i, exclude: /\bcopper[- ](?:colored|colour|color|tone)\b/i, question: 'Is copper a revenue driver or an input cost, and are volumes or prices hedged?' },
  { id: 'gold', code: '088691', pattern: /\bgold\b/i, exclude: /\bgold[- ](?:award|medal|member|loyalty|status|standard|sponsor|plan|tier|card)\b/i, question: 'Does gold affect production revenue, input costs, or balance-sheet holdings, and what is hedged?' },
  { id: 'silver', code: '084691', pattern: /\bsilver\b/i, exclude: /\bsilver[- ](?:award|medal|member|loyalty|status|sponsor|plan|tier|card)\b/i, question: 'Does silver affect production revenue, input costs, or holdings?' },
  { id: 'corn', code: '002602', pattern: /\bcorn\b/i, question: 'How do corn procurement, inventory, pass-through pricing, and hedging affect margins?' },
  { id: 'wheat', code: '001602', pattern: /\bwheat\b/i, question: 'Which wheat classes and regions are relevant, and how does the business manage input costs?', note: 'The linked contract covers soft red winter wheat; other wheat grades can behave differently.' },
  { id: 'soybeans', code: '005602', pattern: /\bsoybeans?\b(?![\s-]+(?:oil|meal)\b)/i, question: 'How do raw soybean purchasing or production, processing margins, and hedging affect earnings?' },
  { id: 'cattle', code: '057642', pattern: /\b(?:live cattle|cattle)\b/i, question: 'Which livestock production or procurement costs are relevant, and how are they managed?' },
  { id: 'coffee', code: '083731', pattern: /\bcoffee\b/i, question: 'Which coffee grades and sourcing regions are relevant, and how are procurement prices hedged?', note: 'Coffee C is a benchmark contract; blends, grades, and sourcing arrangements may differ.' },
  { id: 'cocoa', code: '073732', pattern: /\bcocoa\b/i, question: 'How do cocoa procurement, inventories, hedges, and customer pricing affect margins?' },
  { id: 'cotton', code: '033661', pattern: /\bcotton\b/i, question: 'How do cotton procurement, inventory, and supplier contracts affect input costs?' },
  { id: 'bitcoin', code: '133741', pattern: /\bbitcoin\b/i, question: 'Does the company own bitcoin, earn related fees, or incur mining costs? These are different exposures.' },
  { id: 'ether', code: '146021', pattern: /\b(?:ether|Ethereum)\b/i, question: 'Does the company own ether or earn activity-related fees, and how is that exposure managed?' },
];

function boundedPassages(text) {
  // Preserve exact text and punctuation. Large paragraphs are split into
  // sentences rather than joining unrelated disclosure fragments.
  return text.split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z“"'])/).map(value => value.trim()).filter(value => value.length >= 35 && value.length <= 900);
}

function companyNamePattern(companyName) {
  let name = String(companyName || '').trim(), prior;
  do {
    prior = name;
    name = name.replace(/[,\s]+(?:&\s*)?(?:co(?:mpany)?|inc(?:orporated)?|corp(?:oration)?|ltd|limited|plc|llc)\.?$/i, '').trim();
  } while (name !== prior);
  const words = name.match(/[A-Za-z0-9]+/g) || [];
  // Short generic names are not reliable issuer evidence. Whitespace may be
  // omitted by filing markup, e.g. JPMorganChase vs JPMORGAN CHASE & CO.
  return words.join('').length >= 5 ? new RegExp(`\\b${words.join('[\\s.-]*')}(?:['’]s)?\\b`, 'i') : null;
}

export function extractCompanyCftcLinks(text, filing, { companyName = '' } = {}) {
  const input = String(text || ''), scanned = input.slice(0, COMPANY_CFTC_MAX_TEXT);
  const passages = boundedPassages(scanned);
  const issuerPattern = companyNamePattern(companyName);
  const links = [];
  for (const rule of RULES) {
    const catalog = CFTC_LAUNCH_CATALOG.find(item => item.code === rule.code);
    const evidence = passages.filter(passage => {
      // A market word occurring only in an issuer name (e.g. Gold Bank) is
      // not evidence of that commodity's economic relevance.
      const marketText = issuerPattern ? passage.replace(new RegExp(issuerPattern.source, 'gi'), '') : passage;
      const incompatibleBenchmark = rule.id === 'crude' && /\bBrent\b/i.test(marketText) && !/\b(?:WTI|West Texas Intermediate)\b/i.test(marketText);
      return !incompatibleBenchmark && !CROSS_REFERENCE.test(passage) && rule.pattern.test(marketText) && !rule.exclude?.test(marketText)
        && (COMPANY_LANGUAGE.test(passage) || issuerPattern?.test(passage)) && ECONOMIC_LANGUAGE.test(marketText) && !NEGATIVE_EXPOSURE.test(passage);
    })
      .filter((value, index, all) => !all.slice(0, index).some(prior => prior.endsWith(value) || value.endsWith(prior))).slice(0, 2);
    if (!evidence.length) continue;
    links.push({
      id: rule.id, label: catalog.label, family: catalog.family, contract: catalog.code,
      group: catalog.family === 'tff' ? 'leveraged-funds' : 'managed-money',
      reviewStatus: 'candidate',
      reason: `The SEC annual filing contains a business or financial-risk passage mentioning ${rule.id === 'rates' ? 'interest rates or Treasury securities' : rule.id.replaceAll('-', ' ')}. ${rule.note || 'Review the passage to confirm the market is relevant to your research.'}`,
      evidence: evidence.map(passage => ({ text: passage, url: filing.url, accession: filing.accession, form: filing.form, filed: filing.filed, reportDate: filing.reportDate })),
      reviewQuestion: rule.question,
    });
    if (links.length === COMPANY_CFTC_MAX_LINKS) break;
  }
  return { links, textCharactersScanned: scanned.length, textTruncated: input.length > scanned.length };
}

export const COMPANY_CFTC_LIMITATIONS = [
  'Candidate research links require review of the cited SEC passages; keyword matching does not establish a material exposure, sensitivity, hedge, or investment recommendation.',
  'CFTC positions describe market-wide trader categories. They do not identify the company’s futures positions or predict its share price, default risk, or earnings.',
  'SEC filing dates, fiscal reporting periods, and CFTC position-report dates differ. The filing-date cutoff applies to SEC evidence only, not to the publication timing of CFTC observations.',
  'Only the latest accessible complete annual report is scanned. Later quarterly filings, amendments, attachments, tables split into separate cells, and uncatalogued markets may contain additional information.',
];
