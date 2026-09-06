import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_STORES,
  RESEARCH_BACKUP_LIMIT,
  readResearchVault,
  validateResearchStore,
  exportResearchBackup,
  parseResearchBackup,
  previewResearchRestore,
  restoreResearchVault,
} from "../src/utils/researchVault.js";
import { safeInternalPath } from "../src/utils/siteRoutes.js";

const [
  workspaceKey,
  compareKey,
  disclosuresKey,
  filingsKey,
  marketKey,
  fundsKey,
] = RESEARCH_STORES.map((s) => s.key);
const accession = "0000019617-26-000101";
const url =
  "https://www.sec.gov/Archives/edgar/data/19617/000001961726000101/jpm.htm";
const now = "2026-09-06T12:00:00.000Z";
function fixtures() {
  const settings = {
    tickers: "JPM",
    mode: "companies",
    query: "liquidity AND covenant",
    start: "2025-01-01",
    end: "2026-09-06",
    forms: "10-K",
    section: "all",
    scope: "paragraph",
    depth: 6,
    amendments: false,
  };
  const point = {
    value: 20,
    formula: "Net income / average equity",
    period: { kind: "annual", end: "2025-12-31" },
    sources: [{ documentUrl: url, accession }],
  };
  const filing = {
    accession,
    form: "10-Q",
    filingDate: "2026-08-03",
    reportDate: "2026-06-30",
    documentUrl: url,
  };
  return {
    [workspaceKey]: {
      version: 1,
      companies: {
        JPM: {
          ticker: "JPM",
          name: "JPMorgan",
          saved: true,
          notes: "Credit review notes",
          analysisReviewedAt: now,
          analysisBaseline: {
            version: "analysis-v1",
            metrics: { roe: point },
            period: point.period,
          },
          evidence: [
            {
              label: "Return on equity",
              point,
              notes: "Compare with the capital base",
              collectedAt: now,
            },
          ],
          analysisViews: [
            {
              name: "Bank returns",
              settings: { basis: "annual", view: "drivers" },
              savedAt: now,
            },
          ],
          additionalCompatibleField: "retained",
        },
      },
      peerGroups: [{ name: "Banks", tickers: ["JPM", "BAC"] }],
    },
    [compareKey]: {
      version: 1,
      collectionName: "Bank peers",
      notes: "Peer memo",
      pins: [
        {
          id: "roe",
          ticker: "JPM",
          label: "ROE",
          point,
          settings: { basis: "annual" },
          savedAt: now,
          notes: "Higher return",
          tags: "capital",
        },
      ],
      searches: [
        {
          id: "banks",
          name: "Banks",
          tickers: ["JPM", "BAC"],
          settings: { view: "map", basis: "ttm" },
          savedAt: now,
        },
      ],
    },
    [disclosuresKey]: {
      version: 1,
      searches: [
        {
          id: "liquidity",
          name: "Liquidity review",
          settings,
          seen: [],
          createdAt: now,
          inbox: [
            {
              id: "jpm",
              ticker: "JPM",
              form: "10-K",
              reviewed: false,
              documentUrl: url,
              discoveredAt: now,
            },
          ],
          lastCoverage: [],
        },
      ],
      collections: [
        {
          id: "default",
          name: "Bank refinancing",
          items: [
            {
              id: "passage",
              ticker: "JPM",
              section: "MD&A",
              quote: "Available liquidity was $10 billion.",
              notes: "Verify committed facilities",
              tags: "liquidity",
              documentUrl: url,
              settings,
              observedAt: now,
            },
          ],
        },
      ],
      labels: {},
    },
    [filingsKey]: {
      version: 1,
      companies: {
        JPM: {
          records: {
            [accession]: {
              queued: true,
              reviewedAt: "",
              notes: "Review the covenant note",
              filing,
            },
          },
          evidence: [
            {
              id: "quote",
              filing,
              paragraph: {
                index: 1,
                section: "Notes",
                text: "No covenant breaches were reported.",
              },
              notes: "",
              tags: ["covenants"],
            },
          ],
          views: [
            {
              id: "events",
              name: "Bank events",
              settings: { family: "current" },
              createdAt: now,
            },
          ],
        },
      },
    },
    [marketKey]: {
      version: 1,
      watchlist: ["JPM"],
      views: [{ name: "Banks in review", query: "cohort=banks&basis=ttm" }],
      baselines: {
        JPM: { name: "JPMorgan", metrics: {}, reports: {}, observedAt: now },
      },
    },
    [fundsKey]: ["VTI"],
  };
}
function storage(values = {}) {
  const data = new Map(
    Object.entries(values).map(([k, v]) => [
      k,
      typeof v === "string" ? v : JSON.stringify(v),
    ]),
  );
  return {
    data,
    writes: [],
    get length() {
      return data.size;
    },
    key(i) {
      return [...data.keys()][i] ?? null;
    },
    getItem(k) {
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      this.writes.push(k);
      data.set(k, v);
    },
    removeItem(k) {
      this.writes.push(k);
      data.delete(k);
    },
  };
}
const imported = (values) =>
  parseResearchBackup(exportResearchBackup(storage(values), now));

