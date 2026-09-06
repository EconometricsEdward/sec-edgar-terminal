export const FILINGS_NOTEBOOK_KEY = "edgar:filings-notebook:v1";
export const emptyFilingsNotebook = () => ({ version: 1, companies: {} });
const LIMIT = 4 * 1024 * 1024;
const tickerPattern = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const fail = (detail) => {
  throw new Error(`Filings notebook ${detail}. Existing saved data has not been replaced.`);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function shape(value, label) {
  if (!object(value) || Object.keys(value).some((key) => forbidden.has(key)))
    fail(`has an invalid ${label}`);
}
function text(value, max, label, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > max)
    fail(`${label} must be text of at most ${max.toLocaleString("en-US")} characters`);
  return value;
}
function date(value, label, timestamp = false) {
  const v = text(value, timestamp ? 40 : 10, label);
  if (!v) return "";
  if (!Number.isFinite(Date.parse(v)) ||
      (!timestamp && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(v).toISOString().slice(0, 10) !== v)) ||
      (timestamp && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) || new Date(v).toISOString().slice(0, 10) !== v.slice(0, 10))))
    fail(`has an invalid ${label}`);
  return v;
}
function bounded(values, max, label) {
  if (!Array.isArray(values) || values.length > max)
    fail(`${label} must contain at most ${max} entries`);
  return values;
}
function identifier(value, label) {
  const v = text(value, 200, label);
  if (!v || /[\u0000-\u001f]/.test(v) || forbidden.has(v)) fail(`has an invalid ${label}`);
  return v;
}
function safeSettings(value, depth = 0) {
  if (depth > 4) fail("saved view settings are too deeply nested");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return text(value, 1000, "saved view setting");
  if (Array.isArray(value)) return bounded(value, 80, "saved view setting").map((v) => safeSettings(v, depth + 1));
  shape(value, "saved view settings");
  if (Object.keys(value).length > 80) fail("saved view settings contain too many fields");
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k, 80, "saved view field"), safeSettings(v, depth + 1)]));
}

