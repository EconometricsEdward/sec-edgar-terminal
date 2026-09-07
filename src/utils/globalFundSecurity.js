const cleanText = (value) => String(value ?? "").trim();
const upper = (value) => cleanText(value).toUpperCase();
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** Remove legal endings only, retaining meaningful issuer words such as Holdings. */
export function normalizeIssuerName(name) {
  let normalized = cleanText(name)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\b(?:[a-z]\.){2,}/g, (value) => value.replaceAll(".", ""))
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  const ending =
    /\s+(?:and co|inc|incorporated|corp|corporation|co|company|plc|ltd|limited|llc|llp|lp|sa|nv|ag|se|spa|sarl|bv|gmbh|pte|pty)$/;
  while (ending.test(normalized)) normalized = normalized.replace(ending, "");
  return normalized;
}

const cikKey = (value) => {
  const cik = cleanText(value);
  return /^\d{1,10}$/.test(cik) ? cik.padStart(10, "0") : cik;
};

const suggestion = ({ ticker, name, cik }) => ({
  query: ticker,
  label: `${name} (${ticker})`,
  ticker,
  name,
  cik,
});

/** Resolve a company without silently correcting a query or choosing a share class. */
export function resolveSecurityTarget(query, operatingIndex = {}) {
  const input = cleanText(query).slice(0, 160);
  const symbol = upper(input);
  const canonical = normalizeIssuerName(input);
  const base = {
    query: input,
    label: input,
    kind: "text",
    ticker: null,
    name: null,
    cik: null,
    terms: input ? [input] : [],
    identifier: null,
    suggestions: [],
  };
  if (!input) return base;

  const entries = Object.entries(operatingIndex || {})
    .filter(([, entry]) => entry && cleanText(entry.name))
    .map(([ticker, entry]) => ({
      ticker: upper(ticker),
      name: cleanText(entry.name),
      cik: entry.cik == null ? null : String(entry.cik),
    }));
  const companyTarget = (entry, ticker) => {
    const terms = [entry.name, normalizeIssuerName(entry.name)].filter(Boolean);
    return {
      ...base,
      kind: "company",
      label: `${entry.name}${ticker ? ` (${ticker})` : ""}`,
      ticker,
      name: entry.name,
      cik: entry.cik,
      terms: terms.filter(
        (term, i) =>
          terms.findIndex((other) => upper(other) === upper(term)) === i,
      ),
    };
  };

  const exactTicker = entries.find((entry) => entry.ticker === symbol);
  if (exactTicker) return companyTarget(exactTicker, exactTicker.ticker);

  const names = canonical
    ? entries.filter((entry) => normalizeIssuerName(entry.name) === canonical)
    : [];
  if (names.length === 1) return companyTarget(names[0], names[0].ticker);
  if (names.length > 1) {
    const issuers = new Set(
      names.map((entry) => cikKey(entry.cik) || `unknown:${entry.ticker}`),
    );
    if (issuers.size === 1) {
      // A company-name search covers its issuer; it does not select one stock class.
      const entry = [...names].sort((a, b) =>
        a.ticker.localeCompare(b.ticker),
      )[0];
      return companyTarget(entry, null);
    }
    return { ...base, suggestions: names.slice(0, 10).map(suggestion) };
  }

  // Identifier input is an exact security identifier, never a short issuer CIK.
  const isIsin = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(symbol);
  const isCusip = /^[A-Z0-9*@#]{8}[0-9]$/.test(symbol) && !/^0+$/.test(symbol);
  if (isIsin || isCusip)
    return {
      ...base,
      label: `${isIsin ? "ISIN" : "CUSIP"} ${symbol}`,
      kind: "identifier",
      identifier: symbol,
      terms: [symbol],
    };

  if (symbol === "APPL") {
    const apple = entries.find((entry) => entry.ticker === "AAPL");
    if (apple) return { ...base, suggestions: [suggestion(apple)] };
  }
  return base;
}

const words = (value) =>
  cleanText(value)
    .toLowerCase()
    .match(/[\p{L}\p{N}*@#]+/gu) || [];

/** Match only directly reported Holding fields, never derivative-underlier text. */
export function holdingsMatchTarget(holding = {}, target = {}, asset = "EC") {
  if (!holding || !target) return false;
  if (upper(asset) !== "ALL" && upper(holding.assetCat) !== upper(asset))
    return false;
  if (target.kind === "identifier") {
    const identifier = upper(target.identifier);
    return (
      Boolean(identifier) &&
      [holding.cusip, holding.isin].some((value) => upper(value) === identifier)
    );
  }
  if (target.kind === "company") {
    const ticker = upper(target.ticker);
    const company = normalizeIssuerName(target.name);
    return Boolean(
      (ticker && upper(holding.tickerSymbol) === ticker) ||
      (company && normalizeIssuerName(holding.name) === company),
    );
  }
  const queryWords = words(target.query);
  if (!queryWords.length) return false;
  const reportedWords = new Set(
    words(
      [
        holding.name,
        holding.title,
        holding.tickerSymbol,
        holding.cusip,
        holding.isin,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  );
  return queryWords.every((word) => reportedWords.has(word));
}

function aggregate(holdings, key) {
  const known = holdings.map((holding) => holding[key]).filter(finite);
  const sum = known.length
    ? known.reduce((total, value) => total + value, 0)
    : null;
  const missing = holdings.length - known.length;
  return {
    total: !missing && finite(sum) ? sum : null,
    known: finite(sum) ? sum : null,
    missing,
  };
}

function totals(holdings) {
  const value = aggregate(holdings, "value");
  const weight = aggregate(holdings, "pctOfNav");
  return {
    value: value.total,
    knownValue: value.known,
    missingValueCount: value.missing,
    pctOfNav: weight.total,
    knownWeight: weight.known,
    missingWeightCount: weight.missing,
    positionCount: holdings.length,
  };
}

/** Each summary belongs to one SEC portfolio series and one reported snapshot. */
export function summarizeDiscoveredFund(portfolio, target, asset = "EC") {
  const holdings = (portfolio?.holdings || []).filter((holding) =>
    holdingsMatchTarget(holding, target, asset),
  );
  if (!holdings.length) return null;
  const categories = [
    ...new Set(holdings.map((holding) => upper(holding.assetCat) || "UNKNOWN")),
  ];
  return {
    id: `${portfolio.cik}:${portfolio.seriesId || "registrant"}`,
    name: portfolio.name ?? null,
    tickers: portfolio.tickers || [],
    cik: portfolio.cik ?? null,
    seriesId: portfolio.seriesId ?? null,
    asOf: portfolio.asOf ?? null,
    filingDate: portfolio.filingDate ?? null,
    accession: portfolio.accession ?? null,
    sourceUrl: portfolio.sourceUrl ?? null,
    filingUrl: portfolio.filingUrl ?? null,
    ...totals(holdings),
    categories: categories.map((asset) => ({
      asset,
      ...totals(
        holdings.filter(
          (holding) => (upper(holding.assetCat) || "UNKNOWN") === asset,
        ),
      ),
    })),
    holdings,
    stockPositionCount: holdings.filter(
      (holding) => upper(holding.assetCat) === "EC",
    ).length,
    derivativeCount: holdings.filter((holding) =>
      /^D(IR|CR|FE|E|CO|O)$/.test(upper(holding.assetCat)),
    ).length,
  };
}

function snapshotOrder(left, right) {
  const date = (value) => {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  for (const key of ["asOf", "filingDate"]) {
    const a = date(left[key]),
      b = date(right[key]);
    if (a !== b) return a > b ? 1 : -1;
  }
  const amendment = (fund) => (/\/A$/i.test(fund.form || "") ? 1 : 0);
  return (
    amendment(left) - amendment(right) ||
    cleanText(left.accession).localeCompare(cleanText(right.accession))
  );
}

/** Retain one latest snapshot per series; share-class tickers are display aliases. */
export function mergeDiscoveredFunds(prev = [], next = []) {
  const funds = new Map();
  for (const fund of [...prev, ...next]) {
    if (!fund) continue;
    const key = `${cikKey(fund.cik)}:${upper(fund.seriesId) || "registrant"}`;
    const prior = funds.get(key);
    if (!prior) {
      funds.set(key, { ...fund, tickers: [...(fund.tickers || [])] });
      continue;
    }
    const latest = snapshotOrder(fund, prior) >= 0 ? fund : prior;
    funds.set(key, {
      ...latest,
      tickers: [
        ...new Set([...(prior.tickers || []), ...(fund.tickers || [])]),
      ],
    });
  }
  return [...funds.values()];
}
