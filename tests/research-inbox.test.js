import test from "node:test";
import assert from "node:assert/strict";
import {
  createPortfolioRows,
  normalizePortfolioInput,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import {
  deriveResearchInbox,
  readResearchInbox,
  updateResearchInbox,
  validateResearchInbox,
  safeInboxUrl,
  RESEARCH_INBOX_KEY,
} from "../src/utils/researchInbox.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const stamp = new Date(NOW).toISOString();
const source =
  "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl.htm";
const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    data,
  };
};
const rows = (holdings) =>
  resolvePortfolioRows(
    createPortfolioRows(
      normalizePortfolioInput({
        schema_version: "edgar.portfolio.v1",
        holdings,
      }).holdings,
    ),
    {
      AAPL: { cik: "320193", name: "Apple Inc." },
      MSFT: { cik: "789019", name: "Microsoft Corporation" },
    },
  );
const company = (patch = {}) => ({
  cik: "0000320193",
  ticker: "AAPL",
  name: "Apple Inc.",
  status: "ready",
  kind: "company",
  period: { kind: "annual", end: "2025-09-30" },
  cache: { status: "fresh" },
  metrics: {
    netIncome: {
      value: -10,
      unit: "USD",
      period: { end: "2025-09-30" },
      sources: [{ accession: "0000320193-26-000001", documentUrl: source }],
    },
  },
  filings: [
    {
      form: "10-Q",
      filingDate: "2026-09-01",
      accession: "0000320193-26-000001",
      documentUrl: source,
    },
  ],
  ...patch,
});
const portfolio = (
  companies = [company()],
  holdings = [{ ticker: "AAPL" }],
) => ({
  id: "portfolio-example",
  name: "Research universe",
  rows: rows(holdings),
  allocation: { basis: "none", normalize: false },
  snapshot: { companies },
});
const derive = (portfolios, other = {}) =>
  deriveResearchInbox({ portfolios, now: NOW, ...other });

test("every recent accession gets an independent decision and unchanged refreshes retain review", () => {
  const first = portfolio();
  const initial = derive([first]);
  const filing = initial.items.find((item) => item.kind === "filing");
  const storage = memory();
  const states = updateResearchInbox(storage, {
    id: filing.id,
    status: "reviewed",
    now: stamp,
  });
  const refreshed = structuredClone(first);
  refreshed.snapshot.generated_at = "2026-09-08T13:00:00.000Z";
  refreshed.snapshot.companies[0].retrievedAt = "2026-09-08T13:00:00.000Z";
  assert.equal(
    derive([refreshed], { states }).items.find((item) => item.kind === "filing")
      .status,
    "reviewed",
  );
  refreshed.snapshot.companies[0].filings.unshift({
    form: "8-K",
    filingDate: "2026-09-08",
    accession: "0000320193-26-000002",
    documentUrl: source.replace("000001", "000002"),
  });
  const next = derive([refreshed], { states }).items.filter(
    (item) => item.kind === "filing",
  );
  assert.equal(next.length, 2);
  assert.equal(
    next.find((item) => item.title.startsWith("8-K")).status,
    "open",
  );
  assert.equal(
    next.find((item) => item.title.startsWith("10-Q")).status,
    "reviewed",
  );
  assert.equal(
    readResearchInbox(storage.getItem(RESEARCH_INBOX_KEY)).items.length,
    1,
  );
});

test("reported period, value, and accession changes reopen metric evidence; source ordering and retrieval do not", () => {
  const saved = portfolio();
  const metric = derive([saved]).items.find((item) => item.kind === "metric");
  const storage = memory();
  const states = updateResearchInbox(storage, {
    id: metric.id,
    status: "reviewed",
    now: stamp,
  });
  const changedValue = structuredClone(saved);
  changedValue.snapshot.companies[0].metrics.netIncome.value = -12;
  assert.equal(
    derive([changedValue], { states }).items.find(
      (item) => item.kind === "metric",
    ).status,
    "open",
  );
  const changedPeriod = structuredClone(saved);
  changedPeriod.snapshot.companies[0].metrics.netIncome.period.end =
    "2026-06-30";
  assert.notEqual(
    derive([changedPeriod]).items.find((item) => item.kind === "metric").id,
    metric.id,
  );
  const noChange = structuredClone(saved);
  noChange.snapshot.companies[0].retrievedAt = "2026-09-08T13:00:00.000Z";
  assert.equal(
    derive([noChange], { states }).items.find((item) => item.kind === "metric")
      .status,
    "reviewed",
  );
});

test("snoozes expire without mutating storage and can be explicitly reopened", () => {
  const storage = memory();
  const item = derive([portfolio()]).items[0];
  const states = updateResearchInbox(storage, {
    id: item.id,
    status: "snoozed",
    now: stamp,
  });
  const before = storage.getItem(RESEARCH_INBOX_KEY);
  assert.equal(
    derive([portfolio()], { states, now: NOW + 6 * 86400000 }).items.find(
      (entry) => entry.id === item.id,
    ).status,
    "snoozed",
  );
  assert.equal(
    derive([portfolio()], { states, now: NOW + 7 * 86400000 }).items.find(
      (entry) => entry.id === item.id,
    ).status,
    "open",
  );
  assert.equal(storage.getItem(RESEARCH_INBOX_KEY), before);
  const reopened = updateResearchInbox(storage, {
    id: item.id,
    status: "open",
    expectedUpdatedAt: states.items[0].updatedAt,
    now: stamp,
  });
  assert.equal(reopened.items[0].status, "open");
  assert.equal(reopened.items[0].snoozedUntil, null);
  assert.ok(reopened.items[0].updatedAt > states.items[0].updatedAt);
});

