import {
  buildAnalysisScenario,
  normalizeScenarioSettings,
} from "./analysisScenarios.js";

const AXES = {
  scenarioRevenue: {
    label: "Revenue change",
    unit: "%",
    min: -50,
    max: 50,
    step: 5,
    steps: [1, 2.5, 5, 10, 25],
  },
  scenarioMargin: {
    label: "Margin change",
    unit: "pp",
    min: -20,
    max: 20,
    step: 2,
    steps: [0.25, 0.5, 1, 2, 5],
  },
  scenarioCostChange: {
    label: "Cost change",
    unit: "%",
    min: -50,
    max: 50,
    step: 5,
    steps: [1, 2.5, 5, 10, 25],
  },
  scenarioLoss: {
    label: "Asset loss",
    unit: "%",
    min: 0,
    max: 20,
    step: 2,
    steps: [0.25, 0.5, 1, 2, 5],
  },
  scenarioFunding: {
    label: "Deposit withdrawal",
    unit: "%",
    min: 0,
    max: 50,
    step: 5,
    steps: [1, 2.5, 5, 10, 25],
  },
};

/** At boundaries the grid shrinks: it never invents duplicate or out-of-range cells. */
export function scenarioSensitivityValues(center, step, min, max) {
  if (
    ![center, step, min, max].every(Number.isFinite) ||
    step <= 0 ||
    min > max
  )
    return [];
  const bounded = Math.min(max, Math.max(min, center));
  return [
    ...new Set(
      [-2, -1, 0, 1, 2].map((offset) =>
        Math.min(max, Math.max(min, bounded + offset * step)),
      ),
    ),
  ].sort((a, b) => a - b);
}

export function scenarioSensitivityAxes(data, settings, exercise) {
  const operating = data.lens === "corporate" && exercise !== "balance";
  const keys = operating
    ? [
        "scenarioRevenue",
        settings.scenarioModel === "cost"
          ? "scenarioCostChange"
          : "scenarioMargin",
      ]
    : ["scenarioLoss", ...(data.lens === "banking" ? ["scenarioFunding"] : [])];
  return keys.map((key) => ({ key, ...AXES[key] }));
}

function resultOf(scenario, exercise, outcome) {
  const section = scenario[exercise];
  const row = section?.rows?.find((item) => item.key === outcome);
  const reason =
    section?.reason ||
    row?.selection?.point?.reason ||
    (outcome === "Cash" ? section?.funding?.reason : null) ||
    (!Number.isFinite(row?.selection?.point?.value)
      ? "This outcome is unavailable for these inputs and assumptions."
      : null);
  return { row, reason, value: reason ? null : row.selection.point.value };
}

/** Every grid cell runs the same model as the committed scenario. */
export function buildAnalysisSensitivity(data, input, index, options = {}) {
  const settings = normalizeScenarioSettings(input);
  const period = data.periods?.[index];
  const selectionSettings = (patch) => ({
    ...input,
    ...settings,
    ...patch,
    view: "scenarios",
    basis: data.basis || period?.kind,
    end: period?.end,
    asOf: data.asOf ?? input?.asOf ?? null,
  });
  const exercise =
    data.lens === "corporate" && options.exercise !== "balance"
      ? "operating"
      : "balance";
  const outcomes =
    exercise === "operating"
      ? [
          {
            key: "OperatingIncome",
            label: "Operating income",
            format: "currency",
          },
          { key: "Margin", label: "Operating margin", format: "percent" },
        ]
      : [
          {
            key: "EquityAssets",
            label: "Shareholder equity / assets",
            format: "percent",
          },
          ...(data.lens === "banking"
            ? [
                {
                  key: "Cash",
                  label: "Cash after withdrawals",
                  format: "currency",
                },
              ]
            : []),
        ];
  const outcome =
    outcomes.find((item) => item.key === options.outcome) || outcomes[0];
  const axes = scenarioSensitivityAxes(data, settings, exercise);
  const expandedAxes = axes.map((axis, axisIndex) => {
    const candidate = Number(axisIndex === 0 ? options.xStep : options.yStep);
    const step = axis.steps.includes(candidate) ? candidate : axis.step;
    return {
      ...axis,
      step,
      values: scenarioSensitivityValues(
        settings[axis.key],
        step,
        axis.min,
        axis.max,
      ),
    };
  });
  const [x, y] = expandedAxes;
  const committed = buildAnalysisScenario(data, settings, index);
  const currentResult = resultOf(committed, exercise, outcome.key);
  const cells = (y?.values || [null]).flatMap((yValue) =>
    x.values.map((xValue) => {
      const patch = { [x.key]: xValue, ...(y ? { [y.key]: yValue } : {}) };
      const scenario = buildAnalysisScenario(
        data,
        { ...settings, ...patch },
        index,
      );
      const result = resultOf(scenario, exercise, outcome.key);
      return {
        id: `${xValue}:${yValue ?? "single"}`,
        x: xValue,
        y: yValue,
        patch,
        value: result.value,
        reason: result.reason,
        selection: result.reason
          ? null
          : {
              ...result.row.selection,
              analysisSettings: selectionSettings(patch),
            },
        current: Object.entries(patch).every(
          ([key, value]) => settings[key] === value,
        ),
        delta:
          Number.isFinite(result.value) && Number.isFinite(currentResult.value)
            ? result.value - currentResult.value
            : null,
      };
    }),
  );
  const valid = cells.filter((cell) => Number.isFinite(cell.value));
  const minimum = valid.length
    ? Math.min(...valid.map((cell) => cell.value))
    : null;
  const maximum = valid.length
    ? Math.max(...valid.map((cell) => cell.value))
    : null;
  const reasons = [
    ...new Set(cells.flatMap((cell) => (cell.reason ? [cell.reason] : []))),
  ];
  return {
    exercise,
    settings,
    x,
    y,
    outcome,
    outcomes,
    cells,
    minimum,
    maximum,
    reasons,
    invalidCount: cells.length - valid.length,
    current: {
      value: currentResult.value,
      reason: currentResult.reason,
      selection: currentResult.reason
        ? null
        : {
            ...currentResult.row.selection,
            analysisSettings: selectionSettings({}),
          },
    },
    clipped: x.values.length < 5 || (y && y.values.length < 5),
  };
}

