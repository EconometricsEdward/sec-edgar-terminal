import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { resolveDisclosureCompany } from "./tickerMap.js";
import { buildFilingUrl, stripHtml } from "./filingTextParser.js";
import { warmGet, warmSet } from "./warmCache.js";
import {
  analyzeDisclosure,
  compareDisclosurePassages,
  selectDisclosureBaseline,
  SECTION_OPTIONS,
} from "./disclosureResearch.js";
import { parseDisclosureQuery, QUERY_VERSION } from "./disclosureQuery.js";

export const DISCLOSURE_FORMS = [
  "10-K",
  "10-Q",
  "8-K",
  "20-F",
  "40-F",
  "6-K",
  "S-1",
  "S-3",
  "S-4",
  "DEF 14A",
  "DEFM14A",
  "N-CSR",
  "NPORT-P",
];
let nextRequest = 0;
const textCache = new Map();
const inflight = new Map();
const signature = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function secFetch(url) {
  const slot = Math.max(Date.now(), nextRequest);
  nextRequest = slot + 180;
  if (slot > Date.now())
    await new Promise((resolve) => setTimeout(resolve, slot - Date.now()));
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        process.env.SEC_USER_AGENT ||
        "EDGAR Terminal research@secedgarterminal.com",
    },
    signal: AbortSignal.timeout(18000),
  });
  if (!response.ok) throw new Error(`SEC returned HTTP ${response.status}.`);
  return response;
}

export function disclosureSettings(params) {
  const query = params.get("query") || "";
  const parsed = parseDisclosureQuery(query);
  const today = new Date().toISOString().slice(0, 10);
  const start = params.get("start") || `${Number(today.slice(0, 4)) - 5}-01-01`;
  const end = params.get("end") || today;
  const validDate = (d) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    Number.isFinite(Date.parse(d)) &&
    new Date(d).toISOString().slice(0, 10) === d;
  if (
    !validDate(start) ||
    !validDate(end) ||
    start > end ||
    start < "2001-01-01" ||
    end > today
  )
    throw new Error(
      "Choose a valid filing-date window between 2001 and today.",
    );
  const section = params.get("section") || "all";
  if (!SECTION_OPTIONS.some(([id]) => id === section))
    throw new Error("Choose a supported filing section.");
  const scope = params.get("scope") || "paragraph";
  if (!["paragraph", "document"].includes(scope))
    throw new Error("Choose paragraph or document matching.");
  const forms = (params.get("forms") || "10-K,10-Q").split(",");
  if (!forms.length || forms.some((f) => !DISCLOSURE_FORMS.includes(f)))
    throw new Error("Choose supported SEC forms.");
  const depth = Number(params.get("depth") || 8);
  if (!Number.isInteger(depth) || depth < 1 || depth > 12)
    throw new Error("Review between 1 and 12 filings per company.");
  return {
    query,
    parsed,
    start,
    end,
    section,
    scope,
    forms,
    depth,
    amendments: params.get("amendments") === "true",
  };
}

function rows(recent, cik) {
  return (recent?.accessionNumber || []).flatMap((accession, i) => {
    const form = recent.form?.[i] || "";
    const primaryDoc = recent.primaryDocument?.[i] || "";
    if (!DISCLOSURE_FORMS.includes(form.replace("/A", "")) || !primaryDoc)
      return [];
    return [
      {
        accession,
        form,
        primaryDoc,
        filingDate: recent.filingDate?.[i] || "",
        reportDate: recent.reportDate?.[i] || "",
        documentUrl: buildFilingUrl(cik, accession, primaryDoc),
      },
    ];
  });
}

