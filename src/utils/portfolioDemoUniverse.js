/** One source-dated company universe shared by every Research Hub demo view. */
export const DEMO_UNIVERSE_SCHEMA = "edgar.portfolio.demo-universe.v1";
export const DEMO_UNIVERSE_URL = "/portfolio/portfolio-demo-100-universe.json";
const SOURCE_URL = "https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv";
const SORT = "weight_pct_desc_market_value_usd_desc_ticker_asc";
const tickerPattern = /^[A-Z][A-Z0-9-]{0,9}$/;
const cikPattern = /^(?!0000000000)\d{10}$/;
const fail = (message) => { throw new Error(`Demo universe: ${message}`); };
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const bySize = (a, b) => b.weight_pct - a.weight_pct || b.market_value_usd - a.market_value_usd || a.ticker.localeCompare(b.ticker);
const sameNumber = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(0.000001, Math.abs(b) * 1e-12);
const total = (rows, key) => Math.round(rows.reduce((sum, row) => sum + row[key], 0) * 100) / 100;

export function validatePortfolioDemoUniverse(value) {
  const source = value?.source, selection = value?.selection, companies = value?.companies;
  if (value?.schema_version !== DEMO_UNIVERSE_SCHEMA || source?.fund !== "IVV" || source.url !== SOURCE_URL
    || !validDate(source.asOf) || !Number.isFinite(Date.parse(source.checkedAt)) || Date.parse(source.checkedAt) < Date.parse(source.asOf)
    || !/^[a-f0-9]{64}$/.test(source.sha256 || "")
    || !new RegExp(`^sec-coverage-v1:ivv:${source.asOf}:[a-f0-9]{16}$`).test(value.membership_id || "")) fail("unsupported source identity or dates.");
  if (selection?.method !== "largest-issuer-holdings" || selection.sort !== SORT || selection.count !== 100
    || !Number.isInteger(selection.availableIssuers) || selection.availableIssuers < 475 || selection.availableIssuers > 525
    || typeof selection.description !== "string" || !selection.description.trim() || selection.description.length > 1000
    || !Array.isArray(companies) || companies.length !== 100) fail("incomplete top-100 selection.");
  const ciks = new Set(), tickers = new Set(), aliases = new Set();
  for (const [index, company] of companies.entries()) {
    if (company.rank !== index + 1 || !cikPattern.test(company.cik || "") || ciks.has(company.cik)
      || !tickerPattern.test(company.ticker || "") || tickers.has(company.ticker)
      || typeof company.name !== "string" || !company.name.trim() || company.name.length > 300
      || typeof company.sector !== "string" || !company.sector.trim() || company.sector.length > 100
      || !Array.isArray(company.share_classes) || !company.share_classes.length || company.share_classes.length > 10) fail("invalid company identity or rank.");
    for (const security of company.share_classes) {
      if (!tickerPattern.test(security.ticker || "") || aliases.has(security.ticker)
        || !Number.isFinite(security.weight_pct) || security.weight_pct < 0 || security.weight_pct > 100
        || !Number.isFinite(security.market_value_usd) || security.market_value_usd <= 0) fail("invalid or duplicated source security.");
      aliases.add(security.ticker);
    }
    const rankedClasses = [...company.share_classes].sort(bySize);
    if (company.ticker !== rankedClasses[0].ticker || !sameNumber(company.weight_pct, total(rankedClasses, "weight_pct"))
      || !sameNumber(company.market_value_usd, total(rankedClasses, "market_value_usd"))
      || company.weight_pct <= 0 || company.weight_pct > 100
      || (index > 0 && bySize(companies[index - 1], company) > 0)) fail("source weights, share classes or selection order disagree.");
    ciks.add(company.cik); tickers.add(company.ticker);
  }
  return value;
}

/** Source rows contain original IVV security weights, never hypothetical demo allocations. */
export function buildPortfolioDemoUniverse(snapshot, sourceRows) {
  if (!snapshot || !Array.isArray(snapshot.issuers) || !Array.isArray(sourceRows)
    || snapshot.issuerCount !== snapshot.issuers.length || snapshot.securityCount !== sourceRows.length) fail("incomplete membership source.");
  const byTicker = new Map(), seenCiks = new Set();
  for (const issuer of snapshot.issuers) {
    if (!cikPattern.test(issuer.cik || "") || seenCiks.has(issuer.cik) || !Array.isArray(issuer.aliases) || !issuer.aliases.length) fail("ambiguous source issuer.");
    seenCiks.add(issuer.cik);
    for (const ticker of issuer.aliases) {
      if (!tickerPattern.test(ticker) || byTicker.has(ticker)) fail("ambiguous source ticker.");
      byTicker.set(ticker, issuer);
    }
  }
  if (byTicker.size !== sourceRows.length) fail("source share classes are missing.");
  const companies = new Map(), seen = new Set();
  for (const row of sourceRows) {
    const issuer = byTicker.get(row.ticker);
    if (!issuer || seen.has(row.ticker) || !Number.isFinite(row.weight_pct) || row.weight_pct < 0 || row.weight_pct > 100
      || !Number.isFinite(row.market_value_usd) || row.market_value_usd <= 0) fail("invalid holding size or security identity.");
    seen.add(row.ticker);
    if (!companies.has(issuer.cik)) companies.set(issuer.cik, { cik: issuer.cik, name: issuer.name, sector: issuer.sector, share_classes: [] });
    companies.get(issuer.cik).share_classes.push({ ticker: row.ticker, weight_pct: row.weight_pct, market_value_usd: row.market_value_usd });
  }
  const ranked = [...companies.values()].map(company => {
    company.share_classes.sort(bySize);
    return { ...company, ticker: company.share_classes[0].ticker, weight_pct: total(company.share_classes, "weight_pct"), market_value_usd: total(company.share_classes, "market_value_usd") };
  }).sort(bySize).slice(0, 100).map((company, index) => ({ rank: index + 1, ...company }));
  return validatePortfolioDemoUniverse({
    schema_version: DEMO_UNIVERSE_SCHEMA, membership_id: snapshot.id,
    source: { fund: snapshot.reference?.fund, asOf: snapshot.reference?.asOf, checkedAt: snapshot.reference?.checkedAt, url: snapshot.reference?.url, sha256: snapshot.sourceSnapshot?.sha256 },
    selection: { method: "largest-issuer-holdings", description: "The 100 largest issuer holdings in the active IVV S&P 500 coverage source, ranked by combined published fund weight across share classes. Ties use combined holding market value, then ticker. Each SEC issuer appears once, represented by its largest share class. IVV holdings are a dated coverage proxy, not certified current index membership.", count: 100, availableIssuers: snapshot.issuerCount, sort: SORT },
    companies: ranked,
  });
}
