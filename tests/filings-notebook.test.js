import test from "node:test";
import assert from "node:assert/strict";
import {
  FILINGS_NOTEBOOK_KEY, emptyFilingsNotebook, readFilingsNotebook,
  writeFilingsNotebook, updateFilingsCompany, exportFilingsCsv, exportFilingsBrief, filingsSourceUrl, filingsPassageLabel,
} from "../src/utils/filingsNotebook.js";

const accession = "0000019617-26-000101";
const filing = { accession, form: "10-Q", filingDate: "2026-08-03", reportDate: "2026-06-30",
  documentUrl: "https://www.sec.gov/Archives/edgar/data/19617/000001961726000101/jpm-20260630.htm",
  indexUrl: "https://www.sec.gov/Archives/edgar/data/19617/000001961726000101/0000019617-26-000101-index.html",
  primaryDoc: "jpm-20260630.htm", archive: "CIK0000019617-submissions-001.json", ticker: "JPM", cik: "19617", isAmendment: false, family: "quarterly" };
const record = { queued: true, reviewedAt: "", notes: "Check loan commitments.", filing };
const evidence = { id: `${accession}:10`, filing, paragraph: { text: "Available commitments were $10 billion at June 30, 2026.", index: 10, section: "MD&A" }, notes: "Verify the scope of commitments.", tags: ["liquidity"] };
const notebook = () => ({ version: 1, companies: { JPM: { records: { [accession]: structuredClone(record) }, evidence: [structuredClone(evidence)], views: [{ id: "bank-events", name: "Bank events", settings: { forms: ["8-K"], start: "2025-01-01", query: "liquidity", reviewed: false }, createdAt: "2026-09-06T00:00:00.000Z" }] } } });
const storageOf = (value = null) => ({ value, writes: 0, getItem(key) { assert.equal(key, FILINGS_NOTEBOOK_KEY); return this.value; }, setItem(key, next) { assert.equal(key, FILINGS_NOTEBOOK_KEY); this.writes++; this.value = next; } });

test("Filings notebook validates source metadata, archived history and evidence provenance", () => {
  assert.deepEqual(readFilingsNotebook(null), emptyFilingsNotebook());
  const parsed = readFilingsNotebook(JSON.stringify(notebook()));
  assert.deepEqual(parsed, notebook());
  assert.equal(parsed.companies.JPM.records[accession].filing.archive, "CIK0000019617-submissions-001.json");
  assert.equal(parsed.companies.JPM.evidence[0].paragraph.index, 10);
  assert.equal(parsed.companies.JPM.views[0].settings.forms[0], "8-K");
});

test("corrupt, unsupported and malformed saved data is preserved and never reset on write", () => {
  const invalid = ["", "not-json", JSON.stringify({ version: 2, companies: {} }), JSON.stringify({ version: 1, companies: [] }), '{"version":1,"companies":{"__proto__":{"records":{},"views":[],"evidence":[]}}}'];
  const bad = notebook(); bad.companies.JPM.records[accession].queued = "true"; invalid.push(JSON.stringify(bad));
  for (const raw of invalid) {
    const storage = storageOf(raw);
    assert.throws(() => writeFilingsNotebook(storage, () => emptyFilingsNotebook()), /Filings notebook/);
    assert.equal(storage.value, raw);
    assert.equal(storage.writes, 0);
  }
});

test("fresh reads preserve other tabs' company records, notes and evidence", () => {
  const storage = storageOf(JSON.stringify(notebook()));
  const first = writeFilingsNotebook(storage, (current) => updateFilingsCompany(current, "JPM", (company) => ({ ...company, records: { ...company.records, [accession]: { ...company.records[accession], notes: "Changed in the first tab" } } })));
  const external = structuredClone(first);
  external.companies.AAPL = { records: {}, evidence: [], views: [] };
  external.companies.JPM.evidence[0].notes = "Changed in another tab";
  storage.value = JSON.stringify(external);
  const result = writeFilingsNotebook(storage, (current) => updateFilingsCompany(current, "JPM", (company) => ({ ...company, records: { ...company.records, [accession]: { ...company.records[accession], queued: false, reviewedAt: "2026-09-06T11:23:01.000Z" } } })));
  assert.ok(result.companies.AAPL);
  assert.equal(result.companies.JPM.records[accession].notes, "Changed in the first tab");
  assert.equal(result.companies.JPM.evidence[0].notes, "Changed in another tab");
  assert.equal(result.companies.JPM.records[accession].reviewedAt, "2026-09-06T11:23:01.000Z");
});

