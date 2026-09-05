import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { getFundTicker, getOperatingTicker } from "./tickerMap.js";
import { KNOWN_ETFS } from "./knownFunds.js";
import { warmGet, warmSet } from "./warmCache.js";
import {
  parseNport,
  parseFundFeed,
  portfolioSummary,
  FUND_CATALOG,
} from "./fundResearch.js";
const VERSION = "fund-research-v1";
const cache = new Map(),
  inFlight = new Map();
let nextRequest = 0;
async function sec(url) {
  const wait = Math.max(0, nextRequest - Date.now());
  nextRequest = Date.now() + wait + 180;
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        process.env.SEC_USER_AGENT ||
        "EDGAR Terminal research@secedgarterminal.com",
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok)
    throw new Error(
      `SEC data is temporarily unavailable (HTTP ${response.status}). Please retry.`,
    );
  return response;
}
function put(key, data) {
  if (cache.size >= 16) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expires: Date.now() + 3600000 });
  return data;
}
export async function loadFund(ticker, accession = "") {
  const key = `${ticker}:${accession || "latest"}`;
  const hit = cache.get(key);
  if (hit?.expires > Date.now()) return hit.data;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = (async () => {
    const warm = await warmGet(VERSION, key);
    if (warm?.gzip || warm?.parts) {
      try {
        let encoded = warm.gzip;
        if (
          !encoded &&
          Number.isInteger(warm.parts) &&
          warm.parts > 0 &&
          warm.parts <= 16 &&
          /^[a-f0-9]{16}$/.test(warm.hash)
        ) {
          const chunks = await Promise.all(
            Array.from({ length: warm.parts }, (_, i) =>
              warmGet(VERSION, `${key}:${warm.hash}:${i}`),
            ),
          );
          if (chunks.some((part) => typeof part !== "string"))
            throw new Error("Incomplete cache");
          encoded = chunks.join("");
        }
        if (encoded)
          return put(
            key,
            JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString()),
          );
      } catch {
        /* rebuild corrupt or incomplete cache */
      }
    }
    const data = await buildFund(ticker, accession);
    if (data.status === "ready") {
      const encoded = gzipSync(JSON.stringify(data)).toString("base64");
      if (encoded.length <= 700000)
        await warmSet(VERSION, key, { gzip: encoded }, 3600);
      else {
        const chunks = encoded.match(/.{1,700000}/g);
        if (chunks.length <= 16) {
          const hash = createHash("sha256")
            .update(encoded)
            .digest("hex")
            .slice(0, 16);
          const stored = await Promise.all(
            chunks.map((chunk, i) =>
              warmSet(VERSION, `${key}:${hash}:${i}`, chunk, 7200),
            ),
          );
          if (stored.every(Boolean))
            await warmSet(VERSION, key, { hash, parts: chunks.length }, 3600);
        }
      }
      put(key, data);
      if (!accession) put(`${ticker}:${data.accession}`, data);
    }
    return data;
  })();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}
async function buildFund(ticker, requestedAccession) {
  // A trust CIK may contain many portfolios. Preserve SEC series/class identity.
  const fund = await getFundTicker(ticker);
  const lookup = fund || (await getOperatingTicker(ticker));
  if (!lookup)
    return {
      ticker,
      isFund: false,
      status: "unavailable",
      reason:
        "Ticker not found in the SEC ticker directories. Try another ticker.",
      holdings: [],
    };
  const cik = lookup.cik;
  const submissions = await (
    await sec(`https://data.sec.gov/submissions/CIK${cik}.json`)
  ).json();
  const recent = submissions.filings?.recent || {};
  const filings = (recent.form || []).map((form, i) => ({
    form,
    accession: recent.accessionNumber[i],
    filingDate: recent.filingDate[i],
    reportDate: recent.reportDate?.[i],
    primaryDoc: recent.primaryDocument?.[i],
  }));
  const nports = filings.filter((f) => /^NPORT-P(?:\/A)?$/.test(f.form));
  const isFund = Boolean(fund || KNOWN_ETFS.has(ticker) || nports.length);
  const catalog = FUND_CATALOG.find((f) => f.ticker === ticker);
  const base = {
    ticker,
    cik,
    seriesId: fund?.seriesId || null,
    classId: fund?.classId || null,
    isFund,
    name: catalog?.name || submissions.name,
    registrant: submissions.name,
    family: catalog?.family || null,
    status: "unavailable",
    holdings: [],
    secUrl: `https://www.sec.gov/edgar/browse/?CIK=${fund?.seriesId || cik}&owner=exclude`,
  };
  // SEC's series-filtered feed narrows candidates; XML identity is independently checked.
  let candidates = nports;
  if (fund?.seriesId) {
    const feed = await (
      await sec(
        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${fund.seriesId}&type=NPORT-P&count=40&output=atom`,
      )
    ).text();
    candidates = parseFundFeed(feed).map((f) => ({
      ...f,
      ...nports.find((n) => n.accession === f.accession),
    }));
  }
  if (!candidates.length)
    return {
      ...base,
      reason:
        "No public N-PORT portfolio is available in the recent SEC records checked. This does not establish that the ticker is an operating company. Other fund structures and report types may have different coverage.",
    };
  // Recent submissions supply report dates; sort by portfolio period, then amendment date.
  candidates.sort(
    (a, b) =>
      (b.reportDate || "").localeCompare(a.reportDate || "") ||
      b.filingDate.localeCompare(a.filingDate) ||
      b.accession.localeCompare(a.accession),
  );
  const selected = requestedAccession
    ? candidates.find((f) => f.accession === requestedAccession)
    : candidates[0];
  if (!selected)
    throw new Error(
      "That filing is outside the recent report list for this fund. Open the latest portfolio.",
    );
  const root = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${selected.accession.replaceAll("-", "")}`;
  let filename = selected.primaryDoc?.split("/").pop();
  if (!filename?.endsWith(".xml")) {
    const index = await (await sec(`${root}/index.json`)).json();
    const names = (index.directory?.item || []).map((i) => i.name);
    filename =
      names.find((n) => n === "primary_doc.xml") ||
      names.find((n) => /nport.*\.xml$/i.test(n));
  }
  if (!filename || !/^[\w.-]+\.xml$/i.test(filename))
    throw new Error(
      "The N-PORT XML document could not be located. Open the SEC filing to review it.",
    );
  const sourceUrl = `${root}/${filename}`;
  const xml = await (await sec(sourceUrl)).text();
  const portfolio = parseNport(xml, { cik, seriesId: fund?.seriesId });
  const data = {
    ...base,
    ...portfolio,
    status: "ready",
    accession: selected.accession,
    filingDate: selected.filingDate,
    form: selected.form,
    sourceUrl,
    filingUrl: `${root}/${selected.accession}-index.html`,
    retrievedAt: new Date().toISOString(),
    identity: fund?.seriesId ? "SEC series matched" : "SEC registrant matched",
    reports: candidates
      .slice(0, 20)
      .map((f) => ({
        accession: f.accession,
        filingDate: f.filingDate,
        reportDate:
          f.accession === selected.accession
            ? portfolio.asOf
            : f.reportDate || null,
        form: f.form,
      })),
    filings: filings
      .filter((f) => /^(N-|NPORT|485|497)/.test(f.form))
      .slice(0, 12)
      .map((f) => ({
        ...f,
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.accession.replaceAll("-", "")}/${f.accession}-index.html`,
      })),
  };
  data.summary = portfolioSummary(data);
  return data;
}