test("unified index includes all six tools with separate evidence, notes, searches and unreviewed queues", () => {
  const s = storage(fixtures());
  const vault = readResearchVault(s);
  assert.equal(vault.issues.length, 0);
  assert.deepEqual(
    new Set(vault.entries.map((e) => e.source)),
    new Set([
      "Analysis",
      "Compare",
      "Disclosures",
      "Filings",
      "Market",
      "Funds",
    ]),
  );
  assert.equal(vault.totals.evidence, 4);
  assert.equal(vault.totals.queued, 2);
  assert.equal(vault.totals.searches, 6);
  assert.equal(vault.totals.companies, 3);
  assert.ok(
    vault.entries.find(
      (e) => e.type === "note" && e.text === "Credit review notes",
    ),
  );
  assert.ok(vault.entries.find((e) => e.href === "/fund/VTI"));
  assert.ok(
    vault.entries.find((e) =>
      e.href.includes("/analysis/JPM?basis=annual&view=drivers"),
    ),
  );
  assert.ok(vault.entries.every((e) => safeInternalPath(e.href)));
  assert.ok(
    vault.entries
      .find((e) => e.source === "Compare" && e.type === "evidence")
      .href.startsWith("/compare/JPM,BAC?"),
  );
  assert.equal(s.writes.length, 0);
});

test("reviewed items leave pending queues without erasing saved notes", () => {
  const values = fixtures();
  values[filingsKey].companies.JPM.records[accession].reviewedAt = now;
  values[disclosuresKey].searches[0].inbox[0].reviewed = true;
  const vault = readResearchVault(storage(values));
  assert.equal(vault.totals.queued, 0);
  assert.ok(
    vault.entries.find((e) => e.source === "Filings" && e.type === "note"),
  );
});

test("backup preserves exact store strings and unknown compatible fields without copying unrelated localStorage", () => {
  const s = storage({
    ...fixtures(),
    private_unrelated: "never include",
    [fundsKey]: '[ "VTI" ]',
  });
  const raw = exportResearchBackup(s, now),
    backup = parseResearchBackup(raw);
  assert.equal(backup.stores[fundsKey], '[ "VTI" ]');
  assert.equal(Object.keys(backup.stores).length, 6);
  assert.equal(raw.includes("private_unrelated"), false);
  assert.equal(
    JSON.parse(backup.stores[workspaceKey]).companies.JPM
      .additionalCompatibleField,
    "retained",
  );
});

test("corrupt store remains exportable but cannot be imported over existing saved research", () => {
  const s = storage({ [workspaceKey]: "{broken", [fundsKey]: ["VTI"] });
  const vault = readResearchVault(s);
  assert.equal(vault.issues.length, 1);
  assert.ok(vault.entries.find((e) => e.ticker === "VTI"));
  const backup = parseResearchBackup(exportResearchBackup(s));
  assert.equal(backup.stores[workspaceKey], "{broken");
  assert.equal(backup.issues.length, 1);
  const preview = previewResearchRestore(storage(), backup);
  assert.equal(preview.find((p) => p.key === workspaceKey).available, false);
  assert.equal(s.getItem(workspaceKey), "{broken");
});