test("quota and storage read errors cannot report a successful notebook write", () => {
  const raw = JSON.stringify(notebook());
  const storage = storageOf(raw);
  storage.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.throws(() => writeFilingsNotebook(storage, (current) => updateFilingsCompany(current, "JPM", (company) => ({ ...company, evidence: [] }))), /QuotaExceededError/);
  assert.equal(storage.value, raw);
  assert.throws(() => writeFilingsNotebook({ getItem() { throw new Error("Storage disabled"); } }, (current) => current), /Storage disabled/);
});

test("invalid mutations and bounded-entry limits fail before replacing storage", () => {
  const mutations = [
    (v) => { v.companies.JPM.records[accession].notes = "x".repeat(8001); },
    (v) => { v.companies.JPM.evidence[0].paragraph.text = "x".repeat(16001); },
    (v) => { v.companies.JPM.evidence[0].tags = Array(17).fill("topic"); },
    (v) => { v.companies.JPM.evidence[0].paragraph.index = -1; },
    (v) => { v.companies.JPM.records[accession].filing.accession = "0000019617-26-000102"; },
    (v) => { v.companies.JPM.records[accession].filing.reportDate = "2026-02-31"; },
    (v) => { v.companies.JPM.evidence.push(structuredClone(evidence)); },
    (v) => { v.companies.JPM.views[0].settings = { nested: { a: { b: { c: { d: { e: true } } } } } }; },
    (v) => { v.companies.JPM.views = Array.from({ length: 31 }, (_, i) => ({ ...v.companies.JPM.views[0], id: String(i) })); },
    (v) => { v.companies.JPM.records[accession].filing.documentUrl = "javascript:alert(1)"; },
    (v) => { v.companies.JPM.evidence[0].paragraph.part = 0; v.companies.JPM.evidence[0].paragraph.parts = 3; },
    (v) => { v.companies.JPM.evidence[0].paragraph.part = 3; v.companies.JPM.evidence[0].paragraph.parts = 2; },
    (v) => { v.companies.JPM.evidence[0].paragraph.change = "modified"; v.companies.JPM.evidence[0].paragraph.version = "original"; },
  ];
  for (const mutate of mutations) {
    const raw = JSON.stringify(notebook()); const storage = storageOf(raw);
    assert.throws(() => writeFilingsNotebook(storage, (current) => { mutate(current); return current; }), /Filings notebook/);
    assert.equal(storage.value, raw); assert.equal(storage.writes, 0);
  }
});

test("brief includes review states, quotations, original SEC sources, dates and observed coverage", () => {
  const saved = notebook().companies.JPM;
  const brief = exportFilingsBrief({ ticker: "JPM", company: { name: "JPMorgan Chase & Co", cik: "19617" }, ...saved, settings: { form: "10-Q", start: "2025-01-01" }, coverage: { loaded: 500, failedArchives: ["history-2"], complete: false } });
  for (const value of ["2026-08-03", "2026-06-30", accession, filing.documentUrl, filing.indexUrl, "$10 billion", "Extracted paragraph 11", "liquidity", "Check loan commitments.", "history-2", "2025-01-01", "Queued"])
    assert.ok(brief.includes(value), `Missing ${value}`);
  assert.ok(brief.includes("JPMorgan Chase &amp; Co"));
});

