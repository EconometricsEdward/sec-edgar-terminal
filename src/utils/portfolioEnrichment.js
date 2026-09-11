import {
  PORTFOLIO_METRIC_CATALOG,
  portfolioMetricDefinitionFor,
} from "./portfolioMetricCatalog.js";
import {
  portfolioResearchIssuers,
  portfolioMetricState,
  metricPeriodKey,
  metricUnit,
} from "./portfolioDeepResearch.js";
import { portfolioMetricSourceUrl } from "./portfolioAnalytics.js";
import { csvString } from "./portfolioFiles.js";
import { portfolioMetricDefinition } from "./portfolioChanges.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const sum = (rows, key) =>
  rows.reduce((total, row) => total + (finite(row[key]) ? row[key] : 0), 0);
const weight = (row) => finite(row.weightPct) && row.weightPct >= 0;
const knownWeight = (rows) =>
  rows.length && !rows.some(weight)
    ? null
    : sum(rows.filter(weight), "weightPct");
const partialWeights = (report, rows) =>
  Boolean(
    report.weighted &&
      (!report.concentration?.complete ||
        rows.some((row) => !row.weightComplete || !weight(row))),
  );
const members = (report, companies) => [
  ...new Map(
    portfolioResearchIssuers(report, companies)
      .filter((row) => row.kind === "company")
      .map((row) => [row.cik, row]),
  ).values(),
];
const pointFor = (row, key) =>
  portfolioMetricState(row.company, portfolioMetricDefinitionFor(key)) ===
  "available"
    ? row.company.metrics[key]
    : null;
const pair = (row, keys) => {
  const points = keys.map((key) => pointFor(row, key));
  return points.every(Boolean) &&
    new Set(points.map(metricPeriodKey)).size === 1
    ? points
    : null;
};
const evidence = (points) =>
  [
    ...new Set(
      points.flatMap((point) =>
        (point.sources || [])
          .map((source) => portfolioMetricSourceUrl({ sources: [source] }))
          .filter(Boolean),
      ),
    ),
  ].join(" ; ");
const identity = (row) => ({
  cik: row.cik,
  rowId: row.rowIds[0],
  name: row.name,
  ticker: row.ticker,
  lens: row.lens,
  industry: row.industry,
  weightPct: row.weightPct,
  weightComplete: row.weightComplete,
});
const provenance = (points) => ({
  period: metricPeriodKey(points[0]),
  evidence: evidence(points),
});

/** Use exactly the same eligibility contract as the main financial measure explorer. */
export function buildCatalogReport(report, companies) {
  const rows = members(report, companies);
  const metrics = PORTFOLIO_METRIC_CATALOG.map((definition) => {
    const observations = [],
      eligibleCiks = [],
      missingCiks = [],
      notApplicableCiks = [];
    for (const row of rows) {
      const state = portfolioMetricState(row.company, definition);
      if (state === "not-applicable") {
        notApplicableCiks.push(row.cik);
        continue;
      }
      eligibleCiks.push(row.cik);
      if (state !== "available") {
        missingCiks.push(row.cik);
        continue;
      }
      const point = row.company.metrics[definition.key];
      observations.push({
        ...identity(row),
        value: point.value,
        period: point.period,
        periodEnd: point.period.end,
        periodKey: metricPeriodKey(point),
        sourceUrl: portfolioMetricSourceUrl(point),
        definition: portfolioMetricDefinition(point),
        evidence: evidence([point]),
      });
    }
    return {
      ...definition,
      id: definition.key,
      unit: metricUnit(definition.format),
      availableCount: observations.length,
      observations,
      eligibleCiks,
      missingCiks,
      notApplicableCiks,
    };
  }).filter((metric) => metric.availableCount > 0);
  return {
    ...report,
    concentration: {
      ...report.concentration,
      issuers: report.concentration.issuers.map((row) => ({
        ...row,
        lens: rows.find((item) => item.cik === row.cik)?.lens || "unknown",
      })),
    },
    metrics,
    fullPeriodEvidence: true,
  };
}

