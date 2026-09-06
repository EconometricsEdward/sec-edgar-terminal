import test from "node:test";
import assert from "node:assert/strict";
import {
  filingReaderSettings,
  validateReaderDocument,
  extractFilingReaderText,
  readBoundedFilingResponse,
  fetchReaderDocument,
  paginateReaderText,
  validateReaderPair,
  compareReaderDocuments,
  readFilingsDocument,
} from "../src/utils/filingsReader.js";

const accession = "0000019617-25-000001";
const settings = (values = {}) => new URLSearchParams({ ticker: "JPM", accession, ...values });
const report = (values = {}) => ({
  accession,
  form: "10-K",
  reportDate: "2024-12-31",
  filingDate: "2025-02-14",
  primaryDoc: "report.htm",
  ...values,
});
const previous = (values = {}) => report({
  accession: "0000019617-24-000001",
  reportDate: "2023-12-31",
  filingDate: "2024-02-16",
  ...values,
});
const shared = "Management continually evaluates operational conditions and maintains procedures designed to support reliable service, employee training, and careful oversight of business activities throughout the reporting period.";
const credit = "Our revolving credit facility contains a covenant requiring minimum liquidity of $200 million. We maintained compliance with the agreement during the reporting period and review available liquidity every month.";
const obsolete = "Manufacturing facilities depend on imported components and specialized materials supplied by a limited number of vendors. Unexpected transportation interruptions could delay deliveries to customers and disrupt production schedules.";
const added = "Cybersecurity monitoring identified unauthorized access to a vendor system in November 2024. External specialists investigated the incident and management implemented additional access controls during the reporting period.";
const riskDocument = (paragraphs) => `Item 1A. Risk Factors\n\n${paragraphs.join("\n\n")}\n\nItem 1B. Unresolved Staff Comments\n\nNone.`;

test("Reader settings normalize exact tickers and retain archive, literal query and pagination", () => {
  assert.deepEqual(filingReaderSettings(settings({
    ticker: " jpm ",
    archive: "CIK0000019617-submissions-001.json",
    prior: "0000019617-24-000001",
    priorArchive: "CIK0000019617-submissions-002.json",
    filed: "2025-02-14",
    priorFiled: "2024-02-16",
    query: "  covenant (waiver)  ",
    section: "8k:2.04",
    view: "changes",
    page: "3",
  })), {
    ticker: "JPM", accession,
    archive: "CIK0000019617-submissions-001.json",
    prior: "0000019617-24-000001",
    priorArchive: "CIK0000019617-submissions-002.json",
    filed: "2025-02-14", priorFiled: "2024-02-16",
    query: "covenant (waiver)", section: "8k:2.04", view: "changes", page: 3,
  });
  assert.equal(filingReaderSettings(settings()).filed, "");
  assert.equal(filingReaderSettings(settings()).priorFiled, "");
});

test("Reader settings reject malformed identities, traversal archives and unsupported filters", () => {
  for (const invalid of [
    { ticker: "JPM/../AAPL" }, { ticker: "https://sec.gov" }, { ticker: "" },
    { accession: "000001961725000001" }, { accession: `${accession}/../` },
    { prior: "invalid" }, { archive: "../CIK0000019617-submissions-001.json" },
    { priorArchive: "https://evil.example/CIK0000019617-submissions-001.json" },
    { archive: "CIK19617-submissions-001.json" },
    { section: "8k:2.04/../../" }, { section: "everything" },
    { query: "a".repeat(201) }, { view: "remote" },
    { filed: "2025-02-29" }, { filed: "2024-04-31" }, { filed: "2025-2-01" },
    { filed: "2025-13-01" }, { filed: "2025-01-00" }, { filed: "2025-01-01T00:00:00Z" },
    { priorFiled: "2023-02-29" }, { priorFiled: "../2024-01-01" },
    { page: "0" }, { page: "-1" }, { page: "1.5" }, { page: "100001" }, { page: "Infinity" },
  ]) assert.throws(() => filingReaderSettings(settings(invalid)), { status: 400 }, JSON.stringify(invalid));
  const sanitized = filingReaderSettings(settings({ url: "https://evil.example", primaryDoc: "../../private" }));
  assert.equal("url" in sanitized, false);
  assert.equal("primaryDoc" in sanitized, false);
});

