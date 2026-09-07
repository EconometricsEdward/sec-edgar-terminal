import {
  buildAnalysisScenario,
  SCENARIO_DEFAULTS,
} from "./analysisScenarios.js";
import { labCalculatedPoint, labInput } from "./analysisFormula.js";
import { analysisChange } from "./analysisResearch.js";
import { evidenceSources } from "./researchEvidence.js";

const DAY = 86400000;
const validDate = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const concepts = (point) =>
  [
    ...new Set(
      evidenceSources(point).map((source) =>
        [source.taxonomy || "", source.tag || "", source.unit || ""].join(":"),
      ),
    ),
  ]
    .sort()
    .join("|");
const selection = (input, period) => ({
  definition: input.definition || {
    key: input.key,
    label: input.key,
    format: "currency",
  },
  point: input.point || {
    value: null,
    period,
    classification: "unavailable",
    sources: [],
    reason: input.reason,
  },
});
const cutoffFor = (data, settings) =>
  typeof data.asOf === "string" ? data.asOf : settings.asOf || "";

function inputReadiness(input, period, cutoff) {
  if (input.reason) return input.reason;
  if (!validDate(period?.end))
    return "The selected reporting endpoint is invalid or unavailable.";
  const sources = evidenceSources(input.point);
  if (!sources.length) return "No reported source evidence is available.";
  if (
    sources.some(
      (source) =>
        !validDate(source.end) ||
        source.end > period.end ||
        (source.start != null &&
          (!validDate(source.start) || source.start > source.end)),
    )
  )
    return "A reported input has an invalid date or extends beyond its reporting endpoint.";
  const flows = sources.filter((source) => source.start != null);
  if (
    flows.length &&
    flows.every(
      (source) =>
        source.start === flows[0].start && source.end === flows[0].end,
    ) &&
    (!validDate(period.start) ||
      Math.abs(Date.parse(flows[0].start) - Date.parse(period.start)) >
        14 * DAY ||
      flows[0].end !== period.end)
  )
    return "The actual reported flow window does not match the selected reporting duration within 14 days.";
  if (!sources.some((source) => source.end === period.end))
    return "The retained sources do not reach this reporting endpoint.";
  if (sources.some((source) => !source.tag || !source.taxonomy || !source.unit))
    return "The source concept, taxonomy, or unit is missing; comparability cannot be verified.";
  if (
    cutoff &&
    (!validDate(cutoff) ||
      sources.some(
        (source) => !validDate(source.filed) || source.filed > cutoff,
      ))
  )
    return "Every reported input needs a valid filing date on or before the selected filing cutoff.";
  return null;
}

/** Identity and readiness refer to the actual selected data and exact model inputs. */
export function scenarioBaselineContext(
  data,
  settings = {},
  index = 0,
  suppliedScenario,
) {
  const scenario =
    suppliedScenario || buildAnalysisScenario(data, settings, index);
  const period = data.periods?.[index];
  const cutoff = cutoffFor(data, settings);
  const groups = [
    ...(scenario.operating
      ? [
          {
            key: "operating",
            label: "Operating model",
            model: scenario.operating,
          },
        ]
      : []),
    { key: "balance", label: "Balance model", model: scenario.balance },
  ];
  const cards = new Map();
  for (const group of groups) {
    for (const input of group.model?.inputs || []) {
      if (!cards.has(input.key)) {
        const reason = inputReadiness(input, period, cutoff);
        const sources = evidenceSources(input.point);
        cards.set(input.key, {
          ...input,
          reason,
          ready: !reason,
          selection: selection(input, period),
          sources,
          windows: [
            ...new Set(
              sources.map((source) =>
                source.start
                  ? `${source.start} → ${source.end}`
                  : `As of ${source.end}`,
              ),
            ),
          ],
          groups: [],
        });
      }
      cards.get(input.key).groups.push(group.label);
    }
  }
  const inputs = [...cards.values()];
  return {
    ticker: data.ticker || "Unknown ticker",
    period,
    cutoff,
    observedAt: data.observedAt || null,
    inputs,
    ready: inputs.filter((input) => input.ready).length,
    total: inputs.length,
    groups: groups.map((group) => ({
      key: group.key,
      label: group.label,
      reason: group.model?.reason || null,
      inputCount: group.model?.inputs?.length || 0,
    })),
  };
}

