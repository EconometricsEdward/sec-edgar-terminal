import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoPortfolio } from "../src/utils/portfolioDemo.js";
import { unpackPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import { buildCatalogReport } from "../src/utils/portfolioEnrichment.js";
import { augmentPortfolioCompanyMetrics } from "../src/utils/financialSupplementalMetrics.js";
import {
  buildPortfolioFinancialProfile,
  resolveFinancialProfileMetricLens,
} from "../src/utils/portfolioFinancialProfile.js";
const require = createRequire(import.meta.url),
  ts = require("typescript");
function component(file) {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), file),
    localRequire = createRequire(path);
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const testModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name) => {
      if (name.endsWith(".css")) return {};
      if (name.endsWith("download.js")) return { downloadText: () => {} };
      if (
        name.startsWith(".") &&
        existsSync(resolve(dirname(path), `${name}.tsx`))
      )
        return component(resolve(dirname(path), `${name}.tsx`));
      return localRequire(name);
    },
    testModule,
    testModule.exports,
  );
  return testModule.exports;
}
const demo = JSON.parse(
  readFileSync(
    new URL(
      "../public/portfolio/portfolio-demo-100-results.json",
      import.meta.url,
    ),
  ),
);
const doc = createDemoPortfolio(demo),
  companies = unpackPortfolioSnapshot(doc.snapshot).companies;
const report = buildPortfolioAnalytics(doc.rows, doc.allocation, companies, {
  capturedAt: demo.captured_at,
});
test("all five evidence-backed analysis views render actual demo results without invalid values", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioInsightTools.tsx",
  ).default;
  for (const view of [
    "weighted",
    "buffers",
    "overlap",
    "impact",
    "operating",
  ]) {
    const html = renderToStaticMarkup(
      createElement(Component, {
        report,
        companies,
        view,
        onInspect: () => {},
      }),
    );
    assert.match(html, /<table>/);
    assert.doesNotMatch(html, /NaN|Infinity|undefined/);
    assert.match(html, /Export this analysis/);
  }
});
test("expanded screener disclosure controls remain outside native select elements", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioScreener.tsx",
  ).default;
  const html = renderToStaticMarkup(
    createElement(Component, {
      report: buildCatalogReport(report, companies),
      companies,
      onInspectCompany: () => {},
      onDisclosure: () => {},
    }),
  );
  assert.match(html, /Search matching companies/);
  for (const select of html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/g))
    assert.doesNotMatch(select[1], /<(?:p|div|details|button|input)\b/);
});
test("multiple-shock and rebalancing workbenches render usable initial allocations", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioScenarioWorkbench.tsx",
  ).default;
  for (const view of ["mixed", "rebalance"]) {
    const html = renderToStaticMarkup(
      createElement(Component, {
        report,
        rows: doc.rows,
        settings: doc.allocation,
        companies,
        view,
        onInspect: () => {},
      }),
    );
    assert.match(html, /<table>/);
    assert.doesNotMatch(html, /NaN|Infinity|undefined/);
    assert.match(html, /100/);
  }
});
test("full-catalog peer currency differences retain currency units and compact display", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioFinancialTools.tsx",
  ).default;
  const catalog = buildCatalogReport(report, companies);
  const html = renderToStaticMarkup(
    createElement(Component, {
      report: {
        ...catalog,
        metrics: catalog.metrics.filter((metric) => metric.id === "revenue"),
      },
      view: "peers",
      onInspectCompany: () => {},
    }),
  );
  assert.match(html, /B USD/);
  assert.doesNotMatch(html, /[0-9,] x|percentage points/);
});

test("controlled financial tools keep analysis inside a concrete business model", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioFinancialTools.tsx",
  ).default;
  const catalog = buildCatalogReport(report, companies);
  const html = renderToStaticMarkup(
    createElement(Component, {
      report: catalog,
      view: "peers",
      lens: "",
      onLensChange: () => {},
      onInspectCompany: () => {},
    }),
  );

  const corporateCount = catalog.concentration.issuers.filter(
    (issuer) => issuer.kind === "company" && issuer.lens === "corporate",
  ).length;
  assert.doesNotMatch(html, /Business model|All business models/);
  assert.match(
    html,
    new RegExp(`All included operating companies \\(${corporateCount}\\)`),
  );
  assert.match(html, /Full reporting period/);
});

