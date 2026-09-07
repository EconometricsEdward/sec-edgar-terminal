import test from "node:test";
import assert from "node:assert/strict";
import {
  goalSeekDefaults,
  goalSeekUnits,
  solveOperatingGoal,
  solveAssetLossGoal,
} from "../src/utils/analysisGoalSeek.js";

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

test("Required margin supports losses and does not clamp mathematically large targets", () => {
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
  assert.equal(high.selection.point.value, 200);
  assert.match(
    high.selection.point.note,
    /does not .*establish business feasibility/,
  );
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
