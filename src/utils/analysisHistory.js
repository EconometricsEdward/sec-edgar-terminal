import {
  analysisBaseline,
  analysisChange,
  calculateAnalysisPoint,
} from "./analysisResearch.js";
import { evidenceSources } from "./researchEvidence.js";

const date = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const unavailable = (period, reason) => ({
  period,
  value: null,
  sources: [],
  classification: "unavailable",
  reason,
});

function flowWindow(point) {
  const flows = evidenceSources(point).filter((source) => source.start != null);
  if (
    flows.length &&
    flows.every(
      (source) =>
        source.start === flows[0].start && source.end === flows[0].end,
    )
  )
    return flows[0];
  return point?.period;
}

const conceptSignature = (point) =>
  [
    ...new Set(
      evidenceSources(point).map((source) =>
        [source.taxonomy || "", source.tag || "", source.unit || ""].join(":"),
      ),
    ),
  ]
    .sort()
    .join("|");

function evidenceScope(point, period, cutoff) {
  if (!Number.isFinite(point?.value))
    return point?.reason || "The metric is unavailable for this period.";
  if (
    !date(period?.end) ||
    point.period?.end !== period.end ||
    point.period?.kind !== period.kind ||
    (point.period?.start || null) !== (period.start || null)
  )
    return "The metric does not match this reporting period.";
  const sources = evidenceSources(point);
  if (!sources.length)
    return "Reported evidence is required for historical context.";
  if (
    sources.some(
      (source) =>
        !date(source.end) ||
        source.end > period.end ||
        (source.start != null &&
          (!date(source.start) || source.start > source.end)),
    )
  )
    return "An input has an invalid reporting date or extends beyond this period.";
  if (!sources.some((source) => source.end === period.end))
    return "The reported inputs do not reach this period's reporting endpoint.";
  if (
    cutoff &&
    sources.some((source) => !date(source.filed) || source.filed > cutoff)
  )
    return "Every input needs a valid filing date on or before the selected filing cutoff.";
  const actual = flowWindow(point);
  if (
    sources.some((source) => source.start != null) &&
    (!date(period.start) ||
      !date(actual?.start) ||
      Math.abs(Date.parse(actual.start) - Date.parse(period.start)) >
        14 * 86400000 ||
      actual.end !== period.end)
  )
    return "The actual reported flow window does not match the selected reporting duration within 14 days.";
  return null;
}

/** Descriptive history, never a risk grade. Walk exact one-year baseline anchors
 * so rolling quarters and overlapping TTM windows cannot inflate the sample. */
export function historicalContext(data, key, index = 0, requestedLimit = 8) {
  const limit = Number.isFinite(Number(requestedLimit))
    ? Math.max(1, Math.min(20, Math.floor(Number(requestedLimit))))
    : 8;
  const period = data?.periods?.[index];
  const definition = data?.definitions?.find((item) => item.key === key);
  const current = data?.metrics?.[key]?.[index];
  const rows = [];
  const currentReason = evidenceScope(current, period, data?.asOf);
  let boundaryReason = null;
  let anchor = index;
  let newestIncluded = flowWindow(current);
  if (period && Number.isInteger(index) && index >= 0) {
    for (let offset = 1; offset <= limit; offset += 1) {
      const beforeIndex = analysisBaseline(data.periods, anchor, "year");
      if (beforeIndex < 0) {
        boundaryReason =
          "No same-season annual anchor is available before " +
          data.periods[anchor].end +
          ". The historical window stops here; it does not jump a missing reporting year.";
        break;
      }
      const beforePeriod = data.periods[beforeIndex];
      const before = data.metrics?.[key]?.[beforeIndex];
      const expectedYear = Number(data.periods[anchor].fy) - 1;
      if (
        Number.isFinite(expectedYear) &&
        Number(beforePeriod.fy) !== expectedYear
      ) {
        boundaryReason =
          "The prior anchor is not the immediately preceding fiscal year. The window stops at the fiscal-year mismatch.";
        break;
      }
      let reason =
        currentReason || evidenceScope(before, beforePeriod, data?.asOf);
      if (!reason) {
        const change = analysisChange(current, before, definition?.format);
        if (change.delta == null) reason = change.reason;
      }
      if (
        !reason &&
        period.kind === "ttm" &&
        (!date(newestIncluded?.start) ||
          flowWindow(before)?.end >= newestIncluded.start)
      )
        reason =
          "This trailing-year window overlaps a more recent included observation.";
      rows.push({
        index: beforeIndex,
        period: beforePeriod,
        point: before,
        included: !reason,
        reason,
        note:
          !reason && conceptSignature(before) !== conceptSignature(current)
            ? "Reported input concepts differ from the selected period. Review the underlying SEC tags before interpreting this comparison."
            : null,
      });
      if (!reason) newestIncluded = flowWindow(before);
      anchor = beforeIndex;
    }
  }
  const included = rows.filter((row) => row.included);
  const sorted = [...included].sort((a, b) => a.point.value - b.point.value);
  const count = included.length;
  const summaryReason =
    currentReason ||
    (count < 2
      ? "At least two compatible prior observations are needed to summarize a historical range and median."
      : null);
  let median = unavailable(period, summaryReason);
  let low = null;
  let high = null;
  let position = null;
  if (!summaryReason) {
    low = sorted[0];
    high = sorted.at(-1);
    median = calculateAnalysisPoint(
      period,
      included.map((row) => row.point),
      "Median of " +
        count +
        " compatible prior same-season annual observations; sort their values and use the middle value, or the mean of the two middle values. The current observation is excluded.",
      (...values) => {
        values.sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        return values.length % 2
          ? values[middle]
          : (values[middle - 1] + values[middle]) / 2;
      },
    );
    median.note =
      "A descriptive historical summary, not a reported value for the selected period, a forecast, or a risk threshold. Each prior observation has equal weight.";
    position =
      current.value < low.point.value
        ? "Below the observed prior range"
        : current.value > high.point.value
          ? "Above the observed prior range"
          : "Within the observed prior range";
  }
  return {
    definition,
    current,
    period,
    limit,
    rows,
    count,
    checked: rows.length,
    excluded: rows.length - count,
    currentReason,
    boundaryReason,
    summaryReason,
    median,
    low,
    high,
    position,
  };
}
