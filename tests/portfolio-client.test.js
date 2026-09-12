import test from "node:test";
import assert from "node:assert/strict";
import {
  portfolioIssuerRequests,
  researchPortfolioRows,
  portfolioFilingFeed,
  isCompletePortfolioCheck,
} from "../src/utils/portfolioClient.js";
import { resolveCompanyClassification } from "../src/utils/companyClassification.js";
import { createPortfolio } from "../src/utils/portfolioStorage.js";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
const row = (n, patch = {}) => ({
  id: `r${n}`,
  input: { ticker: `T${n}`, weight_pct: 55, notes: "private note" },
  resolution: {
    status: "resolved",
    kind: "company",
    ticker: `T${n}`,
    cik: String(n).padStart(10, "0"),
  },
  ...patch,
});
test("100-company browser workflow uses twenty bounded batches and sends no private fields", async () => {
  let calls = 0;
  const progress = [];
  const result = await researchPortfolioRows(
    Array.from({ length: 100 }, (_, i) => row(i + 1)),
    {
      onProgress: (p) => progress.push(p.completed),
      fetcher: async (_url, options) => {
        const input = JSON.parse(options.body);
        calls++;
        assert.equal(input.holdings.length, 5);
        assert.ok(!options.body.includes("private note"));
        assert.ok(!options.body.includes("weight_pct"));
        return {
          ok: true,
          json: async () => ({
            companies: input.holdings.map((h) => ({ ...h, status: "ready" })),
          }),
        };
      },
    },
  );
  assert.equal(calls, 20);
  assert.equal(result.companies.length, 100);
  assert.equal(result.completed, 100);
  assert.equal(progress.at(-1), 100);
});
test("share classes deduplicate retrieval while invalid or excluded rows do not block others", () => {
  const first = row(1);
  const second = row(2, {
    resolution: { ...first.resolution, ticker: "OTHER" },
  });
  assert.equal(
    portfolioIssuerRequests([
      first,
      second,
      row(3, { excluded: true }),
      row(4, { resolution: { status: "unresolved" } }),
    ]).length,
    1,
  );
});
test("failed batch preserves successful issuers and retries only failures", async () => {
  let calls = 0;
  const rows = Array.from({ length: 6 }, (_, i) => row(i + 1));
  const first = await researchPortfolioRows(rows, {
    fetcher: async (_url, options) => {
      calls++;
      if (calls === 2) throw new Error("Temporary failure");
      return {
        ok: true,
        json: async () => ({
          companies: JSON.parse(options.body).holdings.map((h) => ({
            ...h,
            status: "ready",
          })),
        }),
      };
    },
  });
  assert.equal(first.companies.filter((c) => c.status === "ready").length, 5);
  const second = await researchPortfolioRows(rows, {
    previousCompanies: first.companies,
    onlyFailed: true,
    fetcher: async (_url, options) => {
      const input = JSON.parse(options.body);
      assert.equal(input.holdings.length, 1);
      return {
        ok: true,
        json: async () => ({
          companies: input.holdings.map((h) => ({ ...h, status: "ready" })),
        }),
      };
    },
  });
  assert.equal(second.companies.length, 6);
  assert.ok(second.companies.every((c) => c.status === "ready"));
});
test("cancel stops new batches and keeps completed results", async () => {
  const controller = new AbortController();
  const result = await researchPortfolioRows(
    Array.from({ length: 10 }, (_, i) => row(i + 1)),
    {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.completed === 5) controller.abort();
      },
      fetcher: async (_url, options) => ({
        ok: true,
        json: async () => ({
          companies: JSON.parse(options.body).holdings.map((h) => ({
            ...h,
            status: "ready",
          })),
        }),
      }),
    },
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.companies.length, 5);
  assert.equal(result.completed, 5);
});
test("filing feed deduplicates issuers, filters dates, and needs valid prior baseline for new labels", () => {
  const filings = [
    { accession: "a", form: "10-K", filingDate: "2026-08-10" },
    { accession: "b", form: "8-K", filingDate: "2026-08-09" },
  ];
  const companies = [{ cik: row(1).resolution.cik, name: "One", filings }];
  assert.ok(portfolioFilingFeed([row(1)], companies).every((f) => !f.isNew));
  const result = portfolioFilingFeed([row(1)], companies, {
    previousCheck: "2026-08-09T12:00:00Z",
  });
  assert.equal(result[0].isNew, true);
  assert.equal(result[1].isNew, false);
  assert.equal(result[1].sameCheckDay, true);
  assert.equal(
    portfolioFilingFeed([row(1)], companies, {
      form: "10-K",
      end: "2026-08-10",
    }).length,
    1,
  );
});

