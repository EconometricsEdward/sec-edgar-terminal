import {
  analysisSecUrl,
  analysisSourceContext,
  uniqueAnalysisSources,
} from "./analysisSources.js";

export const VINTAGE_STATES = {
  changed: "Value changed",
  added: "Newly available",
  removed: "Unavailable now",
  inputs: "Same value, different inputs",
  unchanged: "Unchanged",
  missing: "Unavailable in both",
  incompatible: "Not comparable",
};

const finite = (point) => Number.isFinite(point?.value);
const validDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

/** Both snapshots must describe evidence available before their stated cutoff. */
export function validateVintageDate(
  value,
  currentCutoff = "",
  today = new Date().toISOString().slice(0, 10),
) {
  if (!validDate(value)) return "Choose a valid earlier filing cutoff date.";
  if (!validDate(today) || (currentCutoff && !validDate(currentCutoff)))
    return "The current snapshot cutoff is invalid. Reload the analysis.";
  const limit = currentCutoff || today;
  if (value >= limit || value >= today)
    return `The earlier cutoff must precede ${limit < today ? limit : today}.`;
  return "";
}

export function vintageSnapshotSettings(data, period, fallback = "") {
  return {
    basis: data.basis,
    end: period?.end || "latest",
    asOf: typeof data.asOf === "string" ? data.asOf : fallback,
  };
}

const sourceContexts = (point) =>
  [...new Set(uniqueAnalysisSources(point).map(analysisSourceContext))].sort();
const sourceFingerprint = (point) =>
  uniqueAnalysisSources(point)
    .map((source) =>
      JSON.stringify([
        analysisSourceContext(source),
        source.accession || null,
        source.filed || null,
        source.value,
      ]),
    )
    .sort()
    .join("|");
const completeSources = (point) => {
  const sources = uniqueAnalysisSources(point);
  return (
    sources.length > 0 &&
    sources.every(
      (source) =>
        source.taxonomy &&
        source.tag &&
        source.unit &&
        Number.isFinite(source.value) &&
        source.accession &&
        validDate(source.filed) &&
        validDate(source.end) &&
        (!source.start ||
          (validDate(source.start) && source.start <= source.end)),
    )
  );
};
const missingPoint = (period, reason) => ({
  period,
  value: null,
  sources: [],
  classification: "unavailable",
  reason,
});

function classifyVintageRow(
  definition,
  beforeDefinition,
  current,
  before,
  currentCutoff,
  earlierCutoff,
) {
  if (
    [
      [current, currentCutoff],
      [before, earlierCutoff],
    ].some(
      ([point, cutoff]) =>
        finite(point) &&
        uniqueAnalysisSources(point).some(
          (source) => cutoff && source.filed > cutoff,
        ),
    )
  )
    return {
      state: "incompatible",
      reason:
        "A retained input was filed after its snapshot cutoff. The comparison is withheld until its provenance is resolved.",
    };
  if (!finite(current) && !finite(before))
    return {
      state: "missing",
      reason: "Neither snapshot has the required normalized inputs.",
    };
  if (!finite(before))
    return {
      state: "added",
      reason:
        "Available in the current snapshot only; this does not establish when the company first disclosed it.",
    };
  if (!finite(current))
    return {
      state: "removed",
      reason:
        "Available in the earlier snapshot only. Review missing-context and source-selection details.",
    };

  const sameValue = current.value === before.value;
  if (!completeSources(current) || !completeSources(before))
    return {
      state: "incompatible",
      reason:
        "Reported source metadata is incomplete. A same-concept revision and its delta are not established.",
    };
  const samePeriod =
    current.period?.end === before.period?.end &&
    current.period?.kind === before.period?.kind;
  const sameContexts =
    JSON.stringify(sourceContexts(current)) ===
    JSON.stringify(sourceContexts(before));
  const sameFormula =
    (current.formula || "") === (before.formula || "") &&
    current.classification === before.classification;
  if (
    !samePeriod ||
    definition.format !== beforeDefinition?.format ||
    !sameContexts ||
    !sameFormula
  )
    return {
      state:
        sameValue &&
        samePeriod &&
        definition.format === beforeDefinition?.format
          ? "inputs"
          : "incompatible",
      reason:
        "Source concepts, units, date windows, or calculation methods differ or are incomplete. A same-concept revision and its delta are not established.",
    };

  const delta = current.value - before.value;
  if (!Number.isFinite(delta))
    return {
      state: "incompatible",
      reason: "The arithmetic change exceeds the supported numeric range.",
    };
  const percent =
    before.value > 0 &&
    ["currency", "shares", "eps"].includes(definition.format)
      ? (delta / before.value) * 100
      : null;
  return {
    state: !sameValue
      ? "changed"
      : sourceFingerprint(current) !== sourceFingerprint(before)
        ? "inputs"
        : "unchanged",
    delta,
    percent: Number.isFinite(percent) ? percent : null,
    reason: !sameValue
      ? "The same reported concepts, units, date windows, and calculation method produce a different value. Review the filings to establish why."
      : "The value is unchanged across the two filing cutoffs.",
  };
}

