import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  IMPACT_SCENARIOS,
  buildPortfolioImpactScenarios,
} from "../src/utils/portfolioImpactScenarios.js";
import { unpackPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
import { buildPortfolioCompany } from "../src/utils/portfolioResearchServer.js";

const NOW = "2026-09-14T12:00:00Z";
const period = { kind: "annual", start: "2025-01-01", end: "2025-12-31" };
const cik = (id) => String(id).padStart(10, "0");
const clone = (value) => structuredClone(value);
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
function point(value, key, companyId = 1, kind = "duration") {
  const accession = `${cik(companyId)}-26-000001`;
  const start = kind === "instant" ? null : period.start;
  return {
    value,
    unit: "USD",
    classification: "reported",
    period: { ...period },
    observationPeriod: { kind, start, end: period.end },
    calculations: [],
    sources: [
      {
        unit: "USD",
        value,
        tag: key,
        taxonomy: "us-gaap",
        accession,
        filed: "2026-02-01",
        form: "10-K",
        start,
        end: period.end,
        documentUrl: `https://www.sec.gov/Archives/edgar/data/${companyId}/${accession.replaceAll("-", "")}/annual.htm`,
      },
    ],
  };
}
function company(id = 1, overrides = {}) {
  return {
    cik: cik(id),
    ticker: `C${id}`,
    name: `Company ${id}`,
    lens: "corporate",
    status: "ready",
    metrics: Object.fromEntries(
      Object.entries({
        revenue: 100,
        operatingIncome: 20,
        operatingCashFlow: 30,
        capex: 20,
        totalAssets: 200,
        stockholdersEquity: 40,
        cash: 10,
      }).map(([key, value]) => [
        key,
        point(
          value,
          key,
          id,
          ["totalAssets", "stockholdersEquity", "cash"].includes(key)
            ? "instant"
            : "duration",
        ),
      ]),
    ),
    ...overrides,
  };
}
function report(companies, weights = null) {
  return {
    weighted: !!weights,
    label: "Supplied weights",
    unresolvedCount: 0,
    concentration: {
      complete: !!weights,
      issuers: companies.map((item, index) => ({
        cik: item.cik,
        name: item.name,
        tickers: [item.ticker],
        rowIds: [`row-${index}`],
        sector: index % 2 ? "Industrials" : "Technology",
        kind: "company",
        weightPct: weights?.[index] ?? null,
        weightComplete: !!weights,
      })),
    },
  };
}
const run = (
  companies = [company()],
  options = {},
  portfolio = report(companies),
) =>
  buildPortfolioImpactScenarios(portfolio, companies, { now: NOW, ...options });

test("six presets separate company impact from investment weights and carry useful controls", () => {
  assert.deepEqual(
    IMPACT_SCENARIOS.map((item) => item.id),
    ["demand", "cost", "combined", "recovery", "cash", "assets"],
  );
  for (const scenario of IMPACT_SCENARIOS) {
    const result = run(undefined, { scenarioId: scenario.id });
    assert.equal(result.rows.length, 1);
    assert.equal(result.coverage.weighted, false);
    assert.equal(result.coverage.coveredWeightPct, null);
    assert.ok(
      scenario.controls.every(
        (item) =>
          item.description && Number.isFinite(scenario.defaults[item.key]),
      ),
    );
    assert.ok(
      result.rows[0].evidence.every((item) =>
        item.sources[0].url.startsWith("https://www.sec.gov/Archives/"),
      ),
    );
  }
});
test("demand operating leverage reconciles the bridge and uses original revenue for impact", () => {
  const result = run(),
    row = result.rows[0];
  near(row.baseline, 20);
  near(row.modeled, 13.2);
  near(row.change, -6.8);
  near(row.impactPct, -6.8);
  near(row.beforeRatio, 20);
  near(row.afterRatio, (13.2 / 90) * 100);
  near(
    row.components.reduce((sum, item) => sum + item.value, 0),
    row.modeled - row.baseline,
  );
  assert.notEqual(row.impactPct, row.ratioChange);
  near(row.sensitivity.find((item) => item.shock === -10).value, row.modeled);
  assert.equal(row.sensitivityLabel, "Revenue change");
});
test("cost inflation follows volume adjustment and works with loss-making baselines", () => {
  const c = company();
  c.metrics.operatingIncome = point(-10, "operatingIncome");
  const row = run([c], { scenarioId: "combined" }).rows[0];
  const costs = 110 * (1 + 0.4 * -0.05) * 1.05;
  near(row.modeled, 95 - costs);
  near(row.modeledCosts, costs);
  near(
    row.components.reduce((sum, item) => sum + item.value, 0),
    row.change,
  );
  assert.equal(row.alreadyNegative, true);
  assert.equal(row.enteredLoss, false);
});
test("volume assumptions have meaningful fixed-versus-variable boundary behavior", () => {
  near(run(undefined, { variableCostPct: 0 }).rows[0].modeled, 10);
  near(run(undefined, { variableCostPct: 100 }).rows[0].modeled, 18);
  near(run(undefined, { revenuePct: 0, costPct: 0 }).rows[0].modeled, 20);
  near(run(undefined, { scenarioId: "recovery" }).rows[0].modeled, 26.8);
});
test("cash slowdown keeps capex fixed, exposes a crossed cash-generation threshold", () => {
  const c = company();
  c.metrics.capex = point(25, "capex");
  const result = run([c], { scenarioId: "cash" }),
    row = result.rows[0];
  near(row.baseline, 5);
  near(row.modeled, -1);
  near(row.change, -6);
  near(row.impactPct, -20);
  near(row.beforeRatio, 30 / 25);
  near(row.afterRatio, 24 / 25);
  assert.equal(row.enteredLoss, true);
  assert.equal(result.summary.enteredLossCount, 1);
});
test("cash slowdown worsens negative operating cash flow and never treats missing capex as zero", () => {
  const c = company();
  c.metrics.operatingCashFlow = point(-30, "operatingCashFlow");
  const row = run([c], { scenarioId: "cash" }).rows[0];
  near(row.baseline, -50);
  near(row.modeled, -56);
  near(row.impactPct, -20);
  c.metrics.capex = point(0, "capex");
  const zeroCapex = run([c], { scenarioId: "cash" }).rows[0];
  assert.equal(zeroCapex.beforeRatio, null);
  assert.equal(zeroCapex.afterRatio, null);
  delete c.metrics.capex;
  assert.equal(run([c], { scenarioId: "cash" }).rows.length, 0);
});
test("zero operating cash flow and negative PP&E purchases are not silently modeled", () => {
  const c = company();
  c.metrics.operatingCashFlow = point(0, "operatingCashFlow");
  assert.equal(run([c], { scenarioId: "cash" }).coverage.unavailableCount, 1);
  c.metrics.operatingCashFlow = point(30, "operatingCashFlow");
  c.metrics.capex = point(-20, "capex");
  assert.equal(run([c], { scenarioId: "cash" }).rows.length, 0);
});
test("asset write-down reduces assets and equity equally, not equity alone", () => {
  const row = run(undefined, { scenarioId: "assets", assetLossPct: 10 })
    .rows[0];
  near(row.baseline, 40);
  near(row.modeled, 20);
  near(row.modeledAssets, 180);
  near(row.beforeRatio, 20);
  near(row.afterRatio, (20 / 180) * 100);
  near(row.impactPct, -50);
  assert.equal(row.noncashCapacityVerified, true);
});
test("nonpositive equity retains dollar and accounting ratios, without misleading percentage loss", () => {
  const c = company();
  c.metrics.stockholdersEquity = point(-10, "stockholdersEquity", 1, "instant");
  const result = run([c], { scenarioId: "assets" }),
    row = result.rows[0];
  near(row.modeled, -14);
  assert.equal(row.impactPct, null);
  assert.equal(result.summary.medianImpactPct, null);
  assert.equal(result.summary.impactMeasuredCount, 0);
  assert.equal(row.alreadyNegative, true);
  assert.ok(row.afterRatio < row.beforeRatio);
});
test("asset loss cannot consume cash, while absent cash explicitly leaves the ceiling unverified", () => {
  const c = company();
  c.metrics.cash = point(199, "cash", 1, "instant");
  assert.match(
    run([c], { scenarioId: "assets" }).exclusions[0].reason,
    /exceeds reported assets less cash/,
  );
  delete c.metrics.cash;
  const row = run([c], { scenarioId: "assets" }).rows[0];
  assert.equal(row.noncashCapacityVerified, false);
  assert.match(row.notes[0], /cannot be verified/);
});
test("wrong lens is distinct from missing evidence and bank assets are supported", () => {
  const c = company(1, { lens: "banking" });
  const operating = run([c]);
  assert.equal(operating.coverage.eligibleCount, 0);
  assert.equal(operating.coverage.notApplicableCount, 1);
  assert.equal(operating.coverage.unavailableCount, 0);
  assert.equal(run([c], { scenarioId: "assets" }).rows.length, 1);
});
test("blank, boolean, nonnumeric, out-of-range and invalid selections never silently become defaults", () => {
  for (const revenuePct of [
    "",
    " ",
    true,
    null,
    "oops",
    "0x10",
    Infinity,
    -51,
    51,
  ])
    assert.equal(run(undefined, { revenuePct }).rows.length, 0);
  near(run(undefined, { revenuePct: "0" }).rows[0].modeled, 20);
  assert.ok(run(undefined, { scenarioId: "made-up" }).errors.length);
  assert.ok(
    run(undefined, { scope: "company", targetCik: cik(999) }).errors.length,
  );
  assert.ok(
    run(undefined, { scope: "sector", targetSector: "Missing" }).errors.length,
  );
  assert.ok(run(undefined, { now: "invalid" }).errors.length);
});
test("different full periods, observation kinds and future source dates are rejected", () => {
  for (const mutate of [
    (c) => {
      c.metrics.operatingIncome.period.start = "2025-04-01";
    },
    (c) => {
      c.metrics.operatingIncome.observationPeriod.kind = "instant";
    },
    (c) => {
      c.metrics.operatingIncome.sources[0].filed = "2027-02-01";
    },
    (c) => {
      c.metrics.operatingIncome.sources[0].value = 999;
    },
    (c) => {
      c.metrics.operatingIncome.unit = "EUR";
    },
    (c) => {
      c.metrics.operatingIncome.period.end = "2025-02-30";
    },
    (c) => {
      delete c.metrics.operatingIncome.observationPeriod;
    },
    (c) => {
      c.metrics.operatingIncome.period.asOf = "2026-01-01";
    },
  ]) {
    const c = company();
    mutate(c);
    assert.equal(run([c]).rows.length, 0);
  }
});
test("actual SEC issuer and accession evidence must agree, including filing-agent accessions", () => {
  for (const url of [
    "https://evil.example/Archives/edgar/data/1/000000000126000001/a.htm",
    "https://www.sec.gov/Archives/edgar/data/2/000000000126000001/a.htm",
    "https://www.sec.gov/Archives/edgar/data/1/000000000126999999/a.htm",
    "https://www.sec.gov.evil.example/Archives/edgar/data/1/000000000126000001/a.htm",
  ]) {
    const c = company();
    c.metrics.operatingIncome.sources[0].documentUrl = url;
    assert.equal(run([c]).rows.length, 0);
  }
  const c = company(),
    source = c.metrics.operatingIncome.sources[0];
  source.accession = "0001193125-26-000001";
  source.documentUrl =
    "https://www.sec.gov/Archives/edgar/data/1/000119312526000001/a.htm";
  assert.equal(run([c]).rows.length, 1);
});
test("verified predecessor evidence is preserved and unverified predecessor data is rejected", () => {
  const c = company(2),
    source = c.metrics.operatingIncome.sources[0];
  source.documentUrl =
    "https://www.sec.gov/Archives/edgar/data/1/000000000226000001/a.htm";
  source.sourceCik = cik(1);
  assert.equal(run([c]).rows.length, 0);
  c.evidenceContinuity = {
    currentCik: cik(2),
    predecessorCiks: [cik(1)],
    factSourceCiks: [cik(1), cik(2)],
  };
  assert.equal(run([c]).rows.length, 1);
  c.evidenceContinuity.factSourceCiks = [cik(2)];
  assert.equal(run([c]).rows.length, 0);
});
test("an arbitrary calculation trail cannot legitimize a value that differs from its SEC inputs", () => {
  const c = company(),
    p = c.metrics.revenue;
  p.classification = "derived";
  p.value = 110;
  assert.equal(run([c]).rows.length, 0);
  p.calculations = [
    { formula: "compatible input combination", inputs: ["revenue"] },
  ];
  assert.equal(run([c]).rows.length, 0);
  p.formula = "some formula";
  assert.equal(run([c]).rows.length, 0);
});
function quarterlyProducer(latestQuarter = 3, basis = "quarter") {
  const specs = [
    {
      year: 2024,
      fp: "Q3",
      end: "2024-09-30",
      filed: "2024-11-01",
      values: [350, 70, 140, 40],
    },
    {
      year: 2024,
      fp: "FY",
      end: "2024-12-31",
      filed: "2025-02-01",
      values: [500, 100, 200, 60],
    },
    {
      year: 2025,
      fp: "Q1",
      end: "2025-03-31",
      filed: "2025-05-01",
      values: [100, 20, 40, 10],
    },
    {
      year: 2025,
      fp: "Q2",
      end: "2025-06-30",
      filed: "2025-08-01",
      values: [230, 43, 100, 25],
    },
    {
      year: 2025,
      fp: "Q3",
      end: "2025-09-30",
      filed: "2025-11-01",
      values: [390, 61, 170, 44],
    },
  ].filter(
    (item) => item.year < 2025 || Number(item.fp.slice(1)) <= latestQuarter,
  );
  const tags = [
    "Revenues",
    "OperatingIncomeLoss",
    "NetCashProvidedByUsedInOperatingActivities",
    "PaymentsToAcquirePropertyPlantAndEquipment",
  ];
  const facts = {
    "us-gaap": Object.fromEntries(
      tags.map((tag, index) => [
        tag,
        {
          units: {
            USD: specs.map((item) => ({
              val: item.values[index],
              start: `${item.year}-01-01`,
              end: item.end,
              filed: item.filed,
              fp: item.fp,
              fy: item.year,
              form: item.fp === "FY" ? "10-K" : "10-Q",
              accn: `${cik(1)}-${item.filed.slice(2, 4)}-00000${item.fp === "FY" ? 4 : item.fp.slice(1)}`,
            })),
          },
        },
      ]),
    ),
  };
  return buildPortfolioCompany(
    {
      cik: cik(1),
      ticker: "C1",
      companyName: "Company 1",
      kind: "company",
      sic: "3571",
      facts,
      filings: [],
    },
    { basis, retrievedAt: NOW },
  );
}
test("actual Q2 and Q3 producer root formulas with empty calculations are reconciled and retained", () => {
  for (const quarter of [2, 3]) {
    const c = quarterlyProducer(quarter),
      p = c.metrics.operatingCashFlow;
    assert.equal(p.classification, "calculated");
    assert.equal(
      p.formula,
      "Current cumulative value − prior cumulative value",
    );
    assert.deepEqual(p.calculations, []);
    const result = run([c], { scenarioId: "cash" }),
      row = result.rows[0];
    assert.equal(result.rows.length, 1, JSON.stringify(result.exclusions));
    near(row.baseline, quarter === 2 ? 45 : 51);
    near(row.modeled, quarter === 2 ? 33 : 37);
    const evidence = row.evidence[0];
    assert.equal(evidence.formula, p.formula);
    assert.equal(evidence.calculations.at(-1).value, p.value);
    assert.equal(
      evidence.calculations.at(-1).start,
      quarter === 2 ? "2025-04-01" : "2025-07-01",
    );
    assert.equal(
      evidence.calculationVerification,
      "Recomputed from captured SEC inputs",
    );
    assert.equal(evidence.sources[0].linkKind, "filing-index");
    assert.equal(evidence.sources[0].linkLabel, "SEC filing index");
    p.value += 1;
    assert.equal(run([c], { scenarioId: "cash" }).rows.length, 0);
  }
});
test("actual four-quarter producer totals are recomputed with intermediate cumulative differences", () => {
  const c = quarterlyProducer(3, "ttm"),
    p = c.metrics.operatingCashFlow;
  assert.equal(p.formula, "Sum of four consecutive standalone quarters");
  assert.equal(p.value, 230);
  const result = run([c], { scenarioId: "cash" });
  assert.equal(result.rows.length, 1, JSON.stringify(result.exclusions));
  near(result.rows[0].baseline, 166);
  near(result.rows[0].modeled, 120);
  p.value += 1;
  assert.equal(run([c], { scenarioId: "cash" }).rows.length, 0);
  p.value -= 1;
  p.calculations[0].value += 1;
  assert.equal(run([c], { scenarioId: "cash" }).rows.length, 0);
});
test("SEC filing-index links require the exact issuer, accession and trailing directory slash", () => {
  const c = company(),
    source = c.metrics.operatingIncome.sources[0];
  source.documentUrl = `https://www.sec.gov/Archives/edgar/data/1/${source.accession.replaceAll("-", "")}/`;
  const row = run([c]).rows[0];
  assert.equal(row.evidence[1].sources[0].linkKind, "filing-index");
  source.documentUrl = source.documentUrl.slice(0, -1);
  assert.equal(run([c]).rows.length, 0);
  source.documentUrl =
    "https://www.sec.gov/Archives/edgar/data/2/000000000126000001/";
  assert.equal(run([c]).rows.length, 0);
  source.documentUrl =
    "https://www.sec.gov/Archives/edgar/data/1/000000000126999999/";
  assert.equal(run([c]).rows.length, 0);
});
test("coverage counts unique companies and never weights financial calculations", () => {
  const companies = [company(1), company(2)],
    weighted = report(companies, [70, 30]);
  const list = run(companies),
    allocated = run(companies, {}, weighted);
  assert.deepEqual(
    allocated.rows.map((row) => row.modeled),
    list.rows.map((row) => row.modeled),
  );
  near(allocated.coverage.coveredWeightPct, 100);
  weighted.concentration.issuers.push(clone(weighted.concentration.issuers[0]));
  assert.equal(run(companies, {}, weighted).coverage.modeledCount, 2);
  weighted.concentration.complete = false;
  assert.equal(run(companies, {}, weighted).coverage.coveredWeightPct, null);
  assert.equal(
    run(companies, { scope: "sector", targetSector: "Industrials" }).rows[0]
      .cik,
    cik(2),
  );
});
test("ambiguous duplicate snapshots do not silently choose an issuer's last values", () => {
  const c = company(),
    duplicate = clone(c);
  duplicate.metrics.revenue.value = 200;
  const result = run([c, duplicate]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.exclusions[0].code, "identity");
});
test("numeric overflow is excluded and complete allocated coverage does not normalize missing evidence", () => {
  const c = company();
  c.metrics.revenue = point(Number.MAX_VALUE, "revenue");
  c.metrics.operatingIncome = point(Number.MAX_VALUE / 2, "operatingIncome");
  assert.equal(
    run([c], { scenarioId: "recovery", revenuePct: 50 }).rows.length,
    0,
  );
  const companies = [company(1), company(2)];
  delete companies[1].metrics.operatingIncome;
  const result = run(companies, {}, report(companies, [70, 30]));
  near(result.coverage.coveredWeightPct, 70);
  near(result.coverage.excludedWeightPct, 30);
  assert.equal(result.coverage.modeledCount, 1);
  assert.equal(result.coverage.unavailableCount, 1);
});
test("real captured demo supplies issuer-linked scenarios and non-finite values never enter summaries", () => {
  const raw = JSON.parse(
    readFileSync(
      new URL(
        "../public/portfolio/portfolio-demo-100-results.json",
        import.meta.url,
      ),
    ),
  );
  const companies = unpackPortfolioSnapshot(raw.snapshot).companies;
  for (const scenarioId of [
    "demand",
    "cost",
    "combined",
    "recovery",
    "cash",
    "assets",
  ]) {
    const result = run(companies, { scenarioId });
    assert.ok(
      result.rows.length >= (scenarioId === "assets" ? 95 : 50),
      `${scenarioId}: ${result.rows.length} rows`,
    );
    assert.equal(result.coverage.includedCount, 100);
    assert.equal(result.rows.length + result.exclusions.length, 100);
    assert.equal(result.coverage.coveredWeightPct, null);
    for (const row of result.rows) {
      assert.ok(Number.isFinite(row.baseline) && Number.isFinite(row.modeled));
      for (const key of ["impactPct", "beforeRatio", "afterRatio"])
        assert.ok(row[key] === null || Number.isFinite(row[key]));
      near(
        row.components.reduce((sum, item) => sum + item.value, 0) / 1e9,
        row.change / 1e9,
      );
    }
  }
});
