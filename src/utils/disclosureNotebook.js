export const DISCLOSURE_NOTEBOOK_KEY = "edgar:disclosure-notebook:v1";
export const emptyDisclosureNotebook = () => ({
  version: 1,
  searches: [],
  collections: [{ id: "default", name: "My evidence", items: [] }],
  labels: {},
});
export function readDisclosureNotebook(raw) {
  if (!raw) return emptyDisclosureNotebook();
  const value = JSON.parse(raw);
  if (
    value?.version !== 1 ||
    !Array.isArray(value.searches) ||
    !Array.isArray(value.collections) ||
    value.collections.some((c) => !c.id || !Array.isArray(c.items)) ||
    value.searches.some((s) => !s.id || !s.settings || !Array.isArray(s.seen))
  )
    throw new Error(
      "Saved Disclosures data could not be read. Export your browser storage before replacing it.",
    );
  return { ...value, labels: value.labels || {} };
}
export function writeDisclosureNotebook(storage, update) {
  const current = readDisclosureNotebook(
    storage.getItem(DISCLOSURE_NOTEBOOK_KEY),
  );
  const next = update(current);
  storage.setItem(DISCLOSURE_NOTEBOOK_KEY, JSON.stringify(next));
  return next;
}
export const filingEvidenceId = (filing) =>
  `${filing.cik}:${filing.accession}:${filing.primaryDoc || filing.documentName || ""}`;
export const passageEvidenceId = (filing, passage) =>
  `${filingEvidenceId(filing)}:${passage.change === "removed" ? "prior" : "current"}:${passage.index}`;

export function updateDisclosureMonitor(
  saved,
  companies,
  now = new Date().toISOString(),
) {
  const reviewed = companies.flatMap((c) =>
    (c.filings || []).filter((f) => f.status === "reviewed"),
  );
  const seen = new Set(saved.seen || []);
  const existing = new Set((saved.inbox || []).map((f) => f.id));
  const fresh = reviewed
    .filter(
      (f) =>
        f.matched &&
        !seen.has(filingEvidenceId(f)) &&
        !existing.has(filingEvidenceId(f)),
    )
    .map((f) => ({
      id: filingEvidenceId(f),
      ticker: f.ticker,
      cik: f.cik,
      accession: f.accession,
      primaryDoc: f.primaryDoc,
      form: f.form,
      filingDate: f.filingDate,
      reportDate: f.reportDate,
      documentUrl: f.documentUrl,
      discoveredAt: now,
      reviewed: false,
      reason:
        f.filingDate < (saved.lastChecked || saved.createdAt).slice(0, 10)
          ? "Newly discovered historical match"
          : "New filing match",
    }));
  return {
    ...saved,
    lastChecked: now,
    seen: [...new Set([...seen, ...reviewed.map(filingEvidenceId)])],
    inbox: [...fresh, ...(saved.inbox || [])],
    lastCoverage: companies.map((c) => ({
      ticker: c.ticker,
      reviewed: c.reviewed || 0,
      failed: c.fetchFailed || 0,
      sectionUnavailable: c.sectionUnavailable || 0,
      limited: c.limited || c.historyLimited || false,
      error: c.error || "",
    })),
  };
}

export function collectDisclosureEvidence(filing, passage, settings) {
  const removed = passage.change === "removed";
  const source = removed && filing.pair?.prior ? filing.pair.prior : filing;
  return {
    id: passageEvidenceId(filing, passage),
    ticker: filing.ticker,
    companyName: filing.companyName,
    cik: filing.cik,
    accession: source.accession,
    form: source.form,
    filingDate: source.filingDate,
    reportDate: source.reportDate,
    documentUrl: source.documentUrl,
    section: passage.section,
    quote: removed ? passage.priorText : passage.text,
    priorQuote: passage.priorText || "",
    comparisonAccession: filing.pair?.prior?.accession || "",
    change: passage.change,
    languageLabel: passage.label,
    labelReviewed: false,
    settings: { ...settings },
    observedAt: filing.observedAt || new Date().toISOString(),
    notes: "",
    tags: "",
  };
}

const safeCell = (value) => {
  const s = String(value ?? "");
  return `"${(/^[\s]*[=+@-]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"`;
};
export function exportDisclosureCsv(collection) {
  const columns = [
    "collection",
    "ticker",
    "company",
    "cik",
    "form",
    "filing_date",
    "reporting_period",
    "section",
    "accession",
    "source_url",
    "quotation",
    "prior_quotation",
    "comparison_accession",
    "change",
    "language_label",
    "label_reviewed",
    "notes",
    "tags",
    "observed_at",
    "search_settings",
  ];
  return (
    "\uFEFF" +
    [
      columns,
      ...collection.items.map((e) => [
        collection.name,
        e.ticker,
        e.companyName,
        e.cik,
        e.form,
        e.filingDate,
        e.reportDate,
        e.section,
        e.accession,
        e.documentUrl,
        e.quote,
        e.priorQuote,
        e.comparisonAccession,
        e.change,
        e.languageLabel,
        e.labelReviewed,
        e.notes,
        e.tags,
        e.observedAt,
        JSON.stringify(e.settings),
      ]),
    ]
      .map((row) => row.map(safeCell).join(","))
      .join("\r\n")
  );
}
const escapeHtml = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function exportDisclosureBrief(collection) {
  const e = escapeHtml;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(collection.name)}</title><style>body{font:16px/1.65 system-ui,sans-serif;color:#17212e;max-width:900px;margin:48px auto;padding:0 24px}h1{font-size:32px}h2{font-size:22px;margin-top:36px}blockquote{margin:20px 0;padding:16px 24px;border-left:4px solid #a67615;background:#faf8f0;white-space:pre-wrap}small,dt{color:#526074}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:12px}a{color:#085d84;overflow-wrap:anywhere}article{break-inside:avoid;border-top:1px solid #ccd4dc;margin-top:32px}p{white-space:pre-wrap}@media print{body{margin:0;max-width:none}}</style><h1>${e(collection.name)}</h1><p>EDGAR Terminal · Disclosure research brief</p><small>Exported ${e(new Date().toISOString())}. Quotations are filing text; notes and reviewed labels are analyst annotations. Automated language and change labels require source review. Search prevalence is not a risk score.</small>${collection.items.map((item, i) => `<article><h2>${i + 1}. ${e(item.ticker)} — ${e(item.section)}</h2><p>${e(item.companyName)} · ${e(item.form)} · Filed ${e(item.filingDate)} · Reporting period ${e(item.reportDate || "not provided")}<br>Accession ${e(item.accession)} · CIK ${e(item.cik)}</p><blockquote>${e(item.quote)}</blockquote>${item.priorQuote && item.priorQuote !== item.quote ? `<h3>Prior wording</h3><blockquote>${e(item.priorQuote)}</blockquote>` : ""}<p>Change: ${e(item.change)} · Language: ${e(item.languageLabel)} (${item.labelReviewed ? "analyst reviewed" : "automated, unreviewed"})<br>Comparison accession: ${e(item.comparisonAccession || "none")}<br>Observed: ${e(item.observedAt)}</p><p>Notes: ${e(item.notes || "None")}<br>Tags: ${e(item.tags || "None")}</p><a href="${/^https:\/\/www\.sec\.gov\//.test(item.documentUrl) ? e(item.documentUrl) : "#"}">Original SEC source</a><h3>Search settings</h3><pre>${e(JSON.stringify(item.settings, null, 2))}</pre></article>`).join("")}</html>`;
}
