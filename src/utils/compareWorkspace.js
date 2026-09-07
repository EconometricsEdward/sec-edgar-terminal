import { validTicker } from "./researchWorkspace.js";
import { MAX_COMPARE_COMPANIES } from "./compareLimits.js";

/** Validate the entire paste before applying it; never silently lose peers. */
export function planComparePeers(
  current,
  input,
  mode = "append",
  limit = MAX_COMPARE_COMPANIES,
) {
  const tokens = (
    Array.isArray(input) ? input : String(input || "").split(/[\s,;]+/)
  )
    .map((value) => String(value).trim().toUpperCase())
    .filter(Boolean);
  const invalid = tokens.filter((value) => !validTicker(value));
  if (invalid.length)
    return {
      error: `Invalid ticker${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}. Choose a company suggestion or paste ticker symbols.`,
      tickers: current,
    };
  if (!tokens.length)
    return {
      error: "Enter a ticker or choose a company suggestion.",
      tickers: current,
    };
  const tickers = [
    ...new Set([...(mode === "append" ? current : []), ...tokens]),
  ];
  if (tickers.length > limit)
    return {
      error: `This workspace supports ${limit} companies; this selection contains ${tickers.length}. Remove ${tickers.length - limit} before adding it.`,
      tickers: current,
    };
  return { error: null, tickers };
}

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const check = (ok, message) => {
  if (!ok)
    throw new Error(
      `Saved comparison ${message}. Existing data has been preserved.`,
    );
};
const text = (value, max) =>
  value == null || (typeof value === "string" && value.length <= max);
const list = (value, max) => Array.isArray(value) && value.length <= max;
const date = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
function point(value) {
  check(object(value), "observation is invalid");
  check(
    value.value == null || Number.isFinite(value.value),
    "value is invalid",
  );
  check(
    object(value.period) &&
      text(value.period.start, 30) &&
      text(value.period.end, 30) &&
      text(value.period.kind, 30),
    "reporting period is invalid",
  );
  check(
    value.sources === undefined ||
      (list(value.sources, 200) && value.sources.every(object)),
    "sources are invalid",
  );
  check(
    value.calculations === undefined || list(value.calculations, 200),
    "calculations are invalid",
  );
}
export function validateCompareWorkspace(data) {
  check(
    object(data) &&
      data.version === 1 &&
      list(data.searches, 50) &&
      list(data.pins, 100),
    "notebook is invalid",
  );
  check(
    text(data.collectionName, 120) && text(data.notes, 16000),
    "collection text is too long or invalid",
  );
  for (const item of data.searches) {
    check(
      object(item) &&
        typeof item.id === "string" &&
        text(item.name, 160) &&
        date(item.savedAt) &&
        list(item.tickers, 12) &&
        item.tickers.every(validTicker) &&
        object(item.settings),
      "saved setup is invalid",
    );
  }
  for (const pin of data.pins) {
    check(
      object(pin) &&
        typeof pin.id === "string" &&
        validTicker(pin.ticker) &&
        text(pin.metric, 100) &&
        typeof pin.label === "string" &&
        date(pin.savedAt) &&
        object(pin.settings),
      "evidence metadata is invalid",
    );
    check(
      text(pin.notes, 8000) && text(pin.tags, 300),
      "evidence annotations are too long or invalid",
    );
    point(pin.point);
  }
  if (data.brief !== undefined) {
    const b = data.brief;
    check(
      object(b) &&
        text(b.title, 160) &&
        text(b.researchQuestion, 3000) &&
        text(b.narrative, 12000) &&
        text(b.conclusions, 12000) &&
        [undefined, "order", "company", "metric"].includes(b.groupBy),
      "brief is invalid",
    );
  }
  if (data.snapshots !== undefined) {
    check(list(data.snapshots, 8), "snapshot limit is eight");
    for (const snapshot of data.snapshots) {
      check(
        object(snapshot) &&
          snapshot.version === 1 &&
          typeof snapshot.id === "string" &&
          text(snapshot.name, 160) &&
          date(snapshot.capturedAt) &&
          object(snapshot.settings),
        "snapshot metadata is invalid",
      );
      check(
        list(snapshot.tickers, 12) &&
          snapshot.tickers.every(validTicker) &&
          list(snapshot.metrics, 40) &&
          snapshot.metrics.every(object) &&
          list(snapshot.companies, 12),
        "snapshot membership is invalid",
      );
      check(
        new TextEncoder().encode(JSON.stringify(snapshot)).length <= 1250000,
        "snapshot is too large",
      );
      for (const company of snapshot.companies) {
        check(
          object(company) &&
            validTicker(company.ticker) &&
            list(company.observations, 40),
          "snapshot company is invalid",
        );
        for (const observation of company.observations) {
          check(
            object(observation) && typeof observation.metric === "string",
            "snapshot observation is invalid",
          );
          if (observation.point != null) point(observation.point);
        }
      }
    }
  }
  return data;
}
