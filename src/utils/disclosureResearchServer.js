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
import { secFetch as controlledSecFetch } from "./secClient.js";
import { readPreparedDisclosureText, indexDisclosureText, DISCLOSURE_INDEX_LIMITS } from "./disclosurePassageIndex.js";

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
const textCache = new Map();
const inflight = new Map();
// Bound optional legacy-cache refreshes independently of foreground research.
// SEC dispatch itself remains governed across instances by secClient.
const legacyIndexRefreshes = new Map();
const signature = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function secFetch(url, signal) {
  signal?.throwIfAborted();
  const response = await controlledSecFetch(url, {
    headers: {
      "User-Agent":
        process.env.SEC_USER_AGENT ||
        "EDGAR Terminal research@secedgarterminal.com",
    },
    timeoutMs: 18000,
    signal,
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

export async function disclosureCompanyHistory(input, settings, options = {}) {
  const { signal, accession = "" } = options;
  signal?.throwIfAborted();
  const identity = await resolveDisclosureCompany(input);
  signal?.throwIfAborted();
  const key = `${identity.cik}:${settings.start}`;
  const cached = await warmGet("disclosure-history-v1", key);
  signal?.throwIfAborted();
  if (cached) return { ...cached, ticker: identity.ticker };
  // A standalone passage does not need every historical submissions archive.
  const recentOnly = options.recentOnly || (accession && settings.comparison === "none");
  const recentCached = recentOnly ? await warmGet("disclosure-history-v1", `${key}:recent`) : null;
  if (recentCached && (!accession || recentCached.filings.some(f => f.accession === accession))) return { ...recentCached, ticker: identity.ticker };
  const submissions = await (
    await secFetch(`https://data.sec.gov/submissions/CIK${identity.cik}.json`, signal)
  ).json();
  let filings = rows(submissions.filings?.recent, identity.cik);
  const since = new Date(Date.parse(settings.start) - 410 * 86400000)
    .toISOString()
    .slice(0, 10);
  const archives = (submissions.filings?.files || [])
    .filter((f) => f.filingTo >= since)
    .sort((a, b) => b.filingTo.localeCompare(a.filingTo));
  const issues = [];
  const targetIsRecent = recentOnly && (!accession || filings.some(f => f.accession === accession));
  const selectedArchives = targetIsRecent ? [] : archives.slice(0, 6);
  for (const file of selectedArchives) {
    signal?.throwIfAborted();
    if (!/^CIK\d{10}-submissions-\d+\.json$/.test(file.name)) continue;
    try {
      const data = await (
        await secFetch(`https://data.sec.gov/submissions/${file.name}`, signal)
      ).json();
      filings.push(...rows(data, identity.cik));
    } catch (error) {
      signal?.throwIfAborted();
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
    historyLimited: archives.length > selectedArchives.length || issues.length > 0,
    historyIssues: issues,
    historyArchivesReviewed: selectedArchives.length,
    historyArchivesAvailable: archives.length,
  };
  signal?.throwIfAborted();
  if (!issues.length) await warmSet("disclosure-history-v1", targetIsRecent ? `${key}:recent` : key, result, 300);
  return result;
}

function validateDisclosureDocument(document) {
  if (!/^[\w][\w.\/-]*\.(?:htm|html|txt)$/i.test(document)
    || document.includes("..") || document.includes("//") || document.length > 240)
    throw new Error("This document format cannot be reviewed as text.");
}

async function filingText(cik, filing, signal, { forceRefresh = false } = {}) {
  signal?.throwIfAborted();
  validateDisclosureDocument(filing.primaryDoc);
  const key = `${cik}:${filing.accession}:${filing.primaryDoc}`;
  if (!forceRefresh && textCache.has(key)) return textCache.get(key);
  const existing = inflight.get(key);
  // Never let cancellation of one reader cancel another reader's transport.
  if (existing && existing.signal === signal && existing.forceRefresh === forceRefresh) return existing.promise;
  const promise = (async () => {
    const prepared = forceRefresh ? null : await readPreparedDisclosureText({ cik, filing, signal });
    signal?.throwIfAborted();
    const cached = prepared || forceRefresh ? null : await warmGet("disclosure-text-v1", key);
    let text = prepared?.text;
    let sourceRetrievedAt = prepared?.sourceRetrievedAt || cached?.sourceRetrievedAt || null;
    if (cached?.gzip) {
      try {
        text = gunzipSync(Buffer.from(cached.gzip, "base64"), { maxOutputLength: 24_000_000 }).toString("utf8");
      } catch {
        /* fetch corrupt cache again */
      }
    }
    signal?.throwIfAborted();
    if (!text) {
      sourceRetrievedAt = new Date().toISOString();
      const response = await secFetch(
        buildFilingUrl(cik, filing.accession, filing.primaryDoc),
        signal,
      );
      const html = await response.text();
      signal?.throwIfAborted();
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
        { gzip: gzipSync(text).toString("base64"), sourceRetrievedAt },
        86400 * 7,
      );
    }
    let total = text.length;
    for (const value of textCache.values()) total += value.text.length;
    while (textCache.size && (total > 20000000 || textCache.size >= 24)) {
      const first = textCache.keys().next().value;
      total -= textCache.get(first).text.length;
      textCache.delete(first);
    }
    const entry = { text, sourceRetrievedAt, indexed: Boolean(prepared) };
    textCache.set(key, entry);
    return entry;
  })();
  const pending = { promise, signal, forceRefresh };
  inflight.set(key, pending);
  try {
    return await promise;
  } finally {
    if (inflight.get(key) === pending) inflight.delete(key);
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

function trustworthySourceTimestamp(entry, filing) {
  const time = Date.parse(entry?.sourceRetrievedAt);
  return typeof entry?.sourceRetrievedAt === "string" && Number.isFinite(time)
    && time >= Date.parse(filing.filingDate) && time <= Date.now() + 60_000;
}

function deferLegacyIndexRefresh(company, filing, entry, deferIndexWrite) {
  // Only spend SEC requests on documents the bounded index can retain.
  const filingTime = Date.parse(filing.filingDate);
  if (!Number.isFinite(filingTime) || filingTime > Date.now()
    || filingTime < Date.now() - DISCLOSURE_INDEX_LIMITS.retentionDays * 86400000) return;
  const key = `${company.cik}:${filing.accession}:${filing.primaryDoc}`;
  const previous = legacyIndexRefreshes.get(key);
  if (previous?.pending || previous?.retryAt > Date.now()
    || [...legacyIndexRefreshes.values()].filter(value => value.pending).length >= 2) return;
  if (legacyIndexRefreshes.size >= 64) {
    const oldestSettled = [...legacyIndexRefreshes].find(([, value]) => !value.pending)?.[0];
    if (oldestSettled) legacyIndexRefreshes.delete(oldestSettled);
  }
  const task = { pending: true, retryAt: Date.now() + 300_000 };
  legacyIndexRefreshes.set(key, task);
  entry.indexPending = true;
  try {
    deferIndexWrite(async () => {
      let refreshed;
      const signal = AbortSignal.timeout(30_000);
      try {
        // Another completed reader or prewarmer may have supplied real source
        // metadata while this response was finishing. Reuse it when possible.
        refreshed = textCache.get(key);
        if (!trustworthySourceTimestamp(refreshed, filing))
          refreshed = await filingText(company.cik, filing, signal, { forceRefresh: true });
        refreshed.indexPending = true;
        if (!refreshed.indexed) {
          const result = await indexDisclosureText({ cik: company.cik, ticker: company.ticker,
            companyName: company.companyName, filing, text: refreshed.text,
            sourceRetrievedAt: refreshed.sourceRetrievedAt, signal });
          refreshed.indexed = Boolean(result?.stored);
        }
      } catch {
        // A background outage must not invalidate the retained reader evidence.
      } finally {
        entry.indexPending = false;
        if (refreshed) refreshed.indexPending = false;
        task.pending = false;
        task.retryAt = Date.now() + 300_000;
      }
    });
  } catch {
    entry.indexPending = false;
    task.pending = false;
  }
}

async function inspectFiling(
  company,
  filing,
  settings,
  compare = true,
  baselineAccession = "",
  signal,
  deferIndexWrite,
) {
  signal?.throwIfAborted();
  const entry = await filingText(company.cik, filing, signal);
  signal?.throwIfAborted();
  if (!entry.indexed && !entry.indexPending && !trustworthySourceTimestamp(entry, filing) && deferIndexWrite)
    deferLegacyIndexRefresh(company, filing, entry, deferIndexWrite);
  if (!entry.indexed && !entry.indexPending && trustworthySourceTimestamp(entry, filing)) {
    const persist = async (writeSignal) => {
      try {
        const indexed = await indexDisclosureText({ cik: company.cik, ticker: company.ticker,
          companyName: company.companyName, filing, text: entry.text,
          sourceRetrievedAt: entry.sourceRetrievedAt, signal: writeSignal });
        entry.indexed = Boolean(indexed?.stored);
      } catch {
        // Optional index preparation must not turn a valid source into a
        // failed review, including malformed or unexpectedly large metadata.
        writeSignal?.throwIfAborted();
      } finally { entry.indexPending = false; }
    };
    if (deferIndexWrite) {
      entry.indexPending = true;
      // The host keeps this bounded cache write alive after the response. It
      // never delays verified passages or starts another SEC download.
      deferIndexWrite(() => persist());
    } else await persist(signal);
    signal?.throwIfAborted();
  }
  const analysis = analyzeDisclosure(
    entry.text,
    filing.form,
    settings.parsed,
    settings,
  );
  const pair = selectDisclosureBaseline(
    filing,
    company.filings,
    compare ? settings.comparison : "none",
    baselineAccession,
  );
  let removed = [];
  let unchanged = 0;
  let comparisonError = "";
  if (compare && pair.prior && analysis.status === "reviewed") {
    try {
      const priorText = await filingText(company.cik, pair.prior, signal);
      const prior = analyzeDisclosure(
        priorText.text,
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
      signal?.throwIfAborted();
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

export async function scanDisclosureCompany(input, settings, after = "", options = {}) {
  const { signal } = options;
  signal?.throwIfAborted();
  const company = await disclosureCompanyHistory(input, settings, { signal });
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
  signal?.throwIfAborted();
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
  // Keep filing order stable while at most two inspections progress. The
  // shared secClient dispatch gate still governs every SEC request start.
  const filings = new Array(selected.length);
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      signal?.throwIfAborted();
      const index = next++;
      const filing = selected[index];
      try {
        const result = await inspectFiling(company, filing, settings, true, "", signal, options.deferIndexWrite);
        filings[index] = { ...result, matches: undefined, previews: result.matches.slice(0, 3).map(compactPassage) };
      } catch (error) {
        signal?.throwIfAborted();
        filings[index] = { ...filing, ticker: company.ticker, cik: company.cik,
          companyName: company.companyName, status: "fetch-failed", matched: false,
          reason: error.message, previews: [], topics: {} };
      }
    }
  };
  const workers = Array.from({ length: Math.min(2, selected.length) }, worker);
  const completed = await Promise.allSettled(workers);
  const failed = completed.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  signal?.throwIfAborted();
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

/** Incrementally prepare recent primary filings without running a pretend query. */
export async function prewarmDisclosureCompany(input, { signal, maxDocuments = 2 } = {}) {
  if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 2)
    throw new Error("Prepare one or two recent filings per company.");
  signal?.throwIfAborted();
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 2 * 365 * 86400000).toISOString().slice(0, 10);
  const settings = { start, end, comparison: "none", forms: ["10-K", "10-Q", "8-K"], depth: maxDocuments, amendments: false };
  const company = await disclosureCompanyHistory(input, settings, { signal, recentOnly: true });
  const selected = disclosureFilingBatch(company.filings, settings).selected;
  const result = { cik: company.cik, selected: selected.length, indexed: 0, skipped: 0, failed: 0 };
  for (const filing of selected) {
    signal?.throwIfAborted();
    try {
      let entry = await filingText(company.cik, filing, signal);
      if (!trustworthySourceTimestamp(entry, filing)) {
        // Legacy text remains usable for readers. Scheduled indexing requires
        // a real source fetch, not a freshly invented timestamp on old text.
        entry = await filingText(company.cik, filing, signal, { forceRefresh: true });
      }
      if (entry.indexed) { result.skipped++; continue; }
      if (!entry.sourceRetrievedAt) { result.skipped++; continue; }
      const write = await indexDisclosureText({ cik: company.cik, ticker: company.ticker,
        companyName: company.companyName, filing, text: entry.text,
        sourceRetrievedAt: entry.sourceRetrievedAt, signal });
      entry.indexed = Boolean(write?.stored);
      if (entry.indexed) result.indexed++; else result.skipped++;
    } catch { signal?.throwIfAborted(); result.failed++; }
  }
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
  options.signal?.throwIfAborted();
  if (document) validateDisclosureDocument(document);
  const company = await disclosureCompanyHistory(input, settings, { signal: options.signal, accession });
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
    options.signal,
    options.deferIndexWrite,
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