function priorAnchor(data, anchorIndex, selectedEnd) {
  const anchor = data.periods?.[anchorIndex];
  if (!validDate(anchor?.end)) return -1;
  const matches = (data.periods || [])
    .map((period, index) => ({ period, index }))
    .filter(({ period }) => {
      const distance = (Date.parse(anchor.end) - Date.parse(period.end)) / DAY;
      return (
        validDate(period.end) &&
        period.end < anchor.end &&
        period.end < selectedEnd &&
        period.kind === anchor.kind &&
        (anchor.kind === "annual" || (period.fp && period.fp === anchor.fp)) &&
        distance >= 350 &&
        distance <= 380 &&
        (!Number.isFinite(Number(anchor.fy)) ||
          !Number.isFinite(Number(period.fy)) ||
          Number(period.fy) === Number(anchor.fy) - 1)
      );
    });
  // Ambiguous duplicate fiscal anchors need a human source review.
  return matches.length === 1 ? matches[0].index : -1;
}

function compatibleInput(
  data,
  settings,
  key,
  currentIndex,
  beforeIndex,
  basis,
) {
  const current = labInput(data, key, currentIndex);
  const before = labInput(data, key, beforeIndex);
  const cutoff = cutoffFor(data, settings);
  for (const [input, index] of [
    [current, currentIndex],
    [before, beforeIndex],
  ]) {
    const reason = inputReadiness(input, data.periods?.[index], cutoff);
    if (reason) return reason;
    if (input.basis !== basis)
      return `The ${input.definition?.label || key} input requires ${basis} evidence.`;
  }
  const check = analysisChange(current.point, before.point, "currency");
  if (check.delta == null) return check.reason;
  if (concepts(current.point) !== concepts(before.point))
    return `Reported ${current.definition?.label || key} concepts differ from the selected comparison; inspect the SEC tags before treating them as comparable.`;
  const currentPeriod = data.periods[currentIndex];
  const beforePeriod = data.periods[beforeIndex];
  if (
    currentPeriod.kind === "ttm" &&
    (!validDate(currentPeriod.start) || beforePeriod.end >= currentPeriod.start)
  )
    return "These trailing-year observations overlap and cannot be used as independent annual anchors.";
  return null;
}

const derived = (
  period,
  key,
  label,
  format,
  inputs,
  value,
  formula,
  reason = null,
) => ({
  definition: { key, label, format },
  point: {
    ...labCalculatedPoint(
      period,
      inputs,
      reason ? null : value,
      formula,
      "Descriptive reported history. These observations do not assign probabilities or forecast future results.",
    ),
    reason,
  },
});

/** Reapply exactly the current assumptions to prior same-season observations.
 * Filing cutoffs are retained, but this is retrospective sensitivity, not a
 * claim that revised figures were available at each historic reporting date. */
