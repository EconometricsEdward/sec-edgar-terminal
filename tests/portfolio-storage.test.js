import test from "node:test";
import assert from "node:assert/strict";
import {
  PORTFOLIOS_KEY,
  PORTFOLIO_LIMIT,
  PORTFOLIO_ROW_LIMIT,
  PORTFOLIO_STORAGE_LIMIT,
  createPortfolio,
  readPortfolios,
  validatePortfolio,
  validatePortfolios,
  writePortfolio,
} from "../src/utils/portfolioStorage.js";
import {
  readResearchVault,
  validateResearchStore,
  exportResearchBackup,
  parseResearchBackup,
  previewResearchRestore,
  restoreResearchVault,
} from "../src/utils/researchVault.js";
import {
  createPortfolioRows,
  resolvePortfolioRows,
  applyDuplicateDecision,
  undoPortfolioMerge,
} from "../src/utils/portfolioModel.js";
import { safeInternalPath } from "../src/utils/siteRoutes.js";
import { buildPortfolioCompany } from "../src/utils/portfolioResearchServer.js";

const now = "2026-09-07T18:00:00.000Z";
const companyKey = "edgar:research-workspace:v1";
const marketKey = "edgar:market-research:v1";
const sourceUrl =
  "https://www.sec.gov/Archives/edgar/data/320193/000032019326000079/aapl-20260627.htm";
