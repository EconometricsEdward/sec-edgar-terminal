import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Inflate, zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import {
  parsePortfolioCsv,
  parsePortfolioJson,
  parsePortfolioXlsx,
  parsePortfolioFile,
  mapPortfolioColumns,
  parseTickerList,
  createXlsxWorkbook,
  csvString,
  blankTemplateBytes,
  MAX_PORTFOLIO_FILE_BYTES,
} from "../src/utils/portfolioFiles.js";
import {
  PORTFOLIO_COLUMNS,
  normalizePortfolioInput,
} from "../src/utils/portfolioModel.js";

const workbook = (
  rows = [
    ["ticker", "weight_pct"],
    ["AAPL", 12.5],
  ],
) => createXlsxWorkbook([{ name: "Holdings", rows }]);
const mutateWorkbook = (mutate) => {
  const parts = unzipSync(workbook());
  mutate(parts);
  return zipSync(parts);
};
const replacePart = (parts, name, replace) => {
  parts[name] = strToU8(replace(strFromU8(parts[name])));
};

test("CSV handles BOM, whitespace, multiline quoting, escaped quotes, and blank rows", () => {
  const parsed = parsePortfolioCsv(
    '\uFEFF Symbol , Company Name ,Notes\r\n\r\n AAPL , "Apple, Inc.","A \"\"quoted\"\" note\nsecond line"\r\n , , \r\nMSFT,Microsoft,\r\n',
  );
  const rows = mapPortfolioColumns(parsed);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ticker, "AAPL");
  assert.equal(rows[0].company_name, "Apple, Inc.");
  assert.equal(rows[0].notes, 'A "quoted" note\nsecond line');
  assert.equal(rows[1].ticker, "MSFT");
  assert.deepEqual(parsed.suggestedMapping, {
    Symbol: "ticker",
    "Company Name": "company_name",
    Notes: "notes",
  });
});

test("column mapping preserves unknown input, labels duplicates, and requires explicit unique fields", () => {
  const parsed = parsePortfolioCsv(
    "My investment,Symbol,Symbol,Private extra\nApple,AAPL,AAPL,remember this",
  );
  assert.deepEqual(parsed.headers, [
    "My investment",
    "Symbol",
    "Symbol (2)",
    "Private extra",
  ]);
  const row = mapPortfolioColumns(parsed, {
    "My investment": "company_name",
    Symbol: "ticker",
  })[0];
  assert.equal(row.company_name, "Apple");
  assert.equal(row.original_input["Private extra"], "remember this");
  assert.throws(
    () =>
      mapPortfolioColumns(parsed, { Symbol: "ticker", "Symbol (2)": "ticker" }),
    /only one/,
  );
  assert.throws(
    () => mapPortfolioColumns(parsed, { "Private extra": "notes" }),
    /Map at least/,
  );
  const prototypeHeader = parsePortfolioCsv("__proto__,Symbol\nx,AAPL");
  assert.equal(
    mapPortfolioColumns(prototypeHeader)[0].original_input.__proto__,
    "x",
  );
  assert.equal({}.polluted, undefined);
});

test("CSV and paste limits accept 100 rows and reject over-limit or malformed values", () => {
  assert.equal(
    parsePortfolioCsv(
      `ticker\n${Array.from({ length: 100 }, (_, i) => `T${i}`).join("\n")}`,
    ).records.length,
    100,
  );
  assert.equal(parseTickerList("AAPL, MSFT\nBRK.B; JPM").length, 4);
  assert.equal(
    parseTickerList("AAPL,AAPL").length,
    2,
    "duplicate positions remain for explicit review",
  );
  assert.throws(
    () => parseTickerList(Array(101).fill("AAPL").join(" ")),
    /100/,
  );
  assert.throws(
    () => parsePortfolioCsv(`ticker\n${Array(101).fill("AAPL").join("\n")}`),
    /100/,
  );
  assert.throws(
    () => parsePortfolioCsv(`ticker,notes\nAAPL,${"x".repeat(2001)}`),
    /2,000/,
  );
  assert.throws(() => parsePortfolioCsv('ticker\n"AAPL'), /not closed/);
  assert.throws(() => parsePortfolioCsv('ticker\n"AAPL"garbage'), /Unexpected/);
});