/** Only SEC source links are retained as links; other values cannot become exported executable URLs. */
export function filingsSourceUrl(value) {
  if (typeof value !== "string" || value.length > 1200) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.sec.gov" &&
      !url.username && !url.password && !url.port && url.pathname.startsWith("/Archives/edgar/data/")
      ? url.href : "";
  } catch { return ""; }
}
function filingRecord(value) {
  shape(value, "filing");
  const accession = text(value.accession || value.accessionNumber, 20, "accession");
  if (!accessionPattern.test(accession)) fail("has an invalid filing accession");
  const out = { accession, form: text(value.form, 40, "filing form"),
    filingDate: date(value.filingDate, "filing date"), reportDate: date(value.reportDate, "reporting date") };
  for (const key of ["primaryDoc", "primaryDocument", "documentName", "archive", "family", "ticker", "description", "primaryDescription", "primaryDocDescription", "items", "acceptanceDateTime"])
    if (value[key] !== undefined) out[key] = text(value[key], key.includes("Description") || key === "description" ? 1200 : 500, key);
  for (const key of ["url", "documentUrl", "indexUrl"])
    if (value[key] !== undefined) {
      const source = text(value[key], 1200, key);
      if (source && !filingsSourceUrl(source)) fail(`contains a non-SEC ${key}`);
      out[key] = source;
    }
  if (value.cik !== undefined) {
    const cik = String(value.cik);
    if (!/^\d{1,10}$/.test(cik)) fail("has an invalid filing CIK");
    out.cik = cik;
  }
  if (value.isAmendment !== undefined) {
    if (typeof value.isAmendment !== "boolean") fail("has an invalid amendment flag");
    out.isAmendment = value.isAmendment;
  }
  if (value.size !== undefined) {
    if (!Number.isFinite(value.size) || value.size < 0) fail("has an invalid filing size");
    out.size = value.size;
  }
  return out;
}
function validateNotebook(value) {
  shape(value, "format");
  if (value.version !== 1) fail("format is not supported");
  shape(value.companies, "company list");
  if (Object.keys(value.companies).length > 40) fail("can contain at most 40 companies");
  const companies = {};
  for (const [ticker, company] of Object.entries(value.companies)) {
    if (!tickerPattern.test(ticker)) fail("has an invalid company ticker");
    shape(company, "company");
    shape(company.records, "filing records");
    if (Object.keys(company.records).length > 500) fail("can contain at most 500 filing records per company");
    const records = {};
    for (const [accession, record] of Object.entries(company.records)) {
      if (!accessionPattern.test(accession)) fail("has an invalid record accession");
      shape(record, "record");
      if (record.queued !== undefined && typeof record.queued !== "boolean") fail("has an invalid review queue flag");
      const filing = filingRecord(record.filing);
      if (filing.accession !== accession) fail("record does not match its filing accession");
      records[accession] = { queued: record.queued === true, reviewedAt: date(record.reviewedAt, "review timestamp", true),
        notes: text(record.notes, 8000, "filing notes"), filing };
    }
    const ids = new Set();
    const evidence = bounded(company.evidence, 100, "evidence collection").map((entry) => {
      shape(entry, "evidence entry");
      const id = identifier(entry.id, "evidence ID");
      if (ids.has(id)) fail("contains duplicate evidence IDs");
      ids.add(id);
      shape(entry.paragraph, "evidence paragraph");
      const index = entry.paragraph.index;
      if (!Number.isInteger(index) || index < 0 || index > 1000000) fail("has an invalid paragraph index");
      const paragraph = { index,
        text: text(entry.paragraph.text, 16000, "evidence passage"),
        section: text(entry.paragraph.section, 300, "evidence section") };
      const { part, parts, change, version } = entry.paragraph;
      if (part !== undefined || parts !== undefined) {
        if (!Number.isInteger(part) || !Number.isInteger(parts) || part < 1 || part > parts || parts > 1000000)
          fail("has invalid paragraph part metadata");
        paragraph.part = part;
        paragraph.parts = parts;
      }
      if (change !== undefined || version !== undefined) {
        if (!["added", "modified", "removed"].includes(change) || !["before", "after"].includes(version))
          fail("has invalid comparison excerpt metadata");
        paragraph.change = change;
        paragraph.version = version;
      }
      return { id, filing: filingRecord(entry.filing), paragraph,
      notes: text(entry.notes, 8000, "evidence notes"),
      tags: bounded(entry.tags ?? [], 16, "evidence tags").map((tag) => text(tag, 64, "evidence tag")) };
    });
    const viewIds = new Set();
    const views = bounded(company.views, 30, "saved views").map((entry) => {
      shape(entry, "saved view");
      const id = identifier(entry.id, "saved view ID");
      if (viewIds.has(id)) fail("contains duplicate saved view IDs");
      viewIds.add(id);
      shape(entry.settings, "saved view settings");
      return { id, name: text(entry.name, 100, "saved view name"), settings: safeSettings(entry.settings),
        createdAt: date(entry.createdAt, "view creation timestamp", true) };
    });
    companies[ticker] = { records, evidence, views };
  }
  return { version: 1, companies };
}
export function readFilingsNotebook(raw) {
  if (raw === null || raw === undefined) return emptyFilingsNotebook();
  if (typeof raw !== "string" || raw.length > LIMIT || new TextEncoder().encode(raw).length > LIMIT) fail("exceeds its 4 MiB storage limit");
  let value;
  try { value = JSON.parse(raw); } catch { fail("could not be read"); }
  return validateNotebook(value);
}
/** Reads fresh storage before every mutation to preserve other tabs' latest changes. Errors never trigger a reset. */
export function writeFilingsNotebook(storage, update) {
  const current = readFilingsNotebook(storage.getItem(FILINGS_NOTEBOOK_KEY));
  const next = validateNotebook(update(current));
  const raw = JSON.stringify(next);
  if (raw.length > LIMIT || new TextEncoder().encode(raw).length > LIMIT) fail("exceeds its 4 MiB storage limit");
  storage.setItem(FILINGS_NOTEBOOK_KEY, raw);
  return next;
}
export function updateFilingsCompany(notebook, ticker, update) {
  if (!tickerPattern.test(ticker)) fail("has an invalid company ticker");
  const company = notebook.companies[ticker] || { records: {}, evidence: [], views: [] };
  return { ...notebook, companies: { ...notebook.companies, [ticker]: update(company) } };
}
const csvCell = (value) => {
  const v = String(value ?? "");
  return `"${(/^[\s\u0000-\u001f]*[=+@-]/.test(v) ? "'" : "") + v.replaceAll('"', '""')}"`;
};
const html = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const companyName = (company) => typeof company === "string" ? company : company?.name || company?.companyName || "";
const sourceUrl = (filing) => filingsSourceUrl(filing.documentUrl || filing.url || "");
const filingAccession = (filing) => filing.accession || filing.accessionNumber || "";
const status = (record) => [record?.queued ? "Queued" : "", record?.reviewedAt ? "Reviewed" : ""].filter(Boolean).join("; ") || "Unreviewed";
export function filingsPassageLabel(paragraph) {
  return paragraph.version || paragraph.change
    ? `Comparison excerpt · ${paragraph.version === "before" ? "prior" : "current"} version · ${paragraph.change || "changed"}`
    : `Extracted paragraph ${paragraph.index + 1}${paragraph.parts > 1 ? ` · part ${paragraph.part}/${paragraph.parts}` : ""}`;
}
/** One filing or quotation per row; every row carries dates, accession, settings and observed coverage.
 * @param {any} options
 */