const directory = { AAPL: { cik: "0000320193", name: "Apple Inc." } };
function rows(input = [{ ticker: "AAPL" }]) {
  return resolvePortfolioRows(createPortfolioRows(input), directory);
}
function portfolio(overrides = {}) {
  return createPortfolio({
    id: "portfolio-a",
    name: "Company research",
    rows: rows(),
    now,
    ...overrides,
  });
}
function storage(input = {}) {
  const data = new Map(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  return {
    data,
    writes: [],
    get length() {
      return data.size;
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      this.writes.push(key);
      data.set(key, value);
    },
    removeItem(key) {
      this.writes.push(key);
      data.delete(key);
    },
  };
}
function company() {
  return {
    cik: "0000320193",
    ticker: "AAPL",
    name: "Apple Inc.",
    kind: "company",
    status: "partial",
    period: { start: "2025-09-28", end: "2026-06-27", kind: "ttm" },
    metrics: {
      revenue: {
        value: 1000000,
        unit: "USD",
        label: "Revenue",
        classification: "reported",
        period: { end: "2026-06-27", kind: "ttm" },
        sources: [
          {
            value: 1000000,
            unit: "USD",
            documentUrl: sourceUrl,
            accession: "0000320193-26-000079",
            tag: "RevenueFromContractWithCustomerExcludingAssessedTax",
            taxonomy: "us-gaap",
          },
        ],
        calculations: [],
      },
      debt: {
        value: null,
        unit: "USD",
        label: "Debt",
        classification: "unavailable",
        sources: [],
        reason: "Both components are required.",
      },
    },
    filings: [
      {
        accession: "0000320193-26-000079",
        form: "10-Q",
        filingDate: "2026-08-07",
        reportDate: "2026-06-27",
        description: "Quarterly report",
        documentUrl: sourceUrl,
      },
    ],
    filingCoverage: {
      source: "https://data.sec.gov/submissions/CIK0000320193.json",
      scope: "Recent submissions only",
      returnedCount: 1,
    },
    retrievedAt: now,
    cache: { status: "fresh", storedAt: now },
    warnings: ["Selected metrics are unavailable."],
  };
}
function snapshot(companies = [company()]) {
  return {
    schema_version: "edgar.portfolio.v1",
    generated_at: now,
    basis: "ttm",
    companies,
    coverage: { researchedIssuers: companies.length },
  };
}

test("new portfolios remain research universes without invented weights and survive browser reloads", () => {
  const inputRows = rows();
  const document = portfolio({ rows: inputRows });
  assert.deepEqual(document.allocation, { basis: "none", normalize: false });
  assert.equal(document.rows[0].input.weight_pct, "");
  assert.equal(document.snapshot, null);
  assert.equal(document.lastCheckedAt, null);
  inputRows[0].input.ticker = "MUTATED";
  assert.equal(document.rows[0].input.ticker, "AAPL");
  const browser = storage();
  const saved = writePortfolio(browser, {
    mode: "create",
    portfolio: document,
    now,
  });
  assert.equal(saved.activeId, document.id);
  assert.deepEqual(
    readPortfolios(browser.getItem(PORTFOLIOS_KEY)).portfolios[0],
    document,
  );
  saved.portfolios[0].name = "Mutated return value";
  assert.equal(
    readPortfolios(browser.getItem(PORTFOLIOS_KEY)).portfolios[0].name,
    "Company research",
  );
});

test("multiple named portfolios can be renamed, duplicated, activated, edited and removed independently", () => {
  const browser = storage();
  writePortfolio(browser, { mode: "create", portfolio: portfolio(), now });
  let saved = writePortfolio(browser, {
    mode: "rename",
    id: "portfolio-a",
    name: "  Risk review  ",
    now,
  });
  assert.equal(saved.portfolios[0].name, "Risk review");
  assert.ok(saved.portfolios[0].updatedAt > now);
  const changedAt = saved.portfolios[0].updatedAt;
  saved = writePortfolio(browser, {
    mode: "update",
    id: "portfolio-a",
    patch: { research: { basis: "ttm" } },
    now,
  });
  assert.ok(saved.portfolios[0].updatedAt > changedAt);
  saved = writePortfolio(browser, {
    mode: "duplicate",
    id: "portfolio-a",
    newId: "portfolio-b",
    now,
  });
  assert.equal(saved.portfolios.length, 2);
  assert.equal(saved.activeId, "portfolio-b");
  assert.equal(saved.portfolios[0].name, "Risk review (copy)");
  assert.deepEqual(saved.portfolios[0].rows, saved.portfolios[1].rows);
  saved = writePortfolio(browser, { mode: "activate", id: "portfolio-a", now });
  assert.equal(saved.activeId, "portfolio-a");
  saved = writePortfolio(browser, { mode: "delete", id: "portfolio-a", now });
  assert.equal(saved.activeId, "portfolio-b");
  assert.equal(saved.portfolios.length, 1);
  saved = writePortfolio(browser, { mode: "delete", id: "portfolio-b", now });
  assert.deepEqual(saved, { version: 1, portfolios: [], activeId: "" });
});

test("portfolio names use the same 200-character limit as documented imports", () => {
  const browser = storage();
  const document = portfolio({ name: "x".repeat(200) });
  writePortfolio(browser, { mode: "create", portfolio: document, now });
  const saved = writePortfolio(browser, {
    mode: "duplicate",
    id: document.id,
    newId: "portfolio-b",
    now,
  });
  assert.equal(saved.portfolios[0].name.length, 200);
  assert.ok(saved.portfolios[0].name.endsWith(" (copy)"));
  assert.throws(() => portfolio({ name: "x".repeat(201) }), /200 characters/);
});

test("merge provenance survives persistence and can restore the original separate positions", () => {
  const positions = rows([
    { ticker: "AAPL", weight_pct: 30, notes: "First position" },
    { ticker: "AAPL", weight_pct: 20, notes: "Second position" },
  ]);
  const merged = applyDuplicateDecision(
    positions,
    positions.map((row) => row.id),
    "merge",
  );
  const document = portfolio({
    rows: merged,
    allocation: { basis: "weights", normalize: false },
  });
  const browser = storage();
  writePortfolio(browser, { mode: "create", portfolio: document, now });
  const restored = readPortfolios(browser.getItem(PORTFOLIOS_KEY))
    .portfolios[0];
  assert.equal(restored.rows[0].input.weight_pct, 50);
  assert.deepEqual(
    restored.rows[0].mergedInputs,
    positions.map((row) => row.input),
  );
  assert.equal(restored.rows[1].mergedInto, restored.rows[0].id);
  const undone = undoPortfolioMerge(restored.rows, restored.rows[0].id);
  assert.deepEqual(
    undone.map((row) => row.input),
    positions.map((row) => row.input),
  );
  assert.ok(
    undone.every(
      (row) => !row.excluded && !row.mergedInto && !row.mergedInputs,
    ),
  );
  assert.doesNotThrow(() => validatePortfolio({ ...restored, rows: undone }));
  for (const mutate of [
    (value) => {
      value.rows[1].excluded = false;
    },
    (value) => {
      value.rows[1].mergedInto = "missing";
    },
    (value) => {
      value.rows[0].mergedRowIds = [value.rows[0].id, "missing"];
    },
    (value) => {
      value.rows[0].mergedInputs[1].notes = "x".repeat(2001);
    },
    (value) => {
      value.rows[0].mergedInputs.pop();
    },
    (value) => {
      value.rows[1].input.weight_pct = 200;
    },
    (value) => {
      value.rows[0].mergedRowIds[1] = value.rows[0].id;
    },
  ]) {
    const invalid = structuredClone(restored);
    mutate(invalid);
    assert.throws(() => validatePortfolio(invalid));
  }
});

test("updates read current browser state and preserve changes to unrelated portfolios and stores", () => {
  const browser = storage({
    unrelated: "private unrelated data",
    [marketKey]: { version: 1, watchlist: ["MSFT"], views: [] },
  });
  writePortfolio(browser, { mode: "create", portfolio: portfolio(), now });
  // Simulates another tab creating a document before this tab saves its patch.
  writePortfolio(browser, {
    mode: "create",
    portfolio: portfolio({ id: "portfolio-b", name: "Other tab" }),
    now,
  });
  const saved = writePortfolio(browser, {
    mode: "update",
    id: "portfolio-a",
    patch: { allocation: { basis: "equal", normalize: false } },
    now,
  });
  assert.equal(
    saved.portfolios.find((item) => item.id === "portfolio-b").name,
    "Other tab",
  );
  assert.equal(
    saved.portfolios.find((item) => item.id === "portfolio-a").allocation.basis,
    "equal",
  );
  assert.deepEqual(JSON.parse(browser.getItem(marketKey)).watchlist, ["MSFT"]);
  assert.equal(browser.getItem("unrelated"), "private unrelated data");
  assert.ok(browser.writes.every((key) => key === PORTFOLIOS_KEY));
});

test("stale document revisions cannot overwrite concurrent changes or restore removed portfolios", () => {
  const browser = storage();
  writePortfolio(browser, { mode: "create", portfolio: portfolio(), now });
  writePortfolio(browser, {
    mode: "rename",
    id: "portfolio-a",
    name: "Changed in another tab",
    now,
  });
  assert.throws(
    () =>
      writePortfolio(browser, {
        mode: "update",
        portfolio: portfolio(),
        expectedUpdatedAt: now,
        now,
      }),
    /another tab/,
  );
  writePortfolio(browser, { mode: "delete", id: "portfolio-a", now });
  assert.throws(
    () =>
      writePortfolio(browser, { mode: "update", portfolio: portfolio(), now }),
    /removed or replaced/,
  );
  assert.equal(
    readPortfolios(browser.getItem(PORTFOLIOS_KEY)).portfolios.length,
    0,
  );
});

test("100-row portfolios preserve unresolved and unsupported inputs, exclusions, notes and original allocations", () => {
  const input = Array.from({ length: PORTFOLIO_ROW_LIMIT }, (_, index) => ({
    ticker: index === 0 ? "AAPL" : `UNKNOWN${index}`,
    weight_pct: index === 0 ? 12.5 : "",
    shares: index === 1 ? -2 : "",
    notes: `Private row ${index}`,
  }));
  const positions = rows(input);
  positions[2].excluded = true;
  positions[2].duplicateChoice = "remove";
  positions[3].resolution.status = "unsupported";
  positions[3].resolution.kind = "fund";
  const browser = storage();
  const document = portfolio({
    rows: positions,
    allocation: { basis: "weights", normalize: false },
  });
  writePortfolio(browser, { mode: "create", portfolio: document, now });
  const restored = readPortfolios(browser.getItem(PORTFOLIOS_KEY))
    .portfolios[0];
  assert.equal(restored.rows.length, 100);
  assert.equal(restored.rows[0].input.weight_pct, 12.5);
  assert.equal(
    restored.rows[1].input.shares,
    -2,
    "invalid positions are retained for review, not silently altered by storage",
  );
  assert.equal(restored.rows[1].resolution.status, "unresolved");
  assert.equal(restored.rows[2].excluded, true);
  assert.equal(restored.rows[3].resolution.kind, "fund");
  assert.equal(restored.rows[99].input.notes, "Private row 99");
});

test("row, document, cell and byte limits reject new writes without discarding saved work", () => {
  assert.throws(
    () =>
      portfolio({
        rows: Array.from({ length: 101 }, (_, index) => ({
          ...rows()[0],
          id: `row-${index}`,
        })),
      }),
    /100 rows/,
  );
  assert.throws(
    () =>
      portfolio({ rows: rows([{ ticker: "AAPL", notes: "x".repeat(2001) }]) }),
    /2,000/,
  );
  const browser = storage();
  for (let index = 0; index < PORTFOLIO_LIMIT; index++)
    writePortfolio(browser, {
      mode: "create",
      portfolio: portfolio({ id: `portfolio-${index}` }),
      now,
    });
  const before = browser.getItem(PORTFOLIOS_KEY);
  assert.throws(
    () =>
      writePortfolio(browser, { mode: "create", portfolio: portfolio(), now }),
    /20 portfolios/,
  );
  assert.equal(browser.getItem(PORTFOLIOS_KEY), before);
  const columns = Object.keys(rows()[0].input);
  const largeRows = Array.from({ length: 100 }, (_, index) => ({
    ...rows()[0],
    id: `row-${index}`,
    input: Object.fromEntries(columns.map((key) => [key, "x".repeat(2000)])),
  }));
  const large = {
    version: 1,
    activeId: "portfolio-0",
    portfolios: Array.from({ length: 3 }, (_, index) =>
      portfolio({ id: `portfolio-${index}`, rows: largeRows }),
    ),
  };
  assert.ok(
    new TextEncoder().encode(JSON.stringify(large)).length >
      PORTFOLIO_STORAGE_LIMIT,
  );
  assert.throws(() => validatePortfolios(large), /4 MiB/);
});

test("storage quota and unavailable storage errors never report successful persistence", () => {
  const browser = storage();
  writePortfolio(browser, { mode: "create", portfolio: portfolio(), now });
  const before = browser.getItem(PORTFOLIOS_KEY);
  browser.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.throws(
    () =>
      writePortfolio(browser, {
        mode: "rename",
        id: "portfolio-a",
        name: "Not saved",
        now,
      }),
    /changes have not been saved/,
  );
  assert.equal(browser.getItem(PORTFOLIOS_KEY), before);
  assert.throws(
    () =>
      writePortfolio(
        {
          getItem() {
            throw new Error("Blocked");
          },
        },
        { mode: "create", portfolio: portfolio(), now },
      ),
    /storage is unavailable/,
  );
});

test("malformed stored documents remain recoverable and cannot be overwritten with an empty default", () => {
  assert.deepEqual(readPortfolios(null), {
    version: 1,
    portfolios: [],
    activeId: "",
  });
  for (const raw of [
    "{broken",
    '{"version":2,"portfolios":[],"activeId":""}',
    '{"version":1,"portfolios":[],"activeId":"missing"}',
  ]) {
    const browser = storage({ [PORTFOLIOS_KEY]: raw });
    assert.throws(() => readPortfolios(raw), /preserved/);
    assert.throws(
      () =>
        writePortfolio(browser, {
          mode: "create",
          portfolio: portfolio(),
          now,
        }),
      /preserved/,
    );
    assert.equal(browser.getItem(PORTFOLIOS_KEY), raw);
    assert.equal(browser.writes.length, 0);
    const backup = parseResearchBackup(exportResearchBackup(browser));
    assert.equal(backup.stores[PORTFOLIOS_KEY], raw);
    assert.ok(backup.issues.some((issue) => issue.key === PORTFOLIOS_KEY));
  }
});

test("captured research retains SEC provenance, periods, missing values, reporting basis and check dates", () => {
  const document = portfolio({
    snapshot: snapshot(),
    research: { basis: "ttm" },
    lastCheckedAt: now,
    previousCheckedAt: "2026-09-06T18:00:00.000Z",
  });
  const browser = storage();
  writePortfolio(browser, { mode: "create", portfolio: document, now });
  const restored = readPortfolios(browser.getItem(PORTFOLIOS_KEY))
    .portfolios[0];
  assert.deepEqual(restored.snapshot, document.snapshot);
  assert.equal(restored.snapshot.companies[0].metrics.debt.value, null);
  assert.equal(
    restored.snapshot.companies[0].metrics.revenue.sources[0].documentUrl,
    sourceUrl,
  );
  assert.equal(restored.previousCheckedAt, "2026-09-06T18:00:00.000Z");
  assert.equal(restored.snapshot.generated_at, now);
});

test("100 company snapshots built by the shared research service fit the saved portfolio workflow", () => {
  const observations = (value, instant = false) =>
    [2024, 2025].map((year) => ({
      val: value,
      end: `${year}-12-31`,
      ...(instant ? {} : { start: `${year}-01-01` }),
      fy: year,
      fp: "FY",
      form: "10-K",
      filed: `${year + 1}-02-01`,
      accn: `0000000001-${String(year + 1).slice(-2)}-000001`,
    }));
  const facts = {
    "us-gaap": Object.fromEntries(
      Object.entries({
        RevenueFromContractWithCustomerExcludingAssessedTax: observations(1000),
        Assets: observations(1500, true),
        StockholdersEquity: observations(700, true),
        NetIncomeLoss: observations(200),
        OperatingIncomeLoss: observations(250),
        NetCashProvidedByUsedInOperatingActivities: observations(240),
        PaymentsToAcquirePropertyPlantAndEquipment: observations(40),
        LongTermDebtCurrent: observations(20, true),
        LongTermDebtNoncurrent: observations(180, true),
      }).map(([key, value]) => [key, { units: { USD: value } }]),
    ),
  };
  const companies = Array.from({ length: 100 }, (_, index) =>
    buildPortfolioCompany(
      {
        cik: String(index + 1).padStart(10, "0"),
        ticker: `SAMPLE${index}`,
        companyName: `Sample issuer ${index}`,
        sic: "3571",
        kind: "company",
        facts,
        filings: [],
        filingCoverage: {
          scope: "Deterministic fixture; no live retrieval",
          returnedCount: 0,
        },
      },
      { basis: "annual", retrievedAt: now },
    ),
  );
  // The API JSON boundary removes optional undefined fields in underlying public facts.
  const captured = JSON.parse(
    JSON.stringify({ ...snapshot(companies), basis: "annual" }),
  );
  const document = portfolio({
    rows: rows(companies.map((item) => ({ ticker: item.ticker }))),
    snapshot: captured,
  });
  const browser = storage();
  writePortfolio(browser, { mode: "create", portfolio: document, now });
  const restored = readPortfolios(browser.getItem(PORTFOLIOS_KEY))
    .portfolios[0];
  assert.equal(restored.rows.length, 100);
  assert.equal(restored.snapshot.companies.length, 100);
  assert.equal(restored.snapshot.companies[0].metrics.revenue.value, 1000);
  assert.ok(
    new TextEncoder().encode(browser.getItem(PORTFOLIOS_KEY)).length <
      PORTFOLIO_STORAGE_LIMIT,
  );
});

test("snapshots permit only SEC provenance and the controlled internal Funds destination", () => {
  const fund = {
    ...company(),
    kind: "fund",
    status: "unsupported",
    fundUrl: "/fund?tickers=VTI",
    metrics: {},
  };
  const document = portfolio({ snapshot: snapshot([fund]) });
  assert.doesNotThrow(() =>
    validateResearchStore(
      PORTFOLIOS_KEY,
      JSON.stringify({
        version: 1,
        activeId: document.id,
        portfolios: [document],
      }),
    ),
  );
  for (const badUrl of [
    "javascript:alert(1)",
    "https://www.sec.gov.evil.example/report",
    "//www.sec.gov/a",
    "https://user@www.sec.gov/a",
    "https://www.sec.gov:444/a",
    "https://example.com/a",
  ]) {
    const invalid = structuredClone(document);
    invalid.snapshot.companies[0].filings[0].documentUrl = badUrl;
    assert.throws(() => validatePortfolio(invalid), /SEC|URL/);
  }
  for (const href of [
    "//evil.example",
    "/fund?tickers=VTI&return=https://evil.example",
    "/disclosures",
    "javascript:alert(1)",
  ]) {
    const invalid = structuredClone(document);
    invalid.snapshot.companies[0].fundUrl = href;
    assert.throws(() => validatePortfolio(invalid), /fund destination/);
  }
});

test("unsafe prototypes, unknown snapshot versions and malformed rendered data are rejected before restore", () => {
  const base = portfolio({ snapshot: snapshot() });
  const mutations = [
    (value) => {
      value.snapshot.schema_version = "future-v2";
    },
    (value) => {
      value.snapshot.companies[0].name = {};
    },
    (value) => {
      value.snapshot.companies[0].refreshStatus = {};
    },
    (value) => {
      value.snapshot.companies[0].refreshError = {};
    },
    (value) => {
      value.snapshot.companies[0].metrics.revenue.label = {};
    },
    (value) => {
      value.snapshot.companies[0].metrics.revenue.sources[0].value = {};
    },
    (value) => {
      value.snapshot.companies[0].filings[0].form = {};
    },
    (value) => {
      value.snapshot.companies[0].latestAnnualFiling = {
        ...value.snapshot.companies[0].filings[0],
        filingDate: {},
      };
    },
    (value) => {
      value.snapshot.companies[0].latestInterimFiling = "not a filing";
    },
    (value) => {
      value.rows[0].resolution.candidates = [null];
    },
    (value) => {
      value.rows[0].resolution.warnings = [{}];
    },
    (value) => {
      value.rows[0].input.notes = {};
    },
    (value) => {
      value.snapshot.companies[0].filingCoverage.source =
        "https://evil.example";
    },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(base);
    mutate(value);
    assert.throws(() => validatePortfolio(value));
  }
  const unsafe = JSON.stringify({
    version: 1,
    activeId: base.id,
    portfolios: [base],
  }).replace('"metrics":{', '"metrics":{"__proto__":{"polluted":true},');
  assert.throws(() => readPortfolios(unsafe), /Unsafe/);
  assert.equal({}.polluted, undefined);
});

test("portfolio backup integration preserves exact notes and allocations, with read-only searchable local summaries", () => {
  const document = portfolio({
    rows: rows([
      { ticker: "AAPL", weight_pct: 12.5, notes: "Private evidence follow-up" },
    ]),
    allocation: { basis: "weights", normalize: false },
    snapshot: snapshot(),
  });
  const browser = storage({
    [PORTFOLIOS_KEY]: {
      version: 1,
      activeId: document.id,
      portfolios: [document],
    },
    [companyKey]: {
      version: 1,
      companies: {
        AAPL: { ticker: "AAPL", saved: true, notes: "Existing company note" },
      },
    },
    [marketKey]: { version: 1, watchlist: ["MSFT"], views: [] },
    private_unrelated: "not backed up",
  });
  const vault = readResearchVault(browser);
  assert.equal(vault.issues.length, 0);
  const portfolioRows = vault.entries.filter(
    (entry) => entry.source === "Portfolios",
  );
  assert.equal(portfolioRows.length, 2);
  assert.ok(
    portfolioRows.some(
      (entry) => entry.type === "portfolio" && entry.title === document.name,
    ),
  );
  assert.ok(
    portfolioRows.some(
      (entry) =>
        entry.type === "position" &&
        entry.text.includes("Private evidence follow-up"),
    ),
  );
  assert.ok(
    portfolioRows.every(
      (entry) =>
        safeInternalPath(entry.href) &&
        !entry.href.includes("12.5") &&
        !entry.href.includes("Private"),
    ),
  );
  assert.ok(
    vault.entries.some((entry) => entry.text === "Existing company note"),
  );
  const raw = exportResearchBackup(browser, now);
  const backup = parseResearchBackup(raw);
  assert.equal(backup.stores[PORTFOLIOS_KEY], browser.getItem(PORTFOLIOS_KEY));
  assert.ok(
    raw.includes("Private evidence follow-up"),
    "full private backups intentionally preserve notes; research exports have a separate opt-in",
  );
  assert.equal(raw.includes("private_unrelated"), false);
  assert.equal(browser.writes.length, 0);
  const target = storage({
    [marketKey]: { version: 1, watchlist: ["JPM"], views: [] },
  });
  const preview = previewResearchRestore(target, backup).find(
    (entry) => entry.key === PORTFOLIOS_KEY,
  );
  assert.equal(preview.incomingCount, 2);
  assert.equal(preview.available, true);
  assert.equal(
    restoreResearchVault(
      target,
      backup,
      [PORTFOLIOS_KEY],
      exportResearchBackup(target),
    ).restored,
    1,
  );
  assert.deepEqual(
    readPortfolios(target.getItem(PORTFOLIOS_KEY)).portfolios[0],
    document,
  );
  assert.deepEqual(JSON.parse(target.getItem(marketKey)).watchlist, ["JPM"]);
});

test("older backups restore their own stores without replacing new portfolios", () => {
  const document = portfolio();
  const browser = storage({
    [PORTFOLIOS_KEY]: {
      version: 1,
      activeId: document.id,
      portfolios: [document],
    },
  });
  const previous = browser.getItem(PORTFOLIOS_KEY);
  const old = parseResearchBackup(
    JSON.stringify({
      format: "edgar-research-backup",
      version: 1,
      exportedAt: now,
      stores: {
        [marketKey]: JSON.stringify({
          version: 1,
          watchlist: ["MSFT"],
          views: [],
        }),
      },
    }),
  );
  assert.equal(old.issues.length, 0);
  assert.equal(Object.hasOwn(old.stores, PORTFOLIOS_KEY), false);
  restoreResearchVault(
    browser,
    old,
    [marketKey],
    exportResearchBackup(browser),
  );
  assert.equal(browser.getItem(PORTFOLIOS_KEY), previous);
  const legacy = parseResearchBackup(
    JSON.stringify({
      version: 1,
      companies: { AAPL: { ticker: "AAPL", notes: "Legacy note" } },
    }),
  );
  restoreResearchVault(
    browser,
    legacy,
    [companyKey],
    exportResearchBackup(browser),
  );
  assert.equal(browser.getItem(PORTFOLIOS_KEY), previous);
  assert.equal(
    JSON.parse(browser.getItem(companyKey)).companies.AAPL.notes,
    "Legacy note",
  );
});

test("saved CIK-only filing evidence opens its SEC source instead of a broken ticker notebook", () => {
  const cik = "0000320193";
  const browser = storage({
    [companyKey]: {
      version: 1,
      companies: {
        [cik]: {
          ticker: cik,
          cik,
          name: "Apple Inc.",
          evidence: [
            {
              label: "CIK-only filing",
              text: "Saved portfolio evidence",
              url: sourceUrl,
              collectedAt: now,
            },
            {
              label: "Source-free evidence",
              text: "Local review note",
              collectedAt: now,
            },
          ],
        },
      },
    },
  });
  const vault = readResearchVault(browser);
  assert.equal(vault.issues.length, 0);
  assert.equal(
    vault.entries.find((entry) => entry.title === "CIK-only filing").href,
    sourceUrl,
  );
  assert.equal(
    vault.entries.find((entry) => entry.title === "Source-free evidence").href,
    "/workspace?view=library",
  );
  assert.equal(
    vault.entries.some((entry) => entry.href.includes(`/analysis/${cik}`)),
    false,
  );
  const copied = parseResearchBackup(exportResearchBackup(browser));
  assert.equal(copied.issues.length, 0);
});
