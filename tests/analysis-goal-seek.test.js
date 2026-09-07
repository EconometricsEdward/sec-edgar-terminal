import test from "node:test";
import assert from "node:assert/strict";
import {
  goalSeekDefaults,
  goalSeekUnits,
  solveOperatingGoal,
  solveAssetLossGoal,
  GOAL_SEEK_DEFAULTS,
  normalizeGoalSeekSettings,
  goalSeekInput,
  goalSeekDraft,
  goalSeekDraftPatch,
  operatingGoalApplication,
  assetLossGoalApplication,
  buildScenarioHeadroom,
} from "../src/utils/analysisGoalSeek.js";
import { buildAnalysisScenario } from "../src/utils/analysisScenarios.js";

const period = {
  start: "2025-01-01",
  end: "2025-12-31",
  kind: "annual",
  label: "FY2025",
};
function company(lens = "corporate") {
  const values = {
    revenue: 1e9,
    operatingIncome: 1e8,
    totalAssets: 2e9,
    stockholdersEquity: 2e8,
  };
  return {
    ticker: "TEST",
    lens,
    periods: [period],
    definitions: Object.keys(values).map((key) => ({
      key,
      label: key,
      format: "currency",
    })),
    metrics: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        [
          {
            value,
            period,
            classification: "reported",
            sources: [
              {
                tag: key,
                taxonomy: "us-gaap",
                unit: "USD",
                value,
                start: ["revenue", "operatingIncome"].includes(key)
                  ? period.start
                  : null,
                end: period.end,
                filed: "2026-02-01",
                accession: "0000000001-26-000001",
              },
            ],
          },
        ],
      ]),
    ),
  };
}
const operating = { mode: "revenue", targetIncome: "120", assumedMargin: "15" };

test("Goal-seek denominates exact inputs explicitly including auto and preserves baseline defaults", () => {
  assert.deepEqual(goalSeekUnits("auto"), { divisor: 1, label: "USD" });
  assert.equal(goalSeekDefaults(company(), 0, "millions").targetIncome, "100");
  assert.equal(goalSeekDefaults(company(), 0, "billions").assumedRevenue, "1");
  assert.equal(goalSeekDefaults(company(), 0, "millions").assumedMargin, "10");
  assert.equal(
    goalSeekDefaults(company(), 0, "millions").targetEquityRatio,
    "10",
  );
});

test("Required revenue solves the target and retains baseline provenance plus exact assumptions", () => {
  const result = solveOperatingGoal(company(), operating, 0, "millions");
  assert.equal(result.reason, null);
  assert.equal(result.selection.point.value, 800e6);
  assert.equal(result.baseline, 1e9);
  assert.equal(result.selection.point.sources.length, 2);
  assert.equal(result.selection.definition.key, "goalSeek:revenue");
  assert.match(result.selection.point.formula, /120000000/);
  assert.match(result.selection.point.note, /15%/);
  assert.match(result.selection.point.note, /not a forecast/);
  assert.equal(result.selection.point.value * 0.15, result.target);
});

test("Required margin supports losses but rejects targets implying negative operating costs", () => {
  const loss = solveOperatingGoal(
    company(),
    { mode: "margin", targetIncome: "-50", assumedRevenue: "500" },
    0,
    "millions",
  );
  assert.equal(loss.selection.point.value, -10);
  assert.equal(loss.selection.definition.format, "percent");
  const high = solveOperatingGoal(
    company(),
    { mode: "margin", targetIncome: "200", assumedRevenue: "100" },
    0,
    "millions",
  );
  assert.equal(high.selection, null);
  assert.match(high.reason, /negative operating costs/);
});

test("Goal-seek preserves explicit zero but rejects blank, nonfinite and nonpositive denominators", () => {
  assert.equal(
    solveOperatingGoal(
      company(),
      { ...operating, targetIncome: "0" },
      0,
      "millions",
    ).selection.point.value,
    0,
  );
  for (const targetIncome of ["", " ", null, Infinity, "NaN"]) {
    assert.match(
      solveOperatingGoal(company(), { ...operating, targetIncome }, 0).reason,
      /finite target/,
    );
  }
  for (const assumedMargin of [0, -1]) {
    assert.match(
      solveOperatingGoal(company(), { ...operating, assumedMargin }, 0).reason,
      /strictly positive/,
    );
  }
  assert.match(
    solveOperatingGoal(
      company(),
      { mode: "margin", targetIncome: "1", assumedRevenue: "0" },
      0,
    ).reason,
    /strictly positive/,
  );
  assert.match(
    solveOperatingGoal(company(), { ...operating, targetIncome: "-1" }, 0)
      .reason,
    /negative revenue/,
  );
});