export function exportFilingsCsv({ ticker, company, filings = [], records = {}, evidence = [], settings = {}, coverage = {} }) {
  const header = ["Row type", "Ticker", "Company", "CIK", "Form", "Filed", "Reporting period", "Accession", "Review status", "Reviewed at", "Section", "Excerpt kind", "Original paragraph index (zero-based)", "Comparison excerpt index (zero-based)", "Part", "Parts", "Change", "Version", "Quotation", "Notes", "Tags", "SEC document", "SEC filing index", "Search settings", "Coverage"];
  const metadata = (kind, filing, record, paragraph, notes, tags) => [kind, ticker, companyName(company), filing.cik || company?.cik || "", filing.form,
    filing.filingDate, filing.reportDate, filingAccession(filing), status(record), record?.reviewedAt,
    paragraph?.section, paragraph ? paragraph.version || paragraph.change ? "Comparison excerpt" : "Extracted paragraph" : "",
    paragraph?.version || paragraph?.change ? "" : paragraph?.index,
    paragraph?.version || paragraph?.change ? paragraph?.index : "", paragraph?.part, paragraph?.parts, paragraph?.change, paragraph?.version,
    paragraph?.text, notes, tags?.join("; "), sourceUrl(filing), filingsSourceUrl(filing.indexUrl), JSON.stringify(settings), JSON.stringify(coverage)];
  const rows = [...filings.map((filing) => { const record = records[filingAccession(filing)]; return metadata("Filing", filing, record, null, record?.notes || "", []); }),
    ...evidence.map((entry) => metadata("Evidence", entry.filing, records[filingAccession(entry.filing)], entry.paragraph, entry.notes, entry.tags))];
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
/** @param {any} options */
export function exportFilingsBrief({ ticker, company, records = {}, evidence = [], settings = {}, coverage = {} }) {
  const source = (filing) => `<p>Form ${html(filing.form)} · filed ${html(filing.filingDate || "Unavailable")} · reporting period ${html(filing.reportDate || "Unavailable")}<br>Accession ${html(filingAccession(filing))}${sourceUrl(filing) ? ` · <a href="${html(sourceUrl(filing))}">Original SEC document</a>` : " · Document source unavailable"}${filingsSourceUrl(filing.indexUrl) ? ` · <a href="${html(filingsSourceUrl(filing.indexUrl))}">Filing index and exhibits</a>` : ""}</p>`;
  const filingRows = Object.values(records).sort((a, b) => (b.filing.filingDate || "").localeCompare(a.filing.filingDate || "")).map((record) => `<section><h3>${html(record.filing.form)} — ${html(record.filing.filingDate)}</h3>${source(record.filing)}<p>${html(status(record))}${record.reviewedAt ? ` · reviewed ${html(record.reviewedAt)}` : ""}</p><pre>${html(record.notes || "No analyst notes saved.")}</pre></section>`).join("");
  const passages = evidence.map((entry) => `<section><h3>${html(entry.paragraph.section || "Filing passage")}</h3>${source(entry.filing)}<p>${html(filingsPassageLabel(entry.paragraph))}</p><blockquote>${html(entry.paragraph.text)}</blockquote><pre>${html(entry.notes || "No analyst notes saved.")}</pre><p>Tags: ${html(entry.tags?.join(", ") || "None")}</p></section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${html(ticker)} filing research brief</title><style>body{font:16px/1.6 system-ui;max-width:950px;margin:32px auto;padding:24px;color:#17283a}h1,h2,h3{line-height:1.25}section{border-top:1px solid #cad4df;padding:16px 0}pre,blockquote{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}blockquote{margin:16px 0;padding:12px 18px;border-left:4px solid #bd8614;background:#f6f7f8}a{color:#075eac}small{color:#526278}@media print{section{break-inside:avoid}}</style></head><body><h1>${html(companyName(company) || ticker)} (${html(ticker)})</h1><p>Filing research brief · exported ${html(new Date().toISOString())}</p><p>Filings are SEC source records. Notes and review states reflect the researcher's own work. Historical coverage and extraction limits are recorded below.</p><h2>Saved filing reviews</h2>${filingRows || "<p>No filing reviews saved.</p>"}<h2>Collected source passages</h2>${passages || "<p>No evidence passages saved.</p>"}<h2>Search settings at export</h2><pre>${html(JSON.stringify(settings, null, 2))}</pre><h2>Observed filing coverage</h2><pre>${html(JSON.stringify(coverage, null, 2))}</pre><p><small>Missing reporting dates remain unavailable. A review mark records a user action; it does not certify filing completeness. Notes and collections remain in this browser until exported.</small></p></body></html>`;
}
