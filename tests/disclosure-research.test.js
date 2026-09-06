import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDisclosureQuery,
  matchesQuery,
  buildAdvancedQuery,
  highlightParts,
  legacyDisclosureQuery,
} from "../src/utils/disclosureQuery.js";
import {
  analyzeDisclosure,
  disclosurePassages,
  selectDisclosureBaseline,
  compareDisclosurePassages,
  disclosureWordDiff,
  buildDisclosureMatrix,
  buildDisclosureTrends,
  passageSignals,
} from "../src/utils/disclosureResearch.js";
import {
  disclosureSettings,
  scanDisclosureCompany,
  readDisclosureDocument,
} from "../src/utils/disclosureResearchServer.js";
import { resolveDisclosureCompany } from "../src/utils/tickerMap.js";
import {
  collectDisclosureEvidence,
  exportDisclosureBrief,
  exportDisclosureCsv,
  updateDisclosureMonitor,
  readDisclosureNotebook,
  writeDisclosureNotebook,
  emptyDisclosureNotebook,
  filingEvidenceId,
} from "../src/utils/disclosureNotebook.js";

const q = (s) => parseDisclosureQuery(s);
const paragraph =
  "Our revolving credit facility contains a covenant requiring minimum liquidity of $200 million as of December 31, 2024. We have maintained compliance with the agreement during the reporting period.";
const other =
  "Our operations are subject to market conditions and depend on the availability of employees and other resources. Management regularly reviews the company strategy and its operating performance.";
const filingText = (body) =>
  `Item 1A. Risk Factors\n\n${body}\n\n${other}\n\nItem 1B. Unresolved Staff Comments\n\nNone.\n\nItem 7. Management discussion and analysis\n\n${other}\n\n${paragraph}\n\nItem 8. Financial statements\n\n${other}`;