export function scenarioHistoricalCalibration(
  data,
  settings = {},
  index = 0,
  options = {},
) {
  const limit = Math.max(
    1,
    Math.min(5, Math.floor(Number(options.limit) || 5)),
  );
  const period = data.periods?.[index];
  const rows = [];
  const corporate = data.lens === "corporate";
  const balanceKeys =
    data.lens === "banking"
      ? ["totalAssets", "stockholdersEquity", "cash", "deposits"]
      : ["totalAssets", "stockholdersEquity"];
  let anchor = index;
  let boundaryReason = null;
  if (!period || !validDate(period.end))
    boundaryReason =
      "Select a valid reporting period to compare prior observations.";
  else
    for (let offset = 0; offset < limit; offset += 1) {
      const previousIndex = priorAnchor(data, anchor, period.end);
      if (previousIndex < 0) {
        boundaryReason = `No unique, compatible prior-year ${period.kind === "annual" ? "annual" : period.fp || "same-season"} anchor before ${data.periods[anchor].end}. Missing years, fiscal-season changes, and duplicate anchors are not skipped.`;
        break;
      }
      const previousPeriod = data.periods[previousIndex];
      const previous = buildAnalysisScenario(data, settings, previousIndex);
      const get = (key) => labInput(data, key, previousIndex);
      const revenueReason = corporate
        ? compatibleInput(
            data,
            settings,
            "revenue",
            index,
            previousIndex,
            "period flow",
          ) ||
          (!(get("revenue").point?.value > 0) ||
          !(data.metrics?.revenue?.[index]?.value > 0)
            ? "A positive reported revenue denominator is required in both observations."
            : null)
        : null;
      const operatingReason = corporate
        ? revenueReason ||
          compatibleInput(
            data,
            settings,
            "operatingIncome",
            index,
            previousIndex,
            "period flow",
          )
        : null;
      const balanceReason =
        balanceKeys
          .map((key) =>
            compatibleInput(
              data,
              settings,
              key,
              index,
              previousIndex,
              "ending balance",
            ),
          )
          .find(Boolean) ||
        (!(get("totalAssets").point?.value > 0)
          ? "A positive reported total-assets denominator is required."
          : null);
      const revenue = get("revenue");
      const income = get("operatingIncome");
      const assets = get("totalAssets");
      const equity = get("stockholdersEquity");
      const denominatorIndex = priorAnchor(data, previousIndex, period.end);
      const priorRevenue =
        denominatorIndex >= 0
          ? labInput(data, "revenue", denominatorIndex)
          : null;
      const growthReason = corporate
        ? revenueReason ||
          (denominatorIndex < 0
            ? "The immediately preceding same-season revenue denominator is missing or ambiguous."
            : compatibleInput(
                data,
                settings,
                "revenue",
                previousIndex,
                denominatorIndex,
                "period flow",
              )) ||
          (!(priorRevenue?.point?.value > 0)
            ? "Revenue growth requires a strictly positive prior-year revenue denominator."
            : null)
        : null;
      const operatingResult = !operatingReason
        ? previous.operating?.rows.find((row) => row.key === "OperatingIncome")
            ?.selection
        : null;
      const balanceResult = !balanceReason
        ? previous.balance?.rows.find((row) => row.key === "EquityAssets")
            ?.selection
        : null;
      rows.push({
        index: previousIndex,
        period: previousPeriod,
        operatingReason,
        balanceReason,
        operatingResultReason:
          operatingReason || previous.operating?.reason || null,
        balanceResultReason: balanceReason || previous.balance?.reason || null,
        revenue: corporate ? selection(revenue, previousPeriod) : null,
        operatingIncome: corporate ? selection(income, previousPeriod) : null,
        assets: selection(assets, previousPeriod),
        operatingMargin: corporate
          ? derived(
              previousPeriod,
              "scenarioHistoryMargin",
              "Reported operating income / revenue",
              "percent",
              [income, revenue],
              (income.point?.value / revenue.point?.value) * 100,
              "Reported operating income / reported revenue × 100",
              operatingReason,
            )
          : null,
        revenueGrowth: corporate
          ? derived(
              previousPeriod,
              "scenarioHistoryRevenueGrowth",
              "Same-season reported revenue growth",
              "percent",
              [revenue, ...(priorRevenue ? [priorRevenue] : [])],
              (revenue.point?.value / priorRevenue?.point?.value - 1) * 100,
              "(Reported revenue / immediately preceding same-season reported revenue − 1) × 100",
              growthReason,
            )
          : null,
        growthDenominator: priorRevenue
          ? selection(priorRevenue, data.periods[denominatorIndex])
          : null,
        equityRatio: derived(
          previousPeriod,
          "scenarioHistoryEquityAssets",
          "Reported shareholder equity / assets",
          "percent",
          [equity, assets],
          (equity.point?.value / assets.point?.value) * 100,
          "Reported shareholder equity / reported total assets × 100",
          balanceReason,
        ),
        operatingResult,
        balanceResult,
        inputs: [
          ...(previous.operating?.inputs || []),
          ...(previous.balance?.inputs || []),
        ].map((input) => selection(input, previousPeriod)),
      });
      anchor = previousIndex;
    }
  return {
    rows,
    period,
    limit,
    checked: rows.length,
    operatingCount: rows.filter((row) => !row.operatingReason && corporate)
      .length,
    balanceCount: rows.filter((row) => !row.balanceReason).length,
    growthCount: rows.filter((row) =>
      Number.isFinite(row.revenueGrowth?.point.value),
    ).length,
    boundaryReason,
    note: "Each row applies the same current assumptions to an earlier reported baseline. Observations stop before the selected endpoint; filing evidence follows the selected cutoff and may include later restatements. This is a retrospective sensitivity comparison, not a backtest, probability sample, or suggested target.",
  };
}

