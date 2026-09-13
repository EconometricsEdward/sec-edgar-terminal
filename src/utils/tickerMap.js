/** Full SEC directories are shared across instances, independently of the 500
 * maintained issuers. Entries remain fresh for 24h and may be used for at most
 * seven days after retrieval during an upstream outage. Reads do not extend age.
 */

import { secFetch } from "./secClient.js";
import { warmGet, warmSet } from "./warmCache.js";

const TTL_MS = 24 * 60 * 60 * 1000; // directory files change infrequently
const RETAIN_MS = 7 * TTL_MS;
const DIRECTORY_NAMESPACE = 'sec-directory-v1';
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
// SEC includes a few parenthesized fund symbols. Preserve those exact aliases;
// stripping punctuation could silently identify another security.
const TICKER = /^(?:[A-Z0-9][A-Z0-9.^/$-]{0,31}|\([A-Z0-9][A-Z0-9.^/$-]{0,29}\))$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const normalizedCik = value => /^(?:\d{1,10})$/.test(String(value)) && Number(value) > 0 ? String(value).padStart(10, '0') : null;

const OPERATING_URL = "https://www.sec.gov/files/company_tickers.json";
const FUND_URL = "https://www.sec.gov/files/company_tickers_mf.json";

function getUserAgent() {
  return (
    process.env.SEC_USER_AGENT ||
    "SEC EDGAR Terminal research@secedgarterminal.com"
  );
}

/**
 * Index the operating-companies ticker file into a plain object:
 *   { AAPL: { cik: "0000320193", name: "Apple Inc." }, ... }
 */
function buildOperatingIndex(raw) {
  if (!record(raw)) throw new Error('SEC operating directory is malformed.');
  const index = Object.create(null);
  for (const entry of Object.values(raw)) {
    const ticker = typeof entry?.ticker === 'string' ? entry.ticker.toUpperCase() : '';
    const cik = normalizedCik(entry?.cik_str);
    if (!TICKER.test(ticker) || !cik || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 1000)
      throw new Error('SEC operating directory identity is malformed.');
    if (index[ticker] && index[ticker].cik !== cik) throw new Error('SEC operating directory has an ambiguous ticker.');
    index[ticker] = { cik, name: entry.title };
  }
  return index;
}

/**
 * The mutual-fund file has shape:
 *   { fields: ["cik","seriesId","classId","symbol"], data: [[...], ...] }
 */
function buildFundIndex(raw) {
  if (!Array.isArray(raw?.data) || !Array.isArray(raw.fields)
    || raw.fields.join(',') !== 'cik,seriesId,classId,symbol') throw new Error('SEC fund directory schema is malformed.');
  const index = Object.create(null);
  for (const row of raw.data) {
    const cik = normalizedCik(row?.[0]);
    if (!Array.isArray(row) || row.length !== 4 || !cik || !/^S\d{9}$/.test(row[1]) || !/^C\d{9}$/.test(row[2]) || typeof row[3] !== 'string')
      throw new Error('SEC fund directory identity is malformed.');
    // Some valid SEC fund classes have no trading symbol. They cannot enter a
    // ticker index; keep validating their identity without inventing an alias.
    if (row[3] === '') continue;
    const ticker = row[3].toUpperCase();
    if (!TICKER.test(ticker)) throw new Error('SEC fund directory identity is malformed.');
    const value = { cik, seriesId: row[1], classId: row[2] };
    if (index[ticker] && JSON.stringify(index[ticker]) !== JSON.stringify(value)) throw new Error('SEC fund directory has an ambiguous ticker.');
    index[ticker] = value;
  }
  return index;
}

function validDirectory(value, kind, now) {
  const fetchedAt = Date.parse(value?.fetchedAt), expiresAt = Date.parse(value?.expiresAt);
  if (value?.schema !== 1 || value.kind !== kind || !record(value.data)
    || !Number.isFinite(fetchedAt) || !Number.isFinite(expiresAt)
    || fetchedAt > now + 60000 || expiresAt !== fetchedAt + TTL_MS || now >= fetchedAt + RETAIN_MS) return false;
  const entries = Object.entries(value.data);
  if (!entries.length || entries.length > 100000) return false;
  return entries.every(([ticker, entry]) => TICKER.test(ticker) && record(entry) && /^\d{10}$/.test(entry.cik) && Number(entry.cik) > 0
    && (kind === 'operating' ? typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 1000
      : /^S\d{9}$/.test(entry.seriesId) && /^C\d{9}$/.test(entry.classId)));
}