/** Never fall back to an older reporting period if the requested period is absent. */
export function buildAnalysisVintageComparison(
  current,
  earlier,
  index,
  { earlierCutoff = "", currentCutoff = "", today } = {},
) {
  const period = current.periods?.[index];
  const currentSettings = vintageSnapshotSettings(
    current,
    period,
    currentCutoff,
  );
  const earlierSettings = vintageSnapshotSettings(
    earlier,
    period,
    earlierCutoff,
  );
  const empty = {
    period,
    currentSettings,
    earlierSettings,
    currentObservedAt: current.observedAt || null,
    earlierObservedAt: earlier.observedAt || null,
    rows: [],
    totals: {
      total: 0,
      currentAvailable: 0,
      earlierAvailable: 0,
      ...Object.fromEntries(
        Object.keys(VINTAGE_STATES).map((state) => [state, 0]),
      ),
    },
  };
  const dateError = validateVintageDate(
    earlierSettings.asOf,
    currentSettings.asOf,
    today,
  );
  if (dateError) return { ...empty, status: "invalid", reason: dateError };
  const sameCik =
    String(current.cik || "").replace(/^0+/, "") ===
    String(earlier.cik || "").replace(/^0+/, "");
  if (
    !sameCik ||
    !current.cik ||
    !earlier.cik ||
    current.ticker !== earlier.ticker ||
    current.basis !== earlier.basis ||
    (current.version &&
      earlier.version &&
      current.version !== earlier.version) ||
    (earlierCutoff && earlierSettings.asOf !== earlierCutoff)
  )
    return {
      ...empty,
      status: "invalid",
      reason:
        "The returned snapshot does not match the company, reporting basis, requested cutoff, or analysis version. Reload before comparing.",
    };
  if (!period)
    return {
      ...empty,
      status: "invalid",
      reason: "Select a reporting period before comparing filing snapshots.",
    };
  const matches = (earlier.periods || [])
    .map((p, i) => ({ period: p, index: i }))
    .filter(({ period: p }) => p.end === period.end && p.kind === period.kind);
  if (matches.length !== 1)
    return {
      ...empty,
      status: "missing-period",
      reason:
        matches.length > 1
          ? "The earlier snapshot has ambiguous contexts for this reporting period. No comparison was made."
          : `The ${earlierSettings.asOf} cutoff predates available evidence for the selected ${period.kind} period ending ${period.end}, or the required normalized period is unavailable. No older period was substituted.`,
    };
  const beforeIndex = matches[0].index;
  const earlierDefinitions = new Map(
    (earlier.definitions || []).map((definition) => [
      definition.key,
      definition,
    ]),
  );
  const definitions = [
    ...(current.definitions || []),
    ...(earlier.definitions || []).filter(
      (definition) =>
        !current.definitions?.some((d) => d.key === definition.key),
    ),
  ];
  const rows = definitions.map((definition) => {
    const currentDefinition =
      current.definitions.find((d) => d.key === definition.key) || definition;
    const beforeDefinition = earlierDefinitions.get(definition.key);
    const currentPoint =
      current.metrics?.[definition.key]?.[index] ||
      missingPoint(
        period,
        "This metric is unavailable in the current snapshot.",
      );
    const before =
      earlier.metrics?.[definition.key]?.[beforeIndex] ||
      missingPoint(
        matches[0].period,
        "This metric is unavailable within the earlier filing cutoff.",
      );
    const result = classifyVintageRow(
      currentDefinition,
      beforeDefinition,
      currentPoint,
      before,
      currentSettings.asOf,
      earlierSettings.asOf,
    );
    return {
      definition: currentDefinition,
      earlierDefinition: beforeDefinition || definition,
      current: currentPoint,
      before,
      delta: null,
      percent: null,
      ...result,
    };
  });
  const totals = rows.reduce(
    (counts, row) => {
      counts.total += 1;
      counts[row.state] += 1;
      if (finite(row.current)) counts.currentAvailable += 1;
      if (finite(row.before)) counts.earlierAvailable += 1;
      return counts;
    },
    { ...empty.totals },
  );
  return {
    ...empty,
    rows,
    totals,
    status: "ready",
    reason: "",
    earlierIndex: beforeIndex,
  };
}

