import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDisclosureQuery,
  QUERY_VERSION,
} from "../src/utils/disclosureQuery.js";
import { stripHtml } from "../src/utils/filingTextParser.js";
import {
  analyzeDisclosure,
  disclosurePassages,
  selectDisclosureBaseline,
  compareDisclosurePassages,
} from "../src/utils/disclosureResearch.js";
import {
  disclosureSettings,
  disclosureFilingBatch,
  disclosureReaderOptions,
  paginateDisclosurePassages,
  scanDisclosureCompany,
  readDisclosureDocument,
} from "../src/utils/disclosureResearchServer.js";

const prose =
  "Our liquidity arrangements include a revolving credit facility that remains available to fund ordinary operating expenses and capital projects. We evaluate the facility and covenant conditions throughout the financial reporting period.";
const operations =
  "The company monitors operating performance through its subsidiaries and evaluates revenue trends and production expenses each month. The following operating review describes changes in expenses and discusses the reasons management considers significant.";
const analyze = (text, form, section) =>
  analyzeDisclosure(text, form, parseDisclosureQuery("liquidity"), { section });

test("20-F recognizes Item 3.D risk and Item 5 operating review with strict boundaries", () => {
  const text = `Item 3.D. Risk Factors\n\n${prose}\n\nItem 4. Information on the Company\n\n${operations}\n\nItem 5. Operating and Financial Review and Prospects\n\n${prose}\n\nItem 6. Directors and Management\n\n${operations}`;
  const risk = analyze(text, "20-F", "risk");
  assert.equal(risk.status, "reviewed");
  assert.equal(risk.matches.length, 1);
  assert.equal(
    risk.paragraphs.some((p) => p.text.includes("Item 4")),
    false,
  );
  const mda = analyze(text, "20-F/A", "mda");
  assert.equal(mda.matches.length, 1);
  assert.equal(
    mda.paragraphs.some((p) => p.text.includes("Directors")),
    false,
  );
  assert.match(mda.sections.find((s) => s.id === "mda").label, /20-F Item 5/);
});

test("20-F D subsection stays inside Item 3 and does not label all Key Information as risk", () => {
  const text = `Item 3. Key Information\n\nA. Financial Data\n\n${prose}\n\nD. Risk Factors\n\n${prose}\n\nItem 4. Information on the Company\n\nD. Risk Factors\n\n${operations}\n\nItem 5. Operating and Financial Review and Prospects\n\n${operations}`;
  const risk = analyze(text, "20-F", "risk");
  assert.equal(risk.matches.length, 1);
  assert.equal(
    risk.paragraphs.some((p) => p.text.includes("Financial Data")),
    false,
  );
  assert.equal(
    risk.paragraphs.some((p) => p.text === operations),
    false,
  );
  assert.equal(
    analyze(
      `Item 3. Key Information\n\n${prose}\n\nItem 4. Company`,
      "20-F",
      "risk",
    ).status,
    "section-unavailable",
  );
  assert.equal(
    analyze(
      `Item 3. Key Information\n\nD.\n\nRisk Factors\n\n${prose}\n\nItem 4. Company`,
      "20-F",
      "risk",
    ).matches.length,
    1,
  );
});

test("Foreign section detection rejects a contents-only listing and preserves US section meanings", () => {
  const toc =
    "Item 3.D. Risk Factors ............ 25\n\nItem 4. Information on the Company ........ 40\n\nItem 5. Operating and Financial Review and Prospects .... 58\n\nItem 6. Directors .... 75";
  assert.equal(disclosurePassages(toc, "20-F").sections.length, 0);
  const us = `Item 1A. Risk Factors\n\n${prose}\n\nItem 1B. Staff Comments\n\n${operations}\n\nItem 7. Management discussion and analysis\n\n${prose}\n\nItem 8. Financial Statements`;
  assert.equal(analyze(us, "10-K", "risk").matches.length, 1);
  assert.equal(analyze(us, "10-K", "mda").matches.length, 1);
  assert.equal(analyze(us, "20-F", "risk").status, "section-unavailable");
  assert.equal(analyze(us, "20-F", "mda").status, "section-unavailable");
  const q = `Item 2. Management discussion and analysis\n\n${prose}\n\nItem 3. Market Risk\n\n${operations}`;
  assert.equal(analyze(q, "10-Q", "mda").matches.length, 1);
});