test("export escaping blocks HTML and spreadsheet formulas, including whitespace-prefixed formulas", () => {
  const saved = notebook().companies.JPM;
  saved.records[accession].notes = "\t=HYPERLINK(\"https://evil.example\")";
  saved.evidence[0].notes = "\n+1+1";
  saved.evidence[0].paragraph.text = '<img src=x onerror="alert(1)">';
  saved.evidence[0].filing.documentUrl = "javascript:alert(1)";
  const options = { ticker: "JPM", company: "<script>alert(1)</script>", filings: [filing], ...saved, settings: { query: "<svg/onload=alert(1)>" }, coverage: { loaded: 1 } };
  const brief = exportFilingsBrief(options);
  assert.ok(!brief.includes("<script>")); assert.ok(!brief.includes("<img")); assert.ok(!brief.includes('href="javascript:'));
  assert.ok(brief.includes("&lt;img")); assert.ok(brief.includes("&lt;svg"));
  const csv = exportFilingsCsv(options);
  assert.ok(csv.includes('"\'\t=HYPERLINK(""https://evil.example"")"'));
  assert.ok(csv.includes('"\'\n+1+1"'));
  assert.ok(!csv.includes("javascript:"));
  assert.ok(csv.includes("Search settings")); assert.ok(csv.includes("Coverage"));
  assert.ok(csv.includes('"Evidence"')); assert.ok(csv.includes(filing.documentUrl));
});

test("SEC source URL allowlist rejects credential, external, executable and misleading hosts", () => {
  assert.equal(filingsSourceUrl(filing.documentUrl), filing.documentUrl);
  for (const url of ["http://www.sec.gov/Archives/edgar/data/1/a.htm", "https://www.sec.gov.evil.example/Archives/edgar/data/1/a.htm", "https://user@www.sec.gov/Archives/edgar/data/1/a.htm", "https://www.sec.gov:444/Archives/edgar/data/1/a.htm", "javascript:alert(1)", "https://www.sec.gov/Archives/edgar/data/../../../../bad"])
    assert.equal(filingsSourceUrl(url), "");
});

test("split paragraph metadata survives storage and appears in notebook and export labels", () => {
  const value = notebook();
  value.companies.JPM.evidence[0].paragraph.part = 2;
  value.companies.JPM.evidence[0].paragraph.parts = 3;
  value.companies.JPM.evidence.push({ ...structuredClone(value.companies.JPM.evidence[0]), id: "another-part", paragraph: { ...value.companies.JPM.evidence[0].paragraph, part: 3, text: "The remaining terms were unchanged." } });
  const saved = readFilingsNotebook(JSON.stringify(value)).companies.JPM;
  assert.equal(saved.evidence[0].paragraph.part, 2);
  assert.equal(saved.evidence[1].paragraph.part, 3);
  assert.equal(filingsPassageLabel(saved.evidence[0].paragraph), "Extracted paragraph 11 · part 2/3");
  const options = { ticker: "JPM", company: "JPMorgan Chase", ...saved };
  assert.ok(exportFilingsBrief(options).includes("Extracted paragraph 11 · part 2/3"));
  const csv = exportFilingsCsv(options);
  assert.ok(csv.includes('"MD&A","Extracted paragraph","10","","2","3","",""'));
});

test("comparison sequence indexes are never labeled as original document paragraph numbers", () => {
  const value = notebook();
  value.companies.JPM.evidence[0].paragraph.change = "modified";
  value.companies.JPM.evidence[0].paragraph.version = "before";
  const saved = readFilingsNotebook(JSON.stringify(value)).companies.JPM;
  assert.equal(saved.evidence[0].paragraph.version, "before");
  assert.equal(filingsPassageLabel(saved.evidence[0].paragraph), "Comparison excerpt · prior version · modified");
  const options = { ticker: "JPM", company: "JPMorgan Chase", ...saved };
  const brief = exportFilingsBrief(options);
  assert.ok(brief.includes("Comparison excerpt · prior version · modified"));
  assert.ok(!brief.includes("Extracted paragraph 11"));
  const csv = exportFilingsCsv(options);
  assert.ok(csv.includes('"MD&A","Comparison excerpt","","10","","","modified","before"'));
  assert.ok(csv.includes('"Original paragraph index (zero-based)"'));
  assert.ok(csv.includes('"Comparison excerpt index (zero-based)"'));
});
