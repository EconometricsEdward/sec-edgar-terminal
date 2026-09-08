import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_STORES,
  researchEvidenceSources,
  readResearchVault,
  validateResearchStore,
  exportResearchBackup,
  parseResearchBackup,
  previewResearchRestore,
  restoreResearchVault,
} from "../src/utils/researchVault.js";
import { RESEARCH_INBOX_KEY } from "../src/utils/researchInbox.js";
import {
  PORTFOLIO_VIEWS_KEY,
  DEFAULT_PORTFOLIO_VIEW,
} from "../src/utils/portfolioViews.js";
import {
  RESEARCH_BRIEFS_KEY,
  createResearchBrief,
  createBriefSource,
} from "../src/utils/researchBriefs.js";
import {
  FUND_BOARDS_KEY,
  captureFundBoard,
  createFundEvidence,
} from "../src/utils/fundBoards.js";

const now = "2026-09-08T12:00:00.000Z";
const accession = "0000019617-26-000101";
const url =
  "https://www.sec.gov/Archives/edgar/data/19617/000001961726000101/jpm.htm";
const workspaceKey = "edgar:research-workspace:v1";
function storage(seed = {}) {
  const data = new Map(
    Object.entries(seed).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}
function hubFixtures() {
  const brief = createResearchBrief({
    id: "brief-one",
    title: "Private capital review",
    question: "Private question",
    thesis: "Private thesis",
    ticker: "JPM",
    portfolioId: "portfolio-one",
    now,
    sources: [
      createBriefSource(
        {
          id: "source-one",
          url,
          label: "JPM annual report",
          notes: "Private annotation",
          capturedAt: now,
        },
        now,
      ),
    ],
  });
  return {
    [RESEARCH_INBOX_KEY]: {
      version: 1,
      updatedAt: now,
      items: [
        {
          id: `inbox:filing:${"a".repeat(32)}`,
          status: "reviewed",
          updatedAt: now,
          snoozedUntil: null,
        },
      ],
    },
    [PORTFOLIO_VIEWS_KEY]: {
      version: 1,
      views: [
        {
          id: "view-one",
          name: "Private saved filter",
          value: { ...DEFAULT_PORTFOLIO_VIEW, query: "Private view query" },
          createdAt: now,
          updatedAt: now,
        },
      ],
      current: [
        {
          portfolioId: "portfolio-one",
          value: DEFAULT_PORTFOLIO_VIEW,
          updatedAt: now,
        },
      ],
    },
    [RESEARCH_BRIEFS_KEY]: { version: 1, briefs: [brief], activeId: brief.id },
  };
}

test("full backups restore new hub stores exactly, index private IDs only, and do not duplicate inbox queues", () => {
  const source = storage(hubFixtures());
  const before = [...source.data];
  const vault = readResearchVault(source);
  assert.deepEqual(vault.issues, []);
  assert.equal(vault.entries.length, 2);
  assert.equal(vault.totals.queued, 0);
  assert.equal(vault.totals.briefs, 1);
  const brief = vault.entries.find((entry) => entry.type === "brief");
  assert.equal(brief.source, "Briefs");
  assert.equal(brief.href, "/workspace?view=briefs&brief=brief-one");
  assert.equal(brief.text.includes("Private thesis"), true);
  assert.deepEqual(brief.sources, [
    { url, label: "JPM annual report", capturedAt: now },
  ]);
  assert.equal(
    vault.entries.find((entry) => entry.type === "search").href,
    "/workspace?view=portfolios&portfolioView=view-one",
  );
  assert.equal(
    vault.entries.some((entry) =>
      /Private|question|thesis|query=/.test(entry.href),
    ),
    false,
  );
  assert.equal(
    RESEARCH_STORES.filter((store) => Object.hasOwn(hubFixtures(), store.key))
      .length,
    3,
  );
  assert.deepEqual(
    [...source.data],
    before,
    "Indexing must not normalize or write saved data",
  );
  const raw = exportResearchBackup(source, now),
    backup = parseResearchBackup(raw);
  const destination = storage({ unrelated: "preserve" });
  const preview = previewResearchRestore(destination, backup);
  const selected = preview
    .filter((store) => store.available)
    .map((store) => store.key);
  assert.equal(selected.length, 3);
  restoreResearchVault(
    destination,
    backup,
    selected,
    exportResearchBackup(destination, now),
  );
  for (const key of selected)
    assert.equal(destination.getItem(key), source.getItem(key));
  assert.equal(destination.getItem("unrelated"), "preserve");
  assert.match(raw, /Private annotation/);
});

test("older backups cannot erase hub briefs, view preferences, or review decisions", () => {
  const destination = storage(hubFixtures()),
    preserved = [...destination.data];
  const oldRaw = JSON.stringify({
    format: "edgar-research-backup",
    version: 1,
    exportedAt: now,
    stores: {
      [workspaceKey]: JSON.stringify({
        version: 1,
        companies: { JPM: { saved: true, name: "JPMorgan" } },
      }),
    },
  });
  const backup = parseResearchBackup(oldRaw);
  assert.deepEqual(
    previewResearchRestore(destination, backup).map((store) => store.key),
    [workspaceKey],
  );
  restoreResearchVault(
    destination,
    backup,
    [workspaceKey],
    exportResearchBackup(destination, now),
  );
  for (const [key, value] of preserved)
    assert.equal(destination.getItem(key), value);
  assert.equal(readResearchVault(destination).totals.briefs, 1);
});

test("new store schema failures remain backed up but cannot be restored", () => {
  const fixtures = hubFixtures();
  fixtures[RESEARCH_INBOX_KEY].items[0].snoozedUntil = now;
  fixtures[PORTFOLIO_VIEWS_KEY].views[0].value.query = "x".repeat(301);
  fixtures[RESEARCH_BRIEFS_KEY].briefs[0].sources[0].url =
    "https://example.com/not-sec";
  for (const [key, value] of Object.entries(fixtures))
    assert.throws(() => validateResearchStore(key, JSON.stringify(value)));
  const source = storage(fixtures),
    raw = exportResearchBackup(source, now),
    backup = parseResearchBackup(raw);
  assert.equal(backup.issues.length, 3);
  assert.equal(readResearchVault(source).issues.length, 3);
  assert.equal(
    previewResearchRestore(storage(), backup).some((store) => store.available),
    false,
  );
  for (const key of Object.keys(fixtures))
    assert.equal(backup.stores[key], source.getItem(key));
});

test("legacy evidence from every source keeps its actual SEC citation and original collection context", () => {
  const filing = {
    accession,
    form: "10-K",
    filingDate: "2026-02-01",
    documentUrl: url,
  };
  const point = {
    value: 20,
    period: { kind: "annual", end: "2025-12-31" },
    sources: [{ documentUrl: url, accession, tag: "NetIncomeLoss" }],
  };
  const fundSource = {
    ticker: "VTI",
    name: "Total market",
    accession,
    asOf: "2026-06-30",
    filingDate: "2026-08-28",
    sourceUrl: url,
  };
  const evidence = createFundEvidence({
    kind: "security",
    title: "Position weight",
    summary: "Reported weight",
    values: [{ label: "Weight", value: 1, unit: "%" }],
    sources: [fundSource],
  });
  const board = captureFundBoard({
    id: "board-one",
    name: "Fund review",
    settings: { tickers: ["VTI"] },
    snapshots: [],
    evidence: [evidence],
    now,
  });
  const values = {
    [workspaceKey]: {
      version: 1,
      companies: {
        JPM: { evidence: [{ label: "Income", point, collectedAt: now }] },
      },
    },
    "edgar:compare-notebook:v1": {
      version: 1,
      searches: [],
      pins: [
        {
          id: "pin-one",
          ticker: "JPM",
          label: "Peer income",
          point,
          settings: {},
          savedAt: now,
        },
      ],
    },
    "edgar:disclosure-notebook:v1": {
      version: 1,
      searches: [],
      collections: [
        {
          id: "collection-one",
          name: "Liquidity",
          items: [
            {
              id: "passage-one",
              ticker: "JPM",
              quote: "Quoted passage",
              notes: "Private note",
              tags: "",
              section: "Liquidity",
              settings: {},
              documentUrl: url,
              observedAt: now,
            },
          ],
        },
      ],
    },
    "edgar:filings-notebook:v1": {
      version: 1,
      companies: {
        JPM: {
          records: {},
          views: [],
          evidence: [
            {
              id: "filing-one",
              filing,
              paragraph: { index: 1, text: "Filing passage", section: "Notes" },
              tags: [],
            },
          ],
        },
      },
    },
    [FUND_BOARDS_KEY]: { version: 1, boards: [board] },
  };
  const vault = readResearchVault(storage(values));
  assert.deepEqual(vault.issues, []);
  const saved = vault.entries.filter((entry) => entry.type === "evidence");
  assert.equal(saved.length, 5);
  assert.deepEqual(
    new Set(saved.map((entry) => entry.source)),
    new Set(["Analysis", "Compare", "Disclosures", "Filings", "Funds"]),
  );
  for (const entry of saved) {
    assert.equal(entry.sources.length, 1);
    assert.equal(entry.sources[0].url, url);
    assert.ok(
      entry.title.length &&
        entry.ticker.length &&
        entry.id.startsWith(`${entry.source}:evidence:`),
    );
    assert.notEqual(entry.sources[0].url, entry.href);
  }
  assert.equal(
    saved.find((entry) => entry.source === "Analysis").sources[0].capturedAt,
    now,
  );
  assert.equal(
    saved.find((entry) => entry.source === "Filings").sources[0].capturedAt,
    undefined,
    "A filing date is not a source capture timestamp",
  );
});

test("citation extraction is bounded, deduplicated, and never turns internal or unsafe destinations into evidence", () => {
  const sources = researchEvidenceSources({
    url,
    href: "/analysis/JPM",
    notes: "https://www.sec.gov/guess.htm",
    collectedAt: now,
    point: {
      sources: [
        { documentUrl: url },
        { url: "javascript:alert(1)" },
        { url: "https://sec.gov.evil.test/a" },
        { url: "https://user@www.sec.gov/a" },
        { url: "https://www.sec.gov:444/a" },
        { url: "/workspace?private=secret" },
        { sourceUrl: "http://www.sec.gov/a" },
      ],
    },
  });
  assert.deepEqual(sources, [{ url, label: "SEC source", capturedAt: now }]);
  const many = researchEvidenceSources({
    sources: Array.from({ length: 2000 }, (_, index) => ({
      documentUrl: `${url}?source=${index}`,
    })),
  });
  assert.equal(many.length, 100);
  assert.equal(new Set(many.map((source) => source.url)).size, 100);
  assert.deepEqual(
    researchEvidenceSources({
      cik: "0000019617",
      accession,
      primaryDoc: "jpm.htm",
    }),
    [],
  );
});