test("TSM-style 20-F headings and printed-line HTML expose both narrative sections", () => {
  // Reproduces heading/layout structure in TSM's 2025 report (synthetic prose):
  // https://www.sec.gov/Archives/edgar/data/1046179/000162828026025362/tsm-20251231.htm
  const lines = (value) =>
    value
      .match(/(?:\S+\s*){1,14}/g)
      .map((line) => `<div>${line.trim()}</div>`)
      .join("");
  const html = `<div>ITEM 3.</div><div>KEY INFORMATION</div><div>Risk Factors</div><div>3</div><div>ITEM 4.</div><div>INFORMATION ON THE COMPANY</div><div>14</div><div>ITEM 5.</div><div>OPERATING AND FINANCIAL REVIEWS AND PROSPECTS</div><div>26</div><div>ITEM 6.</div><div>DIRECTORS</div><div>37</div><div>ITEM 3. KEY INFORMATION</div><div>Capitalization and Indebtedness</div><div>Not applicable.</div><div>Reasons for the Offer and Use of Proceeds</div><div>Not applicable.</div><div>Risk Factors</div>${lines(prose)}<div>ITEM 4. INFORMATION ON THE COMPANY</div>${lines(operations)}<div>ITEM 5. OPERATING AND FINANCIAL REVIEWS AND PROSPECTS</div>${lines(prose)}<div>ITEM 6. DIRECTORS, SENIOR MANAGEMENT AND EMPLOYEES</div>${lines(operations)}`;
  const text = stripHtml(html);
  for (const section of ["risk", "mda"]) {
    const reviewed = analyze(text, "20-F", section);
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.matches.length, 1);
    assert.equal(
      reviewed.paragraphs.some((p) =>
        /Not applicable|DIRECTORS|INFORMATION ON THE COMPANY/.test(p.text),
      ),
      false,
    );
    assert.ok(
      reviewed.paragraphs.every((p) => p.text.length < 180),
      "The fixture exercises multiple short printed blocks, not an ordinary long paragraph.",
    );
  }
  const contentsOnly = text.slice(0, text.indexOf("ITEM 3. KEY INFORMATION"));
  assert.equal(
    analyze(contentsOnly, "20-F", "risk").status,
    "section-unavailable",
  );
  assert.equal(
    analyze(contentsOnly, "20-F", "mda").status,
    "section-unavailable",
  );
});

test("Unlettered Risk Factors must be a standalone title inside Item 3", () => {
  for (const text of [
    `Item 3. Key Information\n\nPlease see our Risk Factors in another filing.\n\n${prose}\n\nItem 4. Company`,
    `Item 3. Key Information\n\nNot applicable.\n\nItem 4. Company\n\nRisk Factors\n\n${prose}`,
  ])
    assert.equal(analyze(text, "20-F", "risk").status, "section-unavailable");
  assert.equal(
    analyze(
      `Item 3. Key Information\n\nRisk Factors\n\n${prose}\n\nItem 4. Company`,
      "40-F",
      "risk",
    ).status,
    "section-unavailable",
  );
});

test("20-F paragraph-layout changes retain reviewed matches and withhold false additions and removals", () => {
  const paragraphs = Array.from(
    { length: 20 },
    (_, i) => `${prose} Our reporting sequence is ${i}.`,
  );
  const printed = paragraphs
    .map((p) =>
      p
        .match(/(?:\S+\s*){1,14}/g)
        .map((line) => line.trim())
        .join("\n\n"),
    )
    .join("\n\n");
  const report = (body) =>
    `Item 3. Key Information\n\nRisk Factors\n\n${body}\n\nItem 4. Company`;
  const current = analyze(report(printed), "20-F", "risk");
  const prior = analyze(report(paragraphs.join("\n\n")), "20-F", "risk");
  assert.equal(current.status, "reviewed");
  assert.equal(prior.status, "reviewed");
  assert.equal(current.matches.length, 20);
  for (const [a, b] of [
    [current, prior],
    [prior, current],
  ]) {
    const diff = compareDisclosurePassages(a, b);
    assert.match(
      diff.comparisonError,
      /printed-line fragments versus complete paragraphs/,
    );
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.unchanged, 0);
    assert.equal(diff.matches.length, a.matches.length);
    assert.ok(diff.matches.every((p) => p.change === "uncompared"));
  }
});

