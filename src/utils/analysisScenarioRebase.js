import { buildAnalysisScenario, normalizeScenarioSettings } from "./analysisScenarios.js";
import { scenarioCaseSelection, validateScenarioCase } from "./analysisScenarioCases.js";
import { evidenceSources } from "./researchEvidence.js";

const DAY = 86400000;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
const duration = (period) => validDate(period?.start) && validDate(period?.end) ? (Date.parse(period.end) - Date.parse(period.start)) / DAY + 1 : null;
const daysFromYearStart = (date) => (Date.parse(`2000-${date.slice(5)}`) - Date.parse("2000-01-01")) / DAY;
const seasonDistance = (a, b) => {
  const distance = Math.abs(daysFromYearStart(a) - daysFromYearStart(b));
  return Math.min(distance, 366 - distance);
};

function comparisonBoundary(reference, data, settings, index) {
  const before = reference.context;
  const period = data.periods?.[index];
  if (before.ticker !== data.ticker || before.lens !== data.lens || (before.cik && data.cik && String(before.cik).replace(/^0+/, "") !== String(data.cik).replace(/^0+/, "")))
    return "Choose a reference for the same company and accounting model.";
  if (!before.dataVersion || before.dataVersion !== String(data.version || ""))
    return "The financial data version changed. Preserve the original reference and start a new baseline; numerical attribution is withheld.";
  if (before.basis !== (data.basis || settings.basis) || before.period.kind !== period?.kind)
    return "Use the same reporting basis as the saved reference.";
  if (!validDate(period?.end) || !validDate(before.period.end) || period.end < before.period.end)
    return "The selected reporting period is older than the reference or has no valid date. Select the same period or a later comparable period.";
  const previousDays = duration(before.period), currentDays = duration(period);
  if (!previousDays || !currentDays || previousDays <= 0 || currentDays <= 0 || Math.abs(previousDays - currentDays) > 14)
    return "The reporting durations are missing or differ by more than 14 days. A numerical change would mix different reporting windows.";
  if (period.end === before.period.end && period.start !== before.period.start)
    return "The same reporting endpoint has different starting dates. Review the reporting windows before comparing.";
  if (period.end !== before.period.end && before.basis !== "ttm" && (
    seasonDistance(before.period.end, period.end) > 14 ||
    (before.period.fp && period.fp && before.period.fp !== period.fp)
  ))
    return "Choose a later period at the same point in the fiscal year. Sequential quarters or different year-to-date windows are not seasonally comparable.";
  const cutoff = data.asOf ?? settings.asOf ?? "";
  if (cutoff && (!validDate(cutoff) || (before.asOf && cutoff < before.asOf)))
    return "The filing cutoff precedes the saved reference. Use the same cutoff or later filings.";
  const priorFiled = outcomeRows(reference.snapshot).flatMap((row) => evidenceSources(row.selection?.point)).map((source) => source.filed).filter(validDate).sort().at(-1);
  if (cutoff && priorFiled && cutoff < priorFiled)
    return "The selected filing cutoff excludes evidence retained in the reference. Use a later cutoff.";
  return null;
}

function outcomeRows(scenario) {
  const connected = normalizeScenarioSettings(scenario.settings).scenarioCashMode === "connected" && scenario.connected?.enabled;
  return [
    ...(scenario.operating?.rows || []).map((row) => ({ ...row, group: "operating", comparisonKey: `operating:${row.key}` })),
    ...((connected ? scenario.connected : scenario.balance)?.rows || []).map((row) => ({ ...row, group: connected ? "connected" : "balance", comparisonKey: `${connected ? "connected" : "balance"}:${row.key}` })),
  ];
}

function evidenceReason(row, context) {
  const point = row?.selection?.point;
  if (!row || !finite(point?.value)) return point?.reason || "This outcome has no comparable reported inputs.";
  if (point.reason) return point.reason;
  if (point.period?.end !== context.period.end || point.period?.start !== context.period.start || point.period?.kind !== context.period.kind)
    return "An outcome does not match its retained reporting window.";
  const sources = evidenceSources(point);
  if (!sources.length) return "Reviewable SEC source evidence is missing.";
  if (sources.some((source) => !source.tag || !source.taxonomy || !source.unit || !finite(source.value)))
    return "The SEC concept, unit, or reported source value is missing.";
  if (sources.some((source) => !validDate(source.filed)))
    return "A source filing date is missing or invalid; the evidence chronology cannot be verified.";
  if (sources.some((source) => !validDate(source.end) || source.end > context.period.end || (source.start != null && (!validDate(source.start) || source.start > source.end))))
    return "A source has an invalid or incompatible reporting date.";
  if (!sources.some((source) => source.end === context.period.end))
    return "The source evidence does not reach the selected reporting endpoint.";
  if (context.asOf && sources.some((source) => !validDate(source.filed) || source.filed > context.asOf))
    return "Source evidence does not match the selected filing cutoff.";
  return null;
}

const conceptSignature = (row) => stable([...new Set(evidenceSources(row?.selection?.point).map((source) => stable({
  taxonomy: source.taxonomy, tag: source.tag, unit: source.unit,
  scope: source.scope || null, entity: source.entity || source.entityIdentifier || null,
  dimensions: source.dimensions || source.segment || null,
})))].sort());
const reportedValueSignature = (row) => stable(evidenceSources(row?.selection?.point).map((source) => stable({
  taxonomy: source.taxonomy, tag: source.tag, unit: source.unit, value: source.value,
  start: source.start || null, end: source.end, scope: source.scope || null,
  entity: source.entity || source.entityIdentifier || null, dimensions: source.dimensions || source.segment || null,
})).sort());

