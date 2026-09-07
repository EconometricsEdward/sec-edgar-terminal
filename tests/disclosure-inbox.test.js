import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDisclosureInbox,
  filterDisclosureInbox,
  reviewDisclosureInbox,
  disclosureInboxCoverage,
} from "../src/utils/disclosureInbox.js";
import {
  filingEvidenceId,
  updateDisclosureMonitor,
} from "../src/utils/disclosureNotebook.js";

const settings = (query) => ({
  query,
  tickers: "JPM",
  mode: "companies",
  start: "2025-01-01",
  end: "2026-01-31",
  forms: "10-K",
  section: "risk",
  scope: "paragraph",
  depth: 8,
  amendments: false,
});
const filing = (accession = "0000019617-26-000001", extra = {}) => {
  const f = {
    ticker: "JPM",
    cik: "0000019617",
    companyName: "JPMorgan",
    accession,
    primaryDoc: "report.htm",
    documentUrl: "https://www.sec.gov/Archives/report.htm",
    filingDate: "2026-01-20",
    reportDate: "2025-12-31",
    form: "10-K",
    discoveredAt: "2026-02-01T12:00:00Z",
    reviewed: false,
    ...extra,
  };
  return { ...f, id: filingEvidenceId(f) };
};
const search = (id, query, inbox = [filing()]) => ({
  id,
  name: `${query} research`,
  settings: settings(query),
  inbox,
  seen: [],
  createdAt: "2026-01-01T12:00:00Z",
  lastChecked: "",
  autoCheck: false,
  followLatest: false,
});

test("Inbox groups the same filing but preserves exact query memberships and independent review states", () => {
  const queries = [
    search("a", "liquidity", [filing(undefined, { reviewed: true })]),
    search("b", "cybersecurity"),
  ];
  const rows = buildDisclosureInbox(queries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].memberships.length, 2);
  assert.deepEqual(
    rows[0].memberships.map((m) => [m.searchId, m.settings.query, m.reviewed]),
    [
      ["a", "liquidity", true],
      ["b", "cybersecurity", false],
    ],
  );
  const needingReview = filterDisclosureInbox(rows);
  assert.equal(needingReview.length, 1);
  assert.equal(needingReview[0].reviewState, "partial");
  assert.equal(filterDisclosureInbox(rows, { search: "a" }).length, 0);
  assert.equal(
    filterDisclosureInbox(rows, { search: "b" })[0].memberships.length,
    1,
  );
  assert.equal(
    filterDisclosureInbox(rows, { search: "a", status: "reviewed" }).length,
    1,
  );
});

test("Inbox avoids duplicate copies within a search but keeps distinct SEC documents separate", () => {
  const rows = buildDisclosureInbox([
    search("a", "liquidity", [
      filing(),
      filing(),
      filing(undefined, { primaryDoc: "exhibit.htm" }),
    ]),
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.memberships.length === 1));
});

test("Opening a monitored match uses its captured settings even when the saved search later changes", () => {
  const captured = settings("liquidity AND covenant");
  captured.end = "2026-02-02";
  const saved = search("a", "liquidity");
  saved.inbox = [];
  const next = updateDisclosureMonitor(
    saved,
    [
      {
        ticker: "JPM",
        filings: [{ ...filing(), status: "reviewed", matched: true }],
      },
    ],
    "2026-02-02T12:00:00Z",
    captured,
  );
  captured.query = "cybersecurity";
  next.settings.query = "litigation";
  next.followLatest = true;
  const membership = buildDisclosureInbox([next])[0].memberships[0];
  assert.equal(membership.settings.query, "liquidity AND covenant");
  assert.equal(membership.settings.end, "2026-02-02");
  assert.equal(membership.capturedSettings, true);
  membership.settings.end = "2099-01-01";
  assert.equal(next.inbox[0].searchSettings.end, "2026-02-02");
});

