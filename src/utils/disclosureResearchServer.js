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
  const comparison = params.get("comparison") || "annual-season";
  if (!["annual-season", "previous-report", "none"].includes(comparison))
    throw new Error("Choose a supported filing comparison.");
  return {
    query,
    parsed,
    start,
    end,
    section,
    scope,
    forms,
    depth,
    comparison,
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
    text: (p.text || p.priorText || "").slice(0, 700),
    previewTruncated: (p.text || p.priorText || "").length > 700,
    matchedTerms: p.matchedTerms,
    proximity: p.proximity,
    concrete: p.concrete,
    label: p.label,
    reasons: p.reasons,
    relevance: p.relevance,
    change: p.change,
  };
}

async function inspectFiling(
  company,
  filing,
  settings,
  compare = true,
  baselineAccession = "",
) {
  const text = await filingText(company.cik, filing);
  const analysis = analyzeDisclosure(
    text,
    filing.form,
    settings.parsed,
    settings,
  );
  const pair = selectDisclosureBaseline(
    filing,
    company.filings,
    settings.comparison,
    baselineAccession,
  );
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
        comparisonError = diff.comparisonError || "";
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
    version: QUERY_VERSION,
    evidenceRevision: signature({
      version: QUERY_VERSION,
      query: settings.query,
      section: settings.section,
      scope: settings.scope,
      comparison: settings.comparison || "annual-season",
      baseline: compare ? pair.prior?.accession || null : null,
      status: analysis.status,
      comparisonError,
      paragraphs: analysis.paragraphs.length,
      matches: matches.map((p) => ({
        index: p.index,
        sectionId: p.sectionId,
        text: p.text,
        priorText: p.priorText || "",
        change: p.change,
      })),
    }),
    ...filing,
    ticker: company.ticker,
    cik: company.cik,
    companyName: company.companyName,
    status: analysis.status,
    matched: analysis.matched,
    matchCount: analysis.matches.length,
    removedCount: removed.filter((p) => p.change === "removed").length,
    queryRemovedCount: removed.filter((p) => p.queryNoLongerMatches).length,
    topics: analysis.topics,
    sections: analysis.sections,
    extraction: analysis.extraction,
    pair,
    comparisonError,
    unchanged,
    matches,
    signals: {
      maxRelevance: Math.max(0, ...matches.map((p) => p.relevance)),
      closestTerms:
        Math.min(...matches.map((p) => p.proximity ?? Infinity)) === Infinity
          ? null
          : Math.min(...matches.map((p) => p.proximity ?? Infinity)),
      concrete: matches.filter((p) => p.concrete).length,
      recognized: matches.filter((p) => p.sectionId !== "other").length,
      languages: Object.fromEntries(
        [...new Set(matches.map((p) => p.label))].map((label) => [
          label,
          matches.filter((p) => p.label === label).length,
        ]),
      ),
    },
    additions: analysis.matches.filter((p) => p.change === "added").length,
    revisions: matches.filter((p) => p.change === "revised").length,
    reason:
      analysis.status === "section-unavailable"
        ? "Requested section was not identified; no conclusion about absence of the query."
        : "",
  };
}

/** An accession cursor remains stable when newer reports arrive between requests. */
export function disclosureFilingBatch(filings, settings, after = "") {
  if (after && !/^\d{10}-\d{2}-\d{6}$/.test(after))
    throw new Error("Invalid filing continuation cursor.");
  const eligible = filings
    .filter(
      (f) =>
        f.filingDate >= settings.start &&
        f.filingDate <= settings.end &&
        settings.forms.includes(f.form.replace("/A", "")) &&
        (settings.amendments || !f.form.endsWith("/A")),
    )
    .sort(
      (a, b) =>
        b.filingDate.localeCompare(a.filingDate) ||
        b.accession.localeCompare(a.accession),
    );
  const previous = after
    ? eligible.findIndex((f) => f.accession === after)
    : -1;
  if (after && previous < 0)
    throw new Error(
      "The continuation filing is not eligible for these search settings. Run the search again.",
    );
  const offset = previous + 1;
  const selected = eligible.slice(offset, offset + settings.depth);
  const remaining = Math.max(0, eligible.length - offset - selected.length);
  return {
    selected,
    eligible: eligible.length,
    after,
    batchOffset: offset,
    remaining,
    nextCursor: remaining ? selected.at(-1)?.accession || null : null,
  };
}