test("Goal-seek rejects overflow in both target and assumed revenue after unit conversion", () => {
  assert.match(
    solveOperatingGoal(
      company(),
      { ...operating, targetIncome: "1e308" },
      0,
      "billions",
    ).reason,
    /numerical range/,
  );
  assert.match(
    solveOperatingGoal(
      company(),
      { mode: "margin", targetIncome: "10", assumedRevenue: "1e308" },
      0,
      "billions",
    ).reason,
    /numerical range/,
  );
});

test("Operating goal rejects missing, wrong-currency, and incompatible source durations", () => {
  let data = company();
  data.metrics.operatingIncome[0].value = null;
  assert.match(solveOperatingGoal(data, operating, 0).reason, /unavailable/);
  data = company();
  data.metrics.operatingIncome[0].sources[0].unit = "EUR";
  assert.match(solveOperatingGoal(data, operating, 0).reason, /USD/);
  data = company();
  data.metrics.operatingIncome[0].sources[0].start = "2025-07-01";
  assert.match(solveOperatingGoal(data, operating, 0).reason, /duration/);
  assert.match(
    solveOperatingGoal(company("banking"), operating, 0).reason,
    /corporate lens/,
  );
});

test("Reverse asset loss exactly reconciles the chosen accounting ratio for every lens", () => {
  for (const lens of ["corporate", "banking", "insurance"]) {
    const result = solveAssetLossGoal(
      company(lens),
      { targetEquityRatio: "5" },
      0,
    );
    assert.equal(result.reason, null);
    assert.equal(result.status, "solved");
    assert.ok(Math.abs(result.loss - 100e6 / 0.95) < 1e-6);
    assert.ok(
      Math.abs(((2e8 - result.loss) / (2e9 - result.loss)) * 100 - 5) < 1e-10,
    );
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].point.sources.length, 2);
    assert.match(result.rows[0].point.note, /No deposit withdrawal/);
    assert.match(
      result.rows[0].point.note,
      /target shareholder equity \/ assets = 5%/,
    );
  }
});

test("Baseline at or below target never becomes negative loss capacity or claims the target is attained", () => {
  const at = solveAssetLossGoal(company(), { targetEquityRatio: "10" }, 0);
  assert.equal(at.status, "atTarget");
  assert.equal(at.loss, 0);
  const below = solveAssetLossGoal(company(), { targetEquityRatio: "12" }, 0);
  assert.equal(below.status, "alreadyBelow");
  assert.equal(below.loss, 0);
  assert.match(
    below.rows[0].point.note,
    /does not mean the target is attained/,
  );
  const negative = company();
  negative.metrics.stockholdersEquity[0].value = -100;
  assert.equal(
    solveAssetLossGoal(negative, { targetEquityRatio: "0" }, 0).status,
    "alreadyBelow",
  );
});

test("Zero equity-ratio target permits losses equal to equity and rejects invalid target bounds", () => {
  const result = solveAssetLossGoal(company(), { targetEquityRatio: "0" }, 0);
  assert.equal(result.loss, 2e8);
  assert.equal(result.rows[1].point.value, 10);
  for (const targetEquityRatio of ["", null, -1, 100, 101, Infinity])
    assert.match(
      solveAssetLossGoal(company(), { targetEquityRatio }, 0).reason,
      /0%.*100%/,
    );
});

test("Asset-loss target rejects invalid balance geometry and dates instead of producing a misleading boundary", () => {
  let data = company();
  data.metrics.stockholdersEquity[0].value = 2e9;
  assert.match(
    solveAssetLossGoal(data, { targetEquityRatio: 5 }, 0).reason,
    /equity below assets/,
  );
  data = company();
  data.metrics.totalAssets[0].value = 0;
  assert.match(
    solveAssetLossGoal(data, { targetEquityRatio: 5 }, 0).reason,
    /Positive/,
  );
  data = company();
  data.metrics.totalAssets[0].sources[0].end = "2024-12-31";
  assert.match(
    solveAssetLossGoal(data, { targetEquityRatio: 5 }, 0).reason,
    /ending balances/,
  );
  data = company();
  data.metrics.stockholdersEquity[0].sources = [];
  assert.match(
    solveAssetLossGoal(data, { targetEquityRatio: 5 }, 0).reason,
    /source evidence/,
  );
});

