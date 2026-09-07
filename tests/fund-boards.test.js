import test from "node:test";
import assert from "node:assert/strict";
import {
  FUND_BOARDS_KEY,
  captureFundBoard,
  createFundEvidence,
  fundEvidenceKey,
  readFundBoards,
  validateFundBoards,
  writeFundBoard,
} from "../src/utils/fundBoards.js";
import {
  buildFundBoardBrief,
  fundBoardBriefHtml,
  fundBoardBriefCsv,
} from "../src/utils/fundBoardBrief.js";
import {
  fundWorkspacePath,
  readFundWorkspaceSettings,
} from "../src/utils/fundWorkspaceSettings.js";
import {
  readResearchVault,
  validateResearchStore,
  exportResearchBackup,
  parseResearchBackup,
  restoreResearchVault,
} from "../src/utils/researchVault.js";

const now = "2026-09-07T13:00:00.000Z";
const accession = "0000036405-26-000101";
const older = "0000036405-26-000001";
function snapshot(ticker = "VTI", report = accession) {
  return {
    ticker,
    status: "ready",
    name: "Total Market",
    cik: "0000036405",
    seriesId: "S000002839",
    classId: "C000007775",
    asOf: "2026-06-30",
    filingDate: "2026-08-28",
    accession: report,
    sourceUrl: `https://www.sec.gov/Archives/edgar/data/36405/${report.replaceAll("-", "")}/primary_doc.xml`,
    fundInfo: {
      netAssets: 1000000000,
      totAssets: 1010000000,
      totLiabs: 10000000,
      cash: 0,
    },
    summary: {
      count: 800,
      valuedCount: 799,
      weightCount: 798,
      value: 970000000,
      weightTotal: 97,
      top10Weight: 38,
      derivativeCount: 1,
    },
    holdings: [{ id: 1, secretUnneeded: "Do not capture complete holdings" }],
  };
}
function pin(value = 7.123456789) {
  return createFundEvidence({
    kind: "security",
    title: "Company <A> concentration",
    summary:
      "2 of 3 funds successfully searched; VOO failed; zero matches is separate.",
    values: [
      { label: "Reported NAV weight", value, unit: "% NAV" },
      { label: "Failed fund exposure", value: null, unit: "% NAV" },
    ],
    sources: [snapshot()],
    methodology: "Stable identifiers only; no name-based matching.",
  });
}
function board(overrides = {}) {
  return captureFundBoard({
    id: "board-test",
    name: "Equity review",
    notes: "Private analyst notes",
    now,
    settings: {
      tickers: ["VTI", "VOO"],
      allocations: { VTI: "60", VOO: "40" },
      view: "allocation",
      securityQuery: "AAPL",
      comparisonScope: "shared",
      changeTicker: "VTI",
      changeBefore: older,
      changeAfter: accession,
      minAssets: "5",
    },
    snapshots: [snapshot()],
    evidence: [pin()],
    ...overrides,
  });
}
function storage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
  };
}

test("boards freeze latest matched reports, preserve full settings and distinguish missing snapshot coverage", () => {
  const captured = board();
  assert.equal(captured.settings.reportMap.VTI, accession);
  assert.deepEqual(captured.missingSnapshots, ["VOO"]);
  assert.equal(captured.snapshots[0].holdings, undefined);
  assert.equal(captured.settings.allocations.VOO, "40");
  assert.equal(captured.settings.changeBefore, older);
  assert.equal(captured.settings.minAssets, "5");
  assert.equal(captured.snapshots[0].fundInfo.cash, 0);
  const path = fundWorkspacePath({
    ...captured.settings,
    notes: captured.notes,
    board: captured.id,
  });
  assert.ok(!path.includes("Private") && !path.includes("notes"));
  assert.deepEqual(
    readFundWorkspaceSettings(path.split("?")[1]).reportMap,
    captured.settings.reportMap,
  );
});

test("stale loaded snapshots never replace explicitly requested reports", () => {
  const captured = board({
    settings: { tickers: ["VTI", "VOO"], reportMap: { VTI: older } },
    snapshots: [snapshot(), snapshot("QQQ")],
  });
  assert.equal(captured.settings.reportMap.VTI, older);
  assert.equal(captured.snapshots.length, 0);
  assert.deepEqual(captured.missingSnapshots, ["VTI", "VOO"]);
  assert.equal(
    board({
      snapshots: [{ ...snapshot(), sourceUrl: "https://example.com/fake" }],
    }).snapshots.length,
    0,
  );
});

test("evidence is immutable and identity changes with value, methodology or source report", () => {
  const evidence = pin(),
    source = snapshot();
  const captured = board({ evidence: [evidence], snapshots: [source] });
  evidence.values[0].value = 99;
  source.fundInfo.netAssets = 1;
  assert.equal(captured.evidence[0].values[0].value, 7.123456789);
  assert.equal(captured.snapshots[0].fundInfo.netAssets, 1000000000);
  assert.notEqual(fundEvidenceKey(pin(8)), fundEvidenceKey(pin(7)));
  const otherReport = createFundEvidence({
    ...pin(),
    sources: [snapshot("VTI", older)],
  });
  assert.notEqual(otherReport.id, pin().id);
  assert.throws(
    () => board({ evidence: [pin(), pin()] }),
    /duplicate evidence/,
  );
  assert.throws(
    () => createFundEvidence({ ...pin(), sources: [] }),
    /between one and eight/,
  );
  assert.throws(
    () =>
      createFundEvidence({
        ...pin(),
        sources: [{ ...snapshot(), sourceUrl: "javascript:alert(1)" }],
      }),
    /valid SEC source/,
  );
  assert.throws(
    () =>
      createFundEvidence({
        ...pin(),
        values: [{ label: "Bad", value: Infinity }],
      }),
    /invalid value/,
  );
});