test("Ordinary 20-F paragraph revisions and small samples remain comparable", () => {
  const paragraph = `${prose} Our minimum liquidity facility amount is $200 million.`;
  for (const count of [1, 20]) {
    const report = (amount) =>
      `Item 3.D. Risk Factors\n\n${paragraph.replace("$200", amount)}\n\n${Array.from({ length: count - 1 }, (_, i) => `${operations} Operating sequence ${i}.`).join("\n\n")}\n\nItem 4. Company`;
    const current = analyze(report("$350"), "20-F", "risk");
    const prior = analyze(report("$200"), "20-F", "risk");
    const diff = compareDisclosurePassages(current, prior);
    assert.equal(diff.comparisonError, undefined);
    assert.equal(diff.matches[0].change, "revised");
    assert.match(diff.matches[0].priorText, /\$200/);
    assert.equal(diff.removed.length, 0);
  }
});

const filing = (n, reportDate, filingDate, form = "10-Q") => ({
  accession: `0009999018-26-${String(n).padStart(6, "0")}`,
  form,
  reportDate,
  filingDate,
  primaryDoc: "report.htm",
});
const current = filing(9, "2026-06-30", "2026-08-01");
const previous = filing(8, "2026-03-31", "2026-05-01");
const annual = filing(7, "2025-06-30", "2025-08-01");

test("Comparison choices distinguish same-season and previous reporting periods", () => {
  const late = filing(6, "2024-03-31", "2026-06-01");
  const wrongForm = filing(5, "2026-05-31", "2026-06-15", "10-K");
  const reports = [current, previous, annual, late, wrongForm];
  assert.equal(
    selectDisclosureBaseline(current, reports).prior.accession,
    annual.accession,
  );
  assert.equal(
    selectDisclosureBaseline(current, reports, "previous-report").prior
      .accession,
    previous.accession,
  );
  assert.equal(selectDisclosureBaseline(current, reports, "none").prior, null);
  assert.equal(selectDisclosureBaseline(current, reports, "none").kind, "none");
  assert.throws(
    () => selectDisclosureBaseline(current, reports, "invented"),
    /supported/,
  );
});

test("Amendments require the same known period and events remain unpaired for every enabled comparison", () => {
  const amended = {
    ...current,
    accession: "0009999018-26-000011",
    form: "10-Q/A",
    filingDate: "2026-08-15",
  };
  for (const mode of ["annual-season", "previous-report"]) {
    assert.equal(
      selectDisclosureBaseline(amended, [current, previous], mode).prior
        .accession,
      current.accession,
    );
    assert.equal(
      selectDisclosureBaseline(
        { ...amended, reportDate: "" },
        [{ ...current, reportDate: "" }],
        mode,
      ).prior,
      null,
    );
    assert.equal(
      selectDisclosureBaseline(
        { ...current, form: "8-K" },
        [{ ...previous, form: "8-K" }],
        mode,
      ).prior,
      null,
    );
  }
  assert.equal(
    selectDisclosureBaseline(amended, [current], "none").prior,
    null,
  );
});

test("Pinned comparison accession must satisfy issuer history, form, time and chosen mode", () => {
  assert.equal(
    selectDisclosureBaseline(
      current,
      [annual, previous],
      "annual-season",
      annual.accession,
    ).prior.accession,
    annual.accession,
  );
  assert.throws(
    () =>
      selectDisclosureBaseline(
        current,
        [annual, previous],
        "annual-season",
        previous.accession,
      ),
    /eligible earlier/,
  );
  assert.throws(
    () =>
      selectDisclosureBaseline(
        current,
        [annual, previous],
        "none",
        annual.accession,
      ),
    /eligible earlier/,
  );
  assert.throws(
    () =>
      selectDisclosureBaseline(current, [annual], "annual-season", "not-found"),
    /eligible earlier/,
  );
  assert.throws(
    () =>
      selectDisclosureBaseline(
        current,
        [current],
        "previous-report",
        current.accession,
      ),
    /eligible earlier/,
  );
});

