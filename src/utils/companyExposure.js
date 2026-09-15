import { CFTC_LAUNCH_CATALOG } from './cftc.js';

export const COMPANY_EXPOSURE_SCHEMA_VERSION = 'edgar.company-exposure-map.v1';
export const COMPANY_EXPOSURE_MAX_TEXT = 1_800_000;
export const COMPANY_EXPOSURE_MAX_ROWS = 50;
export const COMPANY_EXPOSURE_CATEGORIES = [
  { id: 'revenue', label: 'Revenue' },
  { id: 'input-costs', label: 'Input costs' },
  { id: 'borrowing', label: 'Borrowing & funding' },
  { id: 'investments', label: 'Investments & earning assets' },
  { id: 'currencies', label: 'Currencies' },
];
export const COMPANY_EXPOSURE_LIMITATIONS = [
  'This is an evidence discovery map, not a complete exposure inventory or an assessment of materiality. Review the exact SEC passages before drawing conclusions.',
  'No matched passage means no qualifying text was found in the scanned reports. It does not mean the company has no exposure. Tables, cross-references, subsidiaries, and descriptions without an explicit company connection can be missed.',
  'Annual and newer quarterly passages keep their own reporting and filing dates. A later report that does not repeat an annual disclosure does not establish that an exposure ended.',
  'CFTC Commitments of Traders data describes aggregate positions in a futures market. It does not identify this company’s futures positions, hedge coverage, exposure amount, or financial sensitivity.',
  'Suggested futures benchmarks require review. Currency pairs, grades, locations, delivery terms, maturities, and contract terms may differ from the company’s exposure. No benchmark is suggested when a defensible supported match is unavailable.',
  'Amounts are exact, explicitly qualified prose excerpts, not standardized or additive exposures. Notional amounts, balances, historical activity, sensitivities, and physical volumes measure different things. Table scales and omitted currency units are never inferred.',
];