test("briefing renders all sector links and dated classification coverage", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioBriefing.tsx",
  ).default;
  const html = renderToStaticMarkup(
    createElement(Component, {
      report,
      onNavigate: () => {},
      onInspectCompany: () => {},
      onExploreGroup: () => {},
    }),
  );
  assert.match(html, /100 of 100 companies covered/);
  assert.match(html, /Fund-reported sectors/);
  assert.match(html, /2026-09-08/);
  assert.match(html, /aria-label="Explore Information Technology"/);
  assert.match(html, /aria-label="Explore Real Estate"/);
  assert.equal((html.match(/aria-label="Explore /g) || []).length, 11);
  assert.doesNotMatch(html, /Other groups|NaN|Infinity|undefined/);
});

test("concentration heat map renders the complete demo with accessible grouping and tile actions", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioConcentrationHeatMap.tsx",
  ).default;
  const html = renderToStaticMarkup(
    createElement(Component, {
      report,
      onInspectCompany: () => {},
      onReviewRows: () => {},
      onSelectGroup: () => {},
    }),
  );
  assert.match(html, /Concentration heat map/);
  assert.match(html, /100% mapped/);
  assert.match(html, /role="group" aria-label="Heat map grouping"/);
  assert.match(html, /aria-pressed="true">Holdings/);
  assert.match(html, /aria-label="Inspect AAPL, 5% allocation"/);
  assert.equal((html.match(/aria-label="Inspect /g) || []).length, 100);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test("financial profile overview renders the expanded demo measures, model lenses and evidence gaps", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioFinancialProfile.tsx",
  ).default;
  const augmentedCompanies = companies.map(augmentPortfolioCompanyMetrics);
  const catalog = buildCatalogReport(report, augmentedCompanies);
  const html = renderToStaticMarkup(
    createElement(Component, {
      report,
      catalogReport: catalog,
      companies: augmentedCompanies,
      capturedAt: demo.captured_at,
      onInspectCompany: () => {},
    }),
  );

  assert.match(html, /See the financial shape behind the holdings/);
  assert.match(html, /Operating companies/);
  assert.match(html, /Banks/);
  assert.match(html, /Insurers/);
  assert.match(html, /24 supported ratio measures/);
  assert.match(html, /Growth × profitability, holding by holding/);
  assert.match(html, /86 aligned companies/);
  assert.match(html, /Inspect a company in the map/);
  assert.match(html, /(?:Positive|Negative|Zero) FCF|FCF unavailable/);
  assert.equal(
    (html.match(/<circle\b[^>]*aria-hidden="true"/g) || []).length,
    86,
  );
  assert.doesNotMatch(html, /<circle\b[^>]*tabindex=/);
  assert.match(html, /Factual tests, not a composite score/);
  assert.match(html, /Operating interest coverage below 2x/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test("unweighted financial profile uses company breadth throughout overview and measures", () => {
  const profileModule = component(
    "../src/app/workspace/portfolio/PortfolioFinancialProfile.tsx",
  );
  const augmentedCompanies = companies.map(augmentPortfolioCompanyMetrics);
  const weightedCatalog = buildCatalogReport(report, augmentedCompanies);
  const catalog = {
    ...weightedCatalog,
    weighted: false,
    concentration: {
      ...weightedCatalog.concentration,
      issuers: weightedCatalog.concentration.issuers.map((issuer) => ({
        ...issuer,
        weightPct: null,
        weightComplete: false,
      })),
    },
    metrics: weightedCatalog.metrics.map((entry) => ({
      ...entry,
      observations: entry.observations.map((row) => ({
        ...row,
        weightPct: null,
        weightComplete: false,
      })),
    })),
  };
  const profile = buildPortfolioFinancialProfile(catalog, {
    lens: "corporate",
  });
  const overview = renderToStaticMarkup(
    createElement(profileModule.default, {
      report: { ...report, weighted: false },
      catalogReport: catalog,
      companies: augmentedCompanies,
      capturedAt: demo.captured_at,
      onInspectCompany: () => {},
    }),
  );
  const measures = renderToStaticMarkup(
    createElement(profileModule.MeasureExplorer, {
      profile,
      requestedMetric: "netMargin",
      onRequestedMetric: () => {},
      onInspectCompany: () => {},
    }),
  );

  assert.match(overview, /Companies represented/);
  assert.match(overview, /Company footprints/);
  assert.match(overview, /Ranked by share of measured companies/);
  assert.match(overview, /Each company has equal bubble area/);
  assert.doesNotMatch(
    overview,
    /Known allocation represented|matched original allocation|Bubble area reflects known holding weight/,
  );
  assert.match(measures, /Company average/);
  assert.match(measures, /Share of measured companies/);
  assert.match(measures, /<th scope="col">Company<\/th>/);
  assert.match(measures, /<th scope="row">/);
  assert.doesNotMatch(measures, /Allocation-weighted median|original allocation/);
});

test("financial profile consumes request nonces once and remounts tools by lens", () => {
  const source = readFileSync(
    new URL(
      "../src/app/workspace/portfolio/PortfolioFinancialProfile.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    source,
    /handledFinancialRequestNonce\.current === financialRequest\.nonce/,
  );
  assert.match(
    source,
    /handledFinancialRequestNonce\.current = financialRequest\.nonce/,
  );
  assert.match(source, /key=\{`overview:\$\{lens\}:\$\{profileRevision\}`\}/);
  assert.match(source, /key=\{`peers:\$\{lens\}:\$\{profileRevision\}`\}/);
  assert.match(source, /key=\{`health:\$\{lens\}:\$\{profileRevision\}`\}/);
  assert.match(source, /key=\{`relationships:\$\{lens\}:\$\{profileRevision\}`\}/);
  assert.match(source, /key=\{`compare:\$\{lens\}:\$\{profileRevision\}`\}/);
  assert.match(source, /<dt>Free cash flow direction<\/dt>/);
});

test("financial health scopes every reused tool to the selected business model", () => {
  const profileModule = component(
    "../src/app/workspace/portfolio/PortfolioFinancialProfile.tsx",
  );
  const augmentedCompanies = companies.map(augmentPortfolioCompanyMetrics);
  const catalog = buildCatalogReport(report, augmentedCompanies);
  const bankingProfile = buildPortfolioFinancialProfile(catalog, {
    lens: "banking",
  });
  const scope = profileModule.buildFinancialHealthScope(
    report,
    catalog,
    augmentedCompanies,
    "banking",
  );
  const bankingCiks = new Set(
    catalog.concentration.issuers
      .filter((issuer) => issuer.kind === "company" && issuer.lens === "banking")
      .map((issuer) => String(issuer.cik).padStart(10, "0")),
  );
  const html = renderToStaticMarkup(
    createElement(profileModule.FinancialHealth, {
      profile: bankingProfile,
      report: scope.report,
      companies: scope.companies,
      capturedAt: demo.captured_at,
      onInspectCompany: () => {},
    }),
  );

  assert.equal(scope.companyCount, bankingCiks.size);
  assert.ok(
    scope.report.concentration.issuers.every((issuer) =>
      bankingCiks.has(String(issuer.cik).padStart(10, "0")),
    ),
  );
  assert.ok(
    scope.companies.every((company) =>
      bankingCiks.has(String(company.cik).padStart(10, "0")),
    ),
  );
  assert.match(html, /Banks only/);
  assert.match(html, /Other business models are excluded, not blended/);
  assert.match(html, /Ratio summaries/);
  assert.match(html, /Cash-and-debt and condition diagnostics remain disabled/);
});

test("unknown business models remain visibly disclosed outside model summaries", () => {
  const Profile = component(
    "../src/app/workspace/portfolio/PortfolioFinancialProfile.tsx",
  ).default;
  const augmentedCompanies = companies.map(augmentPortfolioCompanyMetrics);
  const catalog = buildCatalogReport(report, augmentedCompanies);
  const firstCorporate = catalog.concentration.issuers.find(
    (issuer) => issuer.kind === "company" && issuer.lens === "corporate",
  );
  const withUnknown = {
    ...catalog,
    concentration: {
      ...catalog.concentration,
      issuers: catalog.concentration.issuers.map((issuer) =>
        issuer.cik === firstCorporate.cik
          ? { ...issuer, lens: "unknown" }
          : issuer,
      ),
    },
  };
  const html = renderToStaticMarkup(
    createElement(Profile, {
      report,
      catalogReport: withUnknown,
      companies: augmentedCompanies,
      capturedAt: demo.captured_at,
      onInspectCompany: () => {},
    }),
  );

  assert.match(html, /1 company needs a confirmed business model/);
  assert.match(html, /unlike accounting models are never blended/);
});

test("an external demo bank measure request switches to its observed banking lens", () => {
  const augmentedCompanies = companies.map(augmentPortfolioCompanyMetrics);
  const catalog = buildCatalogReport(report, augmentedCompanies);
  const requestedLens = resolveFinancialProfileMetricLens(
    catalog,
    "loanDeposits",
    "corporate",
  );
  const profile = buildPortfolioFinancialProfile(catalog, {
    lens: requestedLens,
  });
  const measure = profile.metricSummaries.find(
    (entry) => entry.id === "loanDeposits",
  );

  assert.equal(requestedLens, "banking");
  assert.equal(profile.lens, "banking");
  assert.ok(measure.measuredCompanyCount > 0);
});

test("metric rankings expose measured sector peers and a bounded first page", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioMetricExplorer.tsx",
  ).default;
  const html = renderToStaticMarkup(
    createElement(Component, {
      report,
      companies,
      onInspect: () => {},
    }),
  );
  assert.match(html, /Information Technology/);
  assert.match(html, /Real Estate/);
  assert.match(html, /Financial ratios/);
  assert.doesNotMatch(html, /Business model|All business models/);
  assert.match(html, /Find a company in this ranking/);
  assert.match(html, /Page 1 of 4/);
  assert.equal((html.match(/aria-label="Compare /g) || []).length, 25);
  assert.match(
    html,
    /<th scope="col">Compare<\/th><th scope="col">Company<\/th>/,
  );
});

test("metric explanations retain negative values, complete periods and validated SEC evidence", () => {
  const Component = component(
    "../src/app/workspace/portfolio/MetricEvidenceDialog.tsx",
  ).default;
  const html = renderToStaticMarkup(
    createElement(Component, {
      inspector: {
        issuer: {
          ticker: "TEST",
          name: "Test Company",
          lens: "corporate",
          cik: "1234",
          company: { retrievedAt: "2026-09-11T12:00:00Z" },
        },
        key: "netMargin",
        point: {
          value: -5,
          unit: "%",
          classification: "calculated",
          formula: "Net income / revenue × 100",
          period: { kind: "annual", start: "2025-01-01", end: "2025-12-31" },
          sources: [
            {
              documentUrl:
                "https://www.sec.gov/Archives/edgar/data/1234/annual.htm",
              tag: "NetIncomeLoss",
            },
            { documentUrl: "javascript:alert(1)", tag: "Unsafe source" },
          ],
        },
      },
      onClose: () => {},
    }),
  );
  assert.match(html, /-5%/);
  assert.match(html, /2025-01-01 to 2025-12-31/);
  assert.match(html, /2026-09-11T12:00:00Z/);
  assert.match(
    html,
    /href="https:\/\/www.sec.gov\/Archives\/edgar\/data\/1234\/annual.htm"/,
  );
  assert.doesNotMatch(html, /javascript:|Unsafe source|\bissuer\b/i);
});

test("reporting controls separate YTD durations and clear old rankings while retrieving another basis", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioMetricExplorer.tsx",
  ).default;
  const ytdCompanies = companies.slice(0, 3).map((company, index) => {
    const period = {
      kind: "ytd",
      start: "2026-01-01",
      end: index === 0 ? "2026-03-31" : "2026-06-30",
    };
    return {
      ...company,
      basis: "ytd",
      period,
      metrics: {
        netMargin: { ...company.metrics.netMargin, value: index + 1, period },
      },
    };
  });
  const ytdReport = buildPortfolioAnalytics(
    doc.rows,
    doc.allocation,
    ytdCompanies,
    { capturedAt: demo.captured_at },
  );
  const props = {
    report: ytdReport,
    companies: ytdCompanies,
    reportingBasis: "ytd",
    onReportingBasisChange: () => {},
    onInspect: () => {},
  };
  const html = renderToStaticMarkup(createElement(Component, props));
  assert.match(html, /aria-label="Reporting perspective"/);
  for (const label of [
    "Annual",
    "Quarterly",
    "Fiscal year to date",
    "Trailing twelve months",
    "Exact reporting dates",
  ])
    assert.ok(html.includes(label));
  assert.match(html, /<option value="6m" selected="">/);
  assert.equal(
    (html.match(/aria-label="Compare /g) || []).length,
    2,
    "default ranking includes only the most common elapsed duration",
  );
  const loading = renderToStaticMarkup(
    createElement(Component, {
      ...props,
      reportingBasis: "quarter",
      reportingLoading: true,
      reportingProgress: { completed: 5, total: 100 },
      onCancelReporting: () => {},
    }),
  );
  assert.match(loading, /Loading quarterly financials/);
  assert.match(loading, /5 of.*100 companies checked/);
  assert.match(loading, /Cancel retrieval/);
  assert.doesNotMatch(loading, /aria-label="Compare |Companies ranked|<select/);
});

test("new cash-flow margin explanation exposes the exact inputs used in the saved calculation", () => {
  const Component = component(
    "../src/app/workspace/portfolio/MetricEvidenceDialog.tsx",
  ).default;
  const company = companies
    .map(augmentPortfolioCompanyMetrics)
    .find((entry) => entry.metrics.operatingCashFlowMargin?.value != null);
  assert.ok(company);
  const point = company.metrics.operatingCashFlowMargin;
  const html = renderToStaticMarkup(
    createElement(Component, {
      inspector: {
        issuer: {
          ticker: company.ticker,
          name: company.name,
          lens: company.lens,
          company,
        },
        key: "operatingCashFlowMargin",
        point,
      },
      onClose: () => {},
    }),
  );
  assert.match(html, /aria-label="Calculation inputs"/);
  assert.match(html, /Operating Cash Flow/);
  assert.match(html, /Revenue/);
  assert.match(html, /Reporting dates/);
  assert.ok(html.includes(point.period.start));
  assert.ok(html.includes(point.period.end));
  assert.doesNotMatch(html, /As of undefined|Unknown reporting basis/);
});

test("Amazon's opening and closing payable inspectors distinguish value dates from analysis and filing dates", () => {
  const Component = component(
    "../src/app/workspace/portfolio/MetricEvidenceDialog.tsx",
  ).default;
  const company = companies.find((entry) => entry.ticker === "AMZN");
  assert.ok(company);
  const render = (key) =>
    renderToStaticMarkup(
      createElement(Component, {
        inspector: {
          issuer: {
            ticker: company.ticker,
            name: company.name,
            lens: company.lens,
            company,
          },
          key,
          point: company.metrics[key],
        },
        onClose: () => {},
        onSelectMetric: () => {},
      }),
    );
  const opening = render("openingAccountsPayable");
  assert.match(opening, /\$94,363,000,000/);
  assert.match(opening, /Opening balance date · As of 2024-12-31/);
  assert.match(
    opening,
    /<dt>Analysis period<\/dt><dd>Annual · 2025-01-01 to 2025-12-31/,
  );
  assert.match(opening, /Filed 2026-02-06/);
  assert.match(opening, /000101872426000004\/amzn-20251231.htm/);
  assert.match(opening, /\$121,909,000,000/);
  assert.match(opening, /Inspect closing balance/);
  assert.match(opening, /As of 2025-12-31/);
  assert.match(opening, /SEC sources &amp; reported inputs/);
  const closing = render("accountsPayable");
  assert.match(closing, /Balance-sheet date · As of 2025-12-31/);
  assert.match(closing, /Filed 2026-07-31/);
  assert.match(closing, /Inspect opening balance/);
  for (const html of [opening, closing])
    assert.doesNotMatch(
      html,
      /Unknown|NaN|undefined|does not match|is unavailable/,
    );
});

test("a mismatched analysis period does not offer an unrelated paired balance", () => {
  const Component = component(
    "../src/app/workspace/portfolio/MetricEvidenceDialog.tsx",
  ).default;
  const company = companies.find((entry) => entry.ticker === "AMZN");
  const html = renderToStaticMarkup(
    createElement(Component, {
      inspector: {
        issuer: {
          ticker: "AMZN",
          company: {
            ...company,
            metrics: {
              ...company.metrics,
              accountsPayable: {
                ...company.metrics.accountsPayable,
                period: {
                  kind: "annual",
                  start: "2026-01-01",
                  end: "2026-12-31",
                },
              },
            },
          },
        },
        key: "openingAccountsPayable",
        point: company.metrics.openingAccountsPayable,
      },
      onClose: () => {},
      onSelectMetric: () => {},
    }),
  );
  assert.doesNotMatch(html, /Inspect closing balance/);
  assert.match(html, /As of 2024-12-31/);
});