test("inbox review does not acknowledge SEC refresh, company baselines, or original filing queues", () => {
  const workspaceRaw = JSON.stringify({
    companies: { AAPL: { reviewedAt: "2026-01-01T00:00:00.000Z" } },
  });
  const filingsRaw = JSON.stringify({ queued: true, reviewedAt: null });
  const storage = memory({
    "edgar:research-workspace:v1": workspaceRaw,
    "edgar:filings-notebook:v1": filingsRaw,
  });
  const watchlist = [
    {
      ticker: "AAPL",
      kind: "company",
      review: { reviewedAt: "2026-01-01T00:00:00.000Z" },
    },
  ];
  const item = derive([], { watchlist }).items[0];
  updateResearchInbox(storage, { id: item.id, status: "reviewed", now: stamp });
  assert.equal(storage.getItem("edgar:research-workspace:v1"), workspaceRaw);
  assert.equal(storage.getItem("edgar:filings-notebook:v1"), filingsRaw);
  assert.deepEqual(watchlist[0].review, {
    reviewedAt: "2026-01-01T00:00:00.000Z",
  });
});

test("the same issuer is one company filter across portfolios, watchlists, and queued filings", () => {
  const result = derive([portfolio()], {
    watchlist: [{ ticker: "AAPL", kind: "company", review: {} }],
    vault: {
      entries: [
        {
          id: "queue-aapl",
          type: "queue",
          source: "Filings",
          ticker: "AAPL",
          title: "10-Q",
          date: "2026-09-01",
          text: "Read it",
          href: "/filings/AAPL",
          sources: [{ url: source, label: "Quarterly filing" }],
        },
      ],
    },
  });
  assert.equal(result.companies.length, 1);
  assert.equal(result.companies[0].key, "0000320193");
  assert.equal(
    result.items.find((item) => item.kind === "queue").sourceUrl,
    source,
  );
  assert.ok(result.items.every((item) => item.companyName === "Apple Inc."));
});

test("legacy queue identity includes changed evidence; unsupported or unsafe source links never become actions", () => {
  const entry = {
    id: "Filings:queue:AAPL:0000320193-26-000001",
    type: "queue",
    source: "Filings",
    ticker: "AAPL",
    title: "10-Q · 2026-09-01",
    text: "Read the cash flow note",
    date: "2026-09-01",
    href: "/filings/AAPL?view=notebook",
  };
  const vault = {
    entries: [entry, { ...entry, id: "ignored", source: "Market" }],
  };
  const initial = derive([], { vault });
  assert.equal(initial.items.length, 1);
  const states = updateResearchInbox(memory(), {
    id: initial.items[0].id,
    status: "reviewed",
    now: stamp,
  });
  assert.equal(derive([], { vault, states }).items[0].status, "reviewed");
  const changed = {
    entries: [
      {
        ...entry,
        text: "Read the corrected disclosure",
        href: "javascript:alert(1)",
      },
    ],
  };
  const result = derive([], { vault: changed, states }).items[0];
  assert.equal(result.status, "open");
  assert.equal(result.companyUrl, null);
  for (const url of [
    "javascript:alert(1)",
    "//example.com",
    "https://sec.gov.example.com/file",
    "https://user@sec.gov/file",
    "http://www.sec.gov/file",
    "https://www.sec.gov:444/file",
    "/\\example.com",
  ])
    assert.equal(safeInboxUrl(url), null);
  assert.equal(safeInboxUrl(source, true), source);
  assert.equal(safeInboxUrl("/analysis/AAPL", true), null);
});

test("priority is a transparent condition and does not fabricate zero, future filings, fund reviews, or CIK tickers", () => {
  const p = portfolio(
    [
      company({
        ticker: null,
        metrics: { netIncome: { value: null } },
        filings: [
          { form: "10-Q", filingDate: "2026-09-09", documentUrl: source },
        ],
      }),
    ],
    [{ cik: "320193" }],
  );
  const result = derive([p], {
    watchlist: [
      { ticker: "VOO", kind: "fund", review: {} },
      {
        ticker: "MSFT",
        kind: "company",
        review: { reviewedAt: "2026-09-01T00:00:00.000Z" },
      },
    ],
  });
  assert.ok(
    result.items.every(
      (item) => !["metric", "filing", "watchlist"].includes(item.kind),
    ),
  );
  const old = portfolio(
    [
      company({
        ticker: null,
        period: { kind: "annual", end: "2023-09-30" },
        metrics: {},
        filings: [],
      }),
    ],
    [{ cik: "320193" }],
  );
  const freshness = derive([old]).items.find(
    (item) => item.kind === "freshness",
  );
  assert.match(freshness.reason, /550 days/);
  assert.equal(
    freshness.companyUrl,
    "/disclosures?tickers=0000320193&mode=companies",
  );
  assert.equal(freshness.priorityLabel, "Check older evidence");
});