export function fundamentalCohorts(report, companies, key) {
  const groups = new Map();
  for (const row of members(report, companies)) {
    const point = pointFor(row, key);
    if (!point) continue;
    const id = `${row.lens}|${metricPeriodKey(point)}`;
    const group = groups.get(id) || {
      id,
      lens: row.lens,
      period: metricPeriodKey(point),
      count: 0,
    };
    group.count++;
    groups.set(id, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.id.localeCompare(b.id),
  );
}

/** Weighted summaries of company ratios, never consolidated portfolio accounting ratios. */
export function weightedFundamentals(report, companies, key, cohortId) {
  const definition = portfolioMetricDefinitionFor(key);
  if (!["percent", "decimal"].includes(definition?.format))
    return { rows: [], error: "Choose a supported ratio." };
  const cohorts = fundamentalCohorts(report, companies, key);
  const cohort = cohorts.find((item) => item.id === cohortId) || cohorts[0];
  const rows = members(report, companies).flatMap((row) => {
    const point = pointFor(row, key);
    return point && `${row.lens}|${metricPeriodKey(point)}` === cohort?.id
      ? [
          {
            ...identity(row),
            value: point.value,
            unit: point.unit,
            ...provenance([point]),
          },
        ]
      : [];
  });
  const weighted = report.weighted
    ? rows.filter((row) => weight(row) && row.weightPct > 0)
    : [];
  const coveredWeightPct = sum(weighted, "weightPct");
  const equalMean = rows.length
    ? rows.reduce((total, row) => total + row.value / rows.length, 0)
    : null;
  const weightedMean =
    coveredWeightPct > 0
      ? weighted.reduce(
          (total, row) =>
            total + row.value * (row.weightPct / coveredWeightPct),
          0,
        )
      : null;
  let cumulative = 0,
    weightedMedian = null;
  for (const row of [...weighted].sort((a, b) => a.value - b.value)) {
    cumulative += row.weightPct;
    if (cumulative >= coveredWeightPct / 2) {
      weightedMedian = row.value;
      break;
    }
  }
  return {
    rows: rows.sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1)),
    cohorts,
    cohort,
    equalMean,
    weightedMean,
    weightedMedian,
    coveredWeightPct: report.weighted ? knownWeight(rows) : null,
    weightedCompanyCount: weighted.length,
    partial: partialWeights(report, rows),
    unit: metricUnit(definition.format),
    excludedCount: members(report, companies).length - rows.length,
  };
}

export const BUFFER_MEASURES = [
  {
    id: "netDebt",
    label: "Reported debt less cash",
    keys: ["debt", "cash"],
    unit: "USD",
    formula:
      "Reported debt − cash. Negative values indicate cash exceeds reported debt.",
    calculate: ([debt, cash]) => debt - cash,
  },
  {
    id: "cashDebt",
    label: "Cash / reported debt",
    keys: ["cash", "debt"],
    unit: "%",
    formula:
      "100 × cash / positive reported debt. Zero-debt companies are excluded from this ratio.",
    calculate: ([cash, debt]) => (debt > 0 ? (100 * cash) / debt : null),
  },
  {
    id: "interestCover",
    label: "Operating income / interest expense",
    keys: ["operatingIncome", "interestExpense"],
    unit: "x",
    formula:
      "Operating income / positive reported interest expense. This uses the reported interest scope, not all fixed charges.",
    calculate: ([income, interest]) =>
      interest > 0 ? income / interest : null,
  },
];
export function financingBuffers(report, companies) {
  const corporate = members(report, companies).filter(
    (row) => row.lens === "corporate",
  );
  return BUFFER_MEASURES.flatMap((measure) => {
    const rows = corporate
      .flatMap((row) => {
        const points = pair(row, measure.keys);
        if (!points || points.some((point) => point.unit !== "USD")) return [];
        const value = measure.calculate(points.map((point) => point.value));
        return finite(value)
          ? [
              {
                ...identity(row),
                value,
                unit: measure.unit,
                inputValues: measure.keys.map((key, i) => ({
                  key,
                  label: portfolioMetricDefinitionFor(key).label,
                  value: points[i].value,
                  unit: points[i].unit,
                })),
                inputs: measure.keys
                  .map((key, i) => `${key}: ${points[i].value} USD`)
                  .join(" ; "),
                ...provenance(points),
              },
            ]
          : [];
      })
      .sort((a, b) => a.value - b.value);
    return rows.length
      ? [{ ...measure, rows, eligibleCount: corporate.length }]
      : [];
  });
}

