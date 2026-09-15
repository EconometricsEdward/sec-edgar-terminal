import { filingEvidenceId } from "./disclosureNotebook.js";

export const DISCLOSURE_RESULT_SCOPES = [
  ["evidence", "Matches & candidates"],
  ["verified", "Successfully searched"],
  ["indexed", "Prepared passage matches"],
  ["candidates", "Unverified candidates"],
  ["gaps", "Coverage gaps"],
  ["all", "Every selected document"],
];
export const DISCLOSURE_CHANGE_FILTERS = [
  ["all", "Any change status"],
  ["added", "Added language"],
  ["revised", "Revised language"],
  ["removed", "Removed language"],
  ["query-removed", "No longer matches query"],
  ["unchanged", "Repeated language"],
];
export const DISCLOSURE_LANGUAGE_FILTERS = [
  "Reported-event wording",
  "Hypothetical wording",
  "Mixed language",
  "Unclassified wording",
];
export const defaultDisclosureResultFilters = () => ({
  scope: "evidence",
  company: "all",
  form: "all",
  change: "all",
  language: "all",
  review: "all",
  text: "",
  sort: "relevance",
});
const count = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);
export const disclosureResultPreviews = (filing) =>
  (filing.previews || filing.matches || []).slice(0, 3);
export const disclosurePreviewText = (passage) =>
  (passage.change === "removed"
    ? passage.priorText || passage.text
    : passage.text) || "";