test("cancelled refresh retains old sixth-company evidence as unchecked and retries only that issuer", async () => {
  const rows = Array.from({ length: 6 }, (_, index) => row(index + 1));
  const previousCompanies = rows.map((item) => ({
    cik: item.resolution.cik,
    ticker: item.resolution.ticker,
    status: "ready",
    kind: "company",
    refreshStatus: "checked",
    retrievedAt: "2026-08-01T12:00:00Z",
    cache: { status: "fresh", storedAt: "2026-08-01T12:00:00Z" },
    metrics: { revenue: { value: 123 } },
    filings: [{ accession: "old", filingDate: "2026-07-20" }],
  }));
  const controller = new AbortController();
  const progress = [];
  const cancelled = await researchPortfolioRows(rows, {
    previousCompanies,
    signal: controller.signal,
    onProgress: (item) => {
      progress.push(item);
      if (item.completed === 5) controller.abort();
    },
    fetcher: async (_url, options) => ({
      ok: true,
      json: async () => ({
        companies: JSON.parse(options.body).holdings.map((holding) => ({
          ...holding,
          status: "ready",
          cache: { status: "fresh" },
          metrics: { revenue: { value: 456 } },
        })),
      }),
    }),
  });
  assert.ok(
    progress[0].companies.every(
      (company) => company.refreshStatus === "pending",
    ),
  );
  assert.equal(cancelled.completed, 5);
  assert.equal(cancelled.requested, 6);
  assert.equal(cancelled.companies.length, 6);
  const unchecked = cancelled.companies.find(
    (company) => company.cik === rows[5].resolution.cik,
  );
  assert.equal(unchecked.refreshStatus, "not_checked");
  assert.equal(unchecked.metrics.revenue.value, 123);
  assert.equal(unchecked.filings[0].accession, "old");
  assert.equal(previousCompanies[5].refreshStatus, "checked");
  assert.equal(isCompletePortfolioCheck(cancelled), false);
  let retryCalls = 0;
  const retry = await researchPortfolioRows(rows, {
    previousCompanies: cancelled.companies,
    onlyFailed: true,
    fetcher: async (_url, options) => {
      retryCalls++;
      const requested = JSON.parse(options.body).holdings;
      assert.deepEqual(
        requested.map((holding) => holding.cik),
        [rows[5].resolution.cik],
      );
      return {
        ok: true,
        json: async () => ({
          companies: requested.map((holding) => ({
            ...holding,
            status: "partial",
            cache: { status: "fresh" },
          })),
        }),
      };
    },
  });
  assert.equal(retryCalls, 1);
  assert.equal(retry.requested, 1);
  assert.equal(retry.companies.length, 6);
  assert.ok(
    retry.companies.every((company) => company.refreshStatus === "checked"),
  );
  assert.equal(isCompletePortfolioCheck(retry), false);
});

test("refresh failures retain earlier evidence visibly stale and are eligible for retry", async () => {
  const prior = {
    cik: row(1).resolution.cik,
    status: "ready",
    kind: "company",
    retrievedAt: "2026-08-01T12:00:00Z",
    cache: { status: "fresh" },
    metrics: { assets: { value: 987 } },
    filings: [{ accession: "old" }],
  };
  const result = await researchPortfolioRows([row(1)], {
    previousCompanies: [prior],
    fetcher: async () => {
      throw new Error("SEC temporarily unavailable");
    },
  });
  assert.equal(result.companies[0].status, "ready");
  assert.equal(result.companies[0].refreshStatus, "failed");
  assert.equal(result.companies[0].cache.status, "stale");
  assert.equal(result.companies[0].metrics.assets.value, 987);
  assert.match(result.companies[0].refreshError, /temporarily unavailable/);
  assert.equal(isCompletePortfolioCheck(result), false);
  const retry = await researchPortfolioRows([row(1)], {
    previousCompanies: result.companies,
    onlyFailed: true,
    fetcher: async () => ({
      ok: true,
      json: async () => ({
        companies: [{ ...prior, cache: { status: "fresh" } }],
      }),
    }),
  });
  assert.equal(retry.requested, 1);
  assert.equal(retry.companies[0].refreshStatus, "checked");
});

