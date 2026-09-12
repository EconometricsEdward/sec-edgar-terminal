import test from "node:test";
import assert from "node:assert/strict";
import {
  PORTFOLIO_REPORTING_BASES,
  portfolioPeriodKey,
  portfolioPeriodLabel,
  samePortfolioPeriod,
  portfolioPeriodLengthGroup,
  portfolioFiscalQuarter,
} from "../src/utils/portfolioReporting.js";
import {
  normalizePortfolioInput,
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import { parsePortfolioJson } from "../src/utils/portfolioFiles.js";
import {
  createPortfolio,
  writePortfolio,
  readPortfolios,
  PORTFOLIOS_KEY,
  validatePortfolio,
} from "../src/utils/portfolioStorage.js";
import {
  exportResearchBackup,
  parseResearchBackup,
  restoreResearchVault,
} from "../src/utils/researchVault.js";
import {
  createPortfolioBaseline,
  validatePortfolioBaseline,
} from "../src/utils/portfolioChanges.js";
import {
  packPortfolioSnapshot,
  unpackPortfolioSnapshot,
} from "../src/utils/portfolioEvidenceCodec.js";
import { researchPortfolioRows } from "../src/utils/portfolioClient.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import {
  portfolioAvailableMetrics,
  portfolioResearchIssuers,
  portfolioMetricPeerOptions,
  rankPortfolioMetric,
} from "../src/utils/portfolioDeepResearch.js";
import { buildCashEarnings } from "../src/utils/portfolioCashEarnings.js";
import {
  portfolioComparisonProfile,
  comparePortfolioProfiles,
} from "../src/utils/portfolioComparison.js";
import {
  buildPortfolioResearchPackage,
  portfolioCsv,
  portfolioMarkdown,
} from "../src/utils/portfolioExports.js";

const now = "2026-09-12T12:00:00.000Z";
const cik = "0000000001";
const url = "https://www.sec.gov/Archives/edgar/data/1/report.htm";
const windows = {
  annual: { kind: "annual", start: "2025-01-01", end: "2025-12-31" },
  quarter: {
    kind: "quarter",
    start: "2026-04-01",
    end: "2026-06-30",
    fp: "Q2",
  },
  ytd: { kind: "ytd", start: "2026-01-01", end: "2026-06-30", fp: "Q2" },
  ttm: { kind: "ttm", start: "2025-07-01", end: "2026-06-30" },
};
const rows = resolvePortfolioRows(createPortfolioRows([{ ticker: "TEST" }]), {
  TEST: { cik, name: "Test company" },
});
const input = (basis) => ({
  schema_version: "edgar.portfolio.v1",
  holdings: [{ ticker: "TEST" }],
  research: { basis },
});
const point = (basis, value, unit = "USD") => ({
  value,
  unit,
  classification: "reported",
  period: { ...windows[basis] },
  sources: [{ documentUrl: url, taxonomy: "us-gaap", tag: "NetIncomeLoss" }],
  calculations: [],
});
const company = (basis) => ({
  cik,
  ticker: "TEST",
  name: "Test company",
  kind: "company",
  status: "ready",
  lens: "corporate",
  sic: "3571",
  basis,
  retrievedAt: now,
  period: { ...windows[basis] },
  cache: { status: "fresh", storedAt: now },
  metrics: {
    netIncome: point(basis, 10),
    operatingCashFlow: point(basis, 0),
    netMargin: {
      ...point(basis, 10, "%"),
      formula: "100 × net income / revenue",
    },
  },
  filings: [],
});
const snapshot = (basis, companies = [company(basis)]) => ({
  schema_version: "edgar.portfolio.v1",
  generated_at: now,
  basis,
  companies,
});
function document(basis) {
  const captured = snapshot(basis);
  return createPortfolio({
    id: `portfolio-${basis}`,
    name: "Period research",
    rows,
    research: { basis },
    snapshot: captured,
    comparisonBaseline: createPortfolioBaseline(captured),
    now,
  });
}
function storage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