export const FINANCIAL_CONDITIONS = [
  { id: "revenueGrowth", label: "Falling revenue" },
  { id: "netIncome", label: "Net loss" },
  { id: "operatingCashFlow", label: "Negative operating cash flow" },
  { id: "freeCashFlow", label: "Negative free cash flow" },
];
export function conditionOverlap(
  report,
  companies,
  selected = ["revenueGrowth", "operatingCashFlow"],
) {
  const keys = [...new Set(selected)].filter((key) =>
    FINANCIAL_CONDITIONS.some((item) => item.id === key),
  );
  const all = members(report, companies).filter(
    (row) => row.lens === "corporate",
  );
  const measured = keys.length
    ? all.flatMap((row) => {
        const points = pair(row, keys);
        if (!points) return [];
        return [
          {
            ...identity(row),
            conditionValues: keys.map((key, i) => ({
              key,
              label: FINANCIAL_CONDITIONS.find((item) => item.id === key).label,
              value: points[i].value,
              unit: points[i].unit,
            })),
            conditions: keys
              .map(
                (key, i) =>
                  `${FINANCIAL_CONDITIONS.find((item) => item.id === key).label}: ${points[i].value < 0 ? "yes" : "no"} (${points[i].value} ${points[i].unit})`,
              )
              .join(" ; "),
            matches: points.every((point) => point.value < 0),
            ...provenance(points),
          },
        ];
      })
    : [];
  const rows = measured
    .filter((row) => row.matches)
    .sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1));
  return {
    rows,
    measuredCount: measured.length,
    excludedCount: all.length - measured.length,
    knownWeightPct: report.weighted ? knownWeight(rows) : null,
    measuredWeightPct: report.weighted ? knownWeight(measured) : null,
    partial: partialWeights(report, rows),
  };
}

/** @param {any} report @param {any[]} companies @param {string[]} selectedKeys @param {number|null} maxAgeDays */
export function evidenceImpact(
  report,
  companies,
  selectedKeys,
  maxAgeDays = null,
) {
  const catalog = buildCatalogReport(report, companies);
  const selected = catalog.metrics.filter((metric) =>
    selectedKeys.includes(metric.id),
  );
  const now = Date.parse(report.capturedAt || "");
  const rows = members(report, companies).map((row) => {
    const retrieved = Date.parse(row.company?.retrievedAt || "");
    const captureAgeDays =
      finite(now) && finite(retrieved) && retrieved <= now
        ? Math.floor((now - retrieved) / 86400000)
        : null;
    const missing = selected.filter(
      (metric) =>
        portfolioMetricState(row.company, metric) !== "available" &&
        portfolioMetricState(row.company, metric) !== "not-applicable",
    );
    return {
      ...identity(row),
      missingCount: missing.length,
      missing: missing.map((item) => item.label).join(" ; "),
      captureAgeDays,
      retrievedAt: row.company?.retrievedAt || "",
      stale:
        maxAgeDays !== null &&
        (captureAgeDays === null || captureAgeDays > maxAgeDays),
    };
  });
  const measures = selected.map((metric) => {
    const available = rows.filter((row) =>
      metric.observations.some((point) => point.cik === row.cik),
    );
    const missing = rows.filter((row) => metric.missingCiks.includes(row.cik));
    return {
      label: metric.label,
      measuredCount: available.length,
      missingCount: missing.length,
      applicableCount: available.length + missing.length,
      coveredWeightPct: report.weighted ? knownWeight(available) : null,
      missingWeightPct: report.weighted ? knownWeight(missing) : null,
    };
  });
  return {
    measures,
    rows: rows
      .filter((row) => row.missingCount || row.stale)
      .sort(
        (a, b) =>
          (b.weightPct ?? -1) - (a.weightPct ?? -1) ||
          b.missingCount - a.missingCount ||
          a.name.localeCompare(b.name),
      ),
    capturedAt: report.capturedAt,
    weighted: report.weighted,
    partial: partialWeights(report, rows),
    metricIds: selected.map((item) => item.id),
  };
}

/** @param {any} report @param {any[]} companies @param {number|string} revenueChangePct @param {number|string} variableCostPct */
export function operatingSensitivity(
  report,
  companies,
  revenueChangePct = -10,
  variableCostPct = 50,
) {
  const g = strictNumber(revenueChangePct),
    v = strictNumber(variableCostPct);
  const error =
    g === null || g <= -100 || g > 100 || v === null || v < 0 || v > 100
      ? "Revenue change must be above −100% and at most +100%; variable costs must be 0–100%."
      : null;
  const eligible = members(report, companies).filter(
    (row) => row.lens === "corporate",
  );
  const rows = error
    ? []
    : eligible
        .flatMap((row) => {
          const points = pair(row, ["revenue", "operatingIncome"]);
          if (!points || points.some((point) => point.unit !== "USD"))
            return [];
          const [revenue, income] = points.map((point) => point.value),
            costs = revenue - income;
          if (revenue <= 0 || costs < 0) return [];
          const modeledRevenue = revenue * (1 + g / 100),
            modeledCosts = costs * (1 + ((v / 100) * g) / 100),
            modeledIncome = modeledRevenue - modeledCosts;
          if (![modeledRevenue, modeledCosts, modeledIncome].every(finite))
            return [];
          return [
            {
              ...identity(row),
              revenue,
              operatingIncome: income,
              modeledRevenue,
              modeledCosts,
              modeledIncome,
              modeledMarginPct: (100 * modeledIncome) / modeledRevenue,
              enteredLoss: income >= 0 && modeledIncome < 0,
              ...provenance(points),
            },
          ];
        })
        .sort((a, b) => a.modeledMarginPct - b.modeledMarginPct);
  const losses = rows.filter((row) => row.modeledIncome < 0);
  return {
    error,
    rows,
    modeledLossCount: losses.length,
    enteringLossCount: rows.filter((row) => row.enteredLoss).length,
    coveredWeightPct: report.weighted ? knownWeight(rows) : null,
    lossWeightPct: report.weighted ? knownWeight(losses) : null,
    eligibleCount: eligible.length,
    partial: partialWeights(report, rows),
    revenueChangePct: g,
    variableCostPct: v,
  };
}