export async function disclosureCompanyHistory(input, settings) {
  const identity = await resolveDisclosureCompany(input);
  const key = `${identity.cik}:${settings.start}`;
  const cached = await warmGet("disclosure-history-v1", key);
  if (cached) return { ...cached, ticker: identity.ticker };
  const submissions = await (
    await secFetch(`https://data.sec.gov/submissions/CIK${identity.cik}.json`)
  ).json();
  let filings = rows(submissions.filings?.recent, identity.cik);
  const since = new Date(Date.parse(settings.start) - 410 * 86400000)
    .toISOString()
    .slice(0, 10);
  const archives = (submissions.filings?.files || [])
    .filter((f) => f.filingTo >= since)
    .sort((a, b) => b.filingTo.localeCompare(a.filingTo));
  const issues = [];
  for (const file of archives.slice(0, 6)) {
    if (!/^CIK\d{10}-submissions-\d+\.json$/.test(file.name)) continue;
    try {
      const data = await (
        await secFetch(`https://data.sec.gov/submissions/${file.name}`)
      ).json();
      filings.push(...rows(data, identity.cik));
    } catch (error) {
      issues.push(
        `History ${file.filingFrom}–${file.filingTo}: ${error.message}`,
      );
    }
  }
  filings = [...new Map(filings.map((f) => [f.accession, f])).values()].sort(
    (a, b) =>
      b.filingDate.localeCompare(a.filingDate) ||
      b.accession.localeCompare(a.accession),
  );
  const result = {
    ...identity,
    companyName: submissions.name || identity.name,
    filings,
    historyLimited: archives.length > 6 || issues.length > 0,
    historyIssues: issues,
    historyArchivesReviewed: Math.min(archives.length, 6),
    historyArchivesAvailable: archives.length,
  };
  if (!issues.length) await warmSet("disclosure-history-v1", key, result, 300);
  return result;
}

