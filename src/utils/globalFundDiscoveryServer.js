import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { parseNport } from "./fundResearch.js";
import { getOperatingDirectory, getFundSeriesTickers } from "./tickerMap.js";
import {
  resolveSecurityTarget,
  summarizeDiscoveredFund,
  mergeDiscoveredFunds,
  normalizeIssuerName,
} from "./globalFundSecurity.js";
import { warmGet, warmSet } from "./warmCache.js";

const VERSION = "global-fund-discovery-v1";
const DAY = 86400000;
const BATCH_SIZE = 24;
const SEC_PAGE_SIZE = 100;
const cache = new Map();
const pending = new Map();
let nextRequest = 0;
const requestDeadline = new AsyncLocalStorage();
const iso = (date) => new Date(date).toISOString().slice(0, 10);
const validDate = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
  Number.isFinite(Date.parse(value)) &&
  iso(value) === value;
const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

async function cached(key, fn, { shared = false, ttl = 1800000 } = {}) {
  const hit = cache.get(key);
  if (hit?.expires > Date.now()) return hit.value;
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => {
    const warm = shared ? await warmGet(VERSION, key) : null;
    const value = warm || (await fn());
    if (cache.size >= 48) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + ttl });
    if (shared && !warm)
      await warmSet(VERSION, key, value, Math.floor(ttl / 1000));
    return value;
  })();
  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    pending.delete(key);
  }
}

async function sec(url) {
  const remaining = () =>
    (requestDeadline.getStore() || Date.now() + 85000) - Date.now();
  if (remaining() <= 1000)
    throw new Error(
      "Verification time limit reached. Retry this search to check unavailable reports.",
    );
  const wait = Math.max(0, nextRequest - Date.now());
  nextRequest = Date.now() + wait + 260;
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        process.env.SEC_USER_AGENT ||
        "EDGAR Terminal research@secedgarterminal.com",
      Accept: "application/json, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(Math.max(1, Math.min(18000, remaining()))),
  });
  if (!response.ok)
    throw new Error(
      `SEC report service returned HTTP ${response.status}. Please retry.`,
    );
  return response;
}

export function discoveryWindows(anchor) {
  if (!validDate(anchor)) throw new Error("Invalid search date.");
  const start = iso(Date.parse(anchor) - 365 * DAY);
  const ranges = [];
  let end = anchor;
  while (end >= start) {
    const monthStart = end.slice(0, 8) + "01";
    const lower = monthStart < start ? start : monthStart;
    ranges.push({ start: lower, end, offset: 0 });
    end = iso(Date.parse(lower) - DAY);
  }
  return ranges;
}

export function readDiscoveryCursor(cursor, query, asset, today) {
  const key = hash(`${query.trim().toLowerCase()}:${asset}`);
  if (!cursor)
    return { v: 1, key, anchor: today, ranges: discoveryWindows(today) };
  if (cursor.length > 6000)
    throw new Error("Search cursor is too large. Start a new search.");
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    throw new Error("Invalid search cursor. Start a new search.");
  }
  if (
    value.v !== 1 ||
    value.key !== key ||
    !validDate(value.anchor) ||
    value.anchor > today ||
    Date.parse(today) - Date.parse(value.anchor) > 7 * DAY ||
    !Array.isArray(value.ranges) ||
    value.ranges.length > 40
  )
    throw new Error("This search has changed or expired. Start a new search.");
  const lowerBound = iso(Date.parse(value.anchor) - 365 * DAY);
  let previousStart = null;
  for (const range of value.ranges) {
    if (
      !validDate(range.start) ||
      !validDate(range.end) ||
      range.start > range.end ||
      range.start < lowerBound ||
      range.end > value.anchor ||
      !Number.isInteger(range.offset) ||
      range.offset < 0 ||
      range.offset > 10000 ||
      (previousStart && range.end >= previousStart)
    )
      throw new Error("Invalid search page. Start a new search.");
    previousStart = range.start;
  }
  return value;
}

export function splitDiscoveryWindow(range) {
  if (range.start === range.end)
    throw new Error(
      "The SEC search limit was reached for a single day. Use a more specific company or security identifier.",
    );
  const mid = iso(
    Date.parse(range.start) +
      Math.floor((Date.parse(range.end) - Date.parse(range.start)) / DAY / 2) *
        DAY,
  );
  return [
    { start: iso(Date.parse(mid) + DAY), end: range.end, offset: 0 },
    { start: range.start, end: mid, offset: 0 },
  ];
}