export function strictNumber(value) {
  if (
    !["string", "number"].includes(typeof value) ||
    String(value).trim() === ""
  )
    return null;
  if (
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(value).trim())
  )
    return null;
  const number = Number(value);
  return finite(number) ? number : null;
}

/** Starting weights and targets are always complete allocations; no silent residual or normalization. */
export function rebalanceAllocation(scenario, targets, afterShock = false) {
  const errors = [];
  if (!scenario?.eligible)
    errors.push(
      "Choose a complete, reviewed allocation before comparing targets.",
    );
  if (afterShock && !scenario?.endingWeightsDefined)
    errors.push("Ending allocations are undefined after a total modeled loss.");
  const source = scenario?.contributions || [];
  if (
    !targets ||
    typeof targets !== "object" ||
    Object.keys(targets).some((cik) => !source.some((row) => row.cik === cik))
  )
    errors.push("Targets must refer only to holdings in this allocation.");
  const rows = source.map((row) => {
    const targetWeightPct = strictNumber(targets?.[row.cik]);
    const startingWeightPct = afterShock ? row.endingWeightPct : row.weightPct;
    if (
      targetWeightPct === null ||
      targetWeightPct < 0 ||
      targetWeightPct > 100
    )
      errors.push(
        `Enter a target from 0% to 100% for ${row.tickers.join(" / ") || row.name}.`,
      );
    return {
      cik: row.cik,
      rowId: row.rowId,
      name: row.name,
      ticker: row.tickers.join(" / "),
      startingWeightPct,
      targetWeightPct,
      changePct:
        targetWeightPct !== null && finite(startingWeightPct)
          ? targetWeightPct - startingWeightPct
          : null,
      shockPct: row.shockPct,
    };
  });
  const targetTotal = sum(rows, "targetWeightPct");
  if (Math.abs(targetTotal - 100) > 1e-6)
    errors.push(
      `Target weights total ${targetTotal.toFixed(4)}%; they must total 100%.`,
    );
  if (errors.length) return { valid: false, errors, rows, targetTotal };
  return {
    valid: true,
    errors,
    rows: rows.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)),
    targetTotal,
    turnoverPct:
      rows.reduce((total, row) => total + Math.abs(row.changePct), 0) / 2,
    startingHhi: rows.reduce(
      (total, row) => total + row.startingWeightPct ** 2,
      0,
    ),
    targetHhi: rows.reduce((total, row) => total + row.targetWeightPct ** 2, 0),
    startingShockPct: rows.reduce(
      (total, row) => total + (row.startingWeightPct * row.shockPct) / 100,
      0,
    ),
    targetShockPct: rows.reduce(
      (total, row) => total + (row.targetWeightPct * row.shockPct) / 100,
      0,
    ),
  };
}