export function createTickerDirectoryCache({ fetchSec = secFetch, read = warmGet, write = warmSet, now = Date.now } = {}) {
  const memory = new Map(), pending = new Map(), retryAfter = new Map();
  return Object.freeze({
    async get(kind) {
      if (!['operating', 'funds'].includes(kind)) throw new Error('Unknown SEC directory.');
      let previous = memory.get(kind);
      if (previous && !validDirectory(previous, kind, now())) { memory.delete(kind); previous = null; }
      if (previous && (Date.parse(previous.expiresAt) > now() || now() < (retryAfter.get(kind) || 0))) return previous.data;
      if (pending.has(kind)) return pending.get(kind);
      const task = (async () => {
        let shared;
        try { shared = await read(DIRECTORY_NAMESPACE, kind); } catch { /* Existing local data and upstream remain available. */ }
        if (validDirectory(shared, kind, now()) && (!previous || shared.fetchedAt > previous.fetchedAt)) {
          previous = shared; memory.set(kind, shared);
        }
        if (previous && Date.parse(previous.expiresAt) > now()) return previous.data;
        try {
          const response = await fetchSec(kind === 'operating' ? OPERATING_URL : FUND_URL, {
            headers: { 'User-Agent': getUserAgent(), Accept: 'application/json' }, timeoutMs: 15000, maxBytes: MAX_DIRECTORY_BYTES,
          });
          if (!response.ok) throw new Error(`SEC ticker file fetch failed: HTTP ${response.status}`);
          const raw = await response.json();
          const data = kind === 'operating' ? buildOperatingIndex(raw) : buildFundIndex(raw);
          const fetched = now();
          const fresh = { schema: 1, kind, fetchedAt: new Date(fetched).toISOString(), expiresAt: new Date(fetched + TTL_MS).toISOString(), data };
          if (!validDirectory(fresh, kind, fetched)) throw new Error('SEC directory failed validation.');
          memory.set(kind, fresh); retryAfter.delete(kind);
          try { await write(DIRECTORY_NAMESPACE, kind, fresh, RETAIN_MS / 1000); } catch { /* Optional persistence cannot invalidate a verified SEC response. */ }
          return data;
        } catch (error) {
          if (previous && validDirectory(previous, kind, now())) {
            retryAfter.set(kind, now() + 60000);
            return previous.data;
          }
          throw error;
        }
      })();
      pending.set(kind, task);
      try { return await task; } finally { pending.delete(kind); }
    },
  });
}

const directories = createTickerDirectoryCache();
const getCached = kind => directories.get(kind === 'operating' ? kind : 'funds');

/**
 * Look up a single operating-company ticker.
 * @param {string} ticker
 * @returns {Promise<{ cik: string, name: string } | null>}
 */
export async function getOperatingTicker(ticker) {
  if (!ticker) return null;
  const index = await getCached("operating");
  return index[ticker.toUpperCase()] || null;
}

/**
 * Look up a single fund ticker.
 * @param {string} ticker
 * @returns {Promise<{ cik: string, seriesId: string, classId: string } | null>}
 */
export async function getFundTicker(ticker) {
  if (!ticker) return null;
  const index = await getCached("fund");
  return index[ticker.toUpperCase()] || null;
}

/**
 * Unified lookup — operating first, then fund. Use this when you don't know
 * which category a ticker belongs to (as in the fund detection route).
 */
export async function getAnyTicker(ticker) {
  const op = await getOperatingTicker(ticker);
  if (op) return { ...op, kind: "operating" };
  const fund = await getFundTicker(ticker);
  if (fund) return { ...fund, kind: "fund" };
  return null;
}

/**
 * Batch version — takes an array of tickers, returns a map of
 * { TICKER: { cik, name } } for operating companies. Missing tickers are omitted.
 */
export async function getOperatingTickers(tickers) {
  const index = await getCached("operating");
  const out = {};
  for (const t of tickers) {
    const entry = index[String(t).toUpperCase()];
    if (entry) out[String(t).toUpperCase()] = entry;
  }
  return out;
}

/** The same cached SEC directories support security-first fund discovery. */
export async function getOperatingDirectory() {
  return getCached("operating");
}

/** Public SEC fund identities; portfolio imports keep funds separate from issuers. */
export async function getFundDirectory() {
  return getCached("fund");
}

export async function getFundSeriesTickers() {
  const index = await getCached("fund");
  const series = {};
  for (const [ticker, fund] of Object.entries(index)) {
    const key = `${fund.cik}:${fund.seriesId}`;
    (series[key] ||= []).push(ticker);
  }
  for (const tickers of Object.values(series)) tickers.sort();
  return series;
}

/** Resolve before searching; never choose an associated security's first alias. */
export async function resolveDisclosureCompany(value) {
  const requested = String(value || "").trim();
  if (/^\d{1,10}$/.test(requested))
    return {
      ticker: requested.padStart(10, "0"),
      cik: requested.padStart(10, "0"),
      name: "",
    };
  const index = await getCached("operating");
  const ticker = requested.toUpperCase();
  if (index[ticker]) return { ...index[ticker], ticker };
  const normalized = requested.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length < 3)
    throw new Error(
      `No SEC company matched ${requested}. Use its ticker or CIK.`,
    );
  const matches = Object.entries(index).filter(
    ([, entry]) =>
      entry.name.toLowerCase().replace(/[^a-z0-9]/g, "") === normalized,
  );
  const ciks = [...new Set(matches.map(([, entry]) => entry.cik))];
  if (ciks.length !== 1)
    throw new Error(
      `Company identity is unresolved for ${requested}. Use an exact ticker or CIK.`,
    );
  // A name resolves to the issuer's CIK, not an arbitrarily selected share class.
  return { ticker: ciks[0], cik: ciks[0], name: matches[0][1].name };
}
