import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { unpackPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
import {
  buildPortfolioResearchPackage,
  portfolioCsv,
  portfolioMarkdown,
  portfolioXlsx,
} from "../src/utils/portfolioExports.js";
import { parsePortfolioCsv } from "../src/utils/portfolioFiles.js";
import { portfolioReportHtml } from "../src/utils/portfolioReport.js";

function amazonDocument() {
  const demo = JSON.parse(
    fs.readFileSync(
      new URL(
        "../public/portfolio/portfolio-demo-100-results.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const snapshot = unpackPortfolioSnapshot(demo.snapshot);
  const amazon = snapshot.companies.find(
    (company) => company.ticker === "AMZN",
  );
  return {
    name: "Amazon observation-date regression",
    research: { basis: "annual" },
    allocation: { basis: "none" },
    rows: demo.rows.filter((row) => row.resolution?.ticker === "AMZN"),
    snapshot: {
      ...snapshot,
      companies: [
        {
          ...amazon,
          metrics: Object.fromEntries(
            ["openingAccountsPayable", "accountsPayable", "revenue"].map(
              (key) => [key, amazon.metrics[key]],
            ),
          ),
        },
      ],
    },
  };
}

test("Amazon exports preserve the opening and closing balance dates separately from FY2025 and filing dates", () => {
  const document = amazonDocument();
  const before = JSON.stringify(document);
  const bundle = buildPortfolioResearchPackage(document);
  const metrics = bundle.companies[0].metrics;
  assert.equal(metrics.openingAccountsPayable.value, 94_363_000_000);
  assert.equal(metrics.accountsPayable.value, 121_909_000_000);
  assert.equal(metrics.openingAccountsPayable.period.end, "2025-12-31");
  assert.deepEqual(metrics.openingAccountsPayable.observation, {
    role: "opening",
    kind: "instant",
    start: null,
    end: "2024-12-31",
  });
  assert.deepEqual(metrics.accountsPayable.observation, {
    role: "closing",
    kind: "instant",
    start: null,
    end: "2025-12-31",
  });
  assert.equal(metrics.openingAccountsPayable.sources[0].filed, "2026-02-06");
  assert.equal(metrics.accountsPayable.sources[0].filed, "2026-07-31");
  assert.equal(
    JSON.stringify(document),
    before,
    "Old captures must be explained without rewriting saved evidence.",
  );

  const row = Object.assign(
    {},
    ...["openingAccountsPayable", "accountsPayable", "revenue"].map((key) => {
      // The upload parser intentionally limits columns and cell length. Keep
      // the real metric/source records, omitting unrelated export coverage here.
      const parsed = parsePortfolioCsv(
        portfolioCsv({ ...bundle, coverage: {} }, [key]),
      );
      return Object.fromEntries(
        parsed.headers.map((header, index) => [
          header,
          parsed.records[0][index],
        ]),
      );
    }),
  );
  assert.match(row.openingAccountsPayable_period, /2025-01-01 to 2025-12-31/);
  assert.equal(row.openingAccountsPayable_observation_role, "opening");
  assert.equal(row.openingAccountsPayable_observation_end, "2024-12-31");
  assert.equal(
    row.openingAccountsPayable_observation_period,
    "As of 2024-12-31",
  );
  assert.equal(row.accountsPayable_observation_end, "2025-12-31");
  assert.equal(row.openingAccountsPayable_observation_issue, "");
  assert.equal(row.revenue_observation_role, "duration");
  assert.equal(row.revenue_observation_start, "2025-01-01");

  const files = unzipSync(portfolioXlsx(bundle));
  const sheet = strFromU8(files["xl/worksheets/sheet2.xml"]);
  assert.match(sheet, /observation_role/);
  assert.match(sheet, /observation_end/);
  const openingRow = sheet.match(
    /<row\b[^>]*>(?:(?!<\/row>)[\s\S])*openingAccountsPayable(?:(?!<\/row>)[\s\S])*<\/row>/,
  )?.[0];
  assert.ok(openingRow);
  assert.match(openingRow, /94363000000/);
  assert.match(openingRow, /As of 2024-12-31/);
  assert.match(openingRow, /2025-01-01 to 2025-12-31/);
});

test("printable and Markdown reports label comparative amounts with the exact source column date", () => {
  const bundle = buildPortfolioResearchPackage(amazonDocument());
  const html = portfolioReportHtml(bundle);
  const opening = html.match(
    /<article class="metric"><h4>Opening accounts payable:[\s\S]*?<\/article>/,
  )?.[0];
  const closing = html.match(
    /<article class="metric"><h4>Accounts Payable:[\s\S]*?<\/article>/,
  )?.[0];
  assert.ok(opening);
  assert.ok(closing);
  assert.match(opening, /\$94,363,000,000/);
  assert.match(opening, /Opening balance date: As of 2024-12-31/);
  assert.match(opening, /Analysis period: Annual: 2025-01-01 to 2025-12-31/);
  assert.match(
    opening,
    /Reported input: 94,363,000,000 USD · As of 2024-12-31 · 10-K filed 2026-02-06/,
  );
  assert.match(closing, /\$121,909,000,000/);
  assert.match(closing, /Balance-sheet date: As of 2025-12-31/);
  assert.match(closing, /10-Q filed 2026-07-31/);
  assert.doesNotMatch(opening, /Balance-sheet date: As of 2025-12-31/);
  const markdown = portfolioMarkdown(bundle);
  assert.match(markdown, /Value observation \| Analysis period/);
  assert.match(
    markdown,
    /openingAccountsPayable \| 94363000000 USD \| Opening balance date: As of 2024-12-31/,
  );
  assert.match(
    markdown,
    /observation: As of 2024-12-31; 10-K filed 2026-02-06/,
  );
});

test("report source amounts preserve fractional and per-share evidence without display rounding", () => {
  const document = amazonDocument();
  const company = document.snapshot.companies[0];
  const opening = company.metrics.openingAccountsPayable;
  opening.value = 94_363_000_000.125;
  opening.sources[0].value = opening.value;
  const revenue = company.metrics.revenue;
  company.metrics = {
    openingAccountsPayable: opening,
    epsDiluted: {
      ...revenue,
      label: "Diluted earnings per share",
      value: 0.000000000000000000000012345,
      unit: "USD/shares",
      sources: [
        {
          ...revenue.sources[0],
          tag: "EarningsPerShareDiluted",
          value: 0.000000000000000000000012345,
          unit: "USD/shares",
        },
      ],
    },
  };
  const html = portfolioReportHtml(buildPortfolioResearchPackage(document));
  assert.match(html, /Reported input: 94,363,000,000\.125 USD/);
  assert.match(
    html,
    /Reported input: 0\.000000000000000000000012345 USD\/shares/,
  );
});
