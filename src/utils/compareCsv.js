import { normalizeCompareSettings } from "./compareSettings.js";

const cell = (value) => {
  const text = String(value ?? "");
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
};

/** Export original inputs directly, without capturing a notebook or snapshot.
 * @param {Array<{cell: any, metric: any}>} observations
 * @param {{tickers?: string[], settings?: any}} options
 */
export function exportCompareTableCsv(observations, { tickers = [], settings = {} } = {}) {
  const setup = normalizeCompareSettings(settings);
  const columns = [
    "requested_peers", "excluded_peers", "ticker", "company", "cik", "metric",
    "value", "format", "basis", "period_start", "period_end", "classification",
    "formula", "missing_reason", "benchmark", "benchmark_delta", "numeric_rank",
    "settings", "source_tag", "source_value", "source_unit", "source_start",
    "source_end", "source_filed", "source_accession", "source_url",
  ];
  const rows = observations.flatMap(({ cell: observation, metric }) => {
    const point = observation.point;
    const period = point?.period || observation.period;
    return (point?.sources?.length ? point.sources : [{}]).map((source) => [
      tickers.join(", "), setup.excluded.join(", "), observation.ticker,
      observation.name, observation.cik, metric.label, point?.value, metric.format,
      period?.kind || setup.basis, period?.start, period?.end, point?.classification,
      point?.formula, point?.reason || (point?.value == null ? observation.status : ""),
      setup.benchmark, observation.delta, observation.rank, JSON.stringify(setup),
      source.tag, source.value, source.unit, source.start, source.end, source.filed,
      source.accession, source.documentUrl,
    ]);
  });
  return "\uFEFF" + [columns, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}
