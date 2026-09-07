import test from "node:test";
import assert from "node:assert/strict";
import { earningsChangeBridge } from "../src/utils/analysisEarningsBridge.js";

const period = (year) => ({
  fy: year,
  fp: "FY",
  kind: "annual",
  start: `${year}-01-01`,
  end: `${year}-12-31`,
});
const tags = {
  operatingIncome: "OperatingIncomeLoss",
  pretaxIncome:
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  incomeTax: "IncomeTaxExpenseBenefit",
  netIncome: "NetIncomeLoss",
};
function fixture(lens = "corporate", amounts = {}) {
  const periods = [period(2025), period(2024), period(2023)];
  const values = {
    operatingIncome: [130, 100, 90],
    pretaxIncome: [120, 105, 95],
    incomeTax: [20, 25, 20],
    netIncome: [98, 81, 74],
    ...amounts,
  };
  return {
    ticker: "TEST",
    lens,
    periods,
    definitions: Object.keys(tags).map((key) => ({
      key,
      label: key,
      format: "currency",
      category: "income",
    })),
    metrics: Object.fromEntries(
      Object.entries(values).map(([key, row]) => [
        key,
        periods.map((p, i) => ({
          value: row[i],
          period: p,
          classification: Number.isFinite(row[i]) ? "reported" : "unavailable",
          sources: Number.isFinite(row[i])
            ? [
                {
                  tag: tags[key],
                  taxonomy: "us-gaap",
                  unit: "USD",
                  value: row[i],
                  start: p.start,
                  end: p.end,
                  accession: `${p.fy}-test`,
                  filed: `${p.fy + 1}-02-01`,
                },
              ]
            : [],
        })),
      ]),
    ),
  };
}
const values = (bridge) =>
  bridge.components.map((component) => component.point.value);

test("corporate earnings bridge exactly reconciles operating, below-operating, tax and scope changes", () => {
  const bridge = earningsChangeBridge(fixture(), 0);
  assert.equal(bridge.reason, null);
  assert.deepEqual(values(bridge), [30, -15, 5, -3]);
  assert.equal(bridge.change.value, 17);
  assert.equal(bridge.roundingResidual, 0);
  assert.equal(
    bridge.rows.find((row) => row.key === "scopeResidual").current.value,
    -2,
  );
  assert.equal(
    bridge.rows.find((row) => row.key === "effectiveTaxRate").current.value,
    (20 / 120) * 100,
  );
});

test("banking and insurance use a pretax bridge without requiring operating income", () => {
  for (const lens of ["banking", "insurance"]) {
    const data = fixture(lens);
    delete data.metrics.operatingIncome;
    const bridge = earningsChangeBridge(data, 0);
    assert.equal(bridge.reason, null);
    assert.equal(bridge.useOperating, false);
    assert.deepEqual(values(bridge), [15, 5, -3]);
    assert.equal(bridge.roundingResidual, 0);
    assert.equal(
      bridge.rows.some((row) => row.key === "operatingIncome"),
      false,
    );
  }
});

test("tax benefits and explicit zero are retained; losses do not invalidate dollar reconciliation", () => {
  const bridge = earningsChangeBridge(
    fixture("corporate", {
      operatingIncome: [-2, 0, 0],
      pretaxIncome: [-5, 0, 0],
      incomeTax: [-1, 0, 0],
      netIncome: [-4, 0, 0],
    }),
    0,
  );
  assert.equal(bridge.reason, null);
  assert.deepEqual(values(bridge), [-2, -3, 1, 0]);
  assert.equal(bridge.change.value, -4);
  const tax = bridge.rows.find((row) => row.key === "effectiveTaxRate");
  assert.equal(tax.current.value, null);
  assert.equal(tax.previous.value, null);
  assert.match(tax.current.reason, /positive/);
});

test("a negative tax expense with positive pretax income yields a negative reported effective rate", () => {
  const bridge = earningsChangeBridge(
    fixture("banking", { incomeTax: [-12, 25, 20] }),
    0,
  );
  assert.equal(
    bridge.rows.find((row) => row.key === "effectiveTaxRate").current.value,
    -10,
  );
  assert.equal(bridge.roundingResidual, 0);
});

test("missing or nonfinite amounts never become zero and withhold the bridge", () => {
  for (const key of Object.keys(tags)) {
    for (const value of [null, undefined, NaN, Infinity]) {
      const data = fixture();
      data.metrics[key][0].value = value;
      const bridge = earningsChangeBridge(data, 0);
      assert.deepEqual(bridge.components, []);
      assert.match(bridge.reason, /unavailable.*never assumed to be zero/);
    }
  }
});

test("configured baseline is respected and a missing fiscal comparison is explicit", () => {
  const selected = earningsChangeBridge(fixture(), 0, "2023-12-31");
  assert.equal(selected.beforeIndex, 2);
  assert.equal(selected.change.value, 24);
  assert.equal(selected.roundingResidual, 0);
  assert.match(
    earningsChangeBridge(fixture(), 2).reason,
    /compatible comparison/,
  );
});