const csvCell = (value) => {
  const text =
    typeof value === "number"
      ? String(value)
      : String(value ?? "").replace(/^(\s*)([=+@-])/, "$1'$2");
  return `"${text.replaceAll('"', '""')}"`;
};
const exportedSources = (point) =>
  JSON.stringify(
    uniqueAnalysisSources(point).map((source) => ({
      taxonomy: source.taxonomy,
      tag: source.tag,
      unit: source.unit,
      value: source.value,
      start: source.start || null,
      end: source.end,
      filed: source.filed,
      accession: source.accession,
      form: source.form,
      url: analysisSecUrl(source.documentUrl),
    })),
  );

export function exportAnalysisVintageCsv(
  comparison,
  data,
  rows = comparison.rows,
  filters = {},
) {
  const header = [
    "Ticker",
    "CIK",
    "Metric",
    "State",
    "Basis",
    "Period end",
    "Earlier cutoff",
    "Current cutoff",
    "Earlier observed at",
    "Current observed at",
    "Earlier value",
    "Current value",
    "Earlier unit",
    "Current unit",
    "Compatible delta",
    "Compatible percent change",
    "Explanation",
    "Earlier formula",
    "Current formula",
    "Earlier missing reason",
    "Current missing reason",
    "Earlier sources (JSON)",
    "Current sources (JSON)",
    "Earlier settings (JSON)",
    "Current settings (JSON)",
    "Visible-row filters (JSON)",
  ];
  return [
    header,
    ...rows.map((row) => [
      data.ticker,
      data.cik,
      row.definition.label,
      VINTAGE_STATES[row.state],
      comparison.currentSettings.basis,
      comparison.period?.end,
      comparison.earlierSettings.asOf,
      comparison.currentSettings.asOf ||
        "Latest available at current observed time",
      comparison.earlierObservedAt,
      comparison.currentObservedAt,
      row.before.value,
      row.current.value,
      row.earlierDefinition.format === "currency"
        ? "USD"
        : row.earlierDefinition.format,
      row.definition.format === "currency" ? "USD" : row.definition.format,
      row.delta,
      row.percent,
      row.reason,
      row.before.formula,
      row.current.formula,
      row.before.reason,
      row.current.reason,
      exportedSources(row.before),
      exportedSources(row.current),
      JSON.stringify(comparison.earlierSettings),
      JSON.stringify(comparison.currentSettings),
      JSON.stringify(filters),
    ]),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}