export function normalizeNportHit(hit) {
  const source = hit?._source || {};
  const cik = String(source.ciks?.[0] || "").padStart(10, "0");
  const accession = source.adsh || String(hit?._id || "").split(":")[0];
  const doc = String(hit?._id || "")
    .split(":")
    .slice(1)
    .join(":");
  if (
    !/^\d{10}$/.test(cik) ||
    !/^\d{10}-\d{2}-\d{6}$/.test(accession || "") ||
    !/^NPORT-P(?:\/A)?$/.test(source.form || source.root_forms?.[0] || "")
  )
    return null;
  const root = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}`;
  return {
    cik,
    accession,
    documentName: /^[\w.-]+\.xml$/i.test(doc) ? doc : null,
    name: String(source.display_names?.[0] || "SEC fund report").replace(
      /\s*\(CIK.*$/,
      "",
    ),
    asOf: source.period_ending || "",
    filingDate: source.file_date || "",
    form: source.form || "NPORT-P",
    root,
    filingUrl: `${root}/${accession}-index.html`,
  };
}

async function searchPage(term, range, cik = "") {
  const params = new URLSearchParams({
    q: term,
    forms: "NPORT-P",
    dateRange: "custom",
    startdt: range.start,
    enddt: range.end,
    sort: "desc",
    from: String(range.offset),
    ...(cik ? { ciks: cik } : {}),
  });
  const url = `https://efts.sec.gov/LATEST/search-index?${params}`;
  return cached(
    `search:${hash(url)}`,
    async () => {
      const data = await (await sec(url)).json();
      if (data.timed_out || !Array.isArray(data.hits?.hits))
        throw new Error(
          "SEC search did not return a complete page. Please retry.",
        );
      return {
        hits: data.hits.hits,
        total:
          typeof data.hits.total === "number"
            ? data.hits.total
            : data.hits.total?.value || 0,
        relation: data.hits.total?.relation || "eq",
      };
    },
    { shared: true },
  );
}

async function loadReport(candidate) {
  return cached(
    `report:${candidate.cik}:${candidate.accession}`,
    async () => {
      let filename = candidate.documentName;
      if (!filename) {
        const index = await (await sec(`${candidate.root}/index.json`)).json();
        const names = (index.directory?.item || []).map((item) => item.name);
        filename =
          names.find((name) => name === "primary_doc.xml") ||
          names.find((name) => /nport.*\.xml$/i.test(name));
      }
      if (!filename || !/^[\w.-]+\.xml$/i.test(filename))
        throw new Error(
          "The primary N-PORT portfolio could not be located. Open the SEC report.",
        );
      const sourceUrl = `${candidate.root}/${filename}`;
      const response = await sec(sourceUrl);
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 80 * 1024 * 1024) {
            await reader.cancel();
            throw new Error(
              "This portfolio is too large for interactive verification. Open its SEC report.",
            );
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      const portfolio = parseNport(Buffer.concat(chunks).toString("utf8"), {
        cik: candidate.cik,
      });
      if (!/^S\d+$/.test(portfolio.seriesId || "")) portfolio.seriesId = null;
      return {
        ...candidate,
        ...portfolio,
        sourceUrl,
        filingUrl: candidate.filingUrl,
      };
    },
    { ttl: 900000 },
  );
}

export function latestNportCandidate(page) {
  if (
    page.total > 100 ||
    page.relation !== "eq" ||
    page.hits.length < page.total
  )
    throw new Error(
      "This fund has more recent report records than can be safely verified in one lookup. Open its SEC reports.",
    );
  const candidates = page.hits.map(normalizeNportHit).filter(Boolean);
  if (candidates.some((hit) => !validDate(hit.asOf)))
    throw new Error(
      "A report has no valid portfolio date. The latest public portfolio could not be verified.",
    );
  candidates.sort(
    (a, b) =>
      b.asOf.localeCompare(a.asOf) ||
      b.filingDate.localeCompare(a.filingDate) ||
      b.accession.localeCompare(a.accession),
  );
  const newest = candidates[0];
  if (!newest)
    throw new Error(
      "The latest public portfolio could not be verified. Retry this search.",
    );
  return newest;
}

async function latestReport(portfolio, anchor) {
  const start = iso(Date.parse(anchor) - 365 * DAY);
  const page = await searchPage(
    portfolio.seriesId ? `"${portfolio.seriesId}"` : "",
    { start, end: anchor, offset: 0 },
    portfolio.cik,
  );
  const newest = latestNportCandidate(page);
  const latest =
    newest.accession === portfolio.accession
      ? portfolio
      : await loadReport(newest);
  if (
    latest.seriesId !== portfolio.seriesId ||
    latest.cik !== portfolio.cik ||
    latest.asOf !== newest.asOf ||
    (!portfolio.seriesId &&
      normalizeIssuerName(latest.name) !== normalizeIssuerName(portfolio.name))
  )
    throw new Error(
      "SEC report identity or date did not match the expected fund series.",
    );
  return latest;
}

const quote = (value) => `"${String(value).replace(/["\\]/g, " ").trim()}"`;

