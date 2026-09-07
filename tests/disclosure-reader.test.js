import test from "node:test";
import assert from "node:assert/strict";
import {
  disclosureExactText,
  disclosureQuantities,
  disclosureQuantityComparison,
  disclosureQuantityParts,
} from "../src/utils/disclosureQuantities.js";
import {
  disclosureReaderFilters,
  disclosurePassageAnchor,
  disclosureReaderNavigation,
  disclosurePassageCitation,
  makeDisclosurePassageUrl,
  parseDisclosureReaderState,
} from "../src/utils/disclosureReaderState.js";

const prior = {
  accession: "0000019617-24-000001",
  primaryDoc: "old.htm",
  form: "10-K",
  filingDate: "2024-02-12",
  reportDate: "2023-12-31",
  documentUrl:
    "https://www.sec.gov/Archives/edgar/data/19617/000001961724000001/old.htm",
};
const filing = {
  ticker: "JPM",
  cik: "0000019617",
  companyName: "JPMorgan Chase & Co.",
  accession: "0000019617-25-000001",
  primaryDoc: "jpm-20241231.htm",
  form: "10-K",
  filingDate: "2025-02-12",
  reportDate: "2024-12-31",
  documentUrl:
    "https://www.sec.gov/Archives/edgar/data/19617/000001961725000001/jpm-20241231.htm",
  pair: { prior },
};
const settings = {
  query: '(liquidity OR covenant) AND NOT "credit card"',
  tickers: "JPM,BAC",
  mode: "companies",
  start: "2023-01-01",
  end: "2026-09-07",
  forms: "10-K,10-Q",
  section: "all",
  scope: "paragraph",
  depth: 24,
  amendments: true,
  comparison: "previous-report",
  notes: "PRIVATE NOTE",
  collection: "PRIVATE COLLECTION",
  apiKey: "PRIVATE KEY",
};
const passage = {
  index: 241,
  section: "MD&A",
  sectionId: "mda",
  text: "Liquidity was $200 million (-5.5%).",
  priorText: "Liquidity was $250 million (5.5%).",
  change: "revised",
};

test("exact disclosure equality normalizes case and whitespace without erasing financial punctuation", () => {
  assert.equal(
    disclosureExactText("  CASH\n is $5.0 million. "),
    "cash is $5.0 million.",
  );
  for (const [before, after] of [
    ["-5%", "5%"],
    ["5%", "$5"],
    ["5.0", "50"],
    ["(5)", "5"],
    ["$5", "€5"],
    ["$5.1", "$5,1"],
  ]) {
    assert.notEqual(disclosureExactText(before), disclosureExactText(after));
  }
});

test("quantity spans preserve dates, signed percentages and parenthesized currency as complete expressions", () => {
  const text =
    "At December 31, 2024, losses were ($1.25 billion), growth was −5.50%, the spread was +25 basis points, and assets were USD 1,234.56 million.";
  const spans = disclosureQuantities(text);
  assert.deepEqual(
    spans.map(({ kind, text }) => [kind, text]),
    [
      ["date", "December 31, 2024"],
      ["money", "($1.25 billion)"],
      ["percentage", "−5.50%"],
      ["percentage", "+25 basis points"],
      ["money", "USD 1,234.56 million"],
    ],
  );
  assert.equal(
    disclosureQuantityParts(text, spans)
      .map((part) => part.text)
      .join(""),
    text,
  );
  for (const span of spans)
    assert.equal(text.slice(span.start, span.end), span.text);
});

test("quantity extraction recognizes explicit calendar formats without pairing their components", () => {
  const spans = disclosureQuantities(
    "Dates: 2024-12-31, 12/31/2024, 31 December 2024; values: (125), -0.25, +7.",
  );
  assert.deepEqual(
    spans.filter((x) => x.kind === "date").map((x) => x.text),
    ["2024-12-31", "12/31/2024", "31 December 2024"],
  );
  assert.deepEqual(
    spans.filter((x) => x.kind === "number").map((x) => x.text),
    ["(125)", "-0.25", "+7"],
  );
});

test("leading decimal points remain part of signed quantities", () => {
  assert.deepEqual(
    disclosureQuantities("Margin -.5%, rate .25%, payment $.50.").map(
      (x) => x.text,
    ),
    ["-.5%", ".25%", "$.50"],
  );
});

test("side by side quantity inventory distinguishes punctuation but does not assert a numeric change", () => {
  const comparison = disclosureQuantityComparison(
    "Revenue $5 million. Margin 5%. Exposure $5 million.",
    "Exposure $5 million. Margin -5%.",
  );
  assert.equal(comparison.prior.filter((x) => x.alsoPresent).length, 2);
  assert.equal(
    comparison.current.find((x) => x.text === "-5%").alsoPresent,
    false,
  );
  assert.ok(comparison.current.every((x) => !Object.hasOwn(x, "delta")));
  assert.deepEqual(disclosureQuantityComparison("No amount supplied", ""), {
    prior: [],
    current: [],
  });
});

