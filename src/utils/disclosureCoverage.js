import { filingEvidenceId } from "./disclosureNotebook.js";

export const DISCLOSURE_SESSION_KEY = "edgar:disclosure-session:v1";
export function disclosureSearchIdentity(s = {}) {
  return JSON.stringify([
    s.query || "",
    s.tickers || "",
    s.mode || "companies",
    s.start || "",
    s.end || "",
    s.forms || "",
    s.section || "all",
    s.scope || "paragraph",
    s.depth || 6,
    Boolean(s.amendments),
    s.comparison || "annual-season",
  ]);
}
export function summarizeDisclosureCoverage(company) {
  const files = [
    ...new Map(
      (company.filings || []).map((f) => [filingEvidenceId(f), f]),
    ).values(),
  ].sort(
    (a, b) =>
      (b.filingDate || "").localeCompare(a.filingDate || "") ||
      filingEvidenceId(a).localeCompare(filingEvidenceId(b)),
  );
  const reviewed = files.filter((f) => f.status === "reviewed");
  const matching = reviewed.filter((f) => f.matched);
  return {
    ...company,
    filings: files,
    selected: files.length,
    reviewed: reviewed.length,
    matched: matching.length,
    fetchFailed: files.filter((f) => f.status === "fetch-failed").length,
    sectionUnavailable: files.filter((f) => f.status === "section-unavailable")
      .length,
    comparisonFailed: files.filter((f) => Boolean(f.comparisonError)).length,
    firstObserved:
      matching
        .map((f) => f.filingDate)
        .filter(Boolean)
        .sort()[0] || null,
  };
}
export function mergeDisclosureBatch(previous, batch) {
  if (previous?.cik && batch.cik && previous.cik !== batch.cik)
    throw new Error("Cannot merge filings from different SEC companies.");
  const ticker = previous?.cik ? previous.ticker : batch.ticker;
  return summarizeDisclosureCoverage({
    ...previous,
    ...batch,
    ticker,
    error: batch.error || "",
    filings: [...(previous?.filings || []), ...(batch.filings || [])].map(
      (f) => ({ ...f, ticker }),
    ),
  });
}
export function upsertDisclosureCompany(companies, batch) {
  const found = companies.findIndex(
    (c) => (batch.cik && c.cik === batch.cik) || c.ticker === batch.ticker,
  );
  if (found < 0) return [...companies, summarizeDisclosureCoverage(batch)];
  return companies.map((c, i) =>
    i === found ? mergeDisclosureBatch(c, batch) : c,
  );
}
export function replaceDisclosureFiling(companies, filing) {
  return companies.map((c) =>
    c.cik === filing.cik
      ? summarizeDisclosureCoverage({
          ...c,
          filings: [
            ...c.filings.filter(
              (f) => filingEvidenceId(f) !== filingEvidenceId(filing),
            ),
            { ...filing, ticker: c.ticker },
          ],
          checkedAt: new Date().toISOString(),
        })
      : c,
  );
}
export function disclosureCoverageRows(inputs, aliases, companies) {
  const requested = [...new Set(inputs.map((t) => aliases[t] || t))];
  return requested.map((ticker) => {
    const company = companies.find((c) => c.ticker === ticker);
    if (!company)
      return {
        ticker,
        company: null,
        state: "not-reviewed",
        reviewed: 0,
        matched: 0,
        fetchFailed: 0,
        sectionUnavailable: 0,
        comparisonFailed: 0,
        selected: 0,
      };
    const summary = summarizeDisclosureCoverage(company);
    return {
      ...summary,
      company,
      state: company.error
        ? "failed"
        : summary.fetchFailed ||
            summary.sectionUnavailable ||
            summary.comparisonFailed ||
            company.limited ||
            company.historyLimited
          ? "partial"
          : "reviewed",
    };
  });
}
const csvCell = (value) => {
  const s = String(value ?? "");
  return (
    '"' + (/^[\s]*[=+@-]/.test(s) ? "'" : "") + s.replace(/"/g, '""') + '"'
  );
};
export function exportDisclosureCoverage(rows, settings) {
  const header = [
    "Company",
    "CIK",
    "State",
    "Eligible in inspected history",
    "Attempted documents",
    "Successfully reviewed",
    "Query matches",
    "Fetch failures",
    "Unavailable sections",
    "Comparison failures",
    "More filings remain",
    "History limited",
    "First observed within this search",
    "Checked at",
    "Issue",
    "Search settings",
  ];
  return (
    "\uFEFF" +
    [
      header,
      ...rows.map((r) => [
        r.ticker,
        r.cik,
        r.state,
        r.eligible ?? "",
        r.selected,
        r.reviewed,
        r.matched,
        r.fetchFailed,
        r.sectionUnavailable,
        r.comparisonFailed,
        Boolean(r.nextCursor || r.limited),
        Boolean(r.historyLimited),
        r.firstObserved,
        r.checkedAt,
        r.error || (r.historyIssues || []).join("; "),
        JSON.stringify(settings),
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n")
  );
}
export function makeDisclosureSession(
  settings,
  companies,
  aliases,
  now = new Date().toISOString(),
) {
  if (settings?.mode !== "companies") return null;
  const snapshot = { version: 1, settings, companies, aliases, savedAt: now };
  const text = JSON.stringify(snapshot);
  if (text.length > 3500000)
    throw new Error(
      "This result set is too large to retain in this browser tab. Export the coverage ledger before leaving.",
    );
  return text;
}
export function readDisclosureSession(raw) {
  if (!raw) return null;
  if (raw.length > 3500000)
    throw new Error("The saved result set exceeds the supported size.");
  const p = JSON.parse(raw);
  if (
    p?.version !== 1 ||
    p.settings?.mode !== "companies" ||
    !Array.isArray(p.companies) ||
    p.companies.length > 40 ||
    typeof p.aliases !== "object" ||
    !p.aliases ||
    Array.isArray(p.aliases) ||
    !Number.isFinite(Date.parse(p.savedAt))
  )
    throw new Error("The saved disclosure session is invalid.");
  const textKeys = [
    "query",
    "tickers",
    "start",
    "end",
    "forms",
    "section",
    "scope",
    "comparison",
  ];
  if (
    textKeys.some(
      (k) => p.settings[k] !== undefined && typeof p.settings[k] !== "string",
    ) ||
    typeof p.settings.query !== "string" ||
    typeof p.settings.tickers !== "string" ||
    Object.entries(p.aliases).some(
      ([key, value]) =>
        key.length > 15 || typeof value !== "string" || value.length > 15,
    )
  )
    throw new Error("Saved disclosure settings are invalid.");
  for (const c of p.companies) {
    if (
      !c ||
      typeof c.ticker !== "string" ||
      !Array.isArray(c.filings) ||
      c.filings.length > 2000
    )
      throw new Error("Saved company coverage is invalid.");
    for (const f of c.filings)
      if (
        !f ||
        typeof f.accession !== "string" ||
        typeof f.cik !== "string" ||
        typeof f.primaryDoc !== "string" ||
        typeof f.filingDate !== "string" ||
        (f.previews !== undefined &&
          (!Array.isArray(f.previews) ||
            f.previews.some(
              (p) => !p || typeof p !== "object" || typeof p.text !== "string",
            )))
      )
        throw new Error("Saved filing coverage is invalid.");
  }
  return p;
}
