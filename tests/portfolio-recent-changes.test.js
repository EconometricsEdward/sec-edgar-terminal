import test from "node:test";
import assert from "node:assert/strict";
import { buildPortfolioRecentSecEvents, isPortfolioRecentDate } from "../src/utils/portfolioRecentChanges.js";
import { createPortfolioBaseline, comparePortfolioResearch } from "../src/utils/portfolioChanges.js";

const now = "2026-09-14T12:00:00.000Z";
const cik = "0000320193";
const documentUrl = "https://www.sec.gov/Archives/edgar/data/320193/000032019326000080/aapl-update.htm";
const rows = [{ id: "apple", resolution: { cik, ticker: "AAPL", name: "Apple Inc." } }];
const filing = (overrides = {}) => {
  const accession = overrides.accession || "0000320193-26-000080";
  return {
    accession, form: "8-K", filingDate: "2026-09-10", reportDate: "2026-09-09",
    documentUrl: `https://www.sec.gov/Archives/edgar/data/320193/${accession.replaceAll("-", "")}/aapl-update.htm`,
    ...overrides,
  };
};
function snapshot(overrides = {}, issuerOverrides = {}) {
  const period = { kind: "annual", start: "2024-09-29", end: "2025-09-27" };
  return {
    generated_at: "2026-09-14T10:00:00.000Z", basis: "annual",
    companies: [{
      cik, ticker: "AAPL", name: "Apple Inc.", status: "ready", refreshStatus: "checked",
      cache: { status: "fresh" }, period,
      metrics: { revenue: {
        value: 100, label: "Revenue", unit: "USD", classification: "reported", period,
        sources: [{ documentUrl, taxonomy: "us-gaap", tag: "Revenue" }],
      } }, filings: [filing()], ...issuerOverrides,
    }], ...overrides,
  };
}
const feed = (input, options = {}) => buildPortfolioRecentSecEvents({ snapshot: input, rows, now, ...options });

test("first and unchanged captures show recent SEC filings without manufacturing financial changes", () => {
  const current = snapshot();
  for (const baseline of [null, createPortfolioBaseline(current)]) {
    const comparison = comparePortfolioResearch(baseline, current, rows);
    const result = feed(current, { comparison });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].kind, "filing");
    assert.equal(result.events[0].dateBasis, "filed");
    assert.equal(result.events[0].eventDate, "2026-09-10");
    assert.deepEqual(result.events[0].afterSources, [documentUrl]);
    assert.equal(result.checkedIssuers, 1);
    assert.equal(result.coverageEvents.length, 0);
  }
});

test("recent windows use current UTC calendar dates and reject old snapshots masquerading as current", () => {
  const old = snapshot({ generated_at: "2026-01-14T10:00:00.000Z" }, {
    filings: [filing({ filingDate: "2026-01-10" })],
  });
  const result = feed(old);
  assert.equal(result.events.length, 0);
  assert.equal(result.currentDate, "2026-09-14");
  assert.equal(result.cutoffDate, "2026-08-16");
  assert.ok(result.snapshotAgeDays > 30);
  assert.match(result.warnings.join(" "), /More recent filings may be missing/);
  assert.equal(isPortfolioRecentDate("2026-09-08", 7, now), true);
  assert.equal(isPortfolioRecentDate("2026-09-07", 7, now), false);
  assert.equal(isPortfolioRecentDate("2026-09-14", 7, now), true);
  assert.equal(isPortfolioRecentDate("2026-09-15", 7, now), false);
});

test("undated, impossible and future-dated filings cannot acquire the capture's recent date", () => {
  const filings = [undefined, "", "2026-02-30", "2026-09-15", "2026-09-14T00:00:00.000Z"].map((date, i) =>
    filing({ accession: `${cik}-26-${String(i + 1).padStart(6, "0")}`, filingDate: date }));
  const result = feed(snapshot({}, { filings }));
  assert.equal(result.events.length, 0);
  assert.equal(result.excludedUndatedFilings, 4);
  assert.equal(result.excludedFutureFilings, 1);
  assert.match(result.warnings.join(" "), /future submission date/);
});