test("passage links preserve exact source, query settings, baseline and server filters without private notes", () => {
  const link = new URL(
    makeDisclosurePassageUrl({
      filing,
      passage,
      settings,
      filters: {
        section: "mda",
        change: "revised",
        language: "Reported-event wording",
        find: "$200 million",
      },
      origin: "https://secedgarterminal.com/somewhere",
    }),
  );
  assert.equal(link.pathname, "/disclosures");
  assert.equal(link.searchParams.get("comparison"), "previous-report");
  assert.equal(link.searchParams.get("depth"), "24");
  assert.equal(link.searchParams.get("query"), settings.query);
  assert.equal(link.searchParams.get("tickers"), "JPM,BAC");
  assert.equal(link.searchParams.get("amendments"), "true");
  assert.equal(link.searchParams.get("rBaseline"), prior.accession);
  assert.ok(!link.href.includes("PRIVATE"));
  const decoded = parseDisclosureReaderState(link.searchParams);
  assert.equal(decoded.filing.ticker, "JPM");
  assert.equal(decoded.filing.cik, "0000019617");
  assert.equal(decoded.filing.accession, filing.accession);
  assert.equal(decoded.filing.primaryDoc, filing.primaryDoc);
  assert.equal(decoded.filing.documentUrl, filing.documentUrl);
  assert.equal(decoded.index, 241);
  assert.equal(decoded.side, "current");
  assert.equal(decoded.baselineAccession, prior.accession);
  assert.deepEqual(decoded.filters, {
    section: "mda",
    change: "revised",
    language: "Reported-event wording",
    find: "$200 million",
  });
  assert.equal(link.hash, "#disclosure-passage-current-241");
});

test("prior passage links retain the baseline and cannot be mistaken for current paragraph with the same index", () => {
  const removed = { ...passage, change: "removed", text: "" };
  const link = new URL(
    makeDisclosurePassageUrl({
      filing,
      passage: removed,
      settings,
      origin: "https://secedgarterminal.com",
    }),
  );
  assert.equal(parseDisclosureReaderState(link.searchParams).side, "prior");
  assert.notEqual(
    disclosurePassageAnchor(removed),
    disclosurePassageAnchor(passage),
  );
  link.searchParams.delete("rBaseline");
  assert.equal(parseDisclosureReaderState(link.searchParams), null);
});

test("malformed source pointers are rejected instead of silently selecting another filing", () => {
  const original = new URL(
    makeDisclosurePassageUrl({
      filing,
      passage,
      settings,
      origin: "https://secedgarterminal.com",
    }),
  );
  for (const [key, value] of [
    ["rCik", "javascript:alert(1)"],
    ["rAccession", "wrong"],
    ["rDocument", "../secret.htm"],
    ["rDocument", "https://evil.test/a.htm"],
    ["rIndex", "-1"],
    ["rIndex", "1.1"],
    ["rIndex", ""],
    ["rSide", "unknown"],
    ["rBaseline", "wrong"],
  ]) {
    const params = new URLSearchParams(original.searchParams);
    params.set(key, value);
    assert.equal(parseDisclosureReaderState(params), null, key);
  }
  assert.throws(() =>
    makeDisclosurePassageUrl({
      filing,
      passage,
      settings,
      origin: "javascript:alert(1)",
    }),
  );
});

test("copied citations quote the correct current or prior SEC source and reporting period", () => {
  const current = disclosurePassageCitation(filing, passage);
  assert.ok(current.includes(filing.accession));
  assert.ok(current.includes(filing.documentUrl));
  assert.ok(current.includes(passage.text));
  assert.ok(!current.includes(prior.accession));
  const old = disclosurePassageCitation(filing, {
    ...passage,
    change: "removed",
    text: "",
  });
  assert.ok(old.includes(prior.accession));
  assert.ok(old.includes(prior.documentUrl));
  assert.ok(old.includes(passage.priorText));
  assert.ok(old.includes("2023-12-31"));
  assert.ok(!old.includes(filing.accession));
  assert.throws(() =>
    disclosurePassageCitation(
      { ...filing, pair: null },
      { ...passage, change: "removed" },
    ),
  );
});

test("reader filters retain recognized 8-K sections and finite text while isolating navigation from inputs", () => {
  assert.deepEqual(
    disclosureReaderFilters({
      section: "8k:2.04",
      change: "changed",
      language: "fake",
      find: " x ".repeat(300),
    }),
    {
      section: "8k:2.04",
      change: "changed",
      language: "all",
      find: " x ".repeat(300).trim().slice(0, 200),
    },
  );
  assert.equal(disclosureReaderNavigation("ArrowDown", 0, 12), 1);
  assert.equal(disclosureReaderNavigation("ArrowDown", 11, 12), 11);
  assert.equal(disclosureReaderNavigation("ArrowUp", 0, 12), 0);
  assert.equal(disclosureReaderNavigation("Home", 8, 12), 0);
  assert.equal(disclosureReaderNavigation("End", 0, 12), 11);
  assert.equal(disclosureReaderNavigation("Escape", 1, 12), null);
  assert.equal(disclosureReaderNavigation("Home", 0, 0), null);
});