const SUBJECT = /\b(?:we|the company|the group|the bank|the firm|the registrant)\b/i;
const OWNERSHIP = /\b(?:our|the company['’]s|the group['’]s|the bank['’]s|the firm['’]s|registrant['’]s)\b/i;
const CROSS_REFERENCE = /^(?:see|refer to|for (?:additional|further) (?:information|discussion)|the following table|as (?:shown|described) in (?:the|note|item))\b|^(?:the company|the firm)['’]s discussion\b[^.!?]*\bis (?:contained|included|presented)\b/i;
const NEGATED = /\bno longer\b|\b(?:no|negligible|immaterial|insignificant)\s+(?:(?:direct|material|significant|meaningful|remaining|net|price|market|financial|foreign|currency|commodity|interest|rate|gold|silver|copper|oil|gas)\s+){0,5}(?:exposure|risk|holdings?|operations|reserves?|purchases?|borrowings?|debt)\b|\b(?:not|never)\s+(?:(?:directly|materially|significantly|currently|economically)\s+){0,3}(?:exposed|affected|sensitive|subject|hold|held|own|purchase|produce|consume|use|trade|invest)\b|\b(?:exposure|risk|holdings?)\b[^;.!?]{0,60}\b(?:not material|not significant|immaterial|insignificant|negligible)\b|\b(?:do|does|did)\s+not\s+(?:have|hold|own|purchase|produce|consume|use|trade|invest)\b|\b(?:do|does)\s+not\s+(?:believe|expect|consider)\b[^;.!?]{0,100}\b(?:material|significant)\b/i;
const THIRD_PARTY = /\b(?:our|the company['’]s|the firm['’]s)\s+(?:customers?|clients?|borrowers?|suppliers?|competitors?|counterparties|investors?|shareholders?|tenants?)\s+(?:(?:may|can|could|also|often|typically|generally|regularly)\s+){0,3}(?:are|have|hold|own|buy|purchase|sell|produce|consume|use|borrow|invest|face|incur|trade|hedge|experience)\b/i;
const SPECULATION = /\b(?:we|the company|the group|the bank|the firm)\s+(?:believe|expect|anticipate|predict|forecast|estimate|think)\b[^;.!?]{0,80}\b(?:the (?:industry|market|economy)|(?:global|world|industry|market)\s+(?:demand|supply|prices?|growth))\b/i;

const MARKETS = [
  { id: 'sofr', label: 'SOFR', type: 'rate', re: /\b(?:SOFR|secured overnight financing rate)\b/i, code: '134741', named: /\b(?:SOFR|secured overnight financing rate)\b/i, basis: 'The filing names SOFR. Three-month SOFR futures are market context; reset dates, spread adjustments, tenor, and company instrument terms may differ.' },
  { id: 'treasury-2y', label: '2-year U.S. Treasury', type: 'rate', re: /\b(?:2|two)[- ]year (?:U\.?S\.? )?Treasury\b/i, code: '042601', named: /./, basis: 'The filing names the Treasury maturity. Futures delivery terms, duration, and the company’s security or hedge can differ.' },
  { id: 'treasury-10y', label: '10-year U.S. Treasury', type: 'rate', re: /\b(?:10|ten)[- ]year (?:U\.?S\.? )?Treasury\b/i, code: '043602', named: /./, basis: 'The filing names the Treasury maturity. Futures delivery terms, duration, and the company’s security or hedge can differ.' },
  { id: 'treasury', label: 'U.S. Treasury securities', type: 'rate', re: /\b(?:U\.?S\.? )?Treasury (?:securities|notes?|bonds?|yields?)\b/i, excludeIf: ['treasury-2y', 'treasury-10y'], unavailable: 'The passage does not establish a supported Treasury maturity. A 10-year contract is not automatically assigned to all Treasury holdings.' },
  { id: 'interest-rates', label: 'Interest rates — benchmark unspecified', type: 'rate', re: /\b(?:interest[- ]rates?|floating[- ]rate|variable[- ]rate|fixed[- ]rate|prime[- ]rate|LIBOR|EURIBOR)\b/i, excludeIf: ['sofr', 'treasury-2y', 'treasury-10y', 'treasury'], unavailable: 'The passage does not establish a supported benchmark and maturity. Generic interest-rate exposure is not automatically mapped to 10-year Treasury or SOFR futures.' },
  { id: 'euro', label: 'Euro', type: 'currency', re: /\b(?:euros?|EUR[- /]denominated|EUR\s*\/\s*USD)\b/i, exclude: /\beuro (?:area|zone|disney|market)\b/i, code: '099741', named: /\bEUR\s*\/\s*USD\b/i, basis: 'Euro FX futures reflect a euro/U.S. dollar market. The passage may describe another currency pair, translation exposure, or different hedging terms.' },
  { id: 'yen', label: 'Japanese yen', type: 'currency', re: /\b(?:Japanese yen|yen[- ]denominated|JPY[- ]denominated|JPY\s*\/\s*USD|USD\s*\/\s*JPY)\b/i, code: '097741', named: /\b(?:JPY\s*\/\s*USD|USD\s*\/\s*JPY)\b/i, basis: 'Japanese yen futures provide yen/U.S. dollar context. The company’s currency pair, quotation convention, translation exposure, and hedge terms may differ.' },
  { id: 'sterling', label: 'British pound', type: 'currency', re: /\b(?:British pounds?|pounds? sterling|sterling[- ]denominated|GBP[- ]denominated|GBP\s*\/\s*USD)\b/i, code: '096742', named: /\bGBP\s*\/\s*USD\b/i, basis: 'British pound futures provide sterling/U.S. dollar context. The company’s currency pair, translation exposure, and hedge terms may differ.' },
  { id: 'other-currencies', label: 'Other named currencies', type: 'currency', re: /\b(?:Chinese (?:yuan|renminbi)|Canadian dollars?|Australian dollars?|Swiss francs?|Brazilian real|Mexican pesos?|Indian rupees?|Korean won)\b/i, unavailable: 'The named currency is outside the verified CFTC benchmark selection supported by this map.' },
  { id: 'foreign-currencies', label: 'Foreign currencies — pair unspecified', type: 'currency', re: /\b(?:foreign[- ]currenc(?:y|ies)|foreign[- ]exchange|currency[- ](?:exchange|risk|exposure)|FX (?:risk|exposures?)|exchange[- ]rates?)\b/i, excludeIf: ['euro', 'yen', 'sterling', 'other-currencies'], unavailable: 'The passage does not identify a supported currency pair. Geographic sales alone do not establish a currency exposure.' },
  { id: 'brent', label: 'Brent crude oil', type: 'commodity', re: /\bBrent\b/i, unavailable: 'Brent is not WTI. No WTI benchmark is substituted for an explicitly Brent-linked exposure.' },
  { id: 'crude-oil', label: 'Crude oil / WTI', type: 'commodity', re: /\b(?:crude oil|WTI|West Texas Intermediate)\b/i, excludeWhen: text => /\bBrent\b/i.test(text) && !/\b(?:WTI|West Texas Intermediate)\b/i.test(text), code: '067651', named: /\b(?:WTI|West Texas Intermediate)\b/i, basis: 'WTI is a U.S. crude benchmark. Crude grade, location, pricing basis, and contract terms can differ; the company’s futures positions are not identified.' },
  { id: 'lng', label: 'LNG / regional gas benchmarks', type: 'commodity', re: /\b(?:LNG|liquefied natural gas|TTF|Japan Korea Marker|JKM)\b/i, unavailable: 'LNG and regional gas benchmarks are not interchangeable with Henry Hub. No U.S. gas contract is substituted without an explicit Henry Hub reference.' },
  { id: 'natural-gas', label: 'Natural gas / Henry Hub', type: 'commodity', re: /\b(?:natural gas|Henry Hub)\b/i, excludeWhen: text => /\b(?:LNG|liquefied natural gas|TTF|JKM)\b/i.test(text) && !/\bHenry Hub\b/i.test(text), code: '023651', named: /\bHenry Hub\b/i, basis: 'NYMEX natural gas supplies U.S. Henry Hub context. Regional, pipeline, delivery, and company contract terms may differ.' },
  { id: 'jet-fuel', label: 'Jet fuel', type: 'commodity', re: /\b(?:jet fuel|aviation fuel)\b/i, unavailable: 'Jet fuel is a refined product. Crude oil positioning would not establish the company’s jet-fuel price or refining-spread exposure.' },
  { id: 'diesel', label: 'Diesel / heating oil', type: 'commodity', re: /\b(?:diesel|heating oil|distillates?)\b/i, unavailable: 'This refined product is outside the map’s verified benchmark selection. No crude-oil contract is substituted.' },
  { id: 'gasoline', label: 'Gasoline', type: 'commodity', re: /\bgasoline\b/i, unavailable: 'Gasoline is outside the map’s verified benchmark selection. No crude-oil contract is substituted.' },
  { id: 'electricity', label: 'Electricity', type: 'commodity', re: /\b(?:electricity|electric power)\b/i, unavailable: 'Power exposure depends on location, load, and contract terms. No generic energy futures benchmark is substituted.' },
  { id: 'gold', label: 'Gold', type: 'commodity', re: /\bgold\b/i, code: '088691', named: /\bCOMEX gold\b/i, basis: 'Gold futures provide a benchmark context. Grade, location, delivery terms, and physical or financial holdings may differ.' },
  { id: 'silver', label: 'Silver', type: 'commodity', re: /\bsilver\b/i, code: '084691', named: /\bCOMEX silver\b/i, basis: 'Silver futures provide benchmark context. Grade, location, delivery terms, and company instruments may differ.' },
  { id: 'copper', label: 'Copper', type: 'commodity', re: /\bcopper\b/i, code: '085692', named: /\bCOMEX copper\b/i, basis: 'COMEX Copper No. 1 provides a U.S. benchmark. Other exchanges, grades, delivery locations, and company pricing terms may differ.' },
  { id: 'soybean-oil', label: 'Soybean oil', type: 'commodity', re: /\bsoybean[- ]oil\b/i, unavailable: 'Soybean oil is not raw soybeans. No soybean contract is substituted for this processing product.' },
  { id: 'soybean-meal', label: 'Soybean meal', type: 'commodity', re: /\bsoybean[- ]meal\b/i, unavailable: 'Soybean meal is not raw soybeans. No soybean contract is substituted for this processing product.' },
  { id: 'soybeans', label: 'Soybeans', type: 'commodity', re: /\bsoybeans?\b(?![- ]+(?:oil|meal)\b)/i, code: '005602', basis: 'Raw soybean futures do not establish processing margins, delivery basis, or the company’s realized price.' },
  { id: 'corn', label: 'Corn', type: 'commodity', re: /\bcorn\b/i, code: '002602', basis: 'Corn futures provide benchmark context. Grade, geography, delivery, and purchase or sales terms may differ.' },
  { id: 'other-wheat', label: 'Other wheat classes', type: 'commodity', re: /\b(?:hard[- ](?:red[- ])?(?:winter|spring)|durum) wheat\b/i, unavailable: 'The named wheat class differs from soft red winter wheat. No SRW contract is substituted.' },
  { id: 'wheat', label: 'Wheat', type: 'commodity', re: /\bwheat\b/i, excludeIf: ['other-wheat'], code: '001602', named: /\bsoft red winter wheat\b/i, basis: 'The selected futures market covers soft red winter wheat. Other wheat classes, regions, and company pricing terms may differ.' },
  { id: 'cattle', label: 'Cattle', type: 'commodity', re: /\b(?:live cattle|cattle)\b/i, exclude: /\bfeeder cattle\b/i, code: '057642', named: /\blive cattle\b/i, basis: 'Live cattle futures do not cover every livestock stage, feed cost, grade, or company purchase arrangement.' },
  { id: 'coffee', label: 'Coffee', type: 'commodity', re: /\bcoffee\b/i, code: '083731', named: /\bCoffee C\b/, basis: 'Coffee C supplies an arabica benchmark. Robusta, blends, grades, sourcing regions, and company purchase terms may differ.' },
  { id: 'cocoa', label: 'Cocoa', type: 'commodity', re: /\bcocoa\b/i, code: '073732', basis: 'Cocoa futures provide benchmark context. Grade, sourcing region, delivery, and company procurement terms may differ.' },
  { id: 'cotton', label: 'Cotton', type: 'commodity', re: /\bcotton\b/i, code: '033661', named: /\bcotton (?:no\.?\s*2|number two)\b/i, basis: 'Cotton No. 2 provides benchmark context. Fiber quality, sourcing region, and company procurement terms may differ.' },
  { id: 'bitcoin', label: 'Bitcoin', type: 'digital', re: /\bbitcoin\b/i, code: '133741', named: /\bCME bitcoin\b/i, basis: 'CME bitcoin futures provide aggregate market context. The company may hold spot assets, mine, or earn fees rather than hold futures.' },
  { id: 'ether', label: 'Ether', type: 'digital', re: /\b(?:ether|ethereum)\b/i, code: '146021', named: /\bCME ether\b/i, basis: 'CME ether futures provide aggregate market context. Spot holdings, staking, service revenues, and company instruments differ.' },
  ...['aluminum', 'lithium', 'nickel', 'zinc', 'steel', 'iron ore', 'sugar', 'rice', 'rubber', 'palladium', 'platinum'].map(name => ({ id: name.replaceAll(' ', '-'), label: name[0].toUpperCase() + name.slice(1), type: 'commodity', re: new RegExp(`\\b${name}\\b`, 'i'), unavailable: 'This market is outside the verified benchmark selection supported by this map. No unrelated commodity futures contract is substituted.' })),
];

const REVENUE = /\b(?:upstream segment|revenue|revenues|sales|selling prices?|production|produc(?:e|es|ed|ing)|extract(?:ion|s|ed|ing)?|min(?:e|es|ed|ing)|sell|sells|sold)\b/i;
const INPUT = /\b(?:input costs?|raw materials?|ingredients?|procure(?:ment|s|d)?|purchas(?:e|es|ed|ing)|buy|buys|bought|consum(?:e|es|ed|ption)|fuel (?:costs?|expense)|(?:largest|significant|major) cost component|cost (?:of|for) (?:buying|purchasing|consuming))\b|\b(?:prices?|costs?)\b[^;.!?]{0,90}\b(?:our|the company['’]s)\s+(?:costs?|expenses?|margins?)\b|\b(?:our|the company['’]s)\s+(?:(?:annual|operating|energy|commodity|fuel|electricity|material)\s+){0,3}costs?\b/i;
const BORROWING = /\b(?:borrow(?:ing|ings|ed|s)?|debt(?! securities)|credit (?:facilit(?:y|ies)|agreements?|lines?)|revolving (?:credit|facilit(?:y|ies))|interest expense|funding costs?|deposit (?:costs?|rates?|liabilities)|financing costs?)\b/i;
const INVESTMENTS = /\b(?:investment(?:s| portfolio)?|securities|earning assets|loan(?:s| portfolio|s receivable)?|holdings?|held|own(?:s|ed)?|portfolio|interest income)\b/i;
const COMMODITY_INVESTMENTS = /\b(?:holdings?|held|portfolio|inventor(?:y|ies))\b|\b(?:hold|own|owns|owned)\s+(?:(?:physical|spot|digital|approximately|about)\s+){0,2}(?:gold|silver|copper|bitcoin|ether)\b/i;
const CURRENCY_ECONOMIC = /\b(?:expos(?:ure|ed)|risk|hedg(?:e|es|ed|ing)|derivatives?|denominated|translation|translate|revenue|sales|purchases?|costs?|expenses?|debt|borrowings?|investments?|assets?|liabilities|receivables?|payables?|payments?|cash flows?|earnings|income)\b/i;
const CHANNELS = {
  revenue: 'The cited passage connects this market to the company’s production, sales, or revenue. It does not by itself establish the net earnings effect or materiality.',
  'input-costs': 'The cited passage connects this market to the company’s procurement, consumption, or operating costs. Pass-through pricing, inventories, and hedges may change the financial effect.',
  borrowing: 'The cited passage connects this market to the company’s borrowing, financing, or funding costs. Review principal amounts, repricing terms, maturities, and hedges separately.',
  investments: 'The cited passage connects this market to company holdings, investments, lending, or earning assets. The quote does not establish a portfolio-wide sensitivity.',
  currencies: 'The cited passage connects currency changes or denomination to the company’s business or financial exposures. Transaction, translation, debt, and hedge effects can differ.',
};

function issuerRegex(companyName) {
  let name = String(companyName || '').trim(), previous;
  do { previous = name; name = name.replace(/[,\s]+(?:&\s*)?(?:co(?:mpany)?|inc(?:orporated)?|corp(?:oration)?|ltd|limited|plc|llc)\.?$/i, '').trim(); } while (name !== previous);
  const words = name.match(/[A-Za-z0-9]+/g) || [];
  return words.join('').length >= 5 ? new RegExp(`\\b${words.join('[\\s.&-]*')}(?:['’]s)?\\b`, 'i') : null;
}

function passages(text) {
  return text.split(/\n\s*\n|(?<!\b[A-Z]\.)(?<=[.!?])\s+(?=[A-Z“"'])/).map(text => text.trim())
    .filter(text => text.length >= 35 && text.length <= 1_800 && (text.match(/[A-Za-z]{2,}/g)?.length || 0) >= 8 && !/\b(?:and|or|including|of|the|to|a)\s*$/i.test(text));
}
function clauses(text) {
  return text.split(/;|,?\s+(?:but|whereas|while|and)\s+(?=(?:we|our|the company|the firm|the bank)\b)/i).map(value => value.trim()).filter(Boolean);
}

const AMBIGUOUS_METALS = new Set(['gold', 'silver', 'copper', 'platinum']);
const NON_COMMODITY_MARKER = '\uFFFC';
const ENTITY_COMMODITIES = ['Gold', 'Silver', 'Copper', 'Platinum', 'Corn', 'Wheat', 'Soybean', 'Soybeans', 'Coffee', 'Cocoa', 'Cotton', 'Cattle', 'Natural Gas', 'Crude Oil', 'Brent', 'Steel', 'Aluminum', 'Nickel', 'Lithium', 'Rice', 'Sugar'];
const COMMODITY_ENTITY = new RegExp(`\\b(?:${ENTITY_COMMODITIES.flatMap(value => [value, value.toUpperCase()]).join('|')})(?:[ \\t]+[A-Z][A-Za-z0-9&'-]*){0,3}[ \\t]+(?:Inc|INC|Incorporated|INCORPORATED|Corp|CORP|Corporation|CORPORATION|Company|COMPANY|LLC|Ltd|LTD|Limited|LIMITED|Holdings|HOLDINGS|Capital|CAPITAL|Partners|PARTNERS|Management|MANAGEMENT|Bank|BANK|Group|GROUP)\\b`, 'g');

/** Product tiers and entity names can contain a commodity's name. Mask only
 * that use before removing the issuer name: otherwise "Reddit Gold" becomes
 * bare "Gold". Original SEC sentences are retained untouched as evidence. */
function commodityMeaningText(text) {
  const blank = value => ' '.repeat(value.length - 1) + NON_COMMODITY_MARKER;
  return text
    .replace(/\b(?:Reddit|Xbox(?:\s+Live)?)\s+Gold\b/gi, blank)
    .replace(/\b(?:gold|silver|platinum|copper)[- ](?:awards?|medals?|members?(?:hips?)?|loyalty|status|standard|sponsors?(?:hip)?|plans?|tiers?|cards?|subscriptions?|packages?|badges?|software|CRM|colou?red|colou?r|tones?)\b/gi, blank)
    .replace(COMMODITY_ENTITY, (value, offset, original) => {
      // Direct "our Gold Holdings" can still mean owned metal, even when a
      // heading capitalizes it. An investment in "Gold Holdings" names an entity.
      if (/^(?:gold|silver|copper|platinum) holdings$/i.test(value)
        && /\b(?:our|the company['’]s)\s+$/i.test(original.slice(0, offset))
        && /\b(?:ounces|tonnes|tons|pounds|bullion|bars|physical metal)\b/i.test(original.slice(offset + value.length, offset + value.length + 100))) return value;
      return blank(value);
    });
}

function hasMetalCommodityMeaning(text, metal) {
  // A bare metal name beside generic revenue, a product sale, or an investment
  // is insufficient. Require a directly attached physical/market description
  // or a direct purchase, production, or holding of the named metal.
  return new RegExp(`\\b${metal}[- ](?:prices?|pricing|production|mines?|mining|ore|metal|bullion|bars?|coins?|holdings?|reserves?|inventor(?:y|ies)|futures?|options?|derivatives?|forwards?|swaps?|purchases?|sales?|extraction|refining|wire|wiring|content|raw[- ]materials?|exposures?|risk)\\b`, 'i').test(text)
    || new RegExp(`\\b(?:physical|spot|COMEX|refined|unrefined|scrap|precious[- ]metal)\\s+${metal}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:prices?|production|purchases?|sales?|holdings?|inventor(?:y|ies)|ounces|tonnes|tons|pounds)\\s+of\\s+(?:(?:physical|refined|scrap)\\s+)?${metal}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:exposures?|exposed|sensitive|sensitivity)\\s+to\\s+(?:(?:physical|spot|refined|scrap)\\s+)?${metal}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:produce|produces|produced|purchase|purchases|purchased|consume|consumes|consumed|sell|sells|sold|mine|mines|mined|hold|holds|held|use|uses|used)\\s+(?:physical\\s+)?(?:(?:gold|silver|copper|platinum)\\s*(?:,\\s*(?:and\\s+)?|and\\s+)){1,3}${metal}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:purchas(?:e|es|ed|ing)|buy|buys|bought|sell|sells|sold|use|uses|used|consum(?:e|es|ed|ing)|produc(?:e|es|ed|ing)|min(?:e|es|ed|ing)|hold|holds|held|own|owns|owned)\\s+(?:(?:physical|spot|refined|scrap)\\s+)?${metal}\\b`, 'i').test(text);
}

function marketMatches(text) {
  const matches = MARKETS.filter(market => market.re.test(text) && !market.exclude?.test(text) && !market.excludeWhen?.(text)
    && (!AMBIGUOUS_METALS.has(market.id) || hasMetalCommodityMeaning(text, market.id)));
  return matches.filter(market => !market.excludeIf?.some(id => matches.some(other => other.id === id)));
}
function marketChannelText(text, market) {
  // Keep different verbs attached to their own objects: producing oil and
  // purchasing gas must not become oil procurement plus gas production.
  const parts = text.split(/,?\s+(?:and|but|while)\s+(?=(?:(?:also|primarily|typically|generally)\s+)?(?:purchas(?:e|es|ed)|buy|buys|bought|produc(?:e|es|ed)|sell|sells|sold|consum(?:e|es|ed)|use|uses|used|mine|mines|mined|hold|holds|own|owns)\b)/i);
  if (parts.length === 1) return text;
  return parts.flatMap((part, index) => {
    if (!market.re.test(part)) return [];
    const previous = parts[index - 1];
    return [previous && !previous.includes(NON_COMMODITY_MARKER) && !marketMatches(previous).length ? `${previous} ${part}` : part];
  }).join('; ');
}

function operatingCommodityUse(text, market) {
  let input = false;
  // "Use gas to operate production plants" consumes gas. Production in the
  // purpose clause does not establish sales of that input. Keep other actions.
  const revenueText = text.replace(/\b(?:us(?:e|es|ed|ing)|consum(?:e|es|ed|ing))\s+([^;.!?]{1,300}?)\s+(?:to\s+(?:operate|power|fuel|heat|cool)|(?:in|for)\s+(?:(?:our|the)\s+)?(?:manufacturing|production|bottling|distribution|operations?|facilities))\b[^;.!?]*/gi, (passage, inputs) => {
    if (!market.re.test(inputs)) return passage;
    input = true;
    return ' ';
  });
  return { input, revenueText };
}

function categoriesFor(text, market) {
  text = marketChannelText(text, market);
  if (market.type === 'currency') return CURRENCY_ECONOMIC.test(text) ? ['currencies'] : [];
  if (market.type === 'rate') return [BORROWING.test(text) && 'borrowing', INVESTMENTS.test(text) && 'investments'].filter(Boolean);
  const operatingUse = operatingCommodityUse(text, market);
  return [REVENUE.test(operatingUse.revenueText) && 'revenue', (operatingUse.input || INPUT.test(text)) && !/\b(?:market[- ]making|with clients|financing arrangements)\b/i.test(text) && 'input-costs', COMMODITY_INVESTMENTS.test(text) && 'investments'].filter(Boolean);
}
function idOf(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}
function benchmarkFor(market, text) {
  const catalog = CFTC_LAUNCH_CATALOG.find(item => item.code === market.code);
  return catalog ? { family: catalog.family, contract: catalog.code, label: catalog.label, group: catalog.family === 'tff' ? 'leveraged-funds' : 'managed-money', fit: market.named?.test(text) ? 'named-reference' : 'proxy', basisLimit: market.basis } : null;
}

function evidenceScore(text, market, category) {
  let score = 0;
  if (/\b(?:primary exposure|primarily exposed|largest cost component|priced based on|closely aligned|most significant factor)\b/i.test(text)) score += 12;
  if (/\b(?:exposure|risk|affect|affected|sensitive|sensitivity|denominated)\b/i.test(text)) score += 5;
  if (/\b(?:our|the company['’]s|the firm['’]s)\s+(?:revenue|sales|cost|borrowings|debt|investment|portfolio|exposure)/i.test(text)) score += 4;
  if (market.named?.test(text)) score += 4;
  if (/\b(?:structural|arises|arising|sensitivity|exposed)\b/i.test(text)) score += 3;
  if (/\b(?:interest rate risk arises|FX exposures arising|risk associated with)\b/i.test(text)) score += 5;
  if (/\b(?:may|could|would|assuming|opportunit(?:y|ies)|forecast)\b/i.test(text)) score -= 2;
  if (/\b(?:table|page|section|item|note [0-9]|form 10-|see|refer)\b/i.test(text)) score -= 5;
  if (category === 'currencies' && /\b(?:transaction|translation|sales|revenue|cost|expense|denominated)\b/i.test(text)) score += 3;
  return score;
}

const MONEY = /(?:US\$|U\.S\.\s*\$|USD|EUR|GBP|JPY|CAD|AUD|CHF|\$|€|£|¥)\s*\d+(?:,\d{3})*(?:\.\d+)?\s*(?:trillion|billion|million|thousand)\b|\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:trillion|billion|million|thousand)\s+(?:U\.S\. dollars?|US dollars?|euros?|British pounds?|Japanese yen|Canadian dollars?)\b/gi;
const PHYSICAL = /\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:(?:million|billion|thousand)\s+)?(?:barrels|ounces|metric tons|metric tonnes|bushels|pounds|cubic feet|MWh|megawatt hours)\b/gi;
function hasUnresolvedVolumeQualifier(clause, volume) {
  const before = clause.slice(0, volume.index), after = clause.slice(volume.index + volume[0].length);
  const remainder = `${before} ${after}`;
  // A regex match can start inside a signed number or at the last member of
  // a shared-unit list. Keep the quote, but do not detach that qualification.
  if (/(?:[+−±–—\-([.,/]|\bnegative)\s*$/i.test(before) || /^\s*[)\]]/.test(after)
    || before.lastIndexOf('(') > before.lastIndexOf(')') || before.lastIndexOf('[') > before.lastIndexOf(']')) return true;
  if (/\brespectively\b/i.test(clause)
    || /\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:million|billion|thousand)\b/i.test(remainder)
    || /\d+(?:,\d{3})*(?:\.\d+)?\s*(?:,|and|or|to|through|[-−–—])\s*(?:(?:approximately|about|nearly)\s+)?$/i.test(before)
    || /^\s*(?:,|and|or|to|through|[-−–—])\s*(?:(?:approximately|about|nearly)\s+)?[+−-]?\s*\d/i.test(after)) return true;
  return new Set(remainder.match(/\b(?:19|20)\d{2}\b/g) || []).size > 1;
}
function amountBelongsToMarket(clause, amount, kind, category, market) {
  if (kind === 'notional' || kind === 'sensitivity') return true;
  const marketMatch = market.re.exec(clause);
  if (!marketMatch) return false;
  const start = Math.min(marketMatch.index, amount.index), end = Math.max(marketMatch.index + marketMatch[0].length, amount.index + amount[0].length);
  const connection = clause.slice(start, end);
  if (connection.length > 190) return false;
  if (/\b(?:collateral|capital|dividends?|taxes?|total assets|net income|net earnings|unrelated|respectively)\b/i.test(connection)) return false;
  if (kind === 'balance' && /\b(?:revenue|sales|proceeds|expenses?|costs?|cash flows?)\b/i.test(connection)) return false;
  if (kind === 'historical-activity' && category === 'investments' && !/\b(?:sales|proceeds)\b/i.test(connection)) return false;
  return true;
}

function qualifiedAmounts(clause, sentence, marketCount, category, market) {
  // A multi-market clause cannot assign a joint number to each market. A
  // single, fully unit-qualified amount avoids guessing range/currency scope.
  if (marketCount !== 1 || /\b(?:in millions|in thousands|amounts in|dollars in)\b/i.test(clause)) return [];
  const money = [...clause.matchAll(MONEY)];
  const currencyNumbers = [...clause.matchAll(/(?:US\$|U\.S\.\s*\$|USD|EUR|GBP|JPY|CAD|AUD|CHF|\$|€|£|¥)\s*[+-]?\s*\d/g)];
  if (money.length === 1 && currencyNumbers.length <= 1 && !/\b(?:between|ranging|range of|from)\s+(?:US\$|USD|EUR|GBP|JPY|\$|€|£|¥)?\s*\d/i.test(clause)) {
    const amount = money[0], before = clause.slice(Math.max(0, amount.index - 150), amount.index), after = clause.slice(amount.index + amount[0].length, amount.index + amount[0].length + 55);
    if (!/(?:[([±+−–—-]|\bnegative)\s*$/i.test(before) && !/^\s*(?:[)\]]|per\b|(?:[-−–—]|to|and)\s*(?:[$€£¥]|USD|EUR)?\s*\d|\/(?:barrel|ounce|ton|bushel|MWh))/i.test(after)) {
      let kind = null;
      if (/\b(?:would|could)\b[^;.!?]{0,100}\b(?:change|increase|decrease|reduce|reduction|decline|impact|affect|loss|gain)\b[^;.!?]{0,45}$/i.test(before) || /\b(?:hypothetical|sensitivity)\b[^;.!?]{0,60}$/i.test(before)) kind = 'sensitivity';
      else if (/\bnotional(?:\s+(?:amounts?|value|principal|balance|of|was|were|totaled|totalled|aggregate|outstanding|approximately|about|had|a|an|total|is|at|and|net|gross))*\s*$/i.test(before)) kind = 'notional';
      else if (market.type !== 'rate' && /\b(?:purchases?|sales|revenue|revenues|proceeds|spent|expenditures|costs?|expense)\b/i.test(clause) && /\b(?:were|was|total(?:ed|led)?|amounted|generated|incurred|spent|of)\b/i.test(clause)) kind = 'historical-activity';
      else if (/\b(?:outstanding|held|holdings|carrying (?:amount|value)|fair value|balance|principal|borrowings|debt)\b/i.test(clause) && /\b(?:was|were|of|total(?:ed|led)?|held|had|have|has|amounted|at)\b/i.test(clause)) kind = 'balance';
      if (kind && amountBelongsToMarket(clause, amount, kind, category, market)) return [{ text: amount[0].trim(), kind, context: sentence }];
    }
  }
  const volume = [...clause.matchAll(PHYSICAL)];
  if (money.length === 0 && volume.length === 1 && !hasUnresolvedVolumeQualifier(clause, volume[0]) && /\b(?:produced|production|purchased|consumed|sold|sales|procured)\b/i.test(clause) && !/\b(?:per|daily|average|approximately between|range|from|to)\b/i.test(clause.slice(Math.max(0, volume[0].index - 15), volume[0].index + volume[0][0].length + 20))) {
    return [{ text: volume[0][0].trim(), kind: 'volume', context: sentence }];
  }
  return [];
}

/**
 * Discover explicitly issuer-connected prose, preserving each source sentence.
 * This intentionally does not infer exposure from industry, table neighbors,
 * contract positioning, financial materiality, or silence in a newer report.
 */
export function extractCompanyExposureMap(sources, { companyName = '', ticker = '' } = {}) {
  const issuer = issuerRegex(companyName), rows = new Map(), coverage = [], qualifiers = [];
  let omittedRows = 0, omittedEvidence = 0;
  for (const source of (Array.isArray(sources) ? sources : []).slice(0, 5)) {
    const input = String(source.text || ''), scanned = input.slice(0, COMPANY_EXPOSURE_MAX_TEXT), sentences = passages(scanned);
    const filing = source.filing || {}, role = source.role === 'quarterly' ? 'quarterly' : 'annual';
    coverage.push({ ...filing, role, textCharactersScanned: scanned.length, textTruncated: input.length > scanned.length, passagesScanned: sentences.length });
    for (const sentence of sentences) {
      if (CROSS_REFERENCE.test(sentence) || /\b(?:Scope [123]|greenhouse gas|carbon dioxide equivalent|settlements? with|government authorities|legal proceedings|civil penalt(?:y|ies)|pursuing opportunities|opportunities in (?:other )?emerging)\b/i.test(sentence)) continue;
      for (const clause of clauses(sentence)) {
        if ((!SUBJECT.test(clause) && !OWNERSHIP.test(clause) && !issuer?.test(clause)) || THIRD_PARTY.test(clause) || SPECULATION.test(clause)) continue;
        const commodityText = commodityMeaningText(clause);
        const economicText = issuer ? commodityText.replace(new RegExp(issuer.source, 'gi'), '') : commodityText;
        const markets = marketMatches(economicText);
        if (NEGATED.test(clause)) {
          if (markets.length && qualifiers.length < 200) qualifiers.push({ sentence, economicText, markets, filing, role });
          continue;
        }
        for (const market of markets) {
          for (const category of categoriesFor(economicText, market)) {
            const key = `${category}:${market.id}`, existing = rows.get(key);
            if (!existing && rows.size >= COMPANY_EXPOSURE_MAX_ROWS) { omittedRows++; continue; }
            const row = existing || { id: key, category, categoryLabel: COMPANY_EXPOSURE_CATEGORIES.find(item => item.id === category).label, marketId: market.id, marketLabel: market.label, channelExplanation: CHANNELS[category], reviewStatus: 'evidence-linked', benchmark: benchmarkFor(market, economicText), benchmarkUnavailableReason: market.unavailable || null, evidence: [] };
            const evidenceId = `ev-${idOf(`${ticker}|${filing.accession}|${sentence}`)}`;
            if (row.evidence.some(item => item.id === evidenceId)) continue;
            const amounts = qualifiedAmounts(economicText, sentence, markets.length, category, market);
            const score = evidenceScore(sentence, market, category) + (amounts.length ? 3 : 0), sameSource = row.evidence.filter(item => item.accession === filing.accession);
            if (sameSource.length >= 2) {
              const weakest = sameSource.reduce((a, b) => a._score < b._score ? a : b);
              omittedEvidence++;
              if (score <= weakest._score) continue;
              row.evidence = row.evidence.filter(item => item !== weakest);
            } else if (row.evidence.length >= 4) { omittedEvidence++; continue; }
            // If the strongest explicit naming exists in a later source, retain
            // that fit and its separately dated evidence, not a new exposure.
            const benchmark = benchmarkFor(market, economicText);
            if (benchmark?.fit === 'named-reference') row.benchmark = benchmark;
            row.evidence.push({ _score: score, id: evidenceId, text: sentence, url: filing.url, accession: filing.accession, form: filing.form, filed: filing.filed, reportDate: filing.reportDate || null, role, disclosureDirection: 'connection', benchmark: benchmarkFor(market, economicText), amounts });
            rows.set(key, row);
          }
        }
      }
    }
  }
  // Keep a later explicit qualification visible beside an earlier connection.
  // It creates no new exposed row, and a negative phrase does not prove the
  // whole exposure ended (it may concern only a hedge or a materiality claim).
  for (const qualifier of qualifiers) {
    for (const market of qualifier.markets) {
      const categories = categoriesFor(qualifier.economicText, market);
      for (const row of rows.values()) {
        if (row.marketId !== market.id || (categories.length && !categories.includes(row.category))) continue;
        const evidenceId = `ev-${idOf(`${ticker}|${qualifier.filing.accession}|${qualifier.sentence}`)}`;
        if (row.evidence.some(item => item.id === evidenceId)) continue;
        const sameSource = row.evidence.filter(item => item.accession === qualifier.filing.accession);
        if (sameSource.length >= 2) {
          const replaceable = sameSource.filter(item => item.disclosureDirection === 'connection');
          if (!replaceable.length) { omittedEvidence++; continue; }
          const weakest = replaceable.reduce((a, b) => a._score < b._score ? a : b);
          row.evidence = row.evidence.filter(item => item !== weakest); omittedEvidence++;
        } else if (row.evidence.length >= 4) { omittedEvidence++; continue; }
        const filing = qualifier.filing;
        row.evidence.push({ _score: 100, id: evidenceId, text: qualifier.sentence, url: filing.url, accession: filing.accession, form: filing.form, filed: filing.filed, reportDate: filing.reportDate || null, role: qualifier.role, disclosureDirection: 'qualifying-or-negative', benchmark: null, amounts: [] });
      }
    }
  }
  const order = COMPANY_EXPOSURE_CATEGORIES.map(item => item.id);
  return { rows: [...rows.values()].map(row => {
    const evidence = row.evidence.sort((a, b) => (b.filed || '').localeCompare(a.filed || '') || b._score - a._score).map(item => { const result = { ...item }; delete result._score; return result; });
    const benchmark = evidence.find(item => item.benchmark?.fit === 'named-reference')?.benchmark || evidence.find(item => item.benchmark)?.benchmark || null;
    return { ...row, benchmark, qualifyingEvidenceIds: evidence.filter(item => item.disclosureDirection === 'qualifying-or-negative').map(item => item.id), benchmarkEvidenceIds: evidence.filter(item => item.benchmark?.fit === benchmark?.fit && item.benchmark?.contract === benchmark?.contract).map(item => item.id), evidence };
  }).sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.marketLabel.localeCompare(b.marketLabel)), coverage: { filings: coverage, omittedRows, omittedEvidence, extractionLimited: omittedRows > 0 || omittedEvidence > 0 || coverage.some(item => item.textTruncated) }, limitations: COMPANY_EXPOSURE_LIMITATIONS };
}