test("versioned JSON takes the same canonical mapping path and retains incomplete rows for review", () => {
  const input = {
    schema_version: "edgar.portfolio.v1",
    holdings: [
      { ticker: "AAPL", weight_pct: -5 },
      {},
      { cik: "0000789019", shares: 10 },
    ],
    allocation: { basis: "weights", normalize: false },
    research: { basis: "ttm" },
    row_choices: [{ index: 0, duplicateChoice: "keep" }],
  };
  const parsed = parsePortfolioJson(JSON.stringify(input));
  const mapped = mapPortfolioColumns(parsed);
  assert.equal(mapped.length, 3);
  assert.equal(
    mapped[0].weight_pct,
    -5,
    "negative allocations remain reviewable, never disappear",
  );
  assert.equal(mapped[1].ticker, "");
  assert.equal(mapped[2].cik, "0000789019");
  assert.equal(
    normalizePortfolioInput({ ...input, holdings: mapped }).holdings.length,
    3,
  );
  assert.equal(parsed.metadata.research.basis, "ttm");
  assert.deepEqual(parsed.metadata.row_choices, input.row_choices);
  assert.throws(
    () =>
      parsePortfolioJson(JSON.stringify({ ...input, schema_version: "wrong" })),
    /schema_version/,
  );
  assert.throws(
    () =>
      parsePortfolioJson(
        JSON.stringify({ ...input, holdings: [{ ticker: { script: "bad" } }] }),
      ),
    /must be text/,
  );
  assert.throws(
    () =>
      parsePortfolioJson(
        JSON.stringify({
          ...input,
          allocation: { basis: "weights", normalize: "yes" },
        }),
      ),
    /true or false/,
  );
  assert.throws(
    () =>
      parsePortfolioJson(
        JSON.stringify({
          ...input,
          row_choices: [{ index: 99, duplicateChoice: "keep" }],
        }),
      ),
    /valid holding index/,
  );
});

test("file extension and signature checks reject renamed binaries, HTML, old XLS and large files", async () => {
  await assert.rejects(
    parsePortfolioFile(strToU8("ticker\nAAPL"), "sample.xlsx"),
    /signature/,
  );
  await assert.rejects(
    parsePortfolioFile(workbook(), "sample.csv"),
    /plain UTF-8/,
  );
  await assert.rejects(
    parsePortfolioFile(
      strToU8("<html><script>alert(1)</script>"),
      "sample.csv",
    ),
    /HTML and XML/,
  );
  await assert.rejects(
    parsePortfolioFile(strToU8("ticker\nAAPL"), "sample.xls"),
    /Older .xls/,
  );
  await assert.rejects(
    parsePortfolioFile(
      new Uint8Array(MAX_PORTFOLIO_FILE_BYTES + 1),
      "sample.csv",
    ),
    /2 MB/,
  );
  await assert.rejects(
    parsePortfolioFile(new Uint8Array([0xff, 0xfe, 0x41]), "sample.csv"),
    /UTF-8/,
  );
  const parsed = await parsePortfolioFile(
    new File(["ticker\nAAPL"], "local.csv", { type: "text/csv" }),
  );
  assert.equal(parsed.records[0][0], "AAPL");
});

test("XLSX literal runtime roundtrip preserves values and dates without formula execution", () => {
  const bytes = createXlsxWorkbook([
    { name: "Instructions", rows: [["Do not import this"], ["Wrong ticker"]] },
    {
      name: "Holdings",
      rows: [
        PORTFOLIO_COLUMNS,
        [
          "AAPL",
          "Apple Inc.",
          "0000320193",
          "Nasdaq",
          12.5,
          10000,
          20,
          "USD",
          new Date("2026-09-01T00:00:00Z"),
          '=HYPERLINK("https://example.invalid","open")',
        ],
      ],
    },
  ]);
  const parsed = parsePortfolioXlsx(bytes);
  const row = mapPortfolioColumns(parsed)[0];
  assert.equal(row.ticker, "AAPL");
  assert.equal(row.cik, "0000320193");
  assert.equal(row.weight_pct, 12.5);
  assert.equal(row.as_of_date, "2026-09-01");
  assert.equal(row.notes, '=HYPERLINK("https://example.invalid","open")');
  const sheet = strFromU8(unzipSync(bytes)["xl/worksheets/sheet2.xml"]);
  assert.ok(!/<f(?:\s|>)/.test(sheet));
  assert.match(sheet, /t="inlineStr"/);
});

test("XLSX reads Office shared strings, sparse cells, and percentage-point display", () => {
  const bytes = mutateWorkbook((parts) => {
    parts["xl/sharedStrings.xml"] = strToU8(
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Symbol</t></si><si><r><t>AA</t></r><r><t>PL</t></r></si><si><t>weight_pct</t></si></sst>',
    );
    parts["xl/worksheets/sheet1.xml"] = strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2" s="3"><v>0.125</v></c></row></sheetData></worksheet>',
    );
    replacePart(parts, "xl/styles.xml", (text) =>
      text
        .replace('cellXfs count="3"', 'cellXfs count="4"')
        .replace(
          "</cellXfs>",
          '<xf numFmtId="9" fontId="0" fillId="0" borderId="0"/></cellXfs>',
        ),
    );
  });
  const parsed = parsePortfolioXlsx(bytes);
  assert.equal(mapPortfolioColumns(parsed)[0].weight_pct, 12.5);
  assert.equal(mapPortfolioColumns(parsed)[0].ticker, "AAPL");
  assert.ok(
    parsed.warnings.some((warning) => warning.includes("percentage points")),
  );
});