test("board storage refreshes before writes and blocks stale revisions without losing saved changes", () => {
  const s = storage();
  const first = writeFundBoard(s, { mode: "create", board: board() });
  const a = first.boards[0],
    b = structuredClone(a);
  writeFundBoard(s, {
    mode: "update",
    board: { ...a, notes: "Tab A reviewed" },
    expectedRevision: 1,
    now,
  });
  assert.throws(
    () =>
      writeFundBoard(s, {
        mode: "update",
        board: { ...b, notes: "Stale tab B" },
        expectedRevision: 1,
      }),
    /changed in another tab/,
  );
  assert.throws(
    () => writeFundBoard(s, { mode: "delete", id: b.id, expectedRevision: 1 }),
    /changed in another tab/,
  );
  const saved = readFundBoards(s.getItem(FUND_BOARDS_KEY));
  assert.equal(saved.boards[0].notes, "Tab A reviewed");
  assert.equal(saved.boards[0].revision, 2);
  writeFundBoard(s, { mode: "create", board: board({ id: "board-second" }) });
  assert.equal(readFundBoards(s.getItem(FUND_BOARDS_KEY)).boards.length, 2);
});

test("capacity, malformed storage, invalid source dates and quota failures preserve existing research", () => {
  const s = storage();
  for (let i = 0; i < 12; i++)
    writeFundBoard(s, { mode: "create", board: board({ id: `board-${i}` }) });
  const before = s.getItem(FUND_BOARDS_KEY);
  assert.throws(
    () =>
      writeFundBoard(s, { mode: "create", board: board({ id: "board-13" }) }),
    /12 boards/,
  );
  assert.equal(s.getItem(FUND_BOARDS_KEY), before);
  const broken = storage({ [FUND_BOARDS_KEY]: "{broken" });
  assert.throws(
    () => writeFundBoard(broken, { mode: "create", board: board() }),
    /preserved/,
  );
  assert.equal(broken.getItem(FUND_BOARDS_KEY), "{broken");
  s.setItem = () => {
    throw new Error("Quota exceeded");
  };
  assert.throws(
    () =>
      writeFundBoard(s, { mode: "delete", id: "board-0", expectedRevision: 1 }),
    /Quota/,
  );
  assert.equal(s.getItem(FUND_BOARDS_KEY), before);
  assert.throws(() => board({ notes: "a".repeat(8001) }), /8,000/);
  assert.throws(
    () => board({ evidence: Array.from({ length: 41 }, (_, i) => pin(i)) }),
    /40 evidence/,
  );
  assert.throws(
    () =>
      createFundEvidence({
        ...pin(),
        sources: [{ ...snapshot(), asOf: "2026-02-31" }],
      }),
    /valid SEC source/,
  );
});

test("frozen HTML and CSV briefs preserve precision, unavailable values and escaped analyst text", () => {
  const captured = board({
    notes: '=HYPERLINK("https://example.com")\n<script>alert("bad")</script>',
    name: "<img src=x onerror=alert(1)>",
  });
  const brief = buildFundBoardBrief(captured, now);
  captured.notes = "Changed after preview";
  captured.evidence[0].values[0].value = 0;
  const html = fundBoardBriefHtml(brief),
    csv = fundBoardBriefCsv(brief);
  assert.ok(html.includes("7.123456789"));
  assert.ok(html.includes("Unavailable"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(
    !html.includes("<script>") && !html.includes("Changed after preview"),
  );
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('"unavailable"'));
  assert.ok(csv.includes(accession));
  assert.ok(csv.includes("USD billions"));
  assert.ok(html.includes("No matching snapshot captured: VOO"));
});

test("Research Hub indexes board evidence and backs up and restores the exact store", () => {
  const captured = board(),
    raw = JSON.stringify({ version: 1, boards: [captured] });
  const s = storage({ [FUND_BOARDS_KEY]: raw });
  assert.deepEqual(
    validateResearchStore(FUND_BOARDS_KEY, raw).boards[0],
    captured,
  );
  const vault = readResearchVault(s);
  assert.equal(vault.issues.length, 0);
  const entry = vault.entries.find((item) => item.type === "board");
  assert.equal(entry.title, captured.name);
  assert.ok(entry.text.includes("Private analyst notes"));
  assert.ok(
    entry.href.includes("board=board-test") && !entry.href.includes("Private"),
  );
  assert.equal(
    vault.entries.filter((item) => item.type === "evidence").length,
    1,
  );
  const backup = parseResearchBackup(exportResearchBackup(s));
  assert.equal(backup.stores[FUND_BOARDS_KEY], raw);
  const other = storage();
  restoreResearchVault(
    other,
    backup,
    [FUND_BOARDS_KEY],
    exportResearchBackup(other),
  );
  assert.equal(other.getItem(FUND_BOARDS_KEY), raw);
  const tampered = structuredClone(captured);
  tampered.evidence[0].sources[0].sourceUrl = "https://example.com/untrusted";
  assert.throws(
    () =>
      validateResearchStore(
        FUND_BOARDS_KEY,
        JSON.stringify({ version: 1, boards: [tampered] }),
      ),
    /SEC.gov/,
  );
  const inconsistent = structuredClone(captured);
  inconsistent.missingSnapshots = [];
  assert.throws(
    () => validateFundBoards({ version: 1, boards: [inconsistent] }),
    /coverage is inconsistent/,
  );
});