test("Primary document URLs remain inside the resolved company's SEC accession directory", () => {
  assert.equal(validateReaderDocument("0000019617", report({ primaryDoc: "xslF345X05/ownership.xml" })),
    `https://www.sec.gov/Archives/edgar/data/19617/000001961725000001/xslF345X05/ownership.xml`);
  assert.equal(validateReaderDocument("19617", report({ documentUrl: "https://evil.example/report.htm" })),
    `https://www.sec.gov/Archives/edgar/data/19617/000001961725000001/report.htm`);
  for (const primaryDoc of ["../report.htm", "nested/../../report.htm", "/report.htm", "https://evil.example/report.htm", "//evil.example/report.htm", "nested//report.htm", "report.htm?redirect=bad", "report.htm#fragment", "report%2e%2e.htm", "report.pdf", "report\\file.htm"])
    assert.throws(() => validateReaderDocument("19617", report({ primaryDoc })), { status: 422 }, primaryDoc);
  for (const cik of ["19617/../1", "-1", "1e4", "12345678901"])
    assert.throws(() => validateReaderDocument(cik, report()), { status: 400 });
});

test("HTML extraction removes executable and hidden XBRL content while retaining visible paragraphs", () => {
  const raw = `<html><head><style>.hidden { display:none }</style><script>secretScript = 'do not render';</script></head><body><ix:hidden><ix:nonNumeric>hiddenXbrlSecret</ix:nonNumeric></ix:hidden><!-- commentSecret --><p>Visible liquidity &amp; capital narrative contains &#x24;200 million of available funding.</p><p>Another substantive paragraph documents the reporting period.</p></body></html>`;
  const result = extractFilingReaderText(raw, "report.htm");
  assert.equal(result.format, "text");
  assert.match(result.text, /liquidity & capital narrative contains \$200 million/);
  assert.match(result.text, /funding\.\n\nAnother substantive/);
  assert.doesNotMatch(result.text, /secretScript|hiddenXbrlSecret|commentSecret|display:none|<p>/);
});

test("Inline XBRL headers and resources never become narrative while visible tagged values remain readable", () => {
  const raw = `<html><body><ix:header><ix:references><link:schemaRef xlink:href="jpm-20241231.xsd"/></ix:references><ix:resources><xbrli:context id="hidden-context"><xbrli:entity><xbrli:identifier scheme="https://www.sec.gov/CIK">0000019617</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="jpm:BusinessSegmentAxis">jpm:CorporateInvestmentBankMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>hidden-start-date</xbrli:startDate><xbrli:endDate>hidden-end-date</xbrli:endDate></xbrli:period></xbrli:context><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit></ix:resources><ix:hidden><ix:nonNumeric>hidden-only-disclosure</ix:nonNumeric></ix:hidden></ix:header><p>JPMORGAN CHASE &amp; CO reported cash of <ix:nonFraction name="us-gaap:Cash" contextRef="hidden-context" unitRef="usd">215</ix:nonFraction> million for the period ending <ix:nonNumeric name="dei:DocumentPeriodEndDate">December 31, 2024</ix:nonNumeric>. This visible narrative must remain available for evidence review.</p></body></html>`;
  const result = extractFilingReaderText(raw, "jpm-20241231.htm");
  assert.equal(result.format, "text");
  assert.match(result.text, /^JPMORGAN CHASE & CO reported cash of 215 million/);
  assert.match(result.text, /period ending December 31, 2024/);
  assert.match(result.text, /visible narrative must remain available/);
  assert.doesNotMatch(result.text, /0000019617|CorporateInvestmentBankMember|hidden-start-date|hidden-end-date|iso4217:USD|hidden-only-disclosure|BusinessSegmentAxis/);
});