test("source provenance, inclusion choices and issuer/accession identity bound the feed", () => {
  const current = snapshot({}, {
    filings: [filing(), filing(), filing({ accession: "bad" }),
      filing({ accession: `${cik}-26-000081`, documentUrl: "https://sec.gov.evil.test/file" }),
      filing({ accession: `${cik}-26-000082`, documentUrl: "javascript:alert(1)" }),
      filing({ accession: `${cik}-26-000083`, documentUrl: "https://user@www.sec.gov/Archives/edgar/data/1/a.htm" })],
    latestAnnualFiling: filing(),
  });
  const result = feed(current, { rows: [...rows, { ...rows[0], id: "duplicate-share-class" }], weights: { [cik]: 5 } });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].knownWeightPct, 5);
  for (const overrides of [{ excluded: true }, { mergedInto: "other" }, { duplicateChoice: "remove" }])
    assert.equal(feed(current, { rows: [{ ...rows[0], ...overrides }] }).events.length, 0);
});

test("a source-dated duplicate is preferred to an incomplete saved filing", () => {
  const result = feed(snapshot({}, { filings: [filing({ filingDate: undefined })], latestInterimFiling: filing() }));
  assert.equal(result.events.length, 1);
  assert.equal(result.excludedUndatedFilings, 0);
});

test("baseline filing observations are replaced by a single source-dated filing event", () => {
  const before = snapshot({ generated_at: "2026-09-01T10:00:00.000Z" }, { filings: [] });
  const current = snapshot();
  const comparison = comparePortfolioResearch(createPortfolioBaseline(before), current, rows);
  assert.equal(comparison.counts.filing, 1);
  const result = feed(current, { comparison });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].eventDate, "2026-09-10");
  assert.doesNotMatch(result.events[0].title, /newly observed/);
});

test("same-period value changes retain their observation date and disclaim issuer restatements", () => {
  const before = snapshot({ generated_at: "2026-09-01T10:00:00.000Z" });
  const current = snapshot();
  current.companies[0].metrics.revenue.value = 200;
  const comparison = comparePortfolioResearch(createPortfolioBaseline(before), current, rows);
  const result = feed(current, { comparison });
  const change = result.events.find((event) => event.kind === "revision");
  assert.equal(change.eventDate, "2026-09-14");
  assert.equal(change.dateBasis, "observed");
  assert.equal(change.observedAt, current.generated_at);
  assert.equal(change.beforeValue, 100);
  assert.equal(change.afterValue, 200);
  assert.match(change.title, /captured same-period value/);
  assert.match(change.description, /does not establish an issuer restatement/);
  assert.deepEqual(change.beforeSources, [documentUrl]);
});

test("stale baseline differences, missing capture times and future checkpoints cannot be recent financial events", () => {
  const before = snapshot({ generated_at: "2026-01-01T10:00:00.000Z" });
  for (const capture of ["2026-01-14T10:00:00.000Z", null, "2026-09-14T13:00:00.000Z"]) {
    const current = snapshot({ generated_at: capture });
    current.companies[0].metrics.revenue.value = 200;
    const comparison = comparePortfolioResearch(createPortfolioBaseline(before), current, rows);
    assert.equal(feed(current, { comparison }).events.filter((event) => event.kind !== "filing").length, 0);
  }
  const current = snapshot();
  current.companies[0].metrics.revenue.value = 200;
  const comparison = comparePortfolioResearch(createPortfolioBaseline(snapshot({ generated_at: "2026-09-15T10:00:00.000Z" })), current, rows);
  const result = feed(current, { comparison });
  assert.equal(result.events.filter((event) => event.kind !== "filing").length, 0);
  assert.match(result.warnings.join(" "), /checkpoint is later/);
});