test("actual SEC flow durations override misleading inferred period dates", () => {
  const data = fixture();
  data.metrics.incomeTax[0].sources[0].start = "2025-04-01";
  const bridge = earningsChangeBridge(data, 0);
  assert.equal(bridge.components.length, 0);
  assert.match(bridge.reason, /reported source duration/);
});

test("equal-duration shifted reporting windows cannot be mixed within the reconciliation", () => {
  const data = fixture();
  for (const source of [
    data.metrics.incomeTax[0].sources[0],
    data.metrics.incomeTax[1].sources[0],
  ]) {
    source.start = `${Number(source.start.slice(0, 4)) - 1}-12-31`;
    source.end = source.end.slice(0, 4) + "-12-30";
  }
  const bridge = earningsChangeBridge(data, 0);
  assert.equal(bridge.components.length, 0);
  assert.match(bridge.reason, /same actual reporting dates/);
});

test("calculated quarters can retain cumulative inputs and reconcile against reported quarters", () => {
  const data = fixture();
  data.periods = data.periods.map((p) => ({
    ...p,
    fp: "Q2",
    kind: "quarter",
    start: `${p.fy}-04-01`,
    end: `${p.fy}-06-30`,
  }));
  for (const row of Object.values(data.metrics)) {
    row.forEach((point, i) => {
      point.period = data.periods[i];
      point.sources[0].start = `${point.period.fy}-01-01`;
      point.sources[0].end = point.period.end;
      point.sources.push({
        ...point.sources[0],
        value: 15,
        end: `${point.period.fy}-03-31`,
      });
      point.classification = "calculated";
      point.formula = "Current year-to-date − prior year-to-date";
    });
  }
  const bridge = earningsChangeBridge(data, 0);
  assert.equal(bridge.reason, null);
  assert.equal(bridge.roundingResidual, 0);
  assert.equal(bridge.components[1].point.sources.length, 8);
});

test("component evidence contains both periods and the complete calculation chain", () => {
  const bridge = earningsChangeBridge(fixture(), 0);
  const scope = bridge.components.at(-1).point;
  assert.equal(scope.sources.length, 6);
  assert.deepEqual(
    [...new Set(scope.sources.map((source) => source.end))],
    ["2025-12-31", "2024-12-31"],
  );
  assert.ok(
    scope.calculations.some(
      (calculation) =>
        calculation.formula ===
        "Net income − (pre-tax income − income tax expense)",
    ),
  );
  assert.ok(
    bridge.components.every((component) =>
      component.key.startsWith("earningsBridge:"),
    ),
  );
});

test("finite amounts without reviewable USD source evidence are withheld", () => {
  for (const index of [0, 1]) {
    const noSource = fixture();
    noSource.metrics.netIncome[index].sources = [];
    assert.match(
      earningsChangeBridge(noSource, 0).reason,
      /USD source evidence/,
    );
    const nonUsd = fixture();
    nonUsd.metrics.incomeTax[index].sources[0].unit = "EUR";
    assert.match(earningsChangeBridge(nonUsd, 0).reason, /USD source evidence/);
    const wrongFormat = fixture();
    wrongFormat.definitions.find(
      (definition) => definition.key === "incomeTax",
    ).format = "percent";
    assert.match(earningsChangeBridge(wrongFormat, 0).reason, /USD amount/);
  }
});

test("each earnings point must belong to the requested period and basis", () => {
  for (const index of [0, 1]) {
    const data = fixture();
    data.metrics.netIncome[index].period = period(2022);
    assert.match(
      earningsChangeBridge(data, 0).reason,
      /selected reporting period and basis/,
    );
  }
});

test("the bridge enforces the loaded or explicit filing cutoff for both periods", () => {
  const data = fixture();
  data.asOf = "2026-02-01";
  assert.equal(earningsChangeBridge(data, 0).reason, null);
  assert.match(
    earningsChangeBridge(data, 0, "year", "2025-12-31").reason,
    /cutoff.*match/,
  );
  delete data.asOf;
  assert.match(
    earningsChangeBridge(data, 0, "year", "2025-12-31").reason,
    /within the selected cutoff/,
  );
  for (const index of [0, 1]) {
    const future = fixture();
    future.asOf = "2026-02-01";
    future.metrics.incomeTax[index].sources[0].filed = "2026-02-02";
    assert.match(
      earningsChangeBridge(future, 0).reason,
      /within the selected cutoff/,
    );
  }
});

test("missing or inconsistent filing metadata and instant earnings sources are withheld", () => {
  for (const field of ["filed", "accession", "tag", "taxonomy", "start"]) {
    const data = fixture();
    delete data.metrics.pretaxIncome[0].sources[0][field];
    assert.ok(earningsChangeBridge(data, 0).reason, field);
  }
  const invalidDate = fixture();
  invalidDate.metrics.netIncome[0].sources[0].filed = "2026-02-30";
  assert.match(
    earningsChangeBridge(invalidDate, 0).reason,
    /complete SEC concept/,
  );
  const conflict = fixture();
  conflict.metrics.incomeTax[0].sources[0].filed = "2026-02-02";
  assert.match(
    earningsChangeBridge(conflict, 0).reason,
    /inconsistent filing dates/,
  );
});