/** Exact additive attribution, with a separate reconciliation before visualization. */
export function buildScenarioDriverBridge(scenario) {
  const operating = scenario?.operating;
  const result = operating?.rows?.find((row) => row.key === "OperatingIncome");
  const effects = operating?.bridge || [];
  const baselineInput = operating?.inputs?.find(
    (input) => input.key === "operatingIncome",
  );
  const baseline = result?.baseline;
  const final = result?.selection?.point?.value;
  const reason =
    operating?.reason ||
    (!effects.length ||
    !Number.isFinite(baseline) ||
    !Number.isFinite(final) ||
    effects.some((row) => !Number.isFinite(row.selection?.point?.value))
      ? "The operating-income bridge is unavailable for these inputs."
      : null);
  if (reason)
    return {
      reason,
      rows: [],
      reconciled: false,
      method: operating?.bridgeMethod || "",
    };
  const effectTotal = effects.reduce(
    (sum, row) => sum + row.selection.point.value,
    0,
  );
  const reconstructed = baseline + effectTotal;
  const residual = final - reconstructed;
  if (![effectTotal, reconstructed, residual].every(Number.isFinite))
    return {
      reason:
        "The operating-income attribution exceeds the supported numerical range.",
      rows: [],
      reconciled: false,
      method: operating.bridgeMethod || "",
    };
  const tolerance =
    Math.max(
      1,
      Math.abs(baseline),
      Math.abs(final),
      ...effects.map((row) => Math.abs(row.selection.point.value)),
    ) *
    Number.EPSILON *
    32;
  let cumulative = baseline;
  const rows = [
    {
      key: "reported",
      label: "Reported operating income",
      kind: "total",
      value: baseline,
      from: 0,
      to: baseline,
      selection: baselineInput
        ? { definition: baselineInput.definition, point: baselineInput.point }
        : null,
    },
    ...effects.map((row) => {
      const from = cumulative;
      cumulative += row.selection.point.value;
      return {
        ...row,
        kind: "effect",
        value: row.selection.point.value,
        from,
        to: cumulative,
      };
    }),
    {
      key: "result",
      label: "Hypothetical operating income",
      kind: "total",
      value: final,
      from: 0,
      to: final,
      selection: result.selection,
    },
  ];
  if (rows.some((row) => !Number.isFinite(row.to)))
    return {
      reason:
        "A running operating-income attribution exceeds the supported numerical range.",
      rows: [],
      reconciled: false,
      method: operating.bridgeMethod || "",
    };
  return {
    reason: null,
    rows,
    baseline,
    final,
    effectTotal,
    reconstructed,
    residual,
    tolerance,
    reconciled: Math.abs(residual) <= tolerance,
    method: operating.bridgeMethod || "",
  };
}