test("retry includes missing, pending, unchecked, failed and stale responses while retaining checked successes", async () => {
  const rows = Array.from({ length: 7 }, (_, index) => row(index + 1));
  const previousCompanies = [
    {
      cik: rows[0].resolution.cik,
      status: "ready",
      refreshStatus: "checked",
      cache: { status: "fresh" },
    },
    {
      cik: rows[1].resolution.cik,
      status: "ready",
      refreshStatus: "pending",
      cache: { status: "fresh" },
    },
    {
      cik: rows[2].resolution.cik,
      status: "ready",
      refreshStatus: "not_checked",
      cache: { status: "fresh" },
    },
    {
      cik: rows[3].resolution.cik,
      status: "ready",
      refreshStatus: "stale",
      cache: { status: "stale" },
    },
    {
      cik: rows[4].resolution.cik,
      status: "failed",
      refreshStatus: "failed",
      cache: { status: "unavailable" },
    },
    {
      cik: rows[5].resolution.cik,
      status: "partial",
      refreshStatus: "checked",
      cache: { status: "unavailable" },
    },
  ];
  const requestedIds = [];
  const result = await researchPortfolioRows(rows, {
    previousCompanies,
    onlyFailed: true,
    fetcher: async (_url, options) => {
      const holdings = JSON.parse(options.body).holdings;
      requestedIds.push(...holdings.map((holding) => holding.cik));
      return {
        ok: true,
        json: async () => ({
          companies: holdings.map((holding) => ({
            ...holding,
            status: "ready",
            cache: { status: "fresh" },
          })),
        }),
      };
    },
  });
  assert.deepEqual(
    requestedIds,
    rows.slice(1).map((item) => item.resolution.cik),
  );
  assert.equal(result.requested, 6);
  assert.equal(result.companies.length, 7);
});

test("incoming cache and failure states cannot advance a complete filing-check baseline", async () => {
  const rows = Array.from({ length: 3 }, (_, index) => row(index + 1));
  const result = await researchPortfolioRows(rows, {
    fetcher: async () => ({
      ok: true,
      json: async () => ({
        companies: [
          {
            cik: rows[0].resolution.cik,
            status: "ready",
            cache: { status: "stale" },
          },
          {
            cik: rows[1].resolution.cik,
            status: "partial",
            cache: { status: "unavailable" },
          },
          {
            cik: rows[2].resolution.cik,
            status: "failed",
            cache: { status: "fresh" },
          },
        ],
      }),
    }),
  });
  assert.deepEqual(
    result.companies.map((company) => company.refreshStatus),
    ["stale", "failed", "failed"],
  );
  assert.equal(result.completed, 3);
  assert.equal(isCompletePortfolioCheck(result), false);
  const full = {
    checkedAt: "2026-09-07T12:00:00Z",
    requested: 2,
    completed: 2,
    cancelled: false,
    companies: [
      {
        cik: rows[0].resolution.cik,
        status: "partial",
        refreshStatus: "checked",
        cache: { status: "fresh" },
      },
      {
        cik: rows[1].resolution.cik,
        status: "unsupported",
        kind: "fund",
        refreshStatus: "checked",
        cache: { status: "cached" },
      },
    ],
  };
  assert.equal(isCompletePortfolioCheck(full), true);
  assert.equal(isCompletePortfolioCheck(full, true), false);
  let baseline = "2026-08-01T12:00:00Z";
  for (const incomplete of [
    result,
    { ...full, cancelled: true },
    { ...full, onlyFailed: true },
    { ...full, requested: 0, completed: 0, companies: [] },
    { ...full, completed: 1 },
    {
      ...full,
      companies: [
        full.companies[0],
        { ...full.companies[1], refreshStatus: "not_checked" },
      ],
    },
  ]) {
    if (isCompletePortfolioCheck(incomplete)) baseline = incomplete.checkedAt;
    assert.equal(baseline, "2026-08-01T12:00:00Z");
  }
  assert.equal(
    isCompletePortfolioCheck({
      ...full,
      companies: [full.companies[0], { ...full.companies[1], kind: "unknown" }],
    }),
    false,
  );
});