test("legacy single-workspace backup is imported without inventing missing tool stores", () => {
  const backup = parseResearchBackup(JSON.stringify(fixtures()[workspaceKey]));
  assert.deepEqual(Object.keys(backup.stores), [workspaceKey]);
  assert.equal(backup.issues.length, 0);
});

test("unsafe links, prototype fields, malformed nested collections and unsupported versions cannot become restorable", () => {
  for (const badUrl of [
    "javascript:alert(1)",
    "https://www.sec.gov.evil.test/a",
    "https://name@www.sec.gov/a",
    "https://www.sec.gov:444/a",
    "//www.sec.gov/a",
    "https://example.com/a",
  ]) {
    const values = fixtures();
    values[workspaceKey].companies.JPM.evidence[0].url = badUrl;
    assert.throws(
      () =>
        validateResearchStore(
          workspaceKey,
          JSON.stringify(values[workspaceKey]),
        ),
      /URL|HTTPS/,
    );
  }
  assert.throws(
    () =>
      validateResearchStore(
        workspaceKey,
        '{"version":1,"companies":{"__proto__":{"notes":"x"}}}',
      ),
    /Unsafe/,
  );
  const invalid = fixtures()[workspaceKey];
  invalid.companies.JPM.evidence = [{}];
  invalid.companies.JPM.evidence[0].point = "bad";
  assert.throws(
    () => validateResearchStore(workspaceKey, JSON.stringify(invalid)),
    /evidence/,
  );
  assert.throws(
    () =>
      validateResearchStore(
        compareKey,
        JSON.stringify({ version: 1, searches: [null], pins: [] }),
      ),
    /invalid/,
  );
  assert.throws(() => validateResearchStore(fundsKey, '["VTI",{}]'), /ticker/);
  assert.throws(
    () =>
      validateResearchStore(
        marketKey,
        JSON.stringify({ version: 9, views: [], watchlist: [] }),
      ),
    /not supported/,
  );
});

test("unknown stores and oversize files are rejected before any mutation", () => {
  assert.throws(
    () =>
      parseResearchBackup(
        JSON.stringify({
          format: "edgar-research-backup",
          version: 1,
          stores: { unrelated: "{}" },
        }),
      ),
    /unknown/,
  );
  assert.throws(
    () => parseResearchBackup(" ".repeat(RESEARCH_BACKUP_LIMIT + 1)),
    /16 MiB/,
  );
  assert.throws(
    () =>
      parseResearchBackup(
        JSON.stringify({
          format: "edgar-research-backup",
          version: 1,
          stores: { [fundsKey]: [] },
        }),
      ),
    /raw JSON/,
  );
});

test("restore preview distinguishes empty, identical, conflicting and corrupt current stores without writing", () => {
  const s = storage({
    [workspaceKey]: fixtures()[workspaceKey],
    [fundsKey]: ["VOO"],
    [marketKey]: "{bad",
  });
  const preview = previewResearchRestore(s, imported(fixtures()));
  assert.equal(preview.find((p) => p.key === workspaceKey).identical, true);
  assert.equal(preview.find((p) => p.key === fundsKey).conflict, true);
  assert.equal(preview.find((p) => p.key === compareKey).conflict, false);
  assert.equal(preview.find((p) => p.key === marketKey).available, false);
  assert.equal(s.writes.length, 0);
});

test("explicit restore replaces only selected stores and keeps an exact pre-restore backup", () => {
  const s = storage({ [fundsKey]: ["VOO"], untouched: "retained" });
  const before = exportResearchBackup(s);
  const result = restoreResearchVault(
    s,
    imported(fixtures()),
    [fundsKey, workspaceKey],
    before,
  );
  assert.equal(result.restored, 2);
  assert.deepEqual(JSON.parse(s.getItem(fundsKey)), ["VTI"]);
  assert.equal(s.getItem(compareKey), null);
  assert.equal(s.getItem("untouched"), "retained");
  assert.deepEqual(JSON.parse(parseResearchBackup(before).stores[fundsKey]), [
    "VOO",
  ]);
});

