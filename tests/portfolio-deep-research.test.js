import { packPortfolioBaseline, unpackPortfolioBaseline } from "../src/utils/portfolioBaselineCodec.js";
import { createPortfolioBaseline, validatePortfolioBaseline, comparePortfolioResearch } from "../src/utils/portfolioChanges.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import { buildPortfolioResearchPackage } from "../src/utils/portfolioExports.js";
import {
  rankPortfolioMetric,
  portfolioConnections,
  metricPeriodKey,
} from "../src/utils/portfolioDeepResearch.js";
import {
  packPortfolioSnapshot,
  unpackPortfolioSnapshot,
} from "../src/utils/portfolioEvidenceCodec.js";
import {
  enrichPortfolioReport,
  portfolioReportHtml,
} from "../src/utils/portfolioReport.js";
import {
  portfolioSourceIssuers,
  mergePortfolioFilingRows,
  portfolioSourceJson,
  researchPause,
} from "../src/utils/portfolioSourceResearch.js";
const cik = (n) => String(n).padStart(10, "0");
const period = { kind: "annual", start: "2025-01-01", end: "2025-12-31" };
const point = (value, unit = "%", extra = {}) => ({
  value,
  unit,
  classification: "reported",
  period,
  sources: [],
  calculations: [],
  ...extra,
});
const company = (n, metrics = {}, extra = {}) => ({
  cik: cik(n),
  ticker: `C${n}`,
  name: `Company ${n}`,
  kind: "company",
  status: "ready",
  lens: "corporate",
  sic: 3571,
  period,
  metrics,
  ...extra,
});
function fixture(companies) {
  const directory = Object.fromEntries(
    companies.map((c) => [c.ticker, { cik: c.cik, name: c.name }]),
  );
  const rows = resolvePortfolioRows(
    createPortfolioRows(companies.map((c) => ({ ticker: c.ticker }))),
    directory,
  );
  return {
    rows,
    report: buildPortfolioAnalytics(rows, { basis: "none" }, companies),
  };
}
test("rankings retain zero and ties, exclude missing/incompatible observations, and filter full periods", () => {
  const companies = [
    company(1, { netMargin: point(10) }),
    company(2, { netMargin: point(10) }),
    company(3, { netMargin: point(0) }),
    company(4, { netMargin: point(null) }),
    company(5, { netMargin: point(900, "USD") }),
    company(6, { netMargin: point(20) }, { lens: "unknown", status: "failed" }),
  ];
  const { report } = fixture(companies);
  const r = rankPortfolioMetric(report, companies, { metricId: "netMargin" });
  assert.equal(r.available, 3);
  assert.equal(r.median, 10);
  assert.deepEqual(
    r.rows.slice(0, 3).map((r) => r.rank),
    [1, 1, 3],
  );
  assert.equal(r.rows.find((r) => r.cik === cik(6)).state, "unavailable");
  assert.equal(
    rankPortfolioMetric(report, companies, {
      period: "annual|2024-01-01|2024-12-31",
    }).available,
    0,
  );
  const bank = company(7, { currentRatio: point(2, "x") }, { lens: "banking" });
  assert.equal(
    rankPortfolioMetric(fixture([bank]).report, [bank], {
      metricId: "currentRatio",
    }).rows[0].state,
    "not-applicable",
  );
});
test("connected findings require correct units, valid dates, matched periods, and appropriate businesses", () => {
  const badPeriod = { ...period, start: "2024-01-01", end: "2024-12-31" };
  const companies = [
    company(1, {
      cashAfterReturns: point(-10, "USD"),
      revenueGrowth: point(10),
      netMargin: point(-2),
    }),
    company(2, {
      cashAfterReturns: point(-10, "%"),
      revenueGrowth: point(10),
      netMargin: point(-2, "%", { period: badPeriod }),
    }),
    company(3, { loanDeposits: point(150, "USD") }, { lens: "banking" }),
    company(4, { loanDeposits: point(110) }, { lens: "banking" }),
  ];
  const r = portfolioConnections(fixture(companies).report, companies);
  assert.equal(r.groups.find((g) => g.id === "cash-uses").eligible, 1);
  assert.equal(r.groups.find((g) => g.id === "growth-loss").count, 1);
  assert.equal(r.groups.find((g) => g.id === "bank-funding").count, 1);
  assert.equal(
    metricPeriodKey(
      point(1, "USD", { period: { kind: "garbage", end: "not-a-date" } }),
    ),
    "",
  );
  assert.equal(
    metricPeriodKey(
      point(1, "USD", { period: { ...period, start: "2025-02-30" } }),
    ),
    "",
  );
  assert.equal(
    metricPeriodKey(
      point(1, "USD", { period: { ...period, start: undefined } }),
    ),
    "",
  );
  const drivers = Array.from({ length: 4 }, (_, i) =>
    company(i + 10, {
      dupontRoe: point(10 + i),
      equityMultiplier: point(2 + i, "x"),
      assetTurnover: point(1, "x"),
      netMargin: point(20, "%", i === 3 ? { period: badPeriod } : {}),
    }),
  );
  const d = portfolioConnections(fixture(drivers).report, drivers).groups.find(
    (g) => g.id === "roe-corporate",
  );
  assert.equal(d.paired, 3);
  assert.equal(d.count, 0);
});
test("evidence pooling round trips every value, missing field, source, formula and period", () => {
  const source = {
    tag: "NetIncomeLoss",
    value: 10,
    documentUrl: "https://www.sec.gov/Archives/edgar/data/1/report.htm",
  };
  const snapshot = {
    companies: Array.from({ length: 100 }, (_, i) =>
      company(i + 1, {
        netIncome: point(10, "USD", { sources: [source] }),
        netMargin: point(10, "%", { sources: [source] }),
        cashAfterReturns: point(null, "USD", {
          reason: "Missing shareholder returns",
        }),
      }),
    ),
  };
  const packed = JSON.parse(JSON.stringify(packPortfolioSnapshot(snapshot)));
  assert.deepEqual(unpackPortfolioSnapshot(packed), snapshot);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(snapshot).length);
  const invalid = structuredClone(packed);
  invalid.companies[0].metrics.netIncome.templateId = 999999;
  assert.throws(() => unpackPortfolioSnapshot(invalid), /template reference/);
  const amplification = structuredClone(packed);
  amplification.companies[0].sourcePool[0].tag = "x".repeat(20000);
  for (const c of amplification.companies) {
    c.sourcePool = amplification.companies[0].sourcePool;
    c.metrics.netIncome.sourceIds = Array(100).fill(0);
  }
  assert.throws(() => unpackPortfolioSnapshot(amplification), /memory budget/);
});
test("report uses selected issuer denominators, honors privacy and excludes stale outside-portfolio research", () => {
  const companies = [
    company(1, { netMargin: point(10) }),
    company(2, { netMargin: point(20) }),
  ];
  const { rows } = fixture(companies);
  rows[0].input.notes = "private-note-marker";
  const bundle = buildPortfolioResearchPackage(
    {
      name: '<img src=x onerror="bad">',
      rows,
      allocation: { basis: "none" },
      snapshot: {
        companies,
        generated_at: "2026-09-11T00:00:00Z",
        basis: "annual",
      },
    },
    {
      includeNotes: false,
      includeAllocations: false,
      selectedRowIds: [rows[0].id],
    },
  );
  const extras = {
    filingHistory: { [cik(2)]: { cik: cik(2), filings: [] } },
    disclosures: {
      settings: { query: "<script>bad</script>", ciks: [cik(1), cik(2)] },
      companies: [
        { cik: cik(1), filings: [] },
        { cik: cik(2), filings: [] },
      ],
      quotes: [],
    },
    fundOwnership: [{ target: { query: "C2" }, funds: [] }],
  };
  const result = enrichPortfolioReport(bundle, extras);
  assert.equal(result.deep_research.connections.issuerCount, 1);
  assert.equal(result.deep_research.disclosures.companies.length, 1);
  assert.equal(result.deep_research.fundOwnership.length, 0);
  assert.deepEqual(result.deep_research.filingHistory, {});
  const html = portfolioReportHtml(result);
  assert.ok(!html.includes("private-note-marker"));
  assert.ok(!html.includes("<script>bad"));
  assert.ok(html.includes("&lt;script&gt;bad"));
  assert.ok(html.includes("Print / save as PDF"));
  assert.ok(html.includes("No eligible issuers"));
});
test("source issuer scope deduplicates share classes and omits removed and fund positions", () => {
  const companies = [company(1), company(2), company(3)];
  const { rows } = fixture(companies);
  rows[1].excluded = true;
  rows[2].resolution.kind = "fund";
  assert.deepEqual(
    portfolioSourceIssuers([...rows, { ...rows[0], id: "alias" }]).map(
      (c) => c.cik,
    ),
    [cik(1)],
  );
  const filing = {
    cik: cik(1),
    accession: "0000000001-26-000001",
    filingDate: "2026-01-01",
  };
  assert.equal(
    mergePortfolioFilingRows([filing], [{ ...filing, form: "10-K" }]).length,
    1,
  );
});
test("source requests preserve Retry-After and cancellation stops queued work", async () => {
  await assert.rejects(
    portfolioSourceJson(
      "/fixture",
      undefined,
      async () =>
        new Response('{"error":"slow down"}', {
          status: 429,
          headers: { "retry-after": "90" },
        }),
    ),
    (e) => e.status === 429 && e.retryAfter === 90,
  );
  const controller = new AbortController();
  controller.abort(new Error("Stopped"));
  await assert.rejects(researchPause(1000, controller.signal), /Stopped/);
});

 test("checkpoint encoding preserves comparisons and rejects malformed references",()=>{
  const input={basis:"annual",generated_at:"2026-09-11T00:00:00Z",companies:[company(1,{netIncome:point(10,"USD")})]};
  const baseline=createPortfolioBaseline(input);const encoded=packPortfolioBaseline(baseline);
  assert.deepEqual(unpackPortfolioBaseline(encoded),baseline);assert.deepEqual(validatePortfolioBaseline(encoded),baseline);
  assert.deepEqual(comparePortfolioResearch(encoded,input,fixture(input.companies).rows),comparePortfolioResearch(baseline,input,fixture(input.companies).rows));
  const invalid=structuredClone(encoded);invalid.companies[0].metrics.netIncome[1]=999999;assert.throws(()=>validatePortfolioBaseline(invalid),/reference/);
 });