test("Solvers do not mutate reported data or submitted assumptions", () => {
  const data = company();
  const before = structuredClone(data);
  const input = Object.freeze({ ...operating });
  solveOperatingGoal(data, input, 0, "millions");
  solveAssetLossGoal(data, Object.freeze({ targetEquityRatio: "5" }), 0);
  assert.deepEqual(data, before);
});

test("Asset-loss solver withholds a nonfinite baseline ratio", () => {
  const data = company();
  data.metrics.totalAssets[0].value = Number.MIN_VALUE;
  data.metrics.stockholdersEquity[0].value = -1e308;
  const result = solveAssetLossGoal(data, { targetEquityRatio: "5" }, 0);
  assert.equal(result.status, "unavailable");
  assert.equal(result.loss, null);
  assert.match(result.reason, /numerical range/);
});

function bank() {
  const data = company("banking");
  for (const [key, value] of Object.entries({ cash: 1e8, deposits: 1e9 })) {
    data.definitions.push({ key, label: key, format: "currency" });
    data.metrics[key] = [
      {
        value,
        period,
        classification: "reported",
        sources: [
          {
            tag: key,
            taxonomy: "us-gaap",
            unit: "USD",
            value,
            end: period.end,
            filed: "2026-02-01",
            accession: "0000000001-26-000001",
          },
        ],
      },
    ];
  }
  return data;
}
const close = (a, b) =>
  assert.ok(
    Math.abs(a - b) <= Math.max(1, Math.abs(b)) * 1e-12,
    `${a} should equal ${b}`,
  );

test("Persisted target fields contain canonical USD and survive display unit changes and a fresh setup", () => {
  const data = company();
  const draft = {
    ...goalSeekDraft(data, 0, {}, "millions"),
    targetIncome: "120.5",
    assumedRevenue: "850.25",
    assumedMargin: "15",
  };
  const patch = goalSeekDraftPatch(draft, "millions");
  assert.equal(patch.goalTargetIncome, "120500000");
  assert.equal(patch.goalAssumedRevenue, "850250000");
  const saved = normalizeGoalSeekSettings(
    JSON.parse(
      JSON.stringify({
        ...patch,
        goalOperatingSolved: true,
        goalAssetSolved: true,
      }),
    ),
  );
  assert.equal(goalSeekDraft(data, 0, saved, "millions").targetIncome, "120.5");
  assert.equal(
    goalSeekDraft(data, 0, saved, "billions").targetIncome,
    "0.1205",
  );
  assert.equal(goalSeekDraft(data, 0, saved, "raw").targetIncome, "120500000");
  assert.equal(goalSeekDraft(data, 0, saved, "auto").targetIncome, "120500000");
  assert.equal(saved.goalOperatingSolved, true);
  assert.equal(saved.goalAssetSolved, true);
  close(
    solveOperatingGoal(data, goalSeekInput(data, 0, saved), 0).target,
    120.5e6,
  );
  // Changing denomination without editing does not rewrite canonical values.
  assert.deepEqual(
    goalSeekDraftPatch(
      goalSeekDraft(data, 0, saved, "billions"),
      "billions",
      [],
    ),
    { goalMode: "revenue" },
  );
});