test("concurrent saved changes after safety backup stop the entire restore before writes", () => {
  const s = storage({ [fundsKey]: ["VOO"] });
  const before = exportResearchBackup(s);
  s.data.set(fundsKey, '["SPY"]');
  assert.throws(
    () =>
      restoreResearchVault(
        s,
        imported(fixtures()),
        [workspaceKey, fundsKey],
        before,
      ),
    /changed after/,
  );
  assert.equal(s.getItem(workspaceKey), null);
  assert.equal(s.writes.length, 0);
  assert.deepEqual(JSON.parse(s.getItem(fundsKey)), ["SPY"]);
});

test("quota failure rolls back already written stores including removing newly added keys", () => {
  const s = storage({ [fundsKey]: ["VOO"] });
  const before = exportResearchBackup(s);
  const originalSet = s.setItem.bind(s);
  s.setItem = (key, value) => {
    if (key === compareKey) throw new Error("QuotaExceededError");
    originalSet(key, value);
  };
  assert.throws(
    () =>
      restoreResearchVault(
        s,
        imported(fixtures()),
        [fundsKey, workspaceKey, compareKey],
        before,
      ),
    /Previous saved data was restored/,
  );
  assert.deepEqual(JSON.parse(s.getItem(fundsKey)), ["VOO"]);
  assert.equal(s.getItem(workspaceKey), null);
});

test("rollback failure is explicit and never reports a successful restore", () => {
  const s = storage({ [fundsKey]: ["VOO"] });
  const before = exportResearchBackup(s);
  const originalSet = s.setItem.bind(s);
  s.setItem = (key, value) => {
    if (key === compareKey || (key === fundsKey && value.includes("VOO")))
      throw new Error("Storage unavailable");
    originalSet(key, value);
  };
  assert.throws(
    () =>
      restoreResearchVault(
        s,
        imported(fixtures()),
        [fundsKey, compareKey],
        before,
      ),
    /could not be restored automatically/,
  );
});

test("missing backup store, corrupt existing data and missing safety snapshot cannot be overwritten", () => {
  const incoming = imported({ [fundsKey]: ["VTI"] });
  const s = storage({ [fundsKey]: "{bad" });
  assert.throws(
    () =>
      restoreResearchVault(s, incoming, [fundsKey], exportResearchBackup(s)),
    /unavailable/,
  );
  assert.equal(s.getItem(fundsKey), "{bad");
  const clean = storage();
  assert.throws(
    () =>
      restoreResearchVault(
        clean,
        incoming,
        [workspaceKey],
        exportResearchBackup(clean),
      ),
    /unavailable/,
  );
  assert.throws(
    () =>
      restoreResearchVault(
        clean,
        incoming,
        [fundsKey],
        JSON.stringify({ version: 1, companies: {} }),
      ),
    /changed after/,
  );
  assert.equal(clean.writes.length, 0);
});

test("disabled storage produces individual coverage issues and cannot export a misleading empty backup", () => {
  const unavailable = {
    getItem() {
      throw new Error("Storage blocked");
    },
  };
  const vault = readResearchVault(unavailable);
  assert.equal(vault.issues.length, 6);
  assert.equal(vault.entries.length, 0);
  assert.throws(() => exportResearchBackup(unavailable), /blocked/);
});

test("fund notes are indexed and backed up even for funds absent from the shelf", () => {
  const key = "edgar-fund-notes:SPY";
  const notes =
    "Private fund review\nConcentration in technology: verify the portfolio date.";
  const s = storage({ [key]: notes, [fundsKey]: ["VTI"] });
  const vault = readResearchVault(s);
  const note = vault.entries.find(
    (e) => e.type === "note" && e.ticker === "SPY",
  );
  assert.equal(note.text, notes);
  assert.equal(note.href, "/fund/SPY?tab=notebook");
  assert.equal(vault.totals.companies, 2);
  const backup = parseResearchBackup(exportResearchBackup(s));
  assert.equal(backup.stores[key], notes);
  assert.equal(backup.issues.length, 0);
  assert.equal(
    previewResearchRestore(storage(), backup).find((s) => s.key === key)
      .incomingCount,
    1,
  );
});