const contextSelection = (row, settings, period, asOf) => row?.selection ? {
  ...row.selection,
  analysisSettings: { ...settings, view: "scenarios", basis: period.kind, end: period.end, asOf },
} : null;

/** Recalculate retained assumptions on selected SEC inputs without mutating the reference.
 * Attribution order is explicit: change the reported data first, then the assumptions.
 * Its components sum to the total, but neither component is a causal earnings forecast.
 */
export function buildScenarioRebase({ reference, data, settings, index = 0, scenario }) {
  try { validateScenarioCase(reference); } catch (error) {
    return { compatible: false, reason: error.message, rows: [] };
  }
  const reason = comparisonBoundary(reference, data, settings, index);
  if (reason) return { compatible: false, reason, rows: [] };
  const period = data.periods[index];
  const cutoff = data.asOf ?? settings.asOf ?? "";
  const rebasedSettings = { ...settings, ...normalizeScenarioSettings(reference.settings), basis: data.basis || settings.basis, end: period.end, asOf: cutoff };
  const rebasedScenario = buildAnalysisScenario(data, rebasedSettings, index);
  const currentScenario = scenario || buildAnalysisScenario(data, settings, index);
  const originalRows = new Map(outcomeRows(reference.snapshot).map((row) => [row.comparisonKey, row]));
  const rebasedRows = new Map(outcomeRows(rebasedScenario).map((row) => [row.comparisonKey, row]));
  const currentRows = new Map(outcomeRows(currentScenario).map((row) => [row.comparisonKey, row]));
  const originalSettings = normalizeScenarioSettings(reference.settings);
  const currentSettings = normalizeScenarioSettings(settings);
  const modelChanged = originalSettings.scenarioModel !== currentSettings.scenarioModel || originalSettings.scenarioCashMode !== currentSettings.scenarioCashMode;
  const currentContext = { period, asOf: cutoff };
  const rows = [...new Set([...originalRows.keys(), ...rebasedRows.keys(), ...currentRows.keys()])].map((key) => {
    const original = originalRows.get(key), rebased = rebasedRows.get(key), current = currentRows.get(key);
    const metadata = original || rebased || current;
    let dataReason = evidenceReason(original, reference.context) || evidenceReason(rebased, currentContext);
    if (!dataReason && original.format !== rebased.format) dataReason = "The outcome unit changed.";
    if (!dataReason && original.selection.point.formula !== rebased.selection.point.formula)
      dataReason = "The calculation method changed since this reference was saved. Numerical attribution is withheld.";
    if (!dataReason && conceptSignature(original) !== conceptSignature(rebased))
      dataReason = "SEC concepts, units, or accounting scope changed. Inspect the retained and current sources before comparing.";
    if (!dataReason && reference.context.period.end === period.end && reference.context.period.start === period.start && reportedValueSignature(original) === reportedValueSignature(rebased)) {
      const before = original.selection.point.value, after = rebased.selection.point.value;
      if (Math.abs(after - before) > Number.EPSILON * 32 * Math.max(1, Math.abs(before), Math.abs(after)))
        dataReason = "The same reported inputs and saved assumptions produce a different result. A calculation change cannot be attributed to new financial data; preserve this reference and start a new baseline.";
    }
    const assumptionReason = modelChanged ? "The operating or cash model changed. Match the saved model to attribute assumption changes." : evidenceReason(rebased, currentContext) || evidenceReason(current, currentContext) || (rebased.format !== current.format ? "The outcome unit changed." : null);
    const originalValue = original?.selection?.point?.value;
    const rebasedValue = rebased?.selection?.point?.value;
    const currentValue = current?.selection?.point?.value;
    const difference = (a, b) => finite(a) && finite(b) && finite(a - b) ? a - b : null;
    const dataChange = dataReason ? null : difference(rebasedValue, originalValue);
    const assumptionChange = assumptionReason ? null : difference(currentValue, rebasedValue);
    const totalChange = dataChange !== null && assumptionChange !== null ? difference(currentValue, originalValue) : null;
    return {
      key, label: metadata.label, format: metadata.format,
      original: finite(originalValue) ? originalValue : null,
      rebased: finite(rebasedValue) ? rebasedValue : null,
      current: finite(currentValue) ? currentValue : null,
      dataChange, assumptionChange, totalChange, dataReason, assumptionReason,
      originalSelection: original?.selection ? scenarioCaseSelection(reference, original.selection) : null,
      rebasedSelection: contextSelection(rebased, rebasedSettings, period, cutoff),
      currentSelection: contextSelection(current, settings, period, cutoff),
    };
  });
  return {
    compatible: true, reason: null, rows, rebasedSettings, rebasedScenario,
    period, modelChanged,
    status: period.end === reference.context.period.end
      ? rows.every((row) => row.dataChange === 0 && stable(evidenceSources(row.originalSelection?.point)) === stable(evidenceSources(row.rebasedSelection?.point)))
        ? "Reported inputs unchanged"
        : "Same reporting period · compare source evidence"
      : "Later comparable reporting period",
    note: "Change the reported data first while keeping the saved assumptions, then apply current assumptions. This ordering separates the two effects; it does not establish causation. Values remain hypothetical.",
  };
}