test("a partial filings-only result leaves a known large allocation without financial coverage", () => {
  const p = portfolio(
    [company({ status: "partial", metrics: { netIncome: { value: null } } })],
    [{ ticker: "AAPL", weight_pct: 20 }],
  );
  p.allocation = { basis: "weights", normalize: false };
  const item = derive([p]).items.find((entry) => entry.kind === "coverage");
  assert.match(item.reason, /20.00% allocation/);
  assert.match(item.reason, /supported numeric financial facts are missing/);
  const covered = structuredClone(p);
  covered.snapshot.companies[0].metrics.netIncome.value = 0;
  assert.equal(
    derive([covered]).items.some((entry) => entry.kind === "coverage"),
    false,
  );
});

test("brief source capture preserves recorded retrieval dates without inventing dates for legacy sources", () => {
  const retrievedAt = "2026-09-03T10:00:00.000Z";
  const capturedAt = "2026-09-02T08:00:00.000Z";
  const saved = portfolio([company({ retrievedAt })]);
  const result = derive([saved], {
    vault: {
      entries: [
        {
          id: "dated-queue",
          type: "queue",
          source: "Filings",
          ticker: "AAPL",
          title: "Saved filing",
          date: "2026-09-01",
          sources: [{ url: source, capturedAt }],
        },
        {
          id: "legacy-queue",
          type: "queue",
          source: "Filings",
          ticker: "AAPL",
          title: "Legacy filing",
          date: "2026-09-01",
          sources: [{ url: source }],
        },
      ],
    },
  });
  assert.equal(
    result.items.find((item) => item.kind === "filing").capturedAt,
    retrievedAt,
  );
  assert.equal(
    result.items.find((item) => item.kind === "metric").capturedAt,
    retrievedAt,
  );
  assert.equal(
    result.items.find((item) => item.title === "Saved filing").capturedAt,
    capturedAt,
  );
  assert.equal(
    result.items.find((item) => item.title === "Legacy filing").capturedAt,
    undefined,
  );
});

test("store accepts only bounded status metadata and preserves data on corruption, quota, or cross-tab conflicts", () => {
  assert.deepEqual(readResearchInbox(null), {
    version: 1,
    updatedAt: null,
    items: [],
  });
  const id = "inbox:filing:" + "a".repeat(32);
  const storage = memory();
  const first = updateResearchInbox(storage, {
    id,
    status: "reviewed",
    now: stamp,
  });
  const raw = storage.getItem(RESEARCH_INBOX_KEY);
  assert.deepEqual(Object.keys(first.items[0]).sort(), [
    "id",
    "snoozedUntil",
    "status",
    "updatedAt",
  ]);
  assert.throws(
    () =>
      updateResearchInbox(storage, {
        id,
        status: "open",
        expectedUpdatedAt: null,
        now: stamp,
      }),
    /another tab/,
  );
  assert.equal(storage.getItem(RESEARCH_INBOX_KEY), raw);
  assert.throws(
    () => validateResearchInbox({ ...first, notes: "private" }),
    /format/,
  );
  assert.throws(
    () =>
      validateResearchInbox({
        ...first,
        items: [{ ...first.items[0], text: "private" }],
      }),
    /unsupported fields/,
  );
  assert.throws(
    () =>
      readResearchInbox(
        '{"version":1,"updatedAt":null,"items":[],"__proto__":{}}',
      ),
    /could not be read/,
  );
  assert.throws(() => readResearchInbox("{"), /preserved/);
  assert.throws(
    () =>
      validateResearchInbox({
        ...first,
        items: [...first.items, first.items[0]],
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      updateResearchInbox(
        {
          getItem: storage.getItem,
          setItem: () => {
            throw new Error("quota");
          },
        },
        { id, status: "open", now: stamp },
      ),
    /unchanged/,
  );
  assert.equal(storage.getItem(RESEARCH_INBOX_KEY), raw);
  assert.throws(
    () =>
      updateResearchInbox(storage, {
        id,
        status: "snoozed",
        snoozedUntil: stamp,
        now: stamp,
      }),
    /snooze date/,
  );
  const full = {
    version: 1,
    updatedAt: stamp,
    items: Array.from({ length: 1000 }, (_, index) => ({
      id: `inbox:filing:${index.toString(16).padStart(32, "0")}`,
      status: "reviewed",
      updatedAt: stamp,
      snoozedUntil: null,
    })),
  };
  validateResearchInbox(full);
  const fullStorage = memory({ [RESEARCH_INBOX_KEY]: JSON.stringify(full) });
  assert.throws(
    () =>
      updateResearchInbox(fullStorage, { id, status: "reviewed", now: stamp }),
    /1,000/,
  );
  assert.equal(fullStorage.getItem(RESEARCH_INBOX_KEY), JSON.stringify(full));
});