test("Draft normalization preserves blanks, zero, negative and unfinished numbers without admitting user notes", () => {
  for (const raw of ["", "-", ".", "1e-", "-12.50", "0", "0.0"]) {
    const settings = normalizeGoalSeekSettings({ goalTargetIncome: raw });
    assert.equal(settings.goalTargetIncome, raw);
    assert.equal(goalSeekInput(company(), 0, settings).targetIncome, raw);
  }
  assert.equal(
    normalizeGoalSeekSettings({ goalTargetIncome: " " }).goalTargetIncome,
    "",
  );
  assert.equal(
    normalizeGoalSeekSettings({
      goalTargetIncome: "private investment notes",
      goalMode: "unknown",
      goalOperatingSolved: "false",
    }).goalTargetIncome,
    null,
  );
  assert.deepEqual(normalizeGoalSeekSettings(null), GOAL_SEEK_DEFAULTS);
  assert.equal(
    normalizeGoalSeekSettings({ goalOperatingSolved: "true" })
      .goalOperatingSolved,
    true,
  );
  const draft = {
    ...goalSeekDraft(company(), 0, {}, "millions"),
    targetIncome: "",
  };
  const restored = goalSeekInput(
    company(),
    0,
    goalSeekDraftPatch(draft, "millions"),
  );
  assert.equal(restored.targetIncome, "");
  assert.match(
    solveOperatingGoal(company(), restored, 0).reason,
    /finite target/,
  );
});

test("Overflowing denominated input remains invalid across commits and never resets to the baseline", () => {
  const data = company();
  const draft = {
    ...goalSeekDraft(data, 0, {}, "millions"),
    targetIncome: "1e308",
  };
  const settings = normalizeGoalSeekSettings(
    goalSeekDraftPatch(draft, "millions"),
  );
  assert.equal(settings.goalTargetIncome, "1e314");
  assert.match(
    solveOperatingGoal(data, goalSeekInput(data, 0, settings), 0).reason,
    /finite target/,
  );
  assert.equal(
    goalSeekDraft(data, 0, settings, "millions").targetIncome,
    "1e+308",
  );
});

test("Revenue and margin solutions apply explicit margin assumptions and reproduce the income target", () => {
  const data = company();
  for (const input of [
    { mode: "revenue", targetIncome: "120000000", assumedMargin: "15" },
    { mode: "margin", targetIncome: "120000000", assumedRevenue: "850000000" },
    { mode: "margin", targetIncome: "-50000000", assumedRevenue: "500000000" },
  ]) {
    const application = operatingGoalApplication(data, input, 0, {
      scenarioModel: "cost",
      scenarioLoss: 4,
    });
    assert.equal(application.reason, null);
    assert.equal(application.patch.scenarioModel, "margin");
    assert.equal(application.patch.scenarioLoss, undefined);
    const actual = application.preview.operating.rows.find(
      (row) => row.key === "OperatingIncome",
    ).selection.point.value;
    close(actual, Number(input.targetIncome));
    assert.equal(application.preview.settings.scenarioLoss, 4);
    const restored = buildAnalysisScenario(
      data,
      JSON.parse(JSON.stringify(application.patch)),
      0,
    );
    close(
      restored.operating.rows.find((row) => row.key === "OperatingIncome")
        .selection.point.value,
      Number(input.targetIncome),
    );
  }
});

test("Solved assumptions outside scenario limits and impossible costs cannot be silently applied", () => {
  const data = company();
  const tooLarge = operatingGoalApplication(
    data,
    { mode: "revenue", targetIncome: "1000000000", assumedMargin: "10" },
    0,
  );
  assert.match(tooLarge.reason, /outside the scenario range/);
  assert.equal(tooLarge.patch, null);
  const impossible = operatingGoalApplication(
    data,
    {
      mode: "margin",
      targetIncome: "2000000000",
      assumedRevenue: "1000000000",
    },
    0,
  );
  assert.match(impossible.reason, /negative operating costs/);
  assert.equal(impossible.patch, null);
  data.metrics.stockholdersEquity[0].value = 600e6;
  const loss = assetLossGoalApplication(data, { targetEquityRatio: "0" }, 0);
  assert.match(loss.reason, /outside the scenario range/);
  assert.equal(loss.patch, null);
});

test("Asset-loss application retains precise boundary and explicitly removes funding assumptions", () => {
  const data = bank();
  const applied = assetLossGoalApplication(
    data,
    { targetEquityRatio: "5" },
    0,
    {
      scenarioFunding: 5,
      scenarioReplacementFunding: 3,
      scenarioCashAvailable: 50,
    },
  );
  assert.equal(applied.reason, null);
  assert.equal(applied.patch.scenarioFunding, 0);
  assert.equal(applied.patch.scenarioReplacementFunding, 0);
  assert.equal(applied.preview.settings.scenarioCashAvailable, 50);
  close(applied.patch.scenarioLoss, 5.263157894736842);
  close(
    applied.preview.balance.rows.find((row) => row.key === "EquityAssets")
      .selection.point.value,
    5,
  );
  const below = assetLossGoalApplication(data, { targetEquityRatio: "12" }, 0);
  assert.equal(below.patch, null);
  assert.match(below.reason, /does not attain/);
});

