import {
  METRIC_BY_KEY,
  COMPARE_VERSION,
  MAX_COMPARE_COMPANIES,
} from "./compareResearch.js";
import { validTicker } from "./researchWorkspace.js";

export const COMPARE_STORAGE_KEY = "edgar:compare-notebook:v1";
export const DEFAULT_COMPARE_SETTINGS = {
  basis: "annual",
  alignment: "common",
  period: "latest",
  asOf: "",
  lens: "auto",
  benchmark: "median",
  metrics: [],
  excluded: [],
  view: "table",
  metric: "roe",
  x: "equityAssets",
  y: "roa",
  years: 5,
  mode: "absolute",
  sort: "peers",
  descending: true,
};
export function normalizeCompareTickers(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/))
        .map((v) => String(v).trim().toUpperCase())
        .filter(validTicker),
    ),
  ].slice(0, MAX_COMPARE_COMPANIES);
}
export function normalizeCompareSettings(input = {}) {
  const choose = (key, options) =>
    options.includes(input[key]) ? input[key] : DEFAULT_COMPARE_SETTINGS[key];
  const metric = (key) =>
    METRIC_BY_KEY[input[key]] ? input[key] : DEFAULT_COMPARE_SETTINGS[key];
  const date = String(input.asOf || "");
  const validDate =
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date &&
    date <= new Date().toISOString().slice(0, 10);
  return {
    basis: choose("basis", ["annual", "quarter", "ttm"]),
    alignment: choose("alignment", ["common", "latest"]),
    period: /^(19|20)\d{2}(-Q[1-4])?$/.test(input.period || "")
      ? input.period
      : "latest",
    asOf: validDate ? date : "",
    lens: choose("lens", [
      "auto",
      "common",
      "banking",
      "corporate",
      "insurance",
    ]),
    benchmark: validTicker(input.benchmark || "") ? input.benchmark : "median",
    metrics: [
      ...new Set(
        (Array.isArray(input.metrics)
          ? input.metrics
          : String(input.metrics || "").split(",")
        ).filter((key) => METRIC_BY_KEY[key]),
      ),
    ],
    excluded: normalizeCompareTickers(input.excluded),
    view: choose("view", ["table", "trends", "map", "notebook"]),
    metric: metric("metric"),
    x: metric("x"),
    y: metric("y"),
    years: [3, 5, 10].includes(Number(input.years)) ? Number(input.years) : 5,
    mode: choose("mode", ["absolute", "indexed"]),
    sort:
      input.sort === "peers" || METRIC_BY_KEY[input.sort]
        ? input.sort
        : "peers",
    descending: input.descending !== false && input.descending !== "false",
  };
}
export function readCompareUrl(search) {
  return normalizeCompareSettings(
    Object.fromEntries(new URLSearchParams(search)),
  );
}
export function comparePath(tickers, settings) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(
    normalizeCompareSettings(settings),
  )) {
    if (JSON.stringify(value) !== JSON.stringify(DEFAULT_COMPARE_SETTINGS[key]))
      params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const peers = normalizeCompareTickers(tickers);
  return `/compare${peers.length ? `/${peers.join(",")}` : ""}${params.size ? `?${params}` : ""}`;
}
export const emptyCompareNotebook = () => ({
  version: 1,
  searches: [],
  collectionName: "Peer comparison research",
  notes: "",
  pins: [],
});
export function parseCompareNotebook(raw) {
  if (!raw) return emptyCompareNotebook();
  const data = JSON.parse(raw);
  if (
    data?.version !== 1 ||
    !Array.isArray(data.searches) ||
    !Array.isArray(data.pins)
  )
    throw new Error(
      "Saved comparison data could not be read. Existing data has been preserved.",
    );
  return data;
}
export function writeCompareNotebook(storage, update) {
  const result = update(
    parseCompareNotebook(storage.getItem(COMPARE_STORAGE_KEY)),
  );
  storage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(result));
  return result;
}
export function comparisonPin(cell, metric, settings) {
  return {
    id: `${cell.cik}:${metric.key}:${cell.period.end}:${cell.period.kind}:${settings.asOf || "latest"}:${cell.point?.value}:${[...new Set((cell.point?.sources || []).map((s) => s.accession))].sort().join("-")}`,
    ticker: cell.ticker,
    cik: cell.cik,
    name: cell.name,
    metric: metric.key,
    label: metric.label,
    format: metric.format,
    point: cell.point,
    settings: normalizeCompareSettings(settings),
    version: COMPARE_VERSION,
    savedAt: new Date().toISOString(),
    notes: "",
    tags: "",
  };
}
const escapeHtml = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const csvCell = (v) => {
  const s = String(v ?? "");
  return `"${(/^[\s]*[=+@-]/.test(s) ? "'" : "") + s.replaceAll('"', '""')}"`;
};
export function exportCompareCsv(
  pins,
  { collectionName = "", notes = "" } = {},
) {
  const columns = [
    "collection",
    "collection_notes",
    "ticker",
    "company",
    "cik",
    "metric",
    "value",
    "format",
    "basis",
    "period_start",
    "period_end",
    "classification",
    "formula",
    "missing_reason",
    "notes",
    "tags",
    "saved_at",
    "settings",
    "source_tag",
    "source_value",
    "source_unit",
    "source_start",
    "source_end",
    "source_filed",
    "source_accession",
    "source_url",
  ];
  const rows = pins.flatMap((pin) =>
    (pin.point?.sources?.length ? pin.point.sources : [{}]).map((source) => [
      collectionName,
      notes,
      pin.ticker,
      pin.name,
      pin.cik,
      pin.label,
      pin.point?.value,
      pin.format,
      pin.point?.period?.kind,
      pin.point?.period?.start,
      pin.point?.period?.end,
      pin.point?.classification,
      pin.point?.formula,
      pin.point?.reason,
      pin.notes,
      pin.tags,
      pin.savedAt,
      JSON.stringify(pin.settings),
      source.tag,
      source.value,
      source.unit,
      source.start,
      source.end,
      source.filed,
      source.accession,
      source.documentUrl,
    ]),
  );
  return (
    "\uFEFF" +
    [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")
  );
}
export function exportCompareBrief(notebook) {
  const e = escapeHtml;
  const source = (s) =>
    `<li>${e(s.tag)}: ${e(s.value)} ${e(s.unit)} · ${e(s.start || "Balance at")} to ${e(s.end)} · Filed ${e(s.filed)} · ${e(s.accession)} ${/^https:\/\/www\.sec\.gov\//.test(s.documentUrl || "") ? `<a href="${e(s.documentUrl)}">SEC filing</a>` : ""}</li>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(notebook.collectionName)}</title><style>body{max-width:960px;margin:48px auto;padding:0 24px;font:15px/1.65 system-ui;color:#172b40}h1{font-size:34px}article{border-top:1px solid #bbc9d5;margin-top:30px;padding-top:15px;break-inside:avoid}p,pre{white-space:pre-wrap;overflow-wrap:anywhere}pre{background:#f1f5f9;padding:12px;font-size:12px}a{color:#096187}small{color:#4b647c}@media print{body{margin:0}}</style><h1>${e(notebook.collectionName)}</h1><p>EDGAR Terminal · Peer comparison research · ${e(new Date().toISOString())}</p><p>${e(notebook.notes)}</p><small>USD source data. Values may incorporate subsequent comparative revisions within the filing cutoff. Peer ranks describe numeric order, not credit quality. Sources and calculation inputs are preserved below.</small>${notebook.pins.map((p) => `<article><h2>${e(p.ticker)} · ${e(p.label)}</h2><p>${e(p.name)} · CIK ${e(p.cik)}<br>${e(p.point?.value ?? "Unavailable")} ${e(p.format === "currency" ? "USD" : p.format === "percent" ? "%" : "x")} · ${e(p.point?.period?.kind)} · ${e(p.point?.period?.start || "Balance at")} to ${e(p.point?.period?.end)}</p><p>${e(p.point?.formula || p.point?.reason || "Reported SEC fact")}<br>${e(p.point?.note || "")}</p><p>Notes: ${e(p.notes || "None")}<br>Tags: ${e(p.tags || "None")}<br>Saved ${e(p.savedAt)}</p><ul>${(p.point?.sources || []).map(source).join("")}</ul><h3>Comparison settings</h3><pre>${e(JSON.stringify(p.settings, null, 2))}</pre></article>`).join("")}</html>`;
}
