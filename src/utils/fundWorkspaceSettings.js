export const FUND_WORKSPACE_DEFAULTS = {
  view: "discover",
  query: "",
  category: "All funds",
  family: "",
  sort: "ticker",
  direction: "asc",
  layout: "table",
  coverage: "all",
  minAssets: "",
  maxConcentration: "",
  maxAge: "",
  tickers: [],
  reportMap: {},
  allocations: {},
  securityQuery: "",
  securityAsset: "",
  securityCountry: "",
  comparisonLeft: "",
  comparisonRight: "",
  comparisonScope: "all",
  comparisonQuery: "",
  changeTicker: "",
  changeBefore: "",
  changeAfter: "",
  changeScope: "all",
  changeQuery: "",
  board: "",
};
export const validFundTicker = (ticker) =>
  typeof ticker === "string" && /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker);
const accession = (value) =>
  typeof value === "string" && /^\d{10}-\d{2}-\d{6}$/.test(value);
const choices = {
  view: ["discover", "security", "compare", "allocation", "changes", "boards"],
  category: [
    "All funds",
    "US equity",
    "International",
    "Fixed income",
    "Saved funds",
  ],
  sort: ["ticker", "name", "netAssets", "concentration", "positions", "age"],
  direction: ["asc", "desc"],
  layout: ["table", "cards"],
  coverage: ["all", "ready", "missing", "unloaded"],
  comparisonScope: ["all", "shared", "left", "right"],
  changeScope: ["all", "added", "removed", "changed"],
};
const draft = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string" &&
        value.length <= 60 &&
        /^[+-]?(?:\d*(?:\.\d*)?)(?:[eE][+-]?\d*)?$/.test(value)
      ? value
      : "";
export function normalizeFundWorkspaceSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const out = { ...FUND_WORKSPACE_DEFAULTS };
  for (const [key, values] of Object.entries(choices))
    if (values.includes(source[key])) out[key] = source[key];
  for (const key of [
    "query",
    "family",
    "securityQuery",
    "securityAsset",
    "securityCountry",
    "comparisonQuery",
    "changeQuery",
  ])
    out[key] = typeof source[key] === "string" ? source[key].slice(0, 100) : "";
  const requested = Array.isArray(source.tickers) ? source.tickers : [];
  out.tickers = [
    ...new Set(
      requested
        .map((value) =>
          typeof value === "string" ? value.trim().toUpperCase() : "",
        )
        .filter(validFundTicker),
    ),
  ].slice(0, 4);
  out.reportMap = {};
  out.allocations = {};
  for (const ticker of out.tickers) {
    if (accession(source.reportMap?.[ticker]))
      out.reportMap[ticker] = source.reportMap[ticker];
    if (source.allocations && Object.hasOwn(source.allocations, ticker))
      out.allocations[ticker] = draft(source.allocations[ticker]);
  }
  for (const key of ["comparisonLeft", "comparisonRight", "changeTicker"])
    out[key] = out.tickers.includes(source[key]) ? source[key] : "";
  for (const key of ["changeBefore", "changeAfter"])
    out[key] = accession(source[key]) ? source[key] : "";
  for (const key of ["minAssets", "maxConcentration", "maxAge"])
    out[key] = draft(source[key]);
  out.board =
    typeof source.board === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(source.board)
      ? source.board
      : "";
  return out;
}
export function readFundWorkspaceSettings(search) {
  const p = new URLSearchParams(search),
    input = Object.fromEntries(p);
  input.query = p.get("q") ?? p.get("query") ?? "";
  input.tickers = (p.get("tickers") || p.get("compare") || "").split(",");
  for (const key of ["reportMap", "allocations"]) {
    try {
      input[key] = JSON.parse(p.get(key) || "{}");
    } catch {
      input[key] = {};
    }
  }
  if (!p.has("view") && p.has("compare")) input.view = "compare";
  return normalizeFundWorkspaceSettings(input);
}
export function fundWorkspacePath(input = {}) {
  const settings = normalizeFundWorkspaceSettings(input),
    p = new URLSearchParams();
  for (const [key, value] of Object.entries(settings)) {
    if (JSON.stringify(value) === JSON.stringify(FUND_WORKSPACE_DEFAULTS[key]))
      continue;
    p.set(
      key === "query" ? "q" : key,
      Array.isArray(value)
        ? value.join(",")
        : value && typeof value === "object"
          ? JSON.stringify(value)
          : String(value),
    );
  }
  return `/fund${p.size ? `?${p}` : ""}`;
}