test("Accession continuation sorts eligible reports and remains stable when newer filings arrive", () => {
  const settings = disclosureSettings(
    new URLSearchParams({
      query: "liquidity",
      forms: "10-Q",
      start: "2025-01-01",
      end: "2026-08-31",
      depth: "1",
    }),
  );
  const first = disclosureFilingBatch([annual, previous, current], settings);
  assert.equal(first.selected[0].accession, current.accession);
  assert.equal(first.nextCursor, current.accession);
  assert.equal(first.remaining, 2);
  const newer = filing(10, "2026-06-30", "2026-08-02");
  const second = disclosureFilingBatch(
    [newer, current, previous, annual],
    settings,
    first.nextCursor,
  );
  assert.equal(second.selected[0].accession, previous.accession);
  assert.equal(second.batchOffset, 2);
  assert.equal(second.remaining, 1);
  const last = disclosureFilingBatch(
    [current, previous, annual],
    settings,
    previous.accession,
  );
  assert.equal(last.nextCursor, null);
  assert.equal(last.remaining, 0);
  assert.throws(
    () => disclosureFilingBatch([current], settings, "bad"),
    /cursor/,
  );
  assert.throws(
    () => disclosureFilingBatch([current], settings, previous.accession),
    /not eligible/,
  );
  assert.throws(
    () =>
      disclosureFilingBatch(
        [current],
        { ...settings, forms: ["10-K"] },
        current.accession,
      ),
    /not eligible/,
  );
});

const passages = Array.from({ length: 30 }, (_, index) => ({
  index,
  text: `Passage ${index} includes liquidity ${index === 25 ? "target phrase" : "conditions"}.`,
  sectionId: index % 2 ? "risk" : "mda",
  section: index % 2 ? "Risk Factors" : "MD&A",
  change: index > 20 ? "revised" : "unchanged",
  label: index > 20 ? "Reported-event wording" : "Hypothetical wording",
}));

test("Reader filtering occurs across all passages before pagination", () => {
  const options = disclosureReaderOptions(
    new URLSearchParams({
      readerSection: "risk",
      readerChange: "changed",
      readerLanguage: "Reported-event wording",
      readerFind: "TARGET PHRASE",
    }),
  );
  const result = paginateDisclosurePassages(passages, 1, options);
  assert.equal(result.totalPassages, 1);
  assert.equal(result.unfilteredTotalPassages, 30);
  assert.equal(result.matches[0].index, 25);
  assert.equal(result.availableSections.length, 2);
});

test("Deep passage links resolve the correct page and distinguish removed prior indices", () => {
  const result = paginateDisclosurePassages(passages, 1, { passageIndex: 25 });
  assert.equal(result.page, 3);
  assert.equal(result.requestedPassageFound, true);
  const removed = {
    ...passages[0],
    text: "",
    priorText: "A removed quotation.",
    change: "removed",
  };
  const side = paginateDisclosurePassages([...passages, removed], 1, {
    passageIndex: 0,
    passageSide: "prior",
  });
  assert.equal(side.page, 3);
  assert.equal(side.matches.at(-1).change, "removed");
  const excluded = paginateDisclosurePassages(passages, 1, {
    passageIndex: 25,
    readerChange: "unchanged",
  });
  assert.equal(excluded.requestedPassageFound, false);
  assert.equal(excluded.page, 1);
});

