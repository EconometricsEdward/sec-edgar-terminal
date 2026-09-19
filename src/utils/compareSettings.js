import { METRIC_BY_KEY, MAX_COMPARE_COMPANIES } from "./compareResearch.js";
import { DEFAULT_COMPARE_FORMULA, normalizeCompareFormula } from "./compareFormula.js";
import { validTicker } from "./researchWorkspace.js";

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
  focus: "",
  tableMode: "reported",
  changeMode: "periods",
  movementFrom: "previous",
  movementMetric: "netIncome",
  commonSize: "balance",
  ...DEFAULT_COMPARE_FORMULA,
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
    benchmark:
      input.benchmark === "peers"
        ? "peers"
        : validTicker(input.benchmark || "")
          ? input.benchmark
          : "median",
    metrics: [
      ...new Set(
        (Array.isArray(input.metrics)
          ? input.metrics
          : String(input.metrics || "").split(",")
        ).filter((key) => METRIC_BY_KEY[key]),
      ),
    ],
    excluded: normalizeCompareTickers(input.excluded),
    view: choose("view", ["table", "trends", "map"]),
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
    focus: validTicker(input.focus || "") ? input.focus : "",
    // Older links opened period changes as a separate page. Keep the tool and
    // its selected inputs while moving it under the main comparison view.
    tableMode:
      input.view === "changes"
        ? "changes"
        : choose("tableMode", ["reported", "common-size", "formula", "changes"]),
    changeMode: "periods",
    movementFrom: /^(19|20)\d{2}(-Q[1-4])?$/.test(input.movementFrom || "")
      ? input.movementFrom
      : "previous",
    movementMetric: metric("movementMetric"),
    commonSize: choose("commonSize", ["balance", "income"]),
    ...normalizeCompareFormula(input),
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