test("coverage health is separated from issuer activity and stale retained filings are identified", () => {
  const before = snapshot({ generated_at: "2026-09-01T10:00:00.000Z" });
  const current = snapshot({}, { cache: { status: "stale" }, refreshStatus: "failed", filingCoverage: { truncated: true } });
  const comparison = comparePortfolioResearch(createPortfolioBaseline(before), current, rows);
  const result = feed(current, { comparison });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].kind, "filing");
  assert.equal(result.events[0].fresh, false);
  assert.equal(result.coverageEvents.length, 1);
  assert.equal(result.uncheckedIssuers, 1);
  assert.equal(result.checkedIssuers, 0);
  assert.equal(result.truncatedIssuers, 1);
  assert.match(result.warnings.join(" "), /filing coverage may be incomplete/);
});

test("amendments and current reports do not imply financial impact from form type alone", () => {
  const amended = feed(snapshot({}, { filings: [filing({ form: "10-K/A" })] })).events[0];
  assert.match(amended.title, /10-K\/A amendment/);
  assert.match(amended.description, /does not by itself establish a financial restatement/);
  const currentReport = feed(snapshot()).events[0];
  assert.match(currentReport.description, /financial impact is not inferred/);
});

test("different reporting bases still permit source-dated filings", () => {
  const current = snapshot({ basis: "ttm" });
  const comparison = comparePortfolioResearch(createPortfolioBaseline(snapshot()), current, rows);
  assert.equal(comparison.state, "incompatible");
  assert.equal(feed(current, { comparison }).events.length, 1);
});

test("SEC source paths must match the company and accession without conflating filing-agent identity", () => {
  for (const wrongUrl of [
    documentUrl.replace("data/320193/", "data/789019/"),
    documentUrl.replace("000032019326000080", "000032019326000081"),
  ]) {
    const result = feed(snapshot({}, { filings: [filing({ documentUrl: wrongUrl })] }));
    assert.equal(result.events.length, 0);
    assert.equal(result.excludedUnverifiedFilings, 1);
    assert.match(result.warnings.join(" "), /could not be matched/);
  }
  const filingAgentAccession = "0001193125-26-373026";
  assert.equal(feed(snapshot({}, { filings: [filing({ accession: filingAgentAccession })] })).events.length, 1);
});

test("verified predecessor filings retain correct source-registrant provenance", () => {
  const currentCik = "0002115436", predecessorCik = "0000034088";
  const predecessorFiling = filing({
    accession: "0000034088-26-000093", sourceCik: predecessorCik,
    documentUrl: "https://www.sec.gov/Archives/edgar/data/34088/000003408826000093/xom-20260630.htm",
  });
  const options = { rows: [{ id: "exxon", resolution: { cik: currentCik, ticker: "XOM" } }] };
  const current = snapshot({}, {
    cik: currentCik, ticker: "XOM", filings: [predecessorFiling],
    evidenceContinuity: { currentCik, predecessorCiks: [predecessorCik], filingSourceCiks: [currentCik, predecessorCik] },
  });
  assert.equal(feed(current, options).events.length, 1);
  delete current.companies[0].evidenceContinuity;
  assert.equal(feed(current, options).events.length, 0);
});

test("bounded older filing history does not falsely imply omissions inside the selected recent window", () => {
  const current = snapshot({}, {
    filingCoverage: { truncated: true },
    filings: [filing(), filing({ accession: `${cik}-26-000070`, filingDate: "2026-05-01" })],
  });
  const result = feed(current, { windowDays: 60 });
  assert.equal(result.truncatedIssuers, 1);
  assert.equal(result.windowLimitedIssuers, 0);
  assert.doesNotMatch(result.warnings.join(" "), /omit filings inside/);
  current.companies[0].latestAnnualFiling = current.companies[0].filings.pop();
  const limited = feed(current, { windowDays: 60 });
  assert.equal(limited.windowLimitedIssuers, 1);
  assert.match(limited.warnings.join(" "), /omit filings inside/);
});