test("metric coverage separates old captures, missing facts, business scope, units and periods", async () => {
  const { portfolioMetricCoverage, portfolioResearchIssuers, portfolioCaptureCoverage } = await import('../src/utils/portfolioDeepResearch.js');
  const { ANALYSIS_VERSION } = await import('../src/utils/analysisVersion.js');
  const companies = [
    company(1, { accountsPayable: point(0, 'USD') }, { analysisVersion: ANALYSIS_VERSION }),
    company(2),
    company(3, { accountsPayable: point(null, 'USD', { reason: 'Separate payable subtotal is not reported.' }) }, { analysisVersion: ANALYSIS_VERSION }),
    company(4, { accountsPayable: point(10, '%') }),
    company(5, { accountsPayable: point(10, 'USD', { period: null }) }),
    company(6, {}, { lens: 'banking', analysisVersion: ANALYSIS_VERSION }),
  ];
  const { report } = fixture(companies);
  const issuers = portfolioResearchIssuers(report, companies);
  const coverage = portfolioMetricCoverage(issuers).find(d => d.key === 'accountsPayable');
  const result = rankPortfolioMetric(report, companies, { metricId: 'accountsPayable' });
  assert.equal(coverage.available, result.available);
  assert.equal(result.available, 1);
  assert.equal(result.median, 0);
  assert.deepEqual(coverage.reasons, { 'not-captured':1, 'missing-inputs':1, 'incompatible-unit':1, 'unknown-period':1, 'not-applicable':1 });
  assert.match(result.rows.find(r => r.cik === cik(3)).reason, /Separate payable/);
  assert.equal(portfolioCaptureCoverage(issuers).legacy, 3);
  assert.equal(portfolioMetricCoverage(issuers, {period: 'annual|2024-01-01|2024-12-31'}).find(d=>d.key==='accountsPayable').reasons['outside-period'], 1);
});

test("old G&A-only observations cannot enter SG&A rankings or measured report cards", () => {
  const companies = [company(1, {sga: point(123,'USD',{sources:[{tag:'GeneralAndAdministrativeExpense'}]})})];
  const {rows, report} = fixture(companies);
  const result = rankPortfolioMetric(report, companies, {metricId:'sga'});
  assert.equal(result.available,0);
  assert.equal(result.reasons['incomplete-scope'],1);
  const bundle = buildPortfolioResearchPackage({name:'Scope check',rows,allocation:{basis:'none'},snapshot:{companies,basis:'annual',generated_at:'2026-09-11T00:00:00Z'}});
  const enriched = enrichPortfolioReport(bundle);
  assert.equal(enriched.companies[0].metrics.sga.value,123, 'raw captured evidence remains intact');
  const html = portfolioReportHtml(enriched);
  assert.doesNotMatch(html, /<h4>SG&amp;A Expense:/);
  assert.match(html, /general and administrative expense alone/);
});
