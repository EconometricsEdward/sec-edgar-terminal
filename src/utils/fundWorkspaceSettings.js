export const FUND_WORKSPACE_DEFAULTS = {
  view: "discover",
  query: "",
  category: "All funds",
  family: "",
  sort: "ticker",
  direction: "asc",
  layout: "cards",
  coverage: "all",
  minAssets: "",
  maxConcentration: "",
  maxAge: "",
  tickers: [],
  reportMap: {},
  allocations: {},
  securityQuery: "",
  securityScope: "all",
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
  managerCik: "",
  managerPeriod: "",
  managerView: "overview",
  managerCompare: [],
  managerComparePeriod: "",
};
export const validFundTicker = (ticker) =>
  typeof ticker === "string" && /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker) && !/^\d+$/.test(ticker);
const accession = (value) =>
  typeof value === "string" && /^\d{10}-\d{2}-\d{6}$/.test(value);
const choices = {
  view: ["discover", "security", "compare", "allocation", "changes", "13f"],
  managerView: ["overview", "holdings", "changes", "history", "markets", "filings", "compare"],
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
  securityScope: ["all", "selected"],
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
  const cik = typeof source.managerCik === "string" ? source.managerCik.trim() : "";
  out.managerCik = /^\d{1,10}$/.test(cik) && Number(cik) > 0 ? cik.padStart(10, "0") : "";
  const period = typeof source.managerPeriod === "string" ? source.managerPeriod : "";
  out.managerPeriod = out.managerCik && /^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(period) ? period : "";
  out.managerCompare = [...new Set((Array.isArray(source.managerCompare) ? source.managerCompare : [])
    .filter(value => typeof value === "string" && /^\d{1,10}$/.test(value.trim()) && Number(value) > 0)
    .map(value => value.trim().padStart(10, "0")))].slice(0, 4);
  out.managerComparePeriod = typeof source.managerComparePeriod === "string" && /^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(source.managerComparePeriod) ? source.managerComparePeriod : "";
  if (!out.managerCik && out.managerView !== "compare") out.managerView = "overview";
  return out;
}
export function readFundWorkspaceSettings(search) {
  const p = new URLSearchParams(search),
    input = Object.fromEntries(p);
  if (["view", "managerCik", "managerPeriod", "managerView", "managerCompare", "managerComparePeriod"].some(key => p.getAll(key).length > 1)) {
    input.managerCik = "";
    input.managerPeriod = "";
    input.managerView = "overview";
    input.managerComparePeriod = "";
    if (p.getAll("view").length > 1) input.view = "discover";
  }
  input.query = p.get("q") ?? p.get("query") ?? "";
  input.tickers = (p.get("tickers") || p.get("compare") || "").split(",");
  input.managerCompare = p.getAll("managerCompare").length <= 1 ? (p.get("managerCompare") || "").split(",") : [];
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