test("Reader filters retain removed quotations and distinguish unavailable comparisons", () => {
  const matches = [
    {
      ...passages[0],
      change: "removed",
      text: "",
      priorText: "Prior liquidity wording.",
    },
    { ...passages[1], change: "uncompared" },
    { ...passages[2], change: "unmatched" },
  ];
  assert.equal(
    paginateDisclosurePassages(matches, 1, { readerFind: "prior liquidity" })
      .totalPassages,
    1,
  );
  assert.equal(
    paginateDisclosurePassages(matches, 1, { readerChange: "unavailable" })
      .totalPassages,
    2,
  );
  assert.equal(paginateDisclosurePassages([], 40).page, 1);
  for (const params of [
    { readerFind: "a".repeat(201) },
    { readerChange: "risk-score" },
    { readerSection: "secret" },
    { passageIndex: "1.5" },
    { passageIndex: "" },
    { passageIndex: "-1" },
    { passageSide: "both" },
    { baselineAccession: "bad" },
  ])
    assert.throws(() => disclosureReaderOptions(new URLSearchParams(params)));
  assert.throws(
    () =>
      disclosureSettings(
        new URLSearchParams({ query: "liquidity", comparison: "invented" }),
      ),
    /comparison/,
  );
});

test("Financial punctuation changes cannot disappear as unchanged boilerplate", () => {
  for (const [a, b] of [
    ["(100)", "100"],
    ["5%", "5"],
    ["$10", "10"],
  ]) {
    const before = analyzeDisclosure(
      `Our liquidity amount was ${a} during the reporting period and supported our ordinary operating commitments.`,
      "10-K",
      parseDisclosureQuery("liquidity"),
    );
    const after = analyzeDisclosure(
      `Our liquidity amount was ${b} during the reporting period and supported our ordinary operating commitments.`,
      "10-K",
      parseDisclosureQuery("liquidity"),
    );
    assert.equal(compareDisclosurePassages(after, before).unchanged, 0);
    assert.equal(
      compareDisclosurePassages(after, before).matches[0].change,
      "revised",
    );
  }
});

test("Live engine returns stable evidence revisions, continuation metadata and complete reader counts", async () => {
  const original = global.fetch;
  const cik = "0009999019";
  const accessions = ["0009999019-26-000001", "0009999019-25-000001"];
  global.fetch = async (url) =>
    String(url).includes("/submissions/")
      ? Response.json({
          name: "Workflow Fixture",
          filings: {
            recent: {
              accessionNumber: accessions,
              form: ["10-K", "10-K"],
              filingDate: ["2026-02-01", "2025-02-01"],
              reportDate: ["2025-12-31", "2024-12-31"],
              primaryDocument: ["new.htm", "old.htm"],
            },
            files: [],
          },
        })
      : new Response(
          Array.from(
            { length: 30 },
            (_, i) => `<p>${prose} Research sequence ${i}.</p>`,
          ).join(""),
        );
  try {
    const settings = disclosureSettings(
      new URLSearchParams({
        query: "liquidity",
        start: "2025-01-01",
        forms: "10-K",
        depth: "1",
        comparison: "none",
      }),
    );
    const first = await scanDisclosureCompany(cik, settings);
    assert.equal(first.nextCursor, accessions[0]);
    assert.equal(first.remaining, 1);
    assert.equal(first.version, QUERY_VERSION);
    assert.match(first.filings[0].evidenceRevision, /^[a-f0-9]{64}$/);
    const read = await readDisclosureDocument(
      cik,
      accessions[0],
      "new.htm",
      settings,
      1,
      { readerFind: "Research sequence 29." },
    );
    assert.equal(read.totalPassages, 1);
    assert.equal(read.unfilteredTotalPassages, 30);
    assert.deepEqual(read.previews, first.filings[0].previews);
    assert.equal(read.previews.length, 3);
    assert.match(read.matches[0].text, /Research sequence 29\./);
    assert.match(read.previews[0].text, /Research sequence 0\./);
    assert.equal(read.evidenceRevision, first.filings[0].evidenceRevision);
    const second = await scanDisclosureCompany(cik, settings, first.nextCursor);
    assert.equal(second.filings[0].accession, accessions[1]);
    assert.equal(second.nextCursor, null);
    assert.equal(second.selected, 1);
    assert.equal(second.batchOffset, 1);
  } finally {
    global.fetch = original;
  }
});
