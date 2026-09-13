const yahoo = ['ya', 'hoo'].join('');
const stooq = ['st', 'ooq'].join('');
const AUDITED_DELETION_LITERALS = Object.freeze([
  `stock-raw-${yahoo}`,
  'stock-price-failure-v1',
  'price-provider-cooldown',
  'lease:price-provider-start',
  'lease:stock-price-refresh',
  'quant-adjusted-prices-v1',
  'market-signal-result-v1',
  'market-signal-last-eligible-v1',
  'lease:market-signal-result',
  'edgar.factor-universe.v1',
  'edgar.quant-universe.v1',
  'lease:edgar.factor-universe.v1',
  'lease:quant-coverage-v1',
]);

const RULES = Object.freeze([
  {
    id: 'provider-host',
    pattern: new RegExp(
      `finance\\.${yahoo}\\.com\\b|(?:fc|guce|consent|chart|download)\\.${yahoo}\\.com\\b|(?:yimg|${yahoo}apis)\\.(?:com|net)\\b|${stooq}\\.[a-z]{2,}(?:\\.[a-z]{2})?\\b`,
      'i',
    ),
  },
  {
    id: 'provider-proxy-host',
    pattern: new RegExp(
      `(?:${yahoo}[-_.]?finance|finance[-_.]?${yahoo}|${yahoo}finance|apidojo[-_.]?${yahoo})[a-z0-9-]*\\.p\\.rapidapi\\.com\\b|yfapi\\.net\\b|(?:api\\.allorigins\\.win|allorigins\\.hexlet\\.app|corsproxy\\.io|cors-anywhere\\.herokuapp\\.com|thingproxy\\.freeboard\\.io|proxy\\.cors\\.sh|api\\.codetabs\\.com|r\\.jina\\.ai)\\b`,
      'i',
    ),
  },
  {
    id: 'provider-package',
    pattern: new RegExp(
      `\\b(?:${yahoo}-finance2?|${yahoo}query|yfinance|pystooq|${stooq}-api)\\b`,
      'i',
    ),
  },
  {
    id: 'provider-name',
    pattern: new RegExp(`\\b(?:${yahoo}(?:[ _-]finance)?|${stooq})\\b`, 'i'),
  },
  {
    id: 'legacy-provider-module',
    pattern: /(?:priceDataServer|marketSignalsServer|marketRegression|marketFactorInsights|StockPriceChart|warmYahooSeries|loadPriceSeries|readQuantPrices|QUANT_PRICE_CACHE|yahoo_finance)/i,
  },
  {
    id: 'legacy-provider-cache',
    pattern: /(?:stock-raw-yahoo|stock-price-failure-v1|price-provider-cooldown|quant-adjusted-prices-v1|market-signal-(?:result|last-eligible)-v1|edgar\.(?:factor|quant)-universe\.v1)/i,
  },
  {
    id: 'retired-client-call',
    pattern: /\b(?:fetch|fetchJson|apiFetch|requestJson|useSWR|ky(?:\.[a-z]+)?|axios(?:\.[a-z]+)?)\s*\([\s\S]{0,240}?["'`]\/api\/(?:prices|v1\/(?:market-signals|factor-universe))(?:[?"'`/])/i,
  },
  {
    id: 'provider-endpoint-fingerprint',
    pattern: /\/(?:v6|v7|v8|v10)\/finance\/(?:chart|download|quote|quoteSummary|spark|options)\b|\/ws\/fundamentals-timeseries\//i,
  },
]);

export function findProviderBoundaryHits(value) {
  let text = String(value || '')
    .replace(/\\u00(2e|2f|3a)/gi, (_, value) => String.fromCharCode(Number.parseInt(value, 16)))
    .replace(/&#(?:46|47|58);|&#x(?:2e|2f|3a);/gi, (value) => String.fromCharCode(Number.parseInt(value.includes('x') ? value.slice(3, -1) : value.slice(2, -1), value.includes('x') ? 16 : 10)));
  for (let pass = 0; pass < 2; pass += 1) text = text.replace(/%([0-9a-f]{2})/gi, (_, value) => String.fromCharCode(Number.parseInt(value, 16)));
  return RULES.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id);
}

function withoutExactLiterals(value, literals) {
  return literals.reduce((text, literal) => text.replaceAll(literal, ''), String(value));
}

/** Only exact deletion literals and bounded migration prose are excepted. */
export function providerBoundaryViolations(path, value, { built = false } = {}) {
  const name = String(path).replaceAll('\\', '/');
  let inspected = String(value);
  if (built) inspected = withoutExactLiterals(inspected, AUDITED_DELETION_LITERALS);
  if (name === 'src/utils/providerRetirement.js') {
    inspected = withoutExactLiterals(inspected, AUDITED_DELETION_LITERALS);
  }
  if (name === 'docs/provider-retirement-migration.md') {
    inspected = inspected.replaceAll(`${yahoo[0].toUpperCase()}${yahoo.slice(1)} Finance`, '').replaceAll(`${stooq[0].toUpperCase()}${stooq.slice(1)}`, '');
  }
  const hits = findProviderBoundaryHits(inspected);
  // Source files and public assets are scanned separately. Framework bundles
  // and source maps may contain metadata keys or third-party copyright prose,
  // so a provider name alone is not an executable build boundary. Actionable
  // hosts, packages, endpoint fingerprints and retired callers remain blocked.
  if (built) return hits.filter(id => id !== 'provider-name');
  return hits;
}