/** Every case is an illustrative user-editable assumption set, never an estimate. */
export function scenarioStarterCases(data, settings = {}) {
  const costModel = settings.scenarioModel === "cost";
  const model = costModel ? "cost" : "margin";
  const cases = [
    {
      id: "baseline",
      label: "Baseline",
      overrides: { scenarioModel: model },
      assumptions:
        "Revenue 0% · margin 0 pp · cost change 0% · asset loss 0% · withdrawals 0%",
      explanation:
        "Reproduce the reported baseline. Reset variable costs to 60% of baseline operating costs, available cash to 100%, and replacement funding to 0%.",
    },
  ];
  if (data.lens === "corporate") {
    cases.push({
      id: "demand-pressure",
      label: "Demand pressure",
      overrides: { scenarioModel: model, scenarioRevenue: -10 },
      assumptions: `Revenue −10% · ${costModel ? "variable-cost share 60% · cost change 0%" : "margin change 0 pp"}`,
      explanation: costModel
        ? "Apply lower revenue with the default 60% variable-cost share; fixed operating costs stay fixed."
        : "Apply a 10% revenue decline while holding the operating margin unchanged.",
    });
    cases.push(
      costModel
        ? {
            id: "cost-inflation",
            label: "Cost inflation",
            overrides: { scenarioModel: "cost", scenarioCostChange: 5 },
            assumptions:
              "Revenue 0% · variable-cost share 60% · cost change +5%",
            explanation:
              "Increase modeled operating costs by 5% with revenue unchanged; the cost split is an explicit assumption.",
          }
        : {
            id: "margin-pressure",
            label: "Margin pressure",
            overrides: { scenarioModel: "margin", scenarioMargin: -2 },
            assumptions: "Revenue 0% · operating margin −2 pp",
            explanation:
              "Subtract two percentage points from reported operating margin, with revenue unchanged.",
          },
    );
  }
  cases.push({
    id: "asset-loss",
    label: "Asset loss",
    overrides: { scenarioModel: model, scenarioLoss: 2 },
    assumptions: "Asset loss 2% of baseline assets · withdrawals 0%",
    explanation:
      "Charge a new noncash asset loss fully to shareholder equity. This case does not model taxes or regulatory capital.",
  });
  if (data.lens === "banking")
    cases.push({
      id: "deposit-runoff",
      label: "Deposit runoff",
      overrides: { scenarioFunding: 10 },
      assumptions:
        "Withdrawals 10% of deposits · available cash 100% · replacement funding 0% · asset loss 0%",
      explanation:
        "Pay deposit withdrawals from assumed available reported cash. A cash shortfall remains visible instead of assuming asset sales.",
    });
  return cases.map((item) => ({
    ...item,
    patch: { ...SCENARIO_DEFAULTS, ...item.overrides },
  }));
}

export function scenarioStarterPatch(caseId, data, settings = {}) {
  const starter = scenarioStarterCases(data, settings).find(
    (item) => item.id === caseId,
  );
  return starter ? { ...starter.patch } : null;
}
