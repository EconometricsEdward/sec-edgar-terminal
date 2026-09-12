import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAnalysisCompany } from "../src/utils/analysisResearch.js";
import { buildPortfolioCompany } from "../src/utils/portfolioResearchServer.js";
import {
  financialObservationContext,
  financialSourcePeriod,
  financialSourcePeriodLabel,
} from "../src/utils/financialObservationContext.js";
import { selectFinancialFact } from "../src/utils/xbrlPeriods.js";
import {
  packPortfolioSnapshot,
  unpackPortfolioSnapshot,
} from "../src/utils/portfolioEvidenceCodec.js";

const period = {
  kind: "annual",
  fp: "FY",
  start: "2025-01-01",
  end: "2025-12-31",
};
const fact = (value, end, start) => ({
  val: value,
  end,
  ...(start ? { start } : {}),
  fy: 2025,
  fp: "FY",
  form: "10-K",
  filed: "2026-02-06",
  accn: "0001018724-26-000004",
});
const facts = {
  "us-gaap": Object.fromEntries(
    Object.entries({
      Revenues: [fact(700000000000, "2025-12-31", "2025-01-01")],
      Assets: [
        fact(624894000000, "2024-12-31"),
        fact(818042000000, "2025-12-31"),
      ],
      AccountsPayableCurrent: [
        fact(94363000000, "2024-12-31"),
        fact(121909000000, "2025-12-31"),
      ],
      StockholdersEquity: [
        fact(285970000000, "2024-12-31"),
        fact(411065000000, "2025-12-31"),
      ],
      NetIncomeLoss: [fact(100000000000, "2025-12-31", "2025-01-01")],
    }).map(([tag, values]) => [tag, { units: { USD: values } }]),
  ),
};
const company = {
  ticker: "AMZN",
  cik: "0001018724",
  companyName: "AMAZON.COM INC",
  sic: "5961",
  facts,
  filings: [
    {
      accession: "0001018724-26-000004",
      documentUrl:
        "https://www.sec.gov/Archives/edgar/data/1018724/000101872426000004/amzn-20251231.htm",
    },
  ],
};

test("the same 2025 filing preserves Amazon's 2024 opening balance and 2025 closing balance", () => {
  const result = buildPortfolioCompany(company);
  const opening = result.metrics.openingAccountsPayable;
  const closing = result.metrics.accountsPayable;
  assert.equal(opening.value, 94363000000);
  assert.equal(closing.value, 121909000000);
  assert.equal(opening.sources[0].documentUrl, closing.sources[0].documentUrl);
  assert.equal(opening.sources[0].filed, "2026-02-06");
  assert.equal(opening.sources[0].end, "2024-12-31");
  assert.deepEqual(opening.period, closing.period);
  assert.equal(opening.period.end, "2025-12-31");
  assert.deepEqual(opening.observationPeriod, {
    kind: "instant",
    start: null,
    end: "2024-12-31",
  });
  const context = financialObservationContext(
    opening,
    "openingAccountsPayable",
  );
  assert.equal(context.valid, true);
  assert.equal(context.role, "opening");
  assert.equal(context.label, "Opening balance date");
  assert.equal(context.periodLabel, "As of 2024-12-31");
  assert.equal(
    financialObservationContext(closing, "accountsPayable").periodLabel,
    "As of 2025-12-31",
  );
});

test("opening dates use the selected fiscal duration across annual, quarterly, YTD and TTM", () => {
  for (const [kind, start, openingDate] of [
    ["annual", "2025-01-01", "2024-12-31"],
    ["quarter", "2025-10-01", "2025-09-30"],
    ["ytd", "2025-07-01", "2025-06-30"],
    ["ttm", "2025-01-01", "2024-12-31"],
  ]) {
    const p = { ...period, kind, start };
    const source = {
      value: 40,
      unit: "USD",
      start: null,
      end: openingDate,
      filed: "2026-02-06",
    };
    const point = {
      value: 40,
      unit: "USD",
      classification: "reported",
      period: p,
      sources: [source],
    };
    const context = financialObservationContext(
      point,
      "openingAccountsPayable",
    );
    assert.equal(context.valid, true, kind);
    assert.equal(context.observationPeriod.end, openingDate, kind);
    assert.deepEqual(context.reportingPeriod, p);
    assert.equal(
      financialObservationContext(point, "accountsPayable").valid,
      false,
      "an opening balance cannot be relabeled as closing",
    );
  }
});

test("average balances and returns retain both dated balances without becoming a single filing column", () => {
  const result = buildAnalysisCompany(company, {
    basis: "annual",
    latestOnly: true,
  });
  const average = result.metrics.averageAssets[0];
  assert.equal(average.value, (624894000000 + 818042000000) / 2);
  const context = financialObservationContext(average, "averageAssets");
  assert.equal(context.valid, true);
  assert.equal(context.role, "mixed");
  assert.match(context.explanation, /2024-12-31 and 2025-12-31/);
  assert.match(context.explanation, /not a single balance-sheet column/);
  assert.equal(
    financialObservationContext(result.metrics.roa[0], "roa").valid,
    true,
  );
});

