import { FUND_CATALOG } from "./fundResearch.js";
import {
  normalizeFundWorkspaceSettings,
  validFundTicker,
} from "./fundWorkspaceSettings.js";
export const fundSnapshotKey = (ticker, reportMap = {}) =>
  `${ticker}:${reportMap[ticker] || "latest"}`;
export function fundUniverse(
  saved = [],
  selected = [],
  states = {},
  reportMap = {},
) {
  const catalog = new Map(FUND_CATALOG.map((fund) => [fund.ticker, fund]));
  for (const ticker of [...saved, ...selected].filter(validFundTicker))
    if (!catalog.has(ticker)) {
      const data = states[fundSnapshotKey(ticker, reportMap)]?.data;
      catalog.set(ticker, {
        ticker,
        name: data?.name || ticker,
        family: data?.family || data?.registrant || "Not yet loaded",
        category: "Other fund",
        focus: "Added to your research",
        curated: false,
      });
    }
  return [...catalog.values()].map((fund) => ({
    ...fund,
    curated: fund.curated !== false,
    state: states[fundSnapshotKey(fund.ticker, reportMap)] || {
      status: "idle",
    },
  }));
}
export function fundSnapshotFacts(
  state,
  now = new Date().toISOString().slice(0, 10),
) {
  const fund = state?.data;
  if (state?.status !== "ready" || fund?.status !== "ready") return null;
  const age = /^\d{4}-\d{2}-\d{2}$/.test(fund.asOf || "")
    ? Math.floor((Date.parse(now) - Date.parse(fund.asOf)) / 86400000)
    : null;
  const finite = (value) => (Number.isFinite(value) ? value : null);
  return {
    netAssets: finite(fund.fundInfo?.netAssets),
    concentration: finite(fund.summary?.top10Weight),
    positions: finite(fund.summary?.count),
    age: Number.isFinite(age) && age >= 0 ? age : null,
    asOf: fund.asOf,
    filingDate: fund.filingDate,
    knownWeights: finite(fund.summary?.weightCount),
    knownValues: finite(fund.summary?.valuedCount),
    weightTotal: finite(fund.summary?.weightTotal),
  };
}
export function fundScreenErrors(settings) {
  const errors = {};
  for (const [key, label] of [
    ["minAssets", "Minimum net assets"],
    ["maxConcentration", "Maximum top-10 weight"],
    ["maxAge", "Maximum portfolio age"],
  ]) {
    if (settings[key] === "") continue;
    const value = Number(settings[key]);
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (key === "minAssets" && !Number.isFinite(value * 1e9))
    )
      errors[key] = `${label} needs a complete, nonnegative number.`;
  }
  return errors;
}
export function screenFunds(universe, input, saved = [], now) {
  const settings = normalizeFundWorkspaceSettings(input),
    errors = fundScreenErrors(settings);
  const query = settings.query.trim().toLowerCase();
  const candidates = universe.filter(
    (fund) =>
      (settings.category === "All funds" ||
        (settings.category === "Saved funds"
          ? saved.includes(fund.ticker)
          : fund.category === settings.category)) &&
      (!settings.family || fund.family === settings.family) &&
      `${fund.ticker} ${fund.name} ${fund.family} ${fund.focus}`
        .toLowerCase()
        .includes(query),
  );
  const rows = candidates
    .filter((fund) => {
      const facts = fundSnapshotFacts(fund.state, now);
      if (settings.coverage === "ready" && !facts) return false;
      if (
        settings.coverage === "missing" &&
        !["error", "unavailable"].includes(fund.state.status)
      )
        return false;
      if (
        settings.coverage === "unloaded" &&
        !["idle", "cancelled"].includes(fund.state.status)
      )
        return false;
      for (const [key, metric, factor, direction] of [
        ["minAssets", "netAssets", 1e9, "min"],
        ["maxConcentration", "concentration", 1, "max"],
        ["maxAge", "age", 1, "max"],
      ]) {
        if (settings[key] === "" || errors[key]) continue;
        if (!facts || !Number.isFinite(facts[metric])) return false;
        const limit = Number(settings[key]) * factor;
        if (direction === "min" ? facts[metric] < limit : facts[metric] > limit)
          return false;
      }
      return true;
    })
    .sort((a, b) => {
      const key = settings.sort,
        text = key === "ticker" || key === "name";
      const av = text ? a[key] : fundSnapshotFacts(a.state, now)?.[key],
        bv = text ? b[key] : fundSnapshotFacts(b.state, now)?.[key];
      if (av == null) return bv == null ? a.ticker.localeCompare(b.ticker) : 1;
      if (bv == null) return -1;
      const diff = text ? av.localeCompare(bv) : av - bv;
      return (
        diff * (settings.direction === "asc" ? 1 : -1) ||
        a.ticker.localeCompare(b.ticker)
      );
    });
  return {
    rows,
    candidates,
    errors,
    ready: candidates.filter((fund) => fundSnapshotFacts(fund.state, now))
      .length,
    failed: candidates.filter((fund) =>
      ["error", "unavailable"].includes(fund.state.status),
    ).length,
  };
}
const csv = (value) =>
  `"${(typeof value === "number" ? String(value) : String(value ?? "").replace(/^[=+@-]/, "'$&")).replaceAll('"', '""')}"`;
export function fundScreenerCsv(
  rows,
  settings,
  exportedAt = new Date().toISOString(),
) {
  const header = [
    "Ticker",
    "Name",
    "Category",
    "Family",
    "Load status",
    "Portfolio date",
    "Filing date",
    "Net assets USD",
    "Top 10 position weight percent NAV",
    "Reported positions",
    "Positions with weights",
    "Positions with values",
    "Portfolio age days",
    "SEC series",
    "Accession",
    "SEC source",
    "Status or reason",
    "Screen settings",
    "Exported at",
  ];
  return (
    "\uFEFF" +
    [
      header,
      ...rows.map((fund) => {
        const facts = fundSnapshotFacts(fund.state, exportedAt.slice(0, 10)),
          data = fund.state.data;
        return [
          fund.ticker,
          fund.name,
          fund.category,
          fund.family,
          fund.state.status,
          facts?.asOf,
          facts?.filingDate,
          facts?.netAssets,
          facts?.concentration,
          facts?.positions,
          facts?.knownWeights,
          facts?.knownValues,
          facts?.age,
          data?.seriesId,
          data?.accession,
          data?.sourceUrl,
          fund.state.error ||
            data?.reason ||
            "Historical series-level portfolio; net assets may include multiple share classes.",
          JSON.stringify(normalizeFundWorkspaceSettings(settings)),
          exportedAt,
        ];
      }),
    ]
      .map((row) => row.map(csv).join(","))
      .join("\r\n")
  );
}