test("Current-scenario floor check includes existing losses and explicit funding instead of resetting to baseline", () => {
  const data = bank();
  const settings = {
    goalEquityFloor: "5",
    scenarioLoss: 2,
    scenarioFunding: 5,
    scenarioCashAvailable: 50,
    scenarioReplacementFunding: 2,
  };
  const check = buildScenarioHeadroom(data, settings, 0);
  assert.equal(check.reason, null);
  assert.equal(check.status, "headroom");
  close(check.baselineRatio, 10);
  close(check.currentAssets, 1.93e9);
  close(check.currentEquity, 160e6);
  close(check.remainingLoss, (160e6 - 0.05 * 1.93e9) / 0.95);
  close(
    ((check.currentEquity - check.remainingLoss) /
      (check.currentAssets - check.remainingLoss)) *
      100,
    5,
  );
  assert.ok(
    check.remainingLoss <
      solveAssetLossGoal(data, { targetEquityRatio: "5" }, 0).loss,
  );
  assert.equal(check.rows[2].point.sources.length, 4);
  assert.ok(check.rows[2].point.calculations.length >= 2);
  assert.match(check.rows[2].point.note, /Replacement funding = 2%/);
  assert.equal(check.cash.reason, null);
  close(check.cash.remaining, 20e6);
  assert.deepEqual(
    check.cash.rows.map((row) => row.point.value),
    [50e6, 20e6, 50e6, 20e6],
  );
});

test("Floor headroom reports already-below and at-floor cases without negative capacity", () => {
  const data = company();
  const below = buildScenarioHeadroom(
    data,
    { goalEquityFloor: "5", scenarioLoss: 7 },
    0,
  );
  assert.equal(below.status, "alreadyBelow");
  assert.equal(below.remainingLoss, 0);
  assert.match(
    below.rows[2].point.note,
    /zero headroom does not mean the floor is attained/,
  );
  const applied = assetLossGoalApplication(data, { targetEquityRatio: "5" }, 0);
  const at = buildScenarioHeadroom(
    data,
    { ...applied.patch, goalEquityFloor: "5" },
    0,
  );
  assert.equal(at.status, "atTarget");
  assert.equal(at.remainingLoss, 0);
});

test("Funding gaps withhold balance headroom while displaying the explicit cash shortfall", () => {
  const check = buildScenarioHeadroom(
    bank(),
    {
      goalEquityFloor: "5",
      scenarioFunding: 20,
      scenarioCashAvailable: 50,
      scenarioReplacementFunding: 2,
    },
    0,
  );
  assert.equal(check.status, "unavailable");
  assert.equal(check.rows.length, 0);
  assert.match(check.reason, /exceeds usable/);
  assert.equal(check.cash.reason, null);
  assert.equal(check.cash.remaining, 0);
  close(check.cash.gap, 130e6);
});

test("Missing banking funding evidence permits an independent loss check but never invents cash capacity", () => {
  const check = buildScenarioHeadroom(
    company("banking"),
    { goalEquityFloor: "5" },
    0,
  );
  assert.equal(check.reason, null);
  assert.equal(check.status, "headroom");
  assert.equal(check.cash.remaining, null);
  assert.ok(check.cash.reason);
  assert.equal(check.rows[2].point.sources.length, 2);
});

test("Noncash-asset limits block an impossible applied boundary and qualify current floor arithmetic", () => {
  const data = bank();
  data.metrics.cash[0].value = 1.95e9;
  data.metrics.cash[0].sources[0].value = 1.95e9;
  const application = assetLossGoalApplication(
    data,
    { targetEquityRatio: "5" },
    0,
  );
  assert.equal(application.patch, null);
  assert.match(application.reason, /exceeds reported noncash assets/);
  const check = buildScenarioHeadroom(data, { goalEquityFloor: "5" }, 0);
  assert.equal(check.reason, null);
  assert.match(check.capacityNote, /exceeds the remaining noncash assets/);
  close(check.remainingNoncash, 50e6);
});