/** Global filing discovery, with bounded verification and an uncapped continuation. */
export async function discoverFundSecurity(input, dependencies = {}) {
  return requestDeadline.run(Date.now() + 85000, () =>
    runDiscovery(input, dependencies),
  );
}

async function runDiscovery(input, dependencies = {}) {
  const query = String(input.query || "")
    .trim()
    .replace(/\s+/g, " ");
  if (query.length < 1 || query.length > 100 || /[\u0000-\u001f]/.test(query))
    throw new Error(
      "Enter a company, ticker or security identifier (1–100 characters).",
    );
  const asset = input.asset || "EC";
  if (!["EC", "all"].includes(asset))
    throw new Error("Choose common stock or all reported security types.");
  const today = dependencies.today || iso(Date.now());
  const state = readDiscoveryCursor(input.cursor, query, asset, today);
  const startDate = iso(Date.parse(state.anchor) - 365 * DAY);
  const [directory, tickerMap] = await Promise.all([
    dependencies.operatingDirectory
      ? Promise.resolve(dependencies.operatingDirectory)
      : getOperatingDirectory(),
    dependencies.seriesTickers
      ? Promise.resolve(dependencies.seriesTickers)
      : getFundSeriesTickers().catch(() => ({})),
  ]);
  const target = resolveSecurityTarget(query, directory);
  if (query.length === 1 && target.kind !== "company")
    throw new Error(
      "Enter a recognized stock ticker or a more specific company name.",
    );
  const term = [...new Set(target.terms)].map(quote).join(" OR ");
  const search = dependencies.searchPage || searchPage;
  const load = dependencies.loadReport || loadReport;
  const latest = dependencies.latestReport || latestReport;
  const selected = [];
  const seenAccessions = new Set();
  let scannedDocuments = 0,
    rangeTotal = 0,
    rangeLabel = "",
    searchRequests = 0;
  while (
    state.ranges.length &&
    scannedDocuments < BATCH_SIZE &&
    searchRequests < 20
  ) {
    const range = state.ranges[0];
    const pageBase = Math.floor(range.offset / SEC_PAGE_SIZE) * SEC_PAGE_SIZE;
    const page = await search(term, { ...range, offset: pageBase });
    searchRequests++;
    rangeTotal = page.total;
    rangeLabel = `${range.start} to ${range.end}`;
    if (page.total > 10000 || page.relation === "gte") {
      state.ranges.splice(0, 1, ...splitDiscoveryWindow(range));
      continue;
    }
    const begin = range.offset - pageBase;
    const available = page.hits.slice(
      begin,
      begin + BATCH_SIZE - scannedDocuments,
    );
    for (const hit of available) {
      scannedDocuments++;
      range.offset++;
      const candidate = normalizeNportHit(hit);
      if (!candidate || seenAccessions.has(candidate.accession)) continue;
      seenAccessions.add(candidate.accession);
      selected.push(candidate);
    }
    if (
      !available.length ||
      range.offset >= page.total ||
      (page.hits.length < SEC_PAGE_SIZE &&
        range.offset >= pageBase + page.hits.length)
    )
      state.ranges.shift();
  }
  const checkedSeries = new Set();
  const issues = [];
  const funds = [];
  let excludedCount = 0,
    at = 0;
  const work = async () => {
    while (at < selected.length) {
      const candidate = selected[at++];
      try {
        const found = await load(candidate);
        const key = `${found.cik}:${found.seriesId || "registrant"}`;
        if (checkedSeries.has(key)) continue;
        // A full-text mention is not evidence of a matching position. A later
        // report with a direct holding remains discoverable in the global index.
        if (!summarizeDiscoveredFund(found, target, asset)) {
          excludedCount++;
          continue;
        }
        // Recheck qualifying candidates in the latest report, excluding sales.
        const portfolio = await latest(found, state.anchor);
        checkedSeries.add(key);
        const summary = summarizeDiscoveredFund(
          { ...portfolio, tickers: tickerMap[key] || [] },
          target,
          asset,
        );
        if (summary) funds.push(summary);
        else excludedCount++;
      } catch (error) {
        issues.push({
          id: candidate.accession,
          name: candidate.name,
          accession: candidate.accession,
          message: error.message || "Report could not be verified.",
          sourceUrl: candidate.filingUrl,
        });
      }
    }
  };
  await Promise.all([work(), work()]);
  return {
    target,
    funds: mergeDiscoveredFunds([], funds),
    coverage: {
      startDate,
      endDate: state.anchor,
      scannedDocuments,
      checkedSeries: [...checkedSeries],
      unavailableCount: issues.length,
      excludedCount,
      rangeTotal,
      rangeLabel,
      snapshotAt: new Date().toISOString(),
    },
    issues,
    nextCursor: state.ranges.length
      ? Buffer.from(JSON.stringify(state)).toString("base64url")
      : null,
  };
}