export function hasDisclosureChanges(filing) {
  return (
    count(filing.additions) +
      count(filing.revisions) +
      count(filing.removedCount) +
      count(filing.queryRemovedCount) >
    0
  );
}
export function disclosureCoverageGap(filing) {
  return (
    !["reviewed", "index-candidate", "indexed-match"].includes(filing.status) ||
    Boolean(filing.comparisonError)
  );
}
// A legacy change token, not a cryptographic identity. New responses provide a
// server digest of complete evidence, so changes outside previews also reopen review.
function legacyRevision(filing) {
  const raw = JSON.stringify([
    filing.status,
    filing.matchCount,
    filing.additions,
    filing.revisions,
    filing.removedCount,
    filing.queryRemovedCount,
    filing.unchanged,
    filing.pair?.prior?.accession,
    filing.comparisonError,
    disclosureResultPreviews(filing),
  ]);
  let a = 2166136261;
  let b = 3339675911;
  for (let i = 0; i < raw.length; i++) {
    a = Math.imul(a ^ raw.charCodeAt(i), 16777619);
    b = Math.imul(b ^ raw.charCodeAt(i), 2246822519);
  }
  return `preview-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}
export function disclosureReviewId(filing, settings) {
  return `review-v1:${JSON.stringify([
    filingEvidenceId(filing),
    String(settings.query || "").trim(),
    settings.section || "all",
    settings.scope || "paragraph",
    settings.comparison || "annual-season",
    filing.evidenceRevision || legacyRevision(filing),
  ])}`;
}
function scoped(filing, scope) {
  if (scope === "all") return true;
  if (scope === "verified") return filing.status === "reviewed";
  if (scope === "indexed") return filing.status === "indexed-match";
  if (scope === "candidates") return filing.status === "index-candidate";
  if (scope === "gaps") return disclosureCoverageGap(filing);
  return (
    filing.status === "index-candidate" ||
    (["reviewed", "indexed-match"].includes(filing.status) &&
      (filing.matched || hasDisclosureChanges(filing)))
  );
}
function hasChange(filing, value) {
  const key = {
    added: "additions",
    revised: "revisions",
    removed: "removedCount",
    "query-removed": "queryRemovedCount",
    unchanged: "unchanged",
  }[value];
  return value === "all" || (key && count(filing[key]) > 0);
}
function languageCount(filing, language) {
  return filing.signals?.languages
    ? count(filing.signals.languages[language])
    : disclosureResultPreviews(filing).filter((p) => p.label === language)
        .length;
}
function companyCik(value) {
  const raw = String(value ?? "").trim().replace(/^CIK\s*/i, "");
  return /^\d{1,10}$/.test(raw) && Number(raw) > 0
    ? raw.padStart(10, "0")
    : "";
}
function companyKey(filing) {
  const cik = companyCik(filing.cik) || companyCik(filing.ticker);
  if (cik) return `cik:${cik}`;
  const ticker = String(filing.ticker || "").trim().toUpperCase();
  if (ticker) return `ticker:${ticker}`;
  const name = String(filing.companyName || "").trim();
  return name ? `name:${name.toUpperCase()}` : `filing:${filingEvidenceId(filing)}`;
}
function companyFacets(filings) {
  const groups = new Map();
  for (const filing of filings) {
    const value = companyKey(filing);
    if (!groups.has(value)) groups.set(value, { tickers: new Set(), names: new Set() });
    const group = groups.get(value);
    const ticker = String(filing.ticker || "").trim().toUpperCase();
    if (/^[A-Z][A-Z0-9.-]{0,19}$/.test(ticker) && !companyCik(ticker)) group.tickers.add(ticker);
    const name = String(filing.companyName || "").trim();
    if (name) group.names.add(name);
  }
  return [...groups].map(([value, group]) => [
    value,
    [...group.tickers].sort()[0] || [...group.names].sort()[0] ||
      (value.startsWith("cik:") ? `CIK ${value.slice(4)}` : "Unidentified issuer"),
  ]).sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
}
function selected(filing, filters, settings, reviewed, changesOnly) {
  if (!scoped(filing, filters.scope)) return false;
  if (
    changesOnly &&
    !["gaps", "all"].includes(filters.scope) &&
    filing.status !== "index-candidate" &&
    !hasDisclosureChanges(filing)
  )
    return false;
  if (filters.company !== "all" && companyKey(filing) !== filters.company)
    return false;
  if (filters.form !== "all" && filing.form !== filters.form) return false;
  if (!hasChange(filing, filters.change)) return false;
  if (
    filters.language !== "all" &&
    languageCount(filing, filters.language) === 0
  )
    return false;
  const isReviewed =
    filing.status === "reviewed" &&
    Boolean(reviewed[disclosureReviewId(filing, settings)]);
  if (filters.review === "reviewed" && !isReviewed) return false;
  if (filters.review === "unreviewed" && isReviewed) return false;
  const text = filters.text.trim().toLocaleLowerCase();
  if (
    text &&
    !disclosureResultPreviews(filing).some((p) =>
      disclosurePreviewText(p).toLocaleLowerCase().includes(text),
    )
  )
    return false;
  return true;
}
function relevance(filing) {
  return Number.isFinite(filing.signals?.maxRelevance)
    ? filing.signals.maxRelevance
    : Math.max(
        0,
        ...disclosureResultPreviews(filing).map((p) => count(p.relevance)),
      );
}
function searchRank(filing) {
  // Reciprocal rank fusion joins two independent retrieval scales using only
  // their ordinal positions. A match found in both sources receives both votes.
  return [filing.indexRank, filing.preparedRank].reduce(
    (score, rank) => score + (Number.isFinite(rank) && rank >= 0 ? 1 / (60 + rank) : 0),
    0,
  );
}
function discoveryOrder(a, b) {
  const ar = searchRank(a);
  const br = searchRank(b);
  // Search ranks are ordinal positions, not scores. Retaining them while a
  // candidate is verified avoids comparing unrelated passage and SEC scores.
  if (ar || br) return br - ar;
  const candidateA = a.status === "index-candidate";
  const candidateB = b.status === "index-candidate";
  if (candidateA && candidateB) {
    const aScore = Number.isFinite(a.indexScore) ? a.indexScore : -Infinity;
    const bScore = Number.isFinite(b.indexScore) ? b.indexScore : -Infinity;
    return bScore - aScore;
  }
  if (candidateA !== candidateB) return candidateA ? 1 : -1;
  return relevance(b) - relevance(a);
}
export function sortDisclosureResults(filings, sort = "relevance") {
  return [...filings].sort((a, b) => {
    let difference = 0;
    if (sort === "date")
      difference = String(b.filingDate || "").localeCompare(a.filingDate || "");
    else if (sort === "added")
      difference =
        count(b.additions) - count(a.additions) ||
        count(b.revisions) - count(a.revisions);
    else if (sort === "proximity")
      difference =
        (a.signals?.closestTerms ?? Infinity) -
        (b.signals?.closestTerms ?? Infinity);
    else if (sort === "specificity")
      difference = count(b.signals?.concrete) - count(a.signals?.concrete);
    else if (sort === "section")
      difference = count(b.signals?.recognized) - count(a.signals?.recognized);
    else difference = discoveryOrder(a, b);
    return (
      difference ||
      String(b.filingDate || "").localeCompare(a.filingDate || "") ||
      filingEvidenceId(a).localeCompare(filingEvidenceId(b))
    );
  });
}
export function buildDisclosureResults(
  filings,
  suppliedFilters,
  settings,
  reviewed = {},
  changesOnly = false,
) {
  const filters = { ...defaultDisclosureResultFilters(), ...suppliedFilters };
  const matches = (f, overrides = {}) =>
    selected(f, { ...filters, ...overrides }, settings, reviewed, changesOnly);
  const facet = (key, values) =>
    values.map(([value, label]) => ({
      value,
      label,
      count: filings.filter((f) => matches(f, { [key]: value })).length,
    }));
  const companies = companyFacets(filings);
  const forms = [...new Set(filings.map((f) => f.form))]
    .sort()
    .map((value) => [value, value]);
  const results = sortDisclosureResults(
    filings.filter((f) => matches(f)),
    filters.sort,
  );
  return {
    results,
    facets: {
      scope: facet("scope", DISCLOSURE_RESULT_SCOPES),
      company: facet("company", [["all", "All companies"], ...companies]),
      form: facet("form", [["all", "All forms"], ...forms]),
      change: facet("change", DISCLOSURE_CHANGE_FILTERS),
      language: facet("language", [
        ["all", "All wording"],
        ...DISCLOSURE_LANGUAGE_FILTERS.map((v) => [v, v]),
      ]),
      review: facet("review", [
        ["all", "All review states"],
        ["unreviewed", "Awaiting my review"],
        ["reviewed", "Reviewed by me"],
      ]),
    },
    summary: {
      verified: results.filter((f) => f.status === "reviewed").length,
      indexed: results.filter((f) => f.status === "indexed-match").length,
      candidates: results.filter((f) => f.status === "index-candidate").length,
      gaps: results.filter(disclosureCoverageGap).length,
      personallyReviewed: results.filter(
        (f) =>
          f.status === "reviewed" && reviewed[disclosureReviewId(f, settings)],
      ).length,
    },
  };
}
const safeCell = (value) => {
  const text = String(value ?? "");
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : "") + text.replace(/"/g, '""')}"`;
};
export function exportDisclosureResultsCsv(
  filings,
  settings,
  reviewed = {},
  filters = {},
) {
  const columns = [
    "ticker",
    "company",
    "cik",
    "accession",
    "primary_document",
    "form",
    "filing_date",
    "reporting_period",
    "sec_url",
    "search_status",
    "search_result_rank",
    "prepared_passage_rank",
    "sec_index_score",
    "passage_indexed_at",
    "current_query_matched",
    "matching_passages",
    "added_passages",
    "revised_passages",
    "removed_passages",
    "prior_passages_no_longer_matching_query",
    "repeated_passages",
    "coverage_reason",
    "comparison_error",
    "baseline_accession",
    "baseline_kind",
    "baseline_reason",
    "my_reviewed_at",
    "evidence_revision",
    "observed_at",
    "loaded_preview_count",
    "loaded_preview_text",
    "search_settings",
    "result_filters",
    "export_scope",
  ];
  const rows = filings.map((f) => [
    f.ticker,
    f.companyName,
    f.cik,
    f.accession,
    f.primaryDoc,
    f.form,
    f.filingDate,
    f.reportDate,
    f.documentUrl,
    f.status,
    f.indexRank ?? "",
    f.preparedRank ?? "",
    f.indexScore ?? "",
    f.indexedAt ?? "",
    ["reviewed", "indexed-match"].includes(f.status) ? Boolean(f.matched) : "unknown",
    f.status === "reviewed" ? (f.matchCount ?? 0) : "",
    f.additions ?? "",
    f.revisions ?? "",
    f.removedCount ?? "",
    f.queryRemovedCount ?? "",
    f.unchanged ?? "",
    f.reason,
    f.comparisonError,
    f.pair?.prior?.accession,
    f.pair?.kind,
    f.pair?.reason,
    reviewed[disclosureReviewId(f, settings)] || "",
    f.evidenceRevision || "legacy preview fingerprint",
    f.observedAt,
    disclosureResultPreviews(f).length,
    disclosureResultPreviews(f).map(disclosurePreviewText).join("\n\n"),
    JSON.stringify(settings),
    JSON.stringify(filters),
    "Filtered filing manifest; previews only; passage counts apply to extracted query/section scope, not the entire SEC archive",
  ]);
  return (
    "\uFEFF" +
    [columns, ...rows].map((row) => row.map(safeCell).join(",")).join("\r\n")
  );
}