test("Legacy inbox matches disclose missing capture without inventing historical settings", () => {
  const saved = search("a", "liquidity");
  saved.followLatest = true;
  const membership = buildDisclosureInbox([saved])[0].memberships[0];
  assert.equal(membership.capturedSettings, false);
  assert.equal(membership.settings.end, saved.settings.end);
});

test("Filters combine company, form, text, selected query and query-specific status", () => {
  const rows = buildDisclosureInbox([
    search("a", "liquidity", [
      filing(),
      filing("different", { ticker: "BAC", form: "10-Q", reviewed: true }),
    ]),
    search("b", "cybersecurity"),
  ]);
  assert.equal(
    filterDisclosureInbox(rows, {
      company: "BAC",
      status: "all",
      form: "10-Q",
      text: "different",
    }).length,
    1,
  );
  assert.equal(
    filterDisclosureInbox(rows, { company: "BAC", status: "unreviewed" })
      .length,
    0,
  );
  assert.equal(
    filterDisclosureInbox(rows, { search: "a", text: "cybersecurity" }).length,
    0,
  );
  assert.equal(
    filterDisclosureInbox(rows, { text: "cybersecurity" }).length,
    1,
  );
});

test("Bulk review updates fresh storage without dropping concurrent inbox, search or collection edits", () => {
  const oldSearch = search("a", "liquidity");
  const selected = buildDisclosureInbox([oldSearch])[0].memberships;
  const additional = filing("arrived-during-render");
  const current = {
    version: 1,
    labels: { evidence: { label: "edited" } },
    collections: [{ id: "memo", items: [{ notes: "concurrent note" }] }],
    searches: [
      {
        ...oldSearch,
        inbox: [...oldSearch.inbox, additional],
        autoCheck: true,
      },
      search("b", "cybersecurity"),
    ],
  };
  const next = reviewDisclosureInbox(current, selected, true);
  assert.equal(next.searches[0].inbox.length, 2);
  assert.equal(next.searches[0].inbox[0].reviewed, true);
  assert.equal(next.searches[0].inbox[1].reviewed, false);
  assert.equal(next.searches[0].autoCheck, true);
  assert.equal(next.searches[1].inbox[0].reviewed, false);
  assert.equal(next.collections, current.collections);
  assert.equal(next.labels, current.labels);
  assert.equal(current.searches[0].inbox[0].reviewed, false);
});

test("Bulk review is scoped to explicit memberships across searches and supports undoing review", () => {
  const current = {
    searches: [
      search("a", "liquidity"),
      search("b", "cybersecurity"),
      search("c", "litigation", [filing("different")]),
    ],
  };
  const targets = buildDisclosureInbox(current.searches).find(
    (r) => r.filing.accession === filing().accession,
  ).memberships;
  const next = reviewDisclosureInbox(current, targets, true);
  assert.equal(next.searches[0].inbox[0].reviewed, true);
  assert.equal(next.searches[1].inbox[0].reviewed, true);
  assert.equal(next.searches[2].inbox[0].reviewed, false);
  const undone = reviewDisclosureInbox(next, [targets[0]], false);
  assert.equal(undone.searches[0].inbox[0].reviewed, false);
  assert.equal(undone.searches[1].inbox[0].reviewed, true);
});

test("Latest coverage distinguishes successful searches, failed fetches and no usable documents", () => {
  const coverage = disclosureInboxCoverage([
    {
      ...search("a", "liquidity"),
      lastChecked: "2026-02-02",
      lastCoverage: [
        {
          ticker: "JPM",
          reviewed: 2,
          failed: 1,
          sectionUnavailable: 1,
          limited: true,
        },
        { ticker: "BAC", error: "Unavailable" },
      ],
    },
    search("b", "cybersecurity"),
  ]);
  assert.deepEqual(coverage[0], {
    searchId: "a",
    hasCheck: true,
    companies: 2,
    reviewed: 2,
    failed: 1,
    unavailable: 1,
    companyErrors: 1,
    limited: true,
  });
  assert.equal(coverage[1].hasCheck, false);
  assert.equal(coverage[1].reviewed, 0);
});
