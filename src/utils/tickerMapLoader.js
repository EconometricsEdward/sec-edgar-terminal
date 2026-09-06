import { secFilesUrl } from "./secApi.js";
import { KNOWN_ETFS } from "./knownFunds.js";

export const TICKER_DIRECTORY_TTL = 6 * 60 * 60 * 1000;
let cachedMap = null;
let cachedAt = 0;
let loadPromise = null;
let generation = 0;
const directoryCoverage = new WeakMap();

export function tickerDirectoryCoverage(map) {
  return map && typeof map === "object"
    ? directoryCoverage.get(map) || null
    : null;
}

const symbolOf = (value) =>
  typeof value === "string" &&
  /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(value.trim().toUpperCase())
    ? value.trim().toUpperCase()
    : "";
const cikOf = (value) =>
  /^\d{1,10}$/.test(String(value)) && Number(value) > 0
    ? String(value).padStart(10, "0")
    : "";

/** Both source files must validate; partial classification is never cached. */
export function classifyTickerDirectory(companies, mutualFunds) {
  if (!companies || Array.isArray(companies) || typeof companies !== "object")
    throw new Error("The SEC company directory has an unexpected format.");
  const entries = Object.values(companies);
  if (!entries.length) throw new Error("The SEC company directory is empty.");
  const map = Object.create(null);
  for (const entry of entries) {
    const ticker = symbolOf(entry?.ticker),
      cik = cikOf(entry?.cik_str);
    if (
      !ticker ||
      !cik ||
      typeof entry.title !== "string" ||
      !entry.title.trim()
    )
      throw new Error("The SEC company directory contains an invalid entry.");
    map[ticker] = {
      ticker,
      cik,
      name: entry.title.trim(),
      isFund: KNOWN_ETFS.has(ticker),
    };
  }
  if (
    !Array.isArray(mutualFunds?.fields) ||
    !Array.isArray(mutualFunds?.data) ||
    !mutualFunds.data.length
  )
    throw new Error("The SEC fund directory is missing or invalid.");
  const cikIndex = mutualFunds.fields.indexOf("cik");
  const symbolIndex = mutualFunds.fields.indexOf("symbol");
  if (cikIndex < 0 || symbolIndex < 0)
    throw new Error("The SEC fund directory fields have changed.");
  let fundCount = 0;
  let omittedSymbols = 0;
  for (const row of mutualFunds.data) {
    if (!Array.isArray(row))
      throw new Error("The SEC fund directory contains an invalid row.");
    // SEC includes share classes without ticker symbols. They are not searchable tickers.
    if (
      row[symbolIndex] === null ||
      row[symbolIndex] === "" ||
      /^(?:n\/a|\([A-Z0-9.-]+\))$/i.test(String(row[symbolIndex]))
    ) {
      // SEC currently includes n/a and parenthesized symbols. Do not invent a
      // searchable ticker by stripping those markers; disclose the exclusions.
      omittedSymbols += 1;
      continue;
    }
    const ticker = symbolOf(row[symbolIndex]),
      cik = cikOf(row[cikIndex]);
    if (!ticker || !cik)
      throw new Error("The SEC fund directory contains an invalid ticker.");
    fundCount += 1;
    map[ticker] = {
      ticker,
      cik,
      name: map[ticker]?.name || `Mutual Fund (${ticker})`,
      isFund: true,
    };
  }
  if (!fundCount)
    throw new Error("The SEC fund directory contains no ticker symbols.");
  directoryCoverage.set(map, {
    symbols: Object.keys(map).length,
    omittedSymbols,
  });
  return map;
}

/** Share in-flight work, expire complete data, and always release failed requests. */
export function loadClassifiedTickerMap({ force = false } = {}) {
  if (loadPromise) return loadPromise;
  if (!force && cachedMap && Date.now() - cachedAt < TICKER_DIRECTORY_TTL)
    return Promise.resolve(cachedMap);
  const requestGeneration = generation;
  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const sources = await Promise.all(
        ["company_tickers.json", "company_tickers_mf.json"].map(
          async (file) => {
            const response = await fetch(secFilesUrl(file), {
              signal: controller.signal,
            });
            if (!response.ok)
              throw new Error(
                `SEC directory request failed (${response.status}).`,
              );
            return response.json();
          },
        ),
      );
      const map = classifyTickerDirectory(sources[0], sources[1]);
      if (requestGeneration === generation) {
        cachedMap = map;
        cachedAt = Date.now();
      }
      return map;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  })();
  loadPromise = request;
  request.then(
    () => {
      if (loadPromise === request) loadPromise = null;
    },
    () => {
      if (loadPromise === request) loadPromise = null;
    },
  );
  return request;
}

export function clearTickerMapCache() {
  generation += 1;
  cachedMap = null;
  cachedAt = 0;
  loadPromise = null;
}