test("reported values, units, and observation dates must agree with their source", () => {
  const point = buildPortfolioCompany(company).metrics.openingAccountsPayable;
  for (const [change, pattern] of [
    [{ value: 121909000000 }, /does not match its cited source observation/],
    [{ unit: "shares" }, /unit does not match/],
    [
      { sources: [{ ...point.sources[0], end: "2025-12-31" }] },
      /opening balance must be dated/,
    ],
    [
      { sources: [{ ...point.sources[0], end: "2024-02-30" }] },
      /invalid dates/,
    ],
  ]) {
    const context = financialObservationContext(
      { ...point, ...change },
      "openingAccountsPayable",
    );
    assert.equal(context.valid, false);
    assert.match(context.issue, pattern);
  }
  assert.equal(
    financialSourcePeriod({ end: "2025-12-31", filed: "2026-02-06" }).end,
    "2025-12-31",
  );
  assert.equal(
    financialSourcePeriodLabel({ filed: "2026-02-06", fy: 2025 }),
    "Observation dates not supplied",
  );
});

test("the actual reported interval survives a permitted small fiscal-boundary difference", () => {
  const raw = {
    "us-gaap": {
      Revenues: { units: { USD: [fact(100, "2025-12-31", "2025-01-02")] } },
    },
  };
  const selected = selectFinancialFact(raw, ["Revenues"], period);
  const point = { ...selected, period };
  const context = financialObservationContext(point, "revenue");
  assert.equal(context.valid, true);
  assert.equal(point.period.start, "2025-01-01");
  assert.equal(point.observationPeriod.start, "2025-01-02");
  assert.equal(context.periodLabel, "2025-01-02 to 2025-12-31");
});

test("derived quarters expose cumulative source dates separately from the standalone calculation window", () => {
  const raw = {
    "us-gaap": {
      NetCashProvidedByUsedInOperatingActivities: {
        units: {
          USD: [
            fact(100, "2025-12-31", "2025-01-01"),
            {
              ...fact(70, "2025-09-30", "2025-01-01"),
              fp: "Q3",
              form: "10-Q",
              filed: "2025-11-01",
            },
          ],
        },
      },
    },
  };
  const p = { ...period, kind: "quarter", start: "2025-10-01" };
  const selected = selectFinancialFact(
    raw,
    ["NetCashProvidedByUsedInOperatingActivities"],
    p,
  );
  const context = financialObservationContext(
    { ...selected, period: p },
    "operatingCashFlow",
  );
  assert.equal(selected.value, 30);
  assert.equal(context.valid, true);
  assert.equal(context.role, "mixed");
  assert.equal(context.periodLabel, "2025-10-01 to 2025-12-31");
  assert.deepEqual(context.sources.map(financialSourcePeriodLabel), [
    "2025-01-01 to 2025-12-31",
    "2025-01-01 to 2025-09-30",
  ]);
});

test("existing 100-company evidence has exact reported-value mappings and explicitly dated opening balances", () => {
  const demo = JSON.parse(
    readFileSync(
      new URL(
        "../public/portfolio/portfolio-demo-100-results.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const snapshot = unpackPortfolioSnapshot(demo.snapshot);
  let available = 0;
  let opening = 0;
  for (const company of snapshot.companies) {
    for (const [key, point] of Object.entries(company.metrics || {})) {
      if (!Number.isFinite(point.value)) continue;
      available++;
      const context = financialObservationContext(point, key);
      assert.equal(
        context.valid,
        true,
        `${company.ticker || company.cik} ${key}: ${context.issue}`,
      );
      if (context.role === "opening") {
        opening++;
        assert.ok(context.observationPeriod.end < point.period.start);
        assert.equal(context.sources[0].value, point.value);
      }
    }
  }
  assert.ok(available > 5000);
  assert.ok(opening > 200);
  const amazon = snapshot.companies.find((entry) => entry.ticker === "AMZN");
  assert.equal(
    financialObservationContext(
      amazon.metrics.openingAccountsPayable,
      "openingAccountsPayable",
    ).periodLabel,
    "As of 2024-12-31",
  );
});

test("compact saved captures preserve observation metadata and the independent analytical window", () => {
  const result = buildPortfolioCompany(company);
  const snapshot = { basis: "annual", companies: [result] };
  const restored = unpackPortfolioSnapshot(packPortfolioSnapshot(snapshot));
  const opening = restored.companies[0].metrics.openingAccountsPayable;
  assert.equal(opening.observationPeriod.end, "2024-12-31");
  assert.equal(opening.period.end, "2025-12-31");
  assert.equal(
    financialObservationContext(opening, "openingAccountsPayable").valid,
    true,
  );
});