export function analyzeRevisions(changes, options = {}) {
  const minimum = strictNumber(options.minimum ?? 0);
  const error =
    minimum === null || minimum < 0
      ? "Enter a nonnegative minimum absolute revision."
      : null;
  const rows = changes.map((change) => ({
    ...change,
    delta:
      change.kind === "revision" &&
      finite(change.beforeValue) &&
      finite(change.afterValue)
        ? change.afterValue - change.beforeValue
        : null,
    deltaUnit: change.unit === "%" ? "percentage points" : change.unit,
    knownWeightPct: options.weights?.[change.cik] ?? null,
  }));
  const units = [
    ...new Set(
      rows.filter((row) => finite(row.delta)).map((row) => row.deltaUnit),
    ),
  ];
  const filtered = error
    ? []
    : rows.filter(
        (row) =>
          (!options.kind ||
            options.kind === "all" ||
            row.kind === options.kind) &&
          (!options.company ||
            options.company === "all" ||
            row.cik === options.company) &&
          (!options.unit || row.deltaUnit === options.unit) &&
          (minimum === 0 ||
            (finite(row.delta) && Math.abs(row.delta) >= minimum)),
      );
  if (minimum > 0 && !options.unit)
    return {
      rows: [],
      units,
      error: "Choose a revision unit before applying a numeric threshold.",
    };
  filtered.sort((a, b) =>
    options.sortBy === "weight"
      ? (b.knownWeightPct ?? -1) - (a.knownWeightPct ?? -1)
      : options.sortBy === "magnitude" && options.unit
        ? Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)
        : (a.ticker || a.companyName).localeCompare(b.ticker || b.companyName),
  );
  return { rows: filtered, units, error };
}

export function analysisRowsCsv(rows, metadata = {}) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(
    (key) => key !== "rowId",
  );
  const cell = (value) =>
    value && typeof value === "object" ? JSON.stringify(value) : value;
  return csvString([
    [...Object.keys(metadata), ...keys],
    ...rows.map((row) => [
      ...Object.values(metadata).map(cell),
      ...keys.map((key) => cell(row[key])),
    ]),
  ]);
}

/** Applies one assumption to each holding; the ordinary scenario engine validates allocation. */
/** @param {any} base @param {any[]} overrides @param {number|string} remainder */
export function mixedPriceScenario(base, overrides = [], remainder = 0) {
  const errors = [...(base?.allocationErrors || [])];
  const other = strictNumber(remainder);
  if (other === null || other < -100 || other > 100)
    errors.push("The remainder shock must be between −100% and +100%.");
  if (!Array.isArray(overrides) || overrides.length > 20)
    errors.push("Use at most 20 custom assumptions.");
  const companyMap = new Map(),
    industryMap = new Map();
  for (const rule of Array.isArray(overrides) ? overrides : []) {
    const target = String(rule.target || ""),
      value = strictNumber(rule.shockPct);
    const map = rule.scope === "company" ? companyMap : industryMap;
    const validTarget =
      rule.scope === "company"
        ? base.issuers.some((row) => row.cik === target)
        : rule.scope === "industry" && base.industries.includes(target);
    if (!validTarget)
      errors.push("Choose a holding or industry for every custom assumption.");
    if (map.has(target))
      errors.push(
        "Each company or industry can have only one custom assumption.",
      );
    if (value === null || value < -100 || value > 100)
      errors.push("Every custom shock must be between −100% and +100%.");
    map.set(target, value);
  }
  if (errors.length || !base?.issuers?.length)
    return {
      eligible: false,
      errors,
      contributions: [],
      overrides,
      remainderShockPct: other,
    };
  const contributions = base.issuers.map((row) => {
    const assumption = companyMap.has(row.cik)
      ? "Company override"
      : industryMap.has(row.industry)
        ? "Industry override"
        : "Remainder";
    const shockPct =
      companyMap.get(row.cik) ?? industryMap.get(row.industry) ?? other;
    return {
      ...row,
      ticker: row.tickers.join(" / "),
      assumption,
      shockPct,
      contributionPct: (row.weightPct * shockPct) / 100,
    };
  });
  const totalReturnPct = sum(contributions, "contributionPct");
  const remainderValue = contributions.reduce(
    (total, row) => total + (row.weightPct / 100) * (1 + row.shockPct / 100),
    0,
  );
  return {
    ...base,
    eligible: true,
    errors: [],
    scope: "custom",
    targetShockPct: null,
    targetWeightPct: null,
    overrides,
    remainderShockPct: other,
    totalReturnPct,
    valueChange: finite(base.startingValue)
      ? (base.startingValue * totalReturnPct) / 100
      : null,
    endingValue: finite(base.startingValue)
      ? base.startingValue * remainderValue
      : null,
    assumptions: [
      "Hypothetical price assumptions. Company override > industry override > remainder. Each holding receives one shock.",
    ],
    endingWeightsDefined: remainderValue > 0,
    contributions: contributions
      .map((row) => ({
        ...row,
        endingWeightPct:
          remainderValue > 0
            ? (row.weightPct * (1 + row.shockPct / 100)) / remainderValue
            : null,
      }))
      .sort(
        (a, b) => Math.abs(b.contributionPct) - Math.abs(a.contributionPct),
      ),
  };
}