test("restore replaces selected fund notes and restores notes for previously unsaved funds", () => {
  const key = "edgar-fund-notes:SPY",
    newKey = "edgar-fund-notes:VTI";
  const s = storage({ [key]: "Original SPY notes" });
  const backup = imported({
    [key]: "Updated SPY notes",
    [newKey]: "VTI review",
  });
  const before = exportResearchBackup(s);
  assert.equal(
    restoreResearchVault(s, backup, [key, newKey], before).restored,
    2,
  );
  assert.equal(s.getItem(key), "Updated SPY notes");
  assert.equal(s.getItem(newKey), "VTI review");
  assert.equal(parseResearchBackup(before).stores[key], "Original SPY notes");
});

test("fund notes enforce key and text bounds and remain recoverable after partial restore failure", () => {
  assert.throws(
    () => validateResearchStore("edgar-fund-notes:../../bad", "notes"),
    /Unknown/,
  );
  assert.throws(
    () => validateResearchStore("edgar-fund-notes:VTI", "x".repeat(12001)),
    /12,000/,
  );
  const key = "edgar-fund-notes:SPY";
  const s = storage({ [key]: "Original" });
  const before = exportResearchBackup(s);
  const set = s.setItem.bind(s);
  s.setItem = (k, v) => {
    if (k === fundsKey) throw new Error("quota");
    set(k, v);
  };
  assert.throws(
    () =>
      restoreResearchVault(
        s,
        imported({ [key]: "Replacement", [fundsKey]: ["VTI"] }),
        [key, fundsKey],
        before,
      ),
    /Previous saved data/,
  );
  assert.equal(s.getItem(key), "Original");
});

test("real SEC point nullable metadata remains compatible with financial notebook backups", () => {
  const point = {
    value: 20.60198323408508,
    reason: null,
    note: null,
    classification: "calculated",
    period: {
      kind: "ytd",
      start: null,
      end: "2026-06-30",
      ttmStart: null,
      fy: 2026,
      fp: "Q2",
    },
    sources: [
      {
        label: "Stockholders equity",
        value: 356190000000,
        unit: "USD",
        start: null,
        end: "2026-06-30",
        filed: "2026-08-03",
        form: "10-Q",
        tag: "StockholdersEquity",
        accession,
        revisionNote: null,
        durationDays: null,
        documentUrl: url,
      },
    ],
    calculations: [
      {
        label: "Average equity",
        value: 350000000000,
        unit: "USD",
        start: null,
        end: "2026-06-30",
        formula: "(Opening + closing equity) / 2",
        note: null,
      },
    ],
  };
  const data = fixtures();
  data[workspaceKey].companies.JPM.evidence[0].point = point;
  data[workspaceKey].companies.JPM.analysisBaseline.metrics.roe = point;
  data[workspaceKey].companies.JPM.analysisBaseline.period = point.period;
  data[compareKey].pins[0].point = point;
  const vault = readResearchVault(storage(data));
  assert.equal(vault.issues.length, 0);
  assert.equal(imported(data).issues.length, 0);
});

test("rendered settings, source fields, baseline periods and timestamps reject nested objects", () => {
  const mutations = [
    (v) => {
      v[disclosuresKey].searches[0].settings.query = { bad: "object" };
    },
    (v) => {
      v[disclosuresKey].searches[0].settings.tickers = {};
    },
    (v) => {
      v[workspaceKey].companies.JPM.analysisBaseline.basis = {};
    },
    (v) => {
      v[workspaceKey].companies.JPM.analysisBaseline.asOf = {};
    },
    (v) => {
      v[workspaceKey].companies.JPM.analysisBaseline.period.end = {};
    },
    (v) => {
      v[workspaceKey].companies.JPM.evidence[0].point.sources[0].label = {};
    },
    (v) => {
      v[compareKey].pins[0].savedAt = {};
    },
    (v) => {
      v[disclosuresKey].searches[0].lastCoverage = [{ ticker: {} }];
    },
  ];
  for (const mutate of mutations) {
    const value = fixtures();
    mutate(value);
    assert.ok(imported(value).issues.length > 0);
  }
});

test("comparison evidence without a saved peer set opens its company's notebook and memo opens the global notebook", () => {
  const value = fixtures()[compareKey];
  value.searches = [];
  const vault = readResearchVault(storage({ [compareKey]: value }));
  assert.equal(vault.entries.find((e) => e.type === "evidence").href, "/compare/JPM?basis=annual&view=notebook");
  assert.equal(vault.entries.find((e) => e.type === "note").href, "/compare?view=notebook");
});