test("all four reporting bases survive canonical input, JSON import, compact evidence, reload and backup restore", () => {
  const browser = storage();
  for (const basis of PORTFOLIO_REPORTING_BASES) {
    assert.equal(normalizePortfolioInput(input(basis)).research.basis, basis);
    assert.equal(
      parsePortfolioJson(JSON.stringify(input(basis))).metadata.research.basis,
      basis,
    );
    const original = document(basis);
    assert.deepEqual(
      unpackPortfolioSnapshot(packPortfolioSnapshot(original.snapshot)),
      original.snapshot,
    );
    writePortfolio(browser, { mode: "create", portfolio: original, now });
  }
  const saved = readPortfolios(browser.getItem(PORTFOLIOS_KEY));
  const target = storage();
  restoreResearchVault(
    target,
    parseResearchBackup(exportResearchBackup(browser, now)),
    [PORTFOLIOS_KEY],
    exportResearchBackup(target, now),
  );
  assert.deepEqual(readPortfolios(target.getItem(PORTFOLIOS_KEY)), saved);
  for (const captured of saved.portfolios) {
    const basis = captured.research.basis;
    assert.equal(captured.snapshot.basis, basis);
    assert.deepEqual(
      captured.snapshot.companies[0].metrics.netIncome.period,
      windows[basis],
    );
    assert.equal(captured.comparisonBaseline.basis, basis);
  }
  assert.equal(
    saved.version,
    1,
    "Existing storage schema stays backward compatible",
  );
});

test("unsupported reporting bases are rejected at input, import, saved document and comparison checkpoint boundaries", async () => {
  for (const basis of ["monthly", "latest", "", null]) {
    assert.throws(
      () => normalizePortfolioInput(input(basis)),
      /research.basis/,
    );
    if (basis !== null)
      assert.throws(
        () => parsePortfolioJson(JSON.stringify(input(basis))),
        /Research basis/,
      );
    const invalid = document("annual");
    invalid.research.basis = basis;
    assert.throws(() => validatePortfolio(invalid), /reporting settings/);
    const baseline = createPortfolioBaseline(snapshot("annual"));
    baseline.basis = basis;
    assert.throws(() => validatePortfolioBaseline(baseline), /reporting basis/);
    await assert.rejects(
      researchPortfolioRows(rows, {
        basis,
        fetcher: () => {
          throw new Error("Must not fetch");
        },
      }),
      /Choose annual/,
    );
  }
});

test("browser research preserves requested quarterly and YTD bases and never retains evidence from a different basis", async () => {
  for (const basis of PORTFOLIO_REPORTING_BASES) {
    const researched = await researchPortfolioRows(rows, {
      basis,
      fetcher: async (_url, options) => {
        assert.equal(JSON.parse(options.body).research.basis, basis);
        return {
          ok: true,
          json: async () => ({ basis, companies: [company(basis)] }),
        };
      },
    });
    assert.equal(researched.companies[0].basis, basis);
  }
  const failed = await researchPortfolioRows(rows, {
    basis: "ytd",
    previousCompanies: [company("annual")],
    onlyFailed: true,
    fetcher: async () => {
      throw new Error("Temporary failure");
    },
  });
  assert.equal(
    failed.completed,
    1,
    "Changing basis must still fetch a previously successful company",
  );
  assert.equal(failed.companies[0].status, "failed");
  assert.deepEqual(failed.companies[0].metrics, {});
  const mismatched = await researchPortfolioRows(rows, {
    basis: "quarter",
    fetcher: async () => ({
      ok: true,
      json: async () => ({ basis: "annual", companies: [company("annual")] }),
    }),
  });
  assert.equal(mismatched.companies[0].status, "failed");
  assert.match(
    mismatched.companies[0].warnings[0],
    /different reporting basis/,
  );
});

test("quarterly and YTD rankings support exact windows without treating instant balances as flows", () => {
  const companies = [
    company("quarter"),
    { ...company("ytd"), cik: "0000000002", ticker: "OTHER" },
  ];
  const portfolioRows = resolvePortfolioRows(
    createPortfolioRows([{ ticker: "TEST" }, { ticker: "OTHER" }]),
    {
      TEST: { cik, name: "Test company" },
      OTHER: { cik: "0000000002", name: "Other company" },
    },
  );
  const report = buildPortfolioAnalytics(
    portfolioRows,
    { basis: "none" },
    companies,
  );
  assert.equal(
    portfolioAvailableMetrics(companies).find(
      (metric) => metric.key === "netMargin",
    ).availableCount,
    2,
  );
  for (const basis of ["quarter", "ytd"]) {
    const ranked = rankPortfolioMetric(report, companies, {
      metricId: "netMargin",
      period: portfolioPeriodKey(windows[basis]),
    });
    assert.equal(ranked.rows.filter((row) => row.rank !== null).length, 1);
    assert.equal(
      ranked.rows.find((row) => row.rank === 1).point.period.kind,
      basis,
    );
  }
  assert.equal(portfolioPeriodKey({ kind: "instant", end: "2026-06-30" }), "");
  assert.equal(
    portfolioPeriodKey({ ...windows.quarter, start: "2026-02-30" }),
    "",
  );
  assert.equal(samePortfolioPeriod(windows.quarter, windows.ytd), false);
  assert.equal(
    samePortfolioPeriod(windows.ytd, { ...windows.ytd, start: "2026-04-01" }),
    false,
  );
  assert.equal(
    portfolioPeriodLabel({ kind: "instant", end: "2026-06-30" }),
    "As of 2026-06-30",
  );
});