async function filingText(cik, filing) {
  const key = `${cik}:${filing.accession}:${filing.primaryDoc}`;
  if (textCache.has(key)) return textCache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    const cached = await warmGet("disclosure-text-v1", key);
    let text;
    if (cached?.gzip) {
      try {
        text = gunzipSync(Buffer.from(cached.gzip, "base64")).toString("utf8");
      } catch {
        /* fetch corrupt cache again */
      }
    }
    if (!text) {
      if (
        !/^[\w][\w.\/-]*\.(?:htm|html|txt)$/i.test(filing.primaryDoc) ||
        filing.primaryDoc.includes("..")
      )
        throw new Error("This document format cannot be reviewed as text.");
      const response = await secFetch(
        buildFilingUrl(cik, filing.accession, filing.primaryDoc),
      );
      const html = await response.text();
      if (html.length > 24000000)
        throw new Error(
          "Document exceeds the 24 MB text review limit. Open the SEC source.",
        );
      // Inline XBRL hidden facts are not narrative disclosures.
      text = stripHtml(
        html.replace(/<ix:hidden\b[^>]*>[\s\S]*?<\/ix:hidden>/gi, ""),
      );
      if (
        text.length < 100 ||
        /<title>[^<]*(?:access denied|request rate threshold)/i.test(html)
      )
        throw new Error("SEC returned no usable filing text.");
      await warmSet(
        "disclosure-text-v1",
        key,
        { gzip: gzipSync(text).toString("base64") },
        86400 * 7,
      );
    }
    let total = text.length;
    for (const value of textCache.values()) total += value.length;
    while (textCache.size && (total > 20000000 || textCache.size >= 24)) {
      const first = textCache.keys().next().value;
      total -= textCache.get(first).length;
      textCache.delete(first);
    }
    textCache.set(key, text);
    return text;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

function compactPassage(p) {
  // Quotes are never silently shortened; long passages remain available in the reader.
  return {
    index: p.index,
    sectionId: p.sectionId,
    section: p.section,
    text: p.text.slice(0, 700),
    previewTruncated: p.text.length > 700,
    matchedTerms: p.matchedTerms,
    proximity: p.proximity,
    concrete: p.concrete,
    label: p.label,
    reasons: p.reasons,
    relevance: p.relevance,
    change: p.change,
  };
}

async function inspectFiling(company, filing, settings, compare = true) {
  const text = await filingText(company.cik, filing);
  const analysis = analyzeDisclosure(
    text,
    filing.form,
    settings.parsed,
    settings,
  );
  const pair = selectDisclosureBaseline(filing, company.filings);
  let removed = [];
  let unchanged = 0;
  let comparisonError = "";
  if (compare && pair.prior && analysis.status === "reviewed") {
    try {
      const priorText = await filingText(company.cik, pair.prior);
      const prior = analyzeDisclosure(
        priorText,
        pair.prior.form,
        settings.parsed,
        settings,
      );
      if (prior.status !== "reviewed")
        comparisonError =
          "Selected section was not identified in the prior document.";
      else {
        const diff = compareDisclosurePassages(analysis, prior, {
          amendment: pair.kind === "amendment",
        });
        analysis.matches = diff.matches;
        removed = diff.removed;
        unchanged = diff.unchanged;
        pair.coverage = {
          currentSections: analysis.sections,
          priorSections: prior.sections,
        };
      }
    } catch (error) {
      comparisonError = `Prior document was not reviewed: ${error.message}`;
    }
  }
  const matches = [...analysis.matches, ...removed].sort(
    (a, b) => b.relevance - a.relevance,
  );
  return {
    ...filing,
    ticker: company.ticker,
    cik: company.cik,
    companyName: company.companyName,
    status: analysis.status,
    matched: analysis.matched,
    matchCount: analysis.matches.length,
    removedCount: removed.length,
    topics: analysis.topics,
    sections: analysis.sections,
    extraction: analysis.extraction,
    pair,
    comparisonError,
    unchanged,
    matches,
    additions: analysis.matches.filter((p) => p.change === "added").length,
    revisions: analysis.matches.filter((p) => p.change === "revised").length,
    reason:
      analysis.status === "section-unavailable"
        ? "Requested section was not identified; no conclusion about absence of the query."
        : "",
  };
}

export async function scanDisclosureCompany(input, settings) {
  const company = await disclosureCompanyHistory(input, settings);
  const eligible = company.filings.filter(
    (f) =>
      f.filingDate >= settings.start &&
      f.filingDate <= settings.end &&
      settings.forms.includes(f.form.replace("/A", "")) &&
      (settings.amendments || !f.form.endsWith("/A")),
  );
  const selected = eligible.slice(0, settings.depth);
  const key = signature({
    version: QUERY_VERSION,
    cik: company.cik,
    settings: { ...settings, parsed: undefined },
    filings: selected.map((f) => f.accession),
  });
  const cached = await warmGet("disclosure-scan-v1", key);
  if (cached)
    return {
      ...cached,
      ticker: company.ticker,
      filings: cached.filings.map((f) => ({ ...f, ticker: company.ticker })),
      checkedAt: new Date().toISOString(),
      cached: true,
    };
  const filings = [];
  for (const filing of selected) {
    try {
      const result = await inspectFiling(company, filing, settings);
      filings.push({
        ...result,
        matches: undefined,
        previews: result.matches.slice(0, 3).map(compactPassage),
      });
    } catch (error) {
      filings.push({
        ...filing,
        ticker: company.ticker,
        cik: company.cik,
        companyName: company.companyName,
        status: "fetch-failed",
        matched: false,
        reason: error.message,
        previews: [],
        topics: {},
      });
    }
  }
  const reviewed = filings.filter((f) => f.status === "reviewed");
  const matching = reviewed.filter((f) => f.matched);
  const result = {
    ...company,
    filings,
    eligible: eligible.length,
    limited: eligible.length > settings.depth,
    selected: selected.length,
    reviewed: reviewed.length,
    fetchFailed: filings.filter((f) => f.status === "fetch-failed").length,
    sectionUnavailable: filings.filter(
      (f) => f.status === "section-unavailable",
    ).length,
    matched: matching.length,
    firstObserved: matching.map((f) => f.filingDate).sort()[0] || null,
    observedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    query: settings.query,
  };
  if (filings.every((f) => f.status !== "fetch-failed" && !f.comparisonError))
    await warmSet("disclosure-scan-v1", key, result, 1800);
  return result;
}

export async function readDisclosureDocument(
  input,
  accession,
  document,
  settings,
  page = 1,
) {
  if (!/^\d{10}-\d{2}-\d{6}$/.test(accession))
    throw new Error("Invalid SEC accession.");
  const company = await disclosureCompanyHistory(input, settings);
  const filing = company.filings.find((f) => f.accession === accession);
  if (!filing)
    throw new Error(
      "This accession was not found in the inspected issuer history. Open the original SEC filing.",
    );
  // Index results may refer to exhibits. Validate the document name, preserve the
  // submission metadata, and do not compare an exhibit to a primary report.
  const exhibit = document && document !== filing.primaryDoc;
  const selected = exhibit
    ? {
        ...filing,
        primaryDoc: document,
        documentUrl: buildFilingUrl(company.cik, accession, document),
      }
    : filing;
  const result = await inspectFiling(company, selected, settings, !exhibit);
  if (exhibit)
    result.pair = {
      prior: null,
      kind: "exhibit",
      reason:
        "Exhibits are read individually and are not paired with a primary report.",
    };
  const pageSize = 12;
  const total = result.matches.length;
  return {
    ...result,
    matches: result.matches.slice((page - 1) * pageSize, page * pageSize),
    totalPassages: total,
    page,
    pageSize,
    observedAt: new Date().toISOString(),
    query: settings.query,
    settings: { ...settings, parsed: undefined },
  };
}