test("full refresh upgrades successful legacy captures and retains them honestly after a failed refresh", async () => {
  const previous = {
    cik: row(1).resolution.cik,
    ticker: "T1",
    status: "ready",
    refreshStatus: "checked",
    metrics: {
      netIncome: { value: 50, unit: "USD", classification: "reported" },
    },
  };
  let calls = 0;
  const upgraded = await researchPortfolioRows([row(1)], {
    previousCompanies: [previous],
    onlyFailed: false,
    fetcher: async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({
          companies: [
            {
              ...previous,
              analysisVersion: "updated",
              metrics: {
                ...previous.metrics,
                accountsPayable: {
                  value: 20,
                  unit: "USD",
                  classification: "reported",
                },
              },
            },
          ],
        }),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(upgraded.companies[0].metrics.accountsPayable.value, 20);
  const failed = await researchPortfolioRows([row(1)], {
    previousCompanies: [previous],
    onlyFailed: false,
    fetcher: async () => {
      throw new Error("Temporary outage");
    },
  });
  assert.equal(failed.companies[0].metrics.netIncome.value, 50);
  assert.equal(failed.companies[0].analysisVersion, undefined);
  assert.equal(failed.companies[0].refreshStatus, "failed");
});

test("browser captures separate derived fund classifications from SEC financial evidence", async () => {
  const cik = "0000320193";
  const rows = resolvePortfolioRows(createPortfolioRows([{ ticker: "AAPL" }]), {
    AAPL: { cik, name: "Apple Inc." },
  });
  const date = "2026-09-12T12:00:00.000Z";
  const period = { kind: "quarter", start: "2026-04-01", end: "2026-06-30" };
  const source = {
    documentUrl:
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000073/aapl-20260627.htm",
    tag: "RevenueFromContractWithCustomerExcludingAssessedTax",
    value: 100,
    unit: "USD",
    start: period.start,
    end: period.end,
  };
  const company = {
    cik,
    ticker: "AAPL",
    name: "Apple Inc.",
    sic: "3571",
    kind: "company",
    status: "ready",
    basis: "quarter",
    period,
    retrievedAt: date,
    cache: { status: "fresh", storedAt: date },
    metrics: {
      revenue: {
        value: 100,
        unit: "USD",
        period,
        classification: "reported",
        sources: [source],
      },
    },
    filings: [],
    companyClassification: resolveCompanyClassification({ cik, sic: "3571" }),
  };
  assert.match(company.companyClassification.sectorSource.url, /ishares/);
  const result = await researchPortfolioRows(rows, {
    basis: "quarter",
    previousCompanies: [{ ...company, refreshStatus: "checked" }],
    fetcher: async () => ({
      ok: true,
      json: async () => ({ basis: "quarter", companies: [company] }),
    }),
  });
  const capture = result.companies[0];
  assert.equal(capture.companyClassification, undefined);
  assert.deepEqual(capture.metrics.revenue.sources, [source]);
  assert.deepEqual(
    resolveCompanyClassification(capture),
    company.companyClassification,
  );
  assert.ok(company.companyClassification, "the API response is not mutated");
  const portfolio = createPortfolio({
    rows,
    research: { basis: "quarter" },
    snapshot: result,
  });
  assert.equal(portfolio.snapshot.companies[0].metrics.revenue.value, 100);

  const retained = await researchPortfolioRows(rows, {
    basis: "quarter",
    onlyFailed: true,
    previousCompanies: [{ ...company, refreshStatus: "checked" }],
    fetcher: async () => {
      throw new Error("A checked retained company must not be fetched");
    },
  });
  assert.equal(retained.companies[0].companyClassification, undefined);
  createPortfolio({ rows, research: { basis: "quarter" }, snapshot: retained });

  const unsafe = structuredClone(result);
  unsafe.companies[0].metrics.revenue.sources[0].documentUrl =
    "https://example.com/not-sec-evidence";
  assert.throws(
    () =>
      createPortfolio({
        rows,
        research: { basis: "quarter" },
        snapshot: unsafe,
      }),
    /SEC.gov/,
  );
});