test("Standalone XBRL contexts, units and schema references are removed outside an inline header", () => {
  const raw = `<html><body><ix:resources><xbrli:context><xbrli:entity><xbrli:identifier>resource-identifier-secret</xbrli:identifier></xbrli:entity></xbrli:context></ix:resources><xbrli:context id="legacy-context"><xbrli:entity><xbrli:identifier>legacy-identifier-secret</xbrli:identifier></xbrli:entity></xbrli:context><xbrli:unit id="legacy-unit"><xbrli:measure>legacy-unit-secret</xbrli:measure></xbrli:unit><link:schemaRef xlink:href="schema.xsd">schema-reference-secret</link:schemaRef><link:linkbaseRef xlink:href="labels.xml">linkbase-reference-secret</link:linkbaseRef><link:schemaRef xlink:href="other.xsd"/><p>${shared}</p></body></html>`;
  const result = extractFilingReaderText(raw, "legacy.htm");
  assert.equal(result.text, shared);
  assert.doesNotMatch(result.text, /identifier-secret|unit-secret|reference-secret/);
});

test("Numeric entities preserve financial comparisons and supplementary Unicode after markup removal", () => {
  const result = extractFilingReaderText("<p>The financial covenant requires leverage &#x3c; 4.0 and coverage &#62; 1.5 during each reporting period. Encoded examples: &#128200; and &#x1F4C8;. Invalid scalars: &#xD800;, &#1114112;, and &#0;.</p>");
  assert.equal(result.text, "The financial covenant requires leverage < 4.0 and coverage > 1.5 during each reporting period. Encoded examples: 📈 and 📈. Invalid scalars: �, �, and �.");
});