test("cash/earnings and saved portfolio differences pair quarterly and YTD observations only on identical full windows", () => {
  for (const basis of ["quarter", "ytd"]) {
    const a = document(basis),
      b = document(basis);
    b.snapshot.companies[0].metrics.netMargin.value = 15;
    const compare = () =>
      comparePortfolioProfiles(
        portfolioComparisonProfile(a),
        portfolioComparisonProfile(b),
      );
    assert.equal(compare().financial.medianDifference, 5);
    b.snapshot.companies[0].metrics.netMargin.period.start = "2026-05-01";
    assert.equal(compare().financial.pairedCount, 0);
    const companies = [company(basis)];
    const cash = () =>
      buildCashEarnings(
        buildPortfolioAnalytics(rows, { basis: "none" }, companies),
        companies,
      );
    assert.equal(cash().count, 1);
    assert.equal(cash().cells[1].observations[0].operatingCashFlow, 0);
    companies[0].metrics.operatingCashFlow.period.start = "2026-05-01";
    assert.equal(cash().excluded.period, 1);
    companies[0].metrics.operatingCashFlow.period = {
      kind: "instant",
      end: "2026-06-30",
    };
    assert.equal(cash().excluded.period, 1);
  }
});

test("YTD peer filters group elapsed fiscal months from dates rather than a later filing's fiscal tag", () => {
  const companies = [
    company("ytd"),
    { ...company("ytd"), cik: "0000000002", ticker: "OTHER" },
  ];
  const short = {
    kind: "ytd",
    start: "2026-04-01",
    end: "2026-06-30",
    fp: "Q2",
  };
  companies[1].period = short;
  for (const metric of Object.values(companies[1].metrics))
    metric.period = short;
  const portfolioRows = resolvePortfolioRows(
    createPortfolioRows([{ ticker: "TEST" }, { ticker: "OTHER" }]),
    {
      TEST: { cik, name: "Test company" },
      OTHER: { cik: "0000000002", name: "Other company" },
    },
  );
  const report = buildPortfolioAnalytics(
    portfolioRows,
    { basis: "none" },
    companies,
  );
  assert.equal(portfolioPeriodLengthGroup(short), "3m");
  assert.equal(
    portfolioFiscalQuarter(short),
    "Q1",
    "YTD uses elapsed period, not a later filing's Q2 tag",
  );
  assert.equal(portfolioPeriodLengthGroup(windows.ytd), "6m");
  assert.equal(portfolioPeriodLengthGroup(windows.quarter), null);
  assert.equal(portfolioFiscalQuarter(windows.quarter), "Q2");
  assert.equal(
    portfolioPeriodLengthGroup({ ...windows.ytd, start: "2026-06-01" }),
    null,
  );
  const ranked = rankPortfolioMetric(report, companies, {
    metricId: "netMargin",
    durationGroup: "6m",
  });
  assert.equal(ranked.rows.length, 1);
  assert.equal(ranked.rows[0].cik, cik);
  const peers = portfolioMetricPeerOptions(
    portfolioResearchIssuers(report, companies),
    { metricId: "netMargin", durationGroup: "3m" },
  );
  assert.equal(
    peers.sectors.reduce((total, sector) => total + sector.count, 0),
    1,
  );
});

test("CSV and Markdown exports retain fiscal YTD and quarterly window starts as well as ends", () => {
  for (const basis of ["quarter", "ytd"]) {
    const bundle = buildPortfolioResearchPackage(document(basis));
    assert.equal(bundle.reporting_basis, basis);
    const label = portfolioPeriodLabel(windows[basis]);
    assert.ok(portfolioCsv(bundle).includes(label));
    assert.ok(portfolioMarkdown(bundle).includes(label));
  }
});