test("XLSX supports 1904 date system and rejects the fictitious 1900 leap day", () => {
  const makeDate = (serial, is1904) =>
    mutateWorkbook((parts) => {
      if (is1904)
        replacePart(parts, "xl/workbook.xml", (text) =>
          text.replace("<sheets>", '<workbookPr date1904="1"/><sheets>'),
        );
      parts["xl/worksheets/sheet1.xml"] = strToU8(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="str"><v>ticker</v></c><c r="B1" t="str"><v>as_of_date</v></c></row><row r="2"><c r="A2" t="str"><v>AAPL</v></c><c r="B2" s="2"><v>${serial}</v></c></row></sheetData></worksheet>`,
      );
    });
  assert.equal(
    mapPortfolioColumns(parsePortfolioXlsx(makeDate(0, true)))[0].as_of_date,
    "1904-01-01",
  );
  assert.throws(
    () => parsePortfolioXlsx(makeDate(60, false)),
    /date is invalid/,
  );
});

test("XLSX rejects active content, entity declarations, formulas and external relationships", () => {
  for (const [name, content] of [
    ["xl/vbaProject.bin", "bad"],
    ["xl/connections.xml", "<connections/>"],
    ["xl/embeddings/object.bin", "bad"],
    ["xl/media/image.png", "bad"],
  ]) {
    assert.throws(
      () =>
        parsePortfolioXlsx(
          mutateWorkbook((parts) => {
            parts[name] = strToU8(content);
          }),
        ),
      /active content/,
    );
  }
  assert.throws(
    () =>
      parsePortfolioXlsx(
        mutateWorkbook((parts) =>
          replacePart(parts, "xl/worksheets/sheet1.xml", (text) =>
            text.replace("<v>12.5</v>", "<f>1+1</f><v>2</v>"),
          ),
        ),
      ),
    /Formulas/,
  );
  assert.throws(
    () =>
      parsePortfolioXlsx(
        mutateWorkbook((parts) =>
          replacePart(parts, "xl/workbook.xml", (text) =>
            text.replace(
              "<workbook ",
              '<!DOCTYPE workbook [<!ENTITY x SYSTEM "file:///etc/passwd">]><workbook ',
            ),
          ),
        ),
      ),
    /entities/,
  );
  assert.throws(
    () =>
      parsePortfolioXlsx(
        mutateWorkbook((parts) =>
          replacePart(parts, "xl/_rels/workbook.xml.rels", (text) =>
            text.replace(
              "</Relationships>",
              '<Relationship Id="attack" Type="external" Target="https://example.invalid/data" TargetMode="External"/></Relationships>',
            ),
          ),
        ),
      ),
    /External workbook/,
  );
});

test("XLSX preflight blocks traversal, excessive compression, excessive entries and false expanded sizes", () => {
  assert.throws(
    () =>
      parsePortfolioXlsx(
        mutateWorkbook((parts) => {
          parts["../escape.xml"] = strToU8("<x/>");
        }),
      ),
    /unsafe/,
  );
  assert.throws(
    () =>
      parsePortfolioXlsx(
        mutateWorkbook((parts) => {
          parts["xl/bomb.xml"] = strToU8(`<x>${" ".repeat(300000)}</x>`);
        }),
      ),
    /compression/,
  );
  const many = Object.fromEntries(
    Array.from({ length: 1001 }, (_, i) => [`${i}.xml`, strToU8("<x/>")]),
  );
  assert.throws(() => parsePortfolioXlsx(zipSync(many)), /overly complex/);
  const bytes = workbook(),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let directory = -1;
  for (let i = 0; i < bytes.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      directory = i;
      break;
    }
  view.setUint32(directory + 24, 1, true);
  assert.throws(() => parsePortfolioXlsx(bytes), /expanded size/);
});

test("XLSX aborts a dishonest expansion stream before decoding its remaining compressed input", (context) => {
  const parts = unzipSync(workbook());
  // The first archive entry actually expands to 25 MiB, while its central
  // directory claims one byte. The ordinary declared-size/ratio preflight
  // cannot identify this lie without inspecting actual inflater output.
  parts["xl/worksheets/sheet1.xml"] = strToU8(
    `<x>${" ".repeat(25 * 1024 * 1024)}</x>`,
  );
  const bytes = zipSync(parts, { level: 6 });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let compressedSize = 0;
  for (let offset = 0; offset < bytes.length - 46; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const name = strFromU8(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (name !== "xl/worksheets/sheet1.xml") continue;
    compressedSize = view.getUint32(offset + 20, true);
    view.setUint32(offset + 24, 1, true);
    break;
  }
  assert.ok(bytes.length < MAX_PORTFOLIO_FILE_BYTES);
  assert.ok(compressedSize > 1024);

  // Instrument the real decoder rather than substituting a fake. No timing
  // assertion: only one small input chunk may reach it before it throws.
  const originalPush = Inflate.prototype.push;
  const inputChunks = [];
  context.mock.method(Inflate.prototype, "push", function (chunk, final) {
    inputChunks.push(chunk.length);
    return originalPush.call(this, chunk, final);
  });
  assert.throws(
    () => parsePortfolioXlsx(bytes),
    /declared expanded size limit/,
  );
  assert.equal(inputChunks.length, 1);
  assert.ok(inputChunks[0] <= 1024);
  assert.ok(inputChunks[0] < compressedSize);
});

test("XLSX count limit is based on populated rows and cells, not a misleading dimension", () => {
  const rows = [
    ["ticker"],
    ...Array.from({ length: 100 }, (_, i) => [`T${i}`]),
  ];
  assert.equal(parsePortfolioXlsx(workbook(rows)).records.length, 100);
  assert.throws(() => parsePortfolioXlsx(workbook([...rows, ["OVER"]])), /100/);
  assert.throws(
    () =>
      parsePortfolioXlsx(
        workbook([
          ["ticker", "notes"],
          ["AAPL", "x".repeat(2001)],
        ]),
      ),
    /2,000/,
  );
  const emptyFirst = createXlsxWorkbook([
    { name: "Instructions", rows: [["ignore"]] },
    { name: "Empty", rows: [] },
    { name: "Data", rows: [["ticker"], ["AAPL"]] },
  ]);
  assert.equal(
    mapPortfolioColumns(parsePortfolioXlsx(emptyFirst))[0].ticker,
    "AAPL",
  );
});

test("CSV exports quote correctly and neutralize spreadsheet formulas while preserving typed numbers", () => {
  const csv = csvString([
    ["ticker", "notes", "value"],
    ["AAPL", '  =HYPERLINK("https://example.invalid")', -5],
    ["MSFT", "@SUM(1,2)", 12.5],
    ["JPM", "<script>alert(1)</script>", 0],
  ]);
  assert.ok(csv.startsWith("\uFEFF"));
  const parsed = parsePortfolioCsv(csv);
  assert.equal(
    parsed.records[0][1],
    `'  =HYPERLINK("https://example.invalid")`,
  );
  assert.equal(parsed.records[0][2], "-5");
  assert.equal(parsed.records[1][1], "'@SUM(1,2)");
  assert.equal(
    parsed.records[2][1],
    "<script>alert(1)</script>",
    "script text remains inert data, not HTML",
  );
});

test("published templates and JSON schema stay compatible with the import pipeline", () => {
  const path = new URL("../public/portfolio/", import.meta.url);
  const blankXlsx = parsePortfolioXlsx(
    new Uint8Array(fs.readFileSync(new URL("portfolio-template.xlsx", path))),
  );
  assert.deepEqual(blankXlsx.headers, PORTFOLIO_COLUMNS);
  assert.deepEqual(blankXlsx.records, []);
  const blankCsv = parsePortfolioCsv(
    fs.readFileSync(new URL("portfolio-template.csv", path), "utf8"),
  );
  assert.deepEqual(blankCsv.headers, PORTFOLIO_COLUMNS);
  assert.deepEqual(blankCsv.records, []);
  const csv = mapPortfolioColumns(
    parsePortfolioCsv(
      fs.readFileSync(new URL("portfolio-example.csv", path), "utf8"),
    ),
  );
  const json = mapPortfolioColumns(
    parsePortfolioJson(
      fs.readFileSync(new URL("portfolio-example.json", path), "utf8"),
    ),
  );
  assert.deepEqual(
    csv.map((row) => row.ticker),
    json.map((row) => row.ticker),
  );
  assert.equal(
    csv.reduce((total, row) => total + Number(row.weight_pct), 0),
    100,
  );
  assert.ok(csv.every((row) => row.notes.includes("Fictional sample")));
  const schema = JSON.parse(
    fs.readFileSync(new URL("portfolio-schema.json", path), "utf8"),
  );
  assert.deepEqual(
    Object.keys(schema.$defs.holding.properties),
    PORTFOLIO_COLUMNS,
  );
  assert.equal(schema.properties.schema_version.const, "edgar.portfolio.v1");
  assert.deepEqual(
    parsePortfolioCsv(strFromU8(blankTemplateBytes())).headers,
    PORTFOLIO_COLUMNS,
  );
});