test("Ownership XML retains leaf field ancestry and omits markup and external entity declarations", () => {
  const raw = `<?xml version="1.0"?><!DOCTYPE ownershipDocument [<!ENTITY external SYSTEM "file:///etc/passwd">]><ownershipDocument><issuer><issuerName>Example &amp; Company</issuerName></issuer><reportingOwner><reportingOwnerId><rptOwnerName>Jane Smith</rptOwnerName></reportingOwnerId></reportingOwner><nonDerivativeTable><nonDerivativeTransaction><transactionAmounts><transactionShares><value>1500</value></transactionShares></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;
  const result = extractFilingReaderText(raw, "ownership.xml");
  assert.equal(result.format, "xml-fields");
  assert.match(result.text, /issuer \/ issuer Name: Example & Company/);
  assert.match(result.text, /reporting Owner \/ reporting Owner Id \/ rpt Owner Name: Jane Smith/);
  assert.match(result.text, /non Derivative Transaction \/ transaction Amounts \/ transaction Shares: 1500/);
  assert.doesNotMatch(result.text, /DOCTYPE|file:\/\/\/etc\/passwd|<issuer|ownership Document|\/ value:/);
  assert.equal(extractFilingReaderText(`<html><p>${shared}</p></html>`, "rendered.xml").format, "text");
});

test("SEC denial pages and empty extraction fail instead of becoming usable evidence", () => {
  for (const raw of [
    `<html><title>Access Denied</title><body>${shared}</body></html>`,
    `<h1>Request rate threshold exceeded</h1><p>${shared}</p>`,
    `<title>Undeclared automated tool</title><p>${shared}</p>`,
    "<html><body>None.</body></html>",
  ]) assert.throws(() => extractFilingReaderText(raw), { status: 502 });
});

test("Bounded streaming rejects oversized headers before reading and cancels oversized bodies", async () => {
  let touched = false;
  const oversizedHeader = {
    headers: new Headers({ "content-length": "11" }),
    get body() { touched = true; throw new Error("Body must not be read"); },
  };
  await assert.rejects(readBoundedFilingResponse(oversizedHeader, 10), { status: 422 });
  assert.equal(touched, false);
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(7)); controller.enqueue(new Uint8Array(7)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readBoundedFilingResponse(new Response(body), 10), { status: 422 });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  await assert.rejects(readBoundedFilingResponse({ headers: new Headers(), body: null }), { status: 502 });
});

test("Bounded reader decodes UTF-8 split across streamed chunks without corruption", async () => {
  const bytes = new TextEncoder().encode("Liquidity €200 million — available");
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 11));
    controller.enqueue(bytes.slice(11, 12));
    controller.enqueue(bytes.slice(12));
    controller.close();
  } });
  assert.equal(await readBoundedFilingResponse(new Response(body), bytes.length), "Liquidity €200 million — available");
  assert.equal(body.locked, false);
});

test("Reader pagination finds literal text with adjacent context, not regex or Boolean expansion", () => {
  const paragraphs = Array.from({ length: 19 }, (_, index) => `Paragraph ${index}: ${index === 10 ? "COVENANT (waiver)" : index === 11 ? "covenant waiver" : "ordinary narrative"}. ${shared}`);
  const text = paragraphs.join("\n\n");
  const matched = paginateReaderText(text, "8-K", { query: "covenant (waiver)", page: 99 });
  assert.equal(matched.coverage.matchedParagraphs, 1);
  assert.equal(matched.coverage.page, 1);
  assert.equal(matched.paragraphs[0].beforeContext, paragraphs[9]);
  assert.equal(matched.paragraphs[0].afterContext, paragraphs[11]);
  const paged = paginateReaderText(text, "8-K", { page: 2 });
  assert.equal(paged.coverage.totalParagraphs, 19);
  assert.equal(paged.paragraphs.length, 8);
  assert.equal(paged.paragraphs[0].text, paragraphs[8]);
  const empty = paginateReaderText(text, "8-K", { query: "covenant OR ordinary" });
  assert.equal(empty.coverage.matchedParagraphs, 0);
  assert.deepEqual(empty.paragraphs, []);
});

test("Long SEC paragraphs are chunked without dropping words or their final text", () => {
  const text = `${Array.from({ length: 3700 }, (_, i) => `word${i}`).join(" ")} final-sentinel`;
  const result = paginateReaderText(text, "10-K");
  assert.equal(result.coverage.splitParagraphs, true);
  assert.ok(result.paragraphs.length > 1);
  assert.ok(result.paragraphs.every((p) => p.text.length <= 6000));
  assert.equal(result.paragraphs.map((p) => p.text).join(" "), text);
  assert.deepEqual(result.paragraphs.map((p) => p.part), result.paragraphs.map((_, i) => i + 1));
  assert.ok(result.paragraphs.every((p) => p.parts === result.paragraphs.length));
  assert.match(paginateReaderText(text, "10-K", { query: "final-sentinel" }).paragraphs[0].text, /final-sentinel$/);
});

test("Reader section filters cannot leak neighboring 8-K items into requested evidence", () => {
  const text = `Item 2.02 Results of Operations\n\n${credit}\n\n${shared}\n\nItem 2.04 Triggering Events\n\nA covenant waiver was granted. ${shared}\n\n${obsolete}\n\nItem 9.01 Financial Statements and Exhibits\n\n${shared}`;
  const result = paginateReaderText(text, "8-K", { query: "waiver", section: "8k:2.04" });
  assert.equal(result.coverage.matchedParagraphs, 1);
  assert.equal(result.paragraphs[0].sectionId, "8k:2.04");
  assert.equal(paginateReaderText(text, "8-K", { query: "liquidity", section: "8k:2.04" }).coverage.matchedParagraphs, 0);
  assert.equal(paginateReaderText(text, "8-K", { section: "risk" }).coverage.matchedParagraphs, 0);
});

test("Comparison pairing separates reporting periods from same-period amendments", () => {
  assert.equal(validateReaderPair(report(), previous()).kind, "periodic");
  const amended = report({ form: "10-K/A", filingDate: "2025-03-01", accession: "0000019617-25-000002" });
  assert.equal(validateReaderPair(amended, report()).kind, "amendment");
  assert.equal(validateReaderPair(amended, previous()).allowed, false);
  for (const prior of [
    report(), previous({ form: "10-Q" }), previous({ form: "10-K/A" }),
    previous({ reportDate: "2024-12-31" }), previous({ reportDate: "" }),
    previous({ filingDate: "2025-03-01" }),
    previous({ filingDate: "2025-02-14", accession: "0000019617-25-000003" }),
  ]) assert.equal(validateReaderPair(report(), prior).allowed, false, JSON.stringify(prior));
  assert.equal(validateReaderPair(report(), null).kind, "unavailable");
  assert.equal(validateReaderPair(report({ form: "8-K" }), previous({ form: "8-K" })).kind, "unsupported");
});

test("Filing comparison suppresses repeated boilerplate and distinguishes modifications, additions and removals", () => {
  const changedCredit = credit.replace("$200 million", "$450 million");
  const result = compareReaderDocuments(riskDocument([shared, changedCredit, added]), riskDocument([shared, credit, obsolete]), report(), previous());
  assert.equal(result.status, "reviewed");
  assert.equal(result.kind, "periodic");
  assert.ok(result.changes.some((change) => change.type === "modified" && change.before === credit && change.after === changedCredit));
  assert.ok(result.changes.some((change) => change.type === "added" && change.after === added));
  assert.ok(result.changes.some((change) => change.type === "removed" && change.before === obsolete));
  assert.ok(result.changes.every((change) => change.before !== shared && change.after !== shared));
  assert.equal(compareReaderDocuments(riskDocument([shared, credit]), riskDocument([shared, credit]), report(), previous()).changes.length, 0);
});

test("Amendment comparison labels unmatched text and never interprets omitted paragraphs as removals", () => {
  const amended = report({ form: "10-K/A", filingDate: "2025-03-01", accession: "0000019617-25-000002" });
  const result = compareReaderDocuments(riskDocument([shared, added]), riskDocument([shared, credit, obsolete]), amended, report());
  assert.equal(result.kind, "amendment");
  assert.ok(result.changes.some((change) => change.type === "unmatched" && change.after === added));
  assert.ok(result.changes.every((change) => !["removed", "added"].includes(change.type)));
  assert.equal(result.totalChanges, result.changes.length);
  const unavailable = compareReaderDocuments(shared, shared, report(), previous());
  assert.equal(unavailable.status, "section-unavailable");
  assert.deepEqual(unavailable.changes, []);
});

test("Failed SEC fetches are retried, successful text is cached, and caller-supplied URLs are ignored", async (t) => {
  const filing = report({ accession: "0000019617-25-998871", documentUrl: "https://evil.example/collect" });
  const calls = [];
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    // Shared-cache configuration may be present in CI. Handle it without network access.
    if (!String(url).startsWith("https://www.sec.gov/Archives/")) return new Response(JSON.stringify({ result: null }), { status: 200 });
    calls.push({ url, options });
    attempts++;
    return attempts === 1
      ? new Response("SEC unavailable", { status: 503 })
      : new Response(`<html><p>${shared}</p></html>`, { headers: { "content-type": "text/html" } });
  });
  await assert.rejects(fetchReaderDocument("19617", filing), { status: 502 });
  const recovered = await fetchReaderDocument("19617", filing);
  assert.equal(recovered.text, shared);
  assert.deepEqual(await fetchReaderDocument("19617", filing), recovered);
  assert.equal(attempts, 2);
  for (const call of calls) {
    assert.equal(call.url, "https://www.sec.gov/Archives/edgar/data/19617/000001961725998871/report.htm");
    assert.equal(call.options.redirect, "error");
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test("Reader resolves accessions within the exact company manifest before fetching documents or comparison archives", async (t) => {
  const current = report({ accession: "0000019617-25-000201", primaryDoc: "current-reader.htm" });
  const prior = previous({ accession: "0000019617-24-000201", primaryDoc: "prior-reader.htm" });
  const archive = { name: "CIK0000019617-submissions-091.json", filingFrom: "2023-01-01", filingTo: "2024-12-31", filingCount: 1 };
  const unavailableArchive = { ...archive, name: "CIK0000019617-submissions-092.json" };
  const foreignArchive = "CIK0000320193-submissions-091.json";
  const requests = [];
  const documentRequests = [];
  const rows = (filings) => ({
    accessionNumber: filings.map((filing) => filing.accession),
    form: filings.map((filing) => filing.form),
    filingDate: filings.map((filing) => filing.filingDate),
    reportDate: filings.map((filing) => filing.reportDate),
    primaryDocument: filings.map((filing) => filing.primaryDoc),
  });
  const currentUrl = "https://www.sec.gov/Archives/edgar/data/19617/000001961725000201/current-reader.htm";
  const priorUrl = "https://www.sec.gov/Archives/edgar/data/19617/000001961724000201/prior-reader.htm";
  t.mock.method(globalThis, "fetch", async (url) => {
    const requested = String(url);
    requests.push(requested);
    if (requested === "https://www.sec.gov/files/company_tickers.json") return Response.json({
      0: { ticker: "AMJB", cik_str: 19617, title: "Associated security" },
      1: { ticker: "JPM", cik_str: 19617, title: "JPM exact issuer" },
      2: { ticker: "RECOVERY", cik_str: 19618, title: "Recovery limit fixture" },
    });
    if (requested === "https://data.sec.gov/submissions/CIK0000019617.json") return Response.json({
      cik: "19617", name: "JPMORGAN CHASE & CO", filings: { recent: rows([current]), files: [archive, unavailableArchive] },
    });
    if (requested === `https://data.sec.gov/submissions/${archive.name}`) return Response.json(rows([prior]));
    if (requested === `https://data.sec.gov/submissions/${unavailableArchive.name}`) return new Response("Archive unavailable", { status: 503 });
    if (requested.startsWith("https://www.sec.gov/Archives/")) {
      documentRequests.push(requested);
      assert.ok([currentUrl, priorUrl].includes(requested), `Unexpected SEC document URL: ${requested}`);
      return new Response(`<html><p>${riskDocument([shared, requested === currentUrl ? credit.replace("$200 million", "$450 million") : credit])}</p></html>`, { headers: { "content-type": "text/html" } });
    }
    if (!requested.startsWith("https://www.sec.gov/") && !requested.startsWith("https://data.sec.gov/")) return Response.json({ result: null });
    throw new Error(`Unexpected SEC request: ${requested}`);
  });

  const readerSettings = (values = {}) => filingReaderSettings(settings({ accession: current.accession, ...values }));
  await assert.rejects(readFilingsDocument(readerSettings({ accession: "0000320193-25-000201" })), { status: 404 });
  await assert.rejects(readFilingsDocument(readerSettings({ archive: foreignArchive })), { status: 400 });
  await assert.rejects(readFilingsDocument(readerSettings({ prior: prior.accession, priorArchive: foreignArchive, view: "changes" })), { status: 400 });
  assert.equal(documentRequests.length, 0, "Unverified accessions and archives must fail before fetching any document");
  assert.ok(!requests.some((url) => url.includes(foreignArchive)), "Another issuer's archive must never be fetched");

  const plain = await readFilingsDocument(readerSettings({ prior: prior.accession, priorArchive: unavailableArchive.name }));
  assert.equal(plain.ticker, "JPM");
  assert.equal(plain.cik, "0000019617");
  assert.equal(plain.filing.accession, current.accession);
  assert.equal(plain.prior, null);
  assert.equal(plain.comparison.status, "not-requested");
  assert.deepEqual(documentRequests, [currentUrl]);
  assert.ok(!requests.some((url) => url.endsWith(unavailableArchive.name)), "Plain document reading must not depend on a baseline archive");

  await assert.rejects(readFilingsDocument(readerSettings({ prior: prior.accession, priorArchive: unavailableArchive.name, view: "changes" })), { status: 502 });
  assert.deepEqual(documentRequests, [currentUrl], "A failed baseline archive cannot be represented as reviewed text");
  const comparison = await readFilingsDocument(readerSettings({ prior: prior.accession, priorArchive: archive.name, view: "changes" }));
  assert.equal(comparison.prior.accession, prior.accession);
  assert.equal(comparison.prior.archive, archive.name);
  assert.equal(comparison.comparison.status, "reviewed");
  assert.deepEqual(documentRequests, [currentUrl, priorUrl]);
  assert.ok(comparison.comparison.changes.some((change) => change.type === "modified"));

  const beforeRecovery = documentRequests.length;
  await assert.rejects(readFilingsDocument(readerSettings({ accession: prior.accession })), { status: 404 });
  await assert.rejects(readFilingsDocument(readerSettings({ accession: prior.accession, filed: "2022-02-16" })), { status: 404 });
  assert.equal(documentRequests.length, beforeRecovery, "Missing or wrong filing-date hints do not grant accession access");
  const failedArchiveRequests = requests.filter((url) => url.endsWith(unavailableArchive.name)).length;
  const recovered = await readFilingsDocument(readerSettings({ accession: prior.accession, filed: prior.filingDate }));
  assert.equal(recovered.filing.accession, prior.accession);
  assert.equal(recovered.filing.archive, archive.name, "Recovery retains the verified archive for later source access");
  assert.equal(requests.filter((url) => url.endsWith(unavailableArchive.name)).length, failedArchiveRequests, "Recovery stops after finding the accession in a verified archive");
  const recoveredComparison = await readFilingsDocument(readerSettings({ prior: prior.accession, priorFiled: prior.filingDate, view: "changes" }));
  assert.equal(recoveredComparison.prior.accession, prior.accession);
  assert.equal(recoveredComparison.prior.archive, archive.name);
  assert.equal(recoveredComparison.comparison.status, "reviewed");
  await assert.rejects(readFilingsDocument(readerSettings({ accession: "0000019617-24-009999", filed: prior.filingDate })), { status: 502 });
  assert.equal(documentRequests.length, beforeRecovery, "Incomplete archive recovery must not turn an unresolved accession into a document request");
});