export async function scanDisclosureCompany(input, settings, after = "") {
  const company = await disclosureCompanyHistory(input, settings);
  const batch = disclosureFilingBatch(company.filings, settings, after);
  const selected = batch.selected;
  const key = signature({
    version: QUERY_VERSION,
    cik: company.cik,
    after,
    settings: { ...settings, parsed: undefined },
    filings: selected.map((f) => f.accession),
  });
  const cached = await warmGet("disclosure-scan-v1", key);
  if (cached)
    return {
      ...cached,
      ticker: company.ticker,
      filings: cached.filings.map((f) => ({ ...f, ticker: company.ticker })),
      eligible: batch.eligible,
      batchOffset: batch.batchOffset,
      nextCursor: batch.nextCursor,
      remaining: batch.remaining,
      limited: batch.remaining > 0,
      historyLimited: company.historyLimited,
      historyIssues: company.historyIssues,
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
    version: QUERY_VERSION,
    ...company,
    filings,
    eligible: batch.eligible,
    after: batch.after,
    batchOffset: batch.batchOffset,
    nextCursor: batch.nextCursor,
    remaining: batch.remaining,
    limited: batch.remaining > 0,
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
  options = {},
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
  if (exhibit && options.baselineAccession)
    throw new Error(
      "An exhibit cannot use a primary report as its comparison baseline.",
    );
  const selected = exhibit
    ? {
        ...filing,
        primaryDoc: document,
        documentUrl: buildFilingUrl(company.cik, accession, document),
      }
    : filing;
  const result = await inspectFiling(
    company,
    selected,
    settings,
    !exhibit,
    options.baselineAccession || "",
  );
  if (exhibit)
    result.pair = {
      prior: null,
      kind: "exhibit",
      reason:
        "Exhibits are read individually and are not paired with a primary report.",
    };
  const selection = paginateDisclosurePassages(result.matches, page, options);
  return {
    ...result,
    previews: result.matches.slice(0, 3).map(compactPassage),
    ...selection,
    observedAt: new Date().toISOString(),
    query: settings.query,
    settings: { ...settings, parsed: undefined },
  };
}

export function disclosureReaderOptions(params) {
  const readerSection = params.get("readerSection") || "all";
  if (
    !["all", "other", "risk", "mda", "notes"].includes(readerSection) &&
    !/^8k:\d\.\d{2}$/.test(readerSection)
  )
    throw new Error("Choose a recognized reader section.");
  const readerChange = params.get("readerChange") || "all";
  if (
    ![
      "all",
      "changed",
      "added",
      "revised",
      "removed",
      "unchanged",
      "unavailable",
    ].includes(readerChange)
  )
    throw new Error("Choose a supported passage change filter.");
  const readerLanguage = params.get("readerLanguage") || "all";
  if (
    ![
      "all",
      "Reported-event wording",
      "Hypothetical wording",
      "Mixed language",
      "Unclassified wording",
    ].includes(readerLanguage)
  )
    throw new Error("Choose a supported passage language filter.");
  const readerFind = params.get("readerFind") || "";
  if (readerFind.length > 200)
    throw new Error("Keep the reader text filter within 200 characters.");
  const passageIndex = params.has("passageIndex")
    ? Number(params.get("passageIndex"))
    : null;
  if (
    passageIndex !== null &&
    (!/^\d+$/.test(params.get("passageIndex")) ||
      !Number.isSafeInteger(passageIndex) ||
      passageIndex < 0)
  )
    throw new Error("Choose a valid passage index.");
  const passageSide = params.get("passageSide") || "current";
  if (!["current", "prior"].includes(passageSide))
    throw new Error("Choose the current or prior passage side.");
  const baselineAccession = params.get("baselineAccession") || "";
  if (baselineAccession && !/^\d{10}-\d{2}-\d{6}$/.test(baselineAccession))
    throw new Error("Invalid comparison accession.");
  return {
    readerSection,
    readerChange,
    readerLanguage,
    readerFind,
    passageIndex,
    passageSide,
    baselineAccession,
  };
}

/** Filter the complete reviewed document before resolving passage pagination. */
export function paginateDisclosurePassages(matches, page = 1, options = {}) {
  const {
    readerSection = "all",
    readerChange = "all",
    readerLanguage = "all",
    readerFind = "",
    passageIndex = null,
    passageSide = "current",
  } = options;
  const availableSections = [
    ...new Map(
      matches.map((p) => [p.sectionId, { id: p.sectionId, label: p.section }]),
    ).values(),
  ];
  const find = readerFind.trim().toLocaleLowerCase();
  const selected = matches.filter(
    (p) =>
      (readerSection === "all" || p.sectionId === readerSection) &&
      (readerChange === "all" ||
        (readerChange === "changed"
          ? ["added", "revised", "removed"].includes(p.change)
          : readerChange === "unavailable"
            ? ["unmatched", "uncompared"].includes(p.change)
            : p.change === readerChange)) &&
      (readerLanguage === "all" || p.label === readerLanguage) &&
      (!find ||
        `${p.text || ""}\n${p.priorText || ""}`
          .toLocaleLowerCase()
          .includes(find)),
  );
  const pageSize = 12;
  const position =
    passageIndex === null
      ? -1
      : selected.findIndex(
          (p) =>
            p.index === passageIndex &&
            (p.change === "removed" ? "prior" : "current") === passageSide,
        );
  const resolvedPage =
    position >= 0
      ? Math.floor(position / pageSize) + 1
      : Math.max(1, Math.min(page, Math.ceil(selected.length / pageSize) || 1));
  return {
    matches: selected.slice(
      (resolvedPage - 1) * pageSize,
      resolvedPage * pageSize,
    ),
    totalPassages: selected.length,
    unfilteredTotalPassages: matches.length,
    availableSections,
    requestedPassageFound: passageIndex === null ? undefined : position >= 0,
    page: resolvedPage,
    pageSize,
  };
}