test("Boolean groups, NOT, exact phrases and precedence remain consistent", () => {
  const query = q(
    '(liquidity OR covenant) AND (breach OR waiver) AND NOT "credit card"',
  );
  assert.equal(matchesQuery("We received a covenant waiver.", query), true);
  assert.equal(matchesQuery("Covenant compliance is monitored.", query), false);
  assert.equal(matchesQuery("Credit card liquidity waiver.", query), false);
  assert.equal(
    matchesQuery(
      "Refinancing occurred.",
      q("refinancing OR covenant AND waiver"),
    ),
    true,
  );
  assert.equal(
    matchesQuery("A credit card agreement.", q('"credit card"')),
    true,
  );
  assert.equal(
    matchesQuery("A credit business card agreement.", q('"credit card"')),
    false,
  );
  assert.equal(matchesQuery("Illiquidity", q("liquidity")), false);
});
test("Malformed or negative-only queries cannot silently broaden searches", () => {
  for (const raw of [
    "liquidity AND",
    "(covenant OR waiver",
    '"cash flow',
    "liquidity OR NOT covenant",
    "NOT liquidity",
    "liquid*",
    "()",
    "a",
    "liquidity)",
  ])
    assert.throws(() => q(raw), undefined, raw);
  assert.throws(
    () => q(Array.from({ length: 17 }, (_, i) => `term${i}`).join(" OR ")),
    /16/,
  );
});
test("Builder and legacy links preserve phrases and all-term semantics", () => {
  const query = buildAdvancedQuery({
    any: "liquidity, cash flow",
    required: "waiver",
    exclude: "credit card",
  });
  assert.equal(matchesQuery("Cash flow waiver granted.", q(query)), true);
  assert.equal(matchesQuery("Liquidity available.", q(query)), false);
  assert.equal(
    legacyDisclosureQuery("cash flow, credit loss", "all"),
    '"cash flow" AND "credit loss"',
  );
});
test("Every term is highlighted with overlapping phrases merged safely", () => {
  const text = "Credit loss and credit losses differ; CREDIT LOSS repeats.";
  const parts = highlightParts(text, ["credit", "credit loss"]);
  assert.equal(parts.map((p) => p.text).join(""), text);
  assert.deepEqual(
    parts.filter((p) => p.match).map((p) => p.text),
    ["Credit loss", "credit", "CREDIT LOSS"],
  );
});
test("Same-paragraph AND is distinct from document AND and exclusion scope", () => {
  const text = `${paragraph}\n\nWe received a waiver in connection with a separate agreement.\n\nCredit card operations.`;
  assert.equal(
    analyzeDisclosure(text, "10-K", q("liquidity AND waiver")).matched,
    false,
  );
  assert.equal(
    analyzeDisclosure(text, "10-K", q("liquidity AND waiver"), {
      scope: "document",
    }).matched,
    true,
  );
  assert.equal(
    analyzeDisclosure(text, "10-K", q('liquidity AND NOT "credit card"'))
      .matched,
    true,
  );
  assert.equal(
    analyzeDisclosure(text, "10-K", q('liquidity AND NOT "credit card"'), {
      scope: "document",
    }).matched,
    false,
  );
});
test("Section search keeps unidentified sections unavailable", () => {
  const text = filingText(paragraph);
  assert.equal(
    analyzeDisclosure(text, "10-K", q("covenant"), { section: "risk" }).matched,
    true,
  );
  assert.equal(
    analyzeDisclosure(text, "10-K", q("covenant"), { section: "notes" }).status,
    "section-unavailable",
  );
  const missing = analyzeDisclosure(other, "10-K", q("covenant"), {
    section: "risk",
  });
  assert.equal(missing.status, "section-unavailable");
  assert.equal(
    analyzeDisclosure(other, "10-K", q("covenant")).status,
    "reviewed",
  );
});
test("8-K section matching stays within the requested numbered item", () => {
  const text = `Item 2.02 Results of Operations\n\n${paragraph}\n\n${other}\n\nItem 2.04 Triggering Events\n\nWe received a waiver. ${other} ${other}\n\nItem 9.01 Financial Statements and Exhibits\n\n${other}`;
  assert.equal(
    analyzeDisclosure(text, "8-K", q("waiver"), { section: "8k:2.04" }).matched,
    true,
  );
  assert.equal(
    analyzeDisclosure(text, "8-K", q("covenant"), { section: "8k:2.04" })
      .matched,
    false,
  );
});
test("Financial notes are identified from substantive note headings", () => {
  const text = `NOTES TO CONSOLIDATED FINANCIAL STATEMENTS\n\nNote 1. Basis of presentation\n\n${Array(10).fill(paragraph).join("\n\n")}\n\nItem 9. Changes in Accountants\n\n${other}`;
  assert.equal(
    analyzeDisclosure(text, "10-K", q("liquidity"), { section: "notes" })
      .matched,
    true,
  );
  assert.equal(
    disclosurePassages(
      "NOTES TO CONSOLIDATED FINANCIAL STATEMENTS\n\nPage 95",
      "10-K",
    ).sections.length,
    0,
  );
});
const report = (accession, reportDate, filingDate, form = "10-K") => ({
  accession,
  reportDate,
  filingDate,
  form,
  primaryDoc: "report.htm",
  documentUrl: "https://www.sec.gov/Archives/report.htm",
});
test("Comparisons match reporting season and keep amendments in the original period", () => {
  const current = report("new", "2025-06-30", "2025-08-01", "10-Q");
  const sameYear = report(
    "previous-quarter",
    "2025-03-31",
    "2025-05-01",
    "10-Q",
  );
  const comparable = report("same-season", "2024-06-30", "2024-08-01", "10-Q");
  assert.equal(
    selectDisclosureBaseline(current, [current, sameYear, comparable]).prior
      .accession,
    "same-season",
  );
  const amendment = report("amendment", "2025-06-30", "2025-08-10", "10-Q/A");
  assert.equal(
    selectDisclosureBaseline(amendment, [amendment, current, comparable]).prior
      .accession,
    "new",
  );
  assert.equal(
    selectDisclosureBaseline(
      report("event", "2025-06-30", "2025-08-01", "8-K"),
      [current],
    ).prior,
    null,
  );
});
test("Boilerplate disappears from changes while financial wording keeps both versions", () => {
  const before = analyzeDisclosure(
    filingText(paragraph),
    "10-K",
    q("liquidity"),
    { section: "risk" },
  );
  const identical = compareDisclosurePassages(before, before);
  assert.equal(identical.unchanged, 1);
  assert.equal(identical.removed.length, 0);
  const after = analyzeDisclosure(
    filingText(paragraph.replace("$200", "$350").replace("2024", "2025")),
    "10-K",
    q("liquidity"),
    { section: "risk" },
  );
  const changed = compareDisclosurePassages(after, before);
  assert.equal(changed.matches[0].change, "revised");
  assert.match(changed.matches[0].priorText, /200/);
  assert.match(changed.matches[0].text, /350/);
  const diff = disclosureWordDiff(paragraph, after.matches[0].text);
  assert.equal(
    diff
      .filter((x) => x.kind !== "added")
      .map((x) => x.text)
      .join(""),
    paragraph,
  );
  assert.equal(
    diff
      .filter((x) => x.kind !== "removed")
      .map((x) => x.text)
      .join(""),
    after.matches[0].text,
  );
});
test("Changing a leading reporting date does not create a false new paragraph", () => {
  const body =
    "As of December 31, 2024, the Firm had high quality liquid assets of $834 billion and unencumbered marketable securities of $594 billion, resulting in approximately $1.4 trillion of liquidity sources.";
  const before = analyzeDisclosure(filingText(body), "10-K", q("liquidity"), {
    section: "risk",
  });
  const after = analyzeDisclosure(
    filingText(body.replace("2024", "2025").replace("$834", "$915")),
    "10-K",
    q("liquidity"),
    { section: "risk" },
  );
  assert.equal(
    compareDisclosurePassages(after, before).matches[0].change,
    "revised",
  );
});
test("Query language revised away is shown with the current and prior wording", () => {
  const before = analyzeDisclosure(
    filingText(paragraph),
    "10-K",
    q("liquidity"),
    { section: "risk" },
  );
  const after = analyzeDisclosure(
    filingText(paragraph.replace("liquidity", "cash")),
    "10-K",
    q("liquidity"),
    { section: "risk" },
  );
  const diff = compareDisclosurePassages(after, before);
  assert.equal(after.matched, false);
  assert.equal(diff.removed[0].change, "revised");
  assert.equal(diff.removed[0].queryNoLongerMatches, true);
  assert.match(diff.removed[0].text, /cash/);
  assert.match(diff.removed[0].priorText, /liquidity/);
});
test("Partial amendments do not turn omitted paragraphs into removals or additions", () => {
  const before = analyzeDisclosure(
    filingText(paragraph),
    "10-K",
    q("liquidity"),
    { section: "risk" },
  );
  const after = analyzeDisclosure(
    filingText("Bank liquidity arrangements were replaced in full. " + other),
    "10-K/A",
    q("liquidity"),
    { section: "risk" },
  );
  const diff = compareDisclosurePassages(after, before, { amendment: true });
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.matches[0].change, "unmatched");
});
test("Wording heuristics remain reviewable and never return a risk score", () => {
  const result = passageSignals(
    "We incurred $300 million in losses in 2025 and could incur further losses.",
    ["losses"],
    "mda",
  );
  assert.equal(result.label, "Mixed language");
  assert.equal(result.concrete, true);
  assert.equal("riskScore" in result, false);
});
test("Matrix distinguishes reviewed no-match from missing documents", () => {
  const companies = [
    {
      ticker: "JPM",
      filings: [
        { status: "reviewed", topics: { liquidity: 2 }, accession: "a" },
        { status: "fetch-failed" },
      ],
    },
    { ticker: "BAC", filings: [{ status: "reviewed", topics: {} }] },
  ];
  const rows = buildDisclosureMatrix(companies, ["JPM", "BAC", "WFC"]);
  assert.equal(rows[0].reviewed, 1);
  assert.equal(rows[0].missing, 1);
  assert.equal(rows[0].cells[0].state, "match");
  assert.equal(rows[1].cells[0].state, "no-match");
  assert.equal(rows[2].cells[0].state, "unknown");
});
test("Trend denominators exclude failures and reveal sample expansion", () => {
  const f = (year, matched, status = "reviewed", form = "10-K") => ({
    ...report(year, `${year}-12-31`, `${Number(year) + 1}-02-01`, form),
    matched,
    status,
    topics: {},
  });
  const companies = [
    { ticker: "A", filings: [f("2024", true), f("2025", true)] },
    {
      ticker: "B",
      filings: [f("2024", false, "fetch-failed"), f("2025", false)],
    },
    { ticker: "C", filings: [f("2025", true, "reviewed", "10-K/A")] },
  ];
  const rows = buildDisclosureTrends(companies, { requested: ["A", "B", "C"] });
  assert.deepEqual(
    rows.map((r) => [r.numerator, r.denominator, r.prevalence]),
    [
      [1, 1, 100],
      [1, 2, 50],
    ],
  );
  assert.deepEqual(rows[1].entered, ["B"]);
  assert.equal(rows[1].paired.delta, 0);
  assert.deepEqual(rows[1].paired.companies, ["A"]);
});
test("Saved checks deduplicate accessions and retain failed-fetch gaps", () => {
  const old = {
    ...report("old", "2024-12-31", "2025-02-01"),
    ticker: "JPM",
    cik: "19617",
    matched: true,
    status: "reviewed",
  };
  const newer = { ...old, accession: "new", filingDate: "2026-02-01" };
  const historical = {
    ...old,
    accession: "historical",
    filingDate: "2023-02-01",
  };
  const failed = { ...old, accession: "failed", status: "fetch-failed" };
  const saved = {
    seen: [filingEvidenceId(old)],
    inbox: [],
    lastChecked: "2025-09-01T00:00:00Z",
    createdAt: "2025-09-01T00:00:00Z",
  };
  const next = updateDisclosureMonitor(
    saved,
    [{ ticker: "JPM", filings: [old, newer, historical, failed] }],
    "2026-09-01T00:00:00Z",
  );
  assert.equal(next.inbox.length, 2);
  assert.equal(next.seen.includes(filingEvidenceId(failed)), false);
  assert.equal(
    next.inbox.find((i) => i.accession === "historical").reason,
    "Newly discovered historical match",
  );
  assert.equal(
    updateDisclosureMonitor(next, [
      { ticker: "JPM", filings: [newer, historical] },
    ]).inbox.length,
    2,
  );
});
test("Removed quotations retain the actual prior source and dates in exports", () => {
  const prior = report("prior", "2024-12-31", "2025-02-01");
  const current = {
    ...report("current", "2025-12-31", "2026-02-01"),
    ticker: "JPM",
    cik: "19617",
    pair: { prior },
    companyName: "Example",
  };
  const item = collectDisclosureEvidence(
    current,
    {
      index: 3,
      change: "removed",
      priorText: "Prior liquidity covenant text.",
      text: "",
      section: "Risk Factors",
      label: "Unclassified wording",
    },
    { query: "covenant", scope: "paragraph" },
  );
  assert.equal(item.accession, "prior");
  assert.equal(item.filingDate, "2025-02-01");
  assert.equal(item.quote, "Prior liquidity covenant text.");
  const collection = {
    name: "Credit memo",
    items: [
      {
        ...item,
        notes: '=HYPERLINK("evil") <script>alert(1)</script>',
        tags: "liquidity",
      },
    ],
  };
  const csv = exportDisclosureCsv(collection);
  assert.match(csv, /search_settings/);
  assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /2025-02-01/);
  const html = exportDisclosureBrief(collection);
  assert.equal(html.includes("<script>alert"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Prior liquidity covenant text/);
});
test("Corrupt storage and failed writes never silently replace saved research", () => {
  assert.throws(() => readDisclosureNotebook("{broken"));
  assert.throws(() => readDisclosureNotebook('{"version":2}'));
  const previous = JSON.stringify(emptyDisclosureNotebook());
  const storage = {
    getItem: () => previous,
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };
  assert.throws(
    () =>
      writeDisclosureNotebook(storage, (current) => ({
        ...current,
        searches: [],
      })),
    /quota/,
  );
  assert.equal(storage.getItem(), previous);
});
test("Request validation rejects invalid dates, sections, forms and depth", () => {
  for (const values of [
    { start: "2025-02-30" },
    { depth: "0" },
    { depth: "13" },
    { section: "invented" },
    { forms: "random" },
    { scope: "sentence" },
  ])
    assert.throws(() =>
      disclosureSettings(
        new URLSearchParams({ query: "liquidity", ...values }),
      ),
    );
});
test("Issuer resolution preserves JPM even when another security alias sorts first", async () => {
  const original = global.fetch;
  global.fetch = async () =>
    Response.json({
      0: { ticker: "AMJB", cik_str: 19617, title: "JPMORGAN CHASE & CO" },
      1: { ticker: "JPM", cik_str: 19617, title: "JPMORGAN CHASE & CO" },
    });
  try {
    const resolved = await resolveDisclosureCompany("JPM");
    assert.equal(resolved.ticker, "JPM");
    assert.equal(resolved.cik, "0000019617");
    const name = await resolveDisclosureCompany("JPMORGAN CHASE & CO");
    assert.equal(name.ticker, "0000019617");
  } finally {
    global.fetch = original;
  }
});
test("Live-path scan counts successful text separately from a failed source", async () => {
  const original = global.fetch;
  const cik = "0009999001";
  const accessions = [
    "0009999001-26-000001",
    "0009999001-25-000001",
    "0009999001-24-000001",
  ];
  global.fetch = async (url) => {
    if (String(url).includes("/submissions/"))
      return Response.json({
        name: "Coverage Fixture",
        filings: {
          recent: {
            accessionNumber: accessions,
            form: ["10-K", "10-K", "10-K"],
            filingDate: ["2026-02-01", "2025-02-01", "2024-02-01"],
            reportDate: ["2025-12-31", "2024-12-31", "2023-12-31"],
            primaryDocument: ["new.htm", "missing.htm", "old.htm"],
          },
          files: [],
        },
      });
    if (String(url).endsWith("/missing.htm"))
      return new Response("Unavailable", { status: 503 });
    return new Response(filingText(paragraph));
  };
  try {
    const settings = disclosureSettings(
      new URLSearchParams({
        query: "liquidity",
        start: "2024-01-01",
        forms: "10-K",
        depth: "2",
      }),
    );
    const result = await scanDisclosureCompany(cik, settings);
    assert.equal(result.selected, 2);
    assert.equal(result.reviewed, 1);
    assert.equal(result.fetchFailed, 1);
    assert.equal(result.filings[0].status, "reviewed");
    assert.match(result.filings[0].comparisonError, /Prior document/);
    assert.equal(result.filings[1].status, "fetch-failed");
    assert.equal(result.filings[1].matched, false);
    await assert.rejects(
      readDisclosureDocument(cik, "0009999001-20-000001", "new.htm", settings),
      /not found/,
    );
  } finally {
    global.fetch = original;
  }
});