test("Saved filing recovery stops after eight verified archives and reports incomplete coverage", async (t) => {
  const archives = Array.from({ length: 9 }, (_, index) => ({
    name: `CIK0000019618-submissions-${String(index + 1).padStart(3, "0")}.json`,
    filingFrom: "2024-01-01", filingTo: "2024-12-31", filingCount: 0,
  }));
  const archiveRequests = [];
  const emptyRows = { accessionNumber: [], form: [], filingDate: [], reportDate: [], primaryDocument: [] };
  let documentRequests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    const requested = String(url);
    if (requested === "https://www.sec.gov/files/company_tickers.json") return Response.json({
      0: { ticker: "RECOVERY", cik_str: 19618, title: "Recovery limit fixture" },
    });
    if (requested === "https://data.sec.gov/submissions/CIK0000019618.json") return Response.json({
      cik: "19618", name: "Recovery limit fixture", filings: { recent: emptyRows, files: archives },
    });
    const archive = archives.find((entry) => requested === `https://data.sec.gov/submissions/${entry.name}`);
    if (archive) { archiveRequests.push(archive.name); return Response.json(emptyRows); }
    if (requested.startsWith("https://www.sec.gov/Archives/")) { documentRequests++; throw new Error("Unresolved accession must not be fetched"); }
    if (!requested.startsWith("https://www.sec.gov/") && !requested.startsWith("https://data.sec.gov/")) return Response.json({ result: null });
    throw new Error(`Unexpected SEC request: ${requested}`);
  });
  const request = filingReaderSettings(settings({ ticker: "RECOVERY", accession: "0000019618-24-000201", filed: "2024-02-16" }));
  await assert.rejects(readFilingsDocument(request), (error) => error.status === 422 && /archive|history|coverage/i.test(error.message));
  assert.deepEqual(archiveRequests, archives.slice(0, 8).map((archive) => archive.name));
  assert.equal(documentRequests, 0);
});
