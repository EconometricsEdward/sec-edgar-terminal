import { computeCompareFormula } from "./compareFormula.js";
import {
  normalizeCompareSettings,
  normalizeCompareTickers,
} from "./compareNotebook.js";
import {
  compareCanonical,
  comparisonSourceFingerprint,
} from "./compareEvidenceLinks.js";

export const MAX_COMPARE_SNAPSHOTS = 8;
export const MAX_COMPARE_SNAPSHOT_BYTES = 1_250_000;
const copy = (value) =>
  value == null ? null : JSON.parse(JSON.stringify(value));
const statusFor = (entry) =>
  entry.error
    ? "fetch failed"
    : entry.loading
      ? "loading"
      : entry.period
        ? "reviewed"
        : "period unavailable";
const definition = (metric) =>
  Object.fromEntries(
    [
      "key",
      "label",
      "format",
      "category",
      "formula",
      "inputs",
      "customFormula",
      "formulaSettings",
      "definition",
    ]
      .filter((key) => metric[key] !== undefined)
      .map((key) => [key, copy(metric[key])]),
  );
const issuerId = (company) =>
  company.cik
    ? `cik:${String(company.cik).replace(/^0+/, "")}`
    : `ticker:${company.ticker}`;
const metricIdentity = (metric) =>
  compareCanonical({
    key: metric?.key,
    format: metric?.format,
    formula: metric?.formula,
    inputs: metric?.inputs,
    customFormula: metric?.customFormula,
    formulaSettings: metric?.formulaSettings,
  });
// Revised values can be compared only when their reported concepts, units,
// durations and calculation definitions still describe the same observation.
const inputScope = (point) =>
  compareCanonical({
    formula: point?.formula || "",
    sources: (point?.sources || [])
      .map((source) =>
        compareCanonical({
          taxonomy: source.taxonomy || "",
          tag: source.tag || "",
          unit: source.unit || "",
          start: source.start || "",
          end: source.end || "",
          formula: source.formula || "",
        }),
      )
      .sort(),
    calculations: (point?.calculations || [])
      .map((calculation) =>
        compareCanonical({
          formula: calculation.formula || "",
          unit: calculation.unit || "",
          start: calculation.start || "",
          end: calculation.end || "",
        }),
      )
      .sort(),
  });
const pointPeriod = (observation, company) =>
  observation?.point?.period || company?.period || null;
const samePeriod = (a, b) =>
  !!a?.end &&
  !!b?.end &&
  a.end === b.end &&
  (a.start || "") === (b.start || "") &&
  a.kind === b.kind;
export function createCompareSnapshot(
  { name, metrics, entries, settings, tickers },
  now = new Date().toISOString(),
) {
  const title = String(name || "").trim();
  if (!title || title.length > 160)
    throw new Error("Give this snapshot a name of 1–160 characters.");
  if (!Array.isArray(metrics) || !metrics.length || metrics.length > 40)
    throw new Error(
      "Choose between 1 and 40 metrics before capturing a snapshot.",
    );
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > 12 ||
    entries.some((entry) => entry.loading)
  )
    throw new Error(
      "Wait until all selected companies finish loading before capturing a snapshot.",
    );
  if (!Number.isFinite(Date.parse(now)))
    throw new Error("The snapshot capture time is invalid.");
  const seen = new Set();
  const companies = entries.map((entry) => {
    const company = {
      ticker: entry.ticker,
      cik: entry.data?.cik || "",
      name: entry.data?.name || entry.ticker,
      status: statusFor(entry),
      period: copy(entry.period),
      observations: metrics.map((metric) => ({
        metric: metric.key,
        point: copy(
          metric.key === "customFormula"
            ? computeCompareFormula(entry, settings)
            : entry.index >= 0
              ? entry.data?.metrics?.[metric.key]?.[entry.index]
              : null,
        ),
        status: statusFor(entry),
      })),
    };
    const id = issuerId(company);
    if (seen.has(id))
      throw new Error(
        "Resolve duplicate issuer identities before capturing a snapshot.",
      );
    seen.add(id);
    return company;
  });
  const snapshot = {
    id: `snapshot-${now}-${comparisonSourceFingerprint({ companies, name: title })}`,
    name: title,
    capturedAt: now,
    version: 1,
    settings: normalizeCompareSettings(settings),
    tickers: normalizeCompareTickers(tickers),
    metrics: metrics.map(definition),
    companies,
  };
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
    MAX_COMPARE_SNAPSHOT_BYTES
  )
    throw new Error(
      "This snapshot exceeds 1.25 MB of source evidence. Select fewer metrics and try again.",
    );
  return snapshot;
}
const evidenceFor = (company, observation, metric, settings, snapshot) =>
  company && metric
    ? {
        cell: {
          ticker: company.ticker,
          cik: company.cik,
          name: company.name,
          period: pointPeriod(observation, company),
          point: observation?.point || null,
          status: observation?.status || company.status,
        },
        metric,
        settings: copy(settings),
        ...(snapshot
          ? { capturedAt: snapshot.capturedAt, snapshotName: snapshot.name }
          : {}),
      }
    : null;
export const SNAPSHOT_STATUS_LABELS = {
  "value-changed": "Value changed",
  "inputs-changed": "Source or calculation changed",
  "period-changed": "Different reporting period",
  "definition-changed": "Metric definition changed",
  recovered: "Coverage recovered",
  missing: "Coverage missing",
  unavailable: "Still unavailable",
  unchanged: "Unchanged",
  "company-added": "Company added",
  "company-removed": "Company removed",
  "metric-added": "Metric added",
  "metric-removed": "Metric removed",
  loading: "Still loading",
};
export function compareSnapshot(snapshot, current) {
  const present = createCompareSnapshot({
    ...current,
    name: "Current comparison",
    entries: current.entries.map((entry) => ({ ...entry, loading: false })),
  });
  const currentLoading = new Set(
    current.entries
      .filter((entry) => entry.loading)
      .map((entry) => entry.ticker),
  );
  const counterpartId = (company, peers) =>
    company.cik
      ? issuerId(company)
      : issuerId(
          peers.find((peer) => peer.ticker === company.ticker) || company,
        );
  const oldCompanies = new Map(
    snapshot.companies.map((company) => [
      counterpartId(company, present.companies),
      company,
    ]),
  );
  const nowCompanies = new Map(
    present.companies.map((company) => [
      counterpartId(company, snapshot.companies),
      company,
    ]),
  );
  const oldMetrics = new Map(
    snapshot.metrics.map((metric) => [metric.key, metric]),
  );
  const nowMetrics = new Map(
    present.metrics.map((metric) => [metric.key, metric]),
  );
  const companyIds = [
    ...new Set([...oldCompanies.keys(), ...nowCompanies.keys()]),
  ];
  const metricIds = [...new Set([...oldMetrics.keys(), ...nowMetrics.keys()])];
  const rows = companyIds.flatMap((id) =>
    metricIds.map((key) => {
      const oldCompany = oldCompanies.get(id),
        nowCompany = nowCompanies.get(id),
        oldMetric = oldMetrics.get(key),
        nowMetric = nowMetrics.get(key);
      const old = oldCompany?.observations.find(
          (observation) => observation.metric === key,
        ),
        latest = nowCompany?.observations.find(
          (observation) => observation.metric === key,
        );
      const prior = evidenceFor(
          oldCompany,
          old,
          oldMetric,
          snapshot.settings,
          snapshot,
        ),
        currentEvidence = evidenceFor(
          nowCompany,
          latest,
          nowMetric,
          present.settings,
        );
      const priorPeriod = pointPeriod(old, oldCompany),
        currentPeriod = pointPeriod(latest, nowCompany);
      const oldAvailable = Number.isFinite(old?.point?.value),
        nowAvailable = Number.isFinite(latest?.point?.value);
      let status,
        detail = "",
        delta = null;
      if (currentLoading.has((nowCompany || oldCompany).ticker)) {
        status = "loading";
        detail = "Waiting for the current company response.";
      } else if (!oldCompany) {
        status = "company-added";
        detail = "This issuer was not included in the saved snapshot.";
      } else if (!nowCompany) {
        status = "company-removed";
        detail = "This issuer is not included in the current comparison.";
      } else if (!oldMetric) {
        status = "metric-added";
        detail = "This metric was not captured in the saved snapshot.";
      } else if (!nowMetric) {
        status = "metric-removed";
        detail = "This metric is not selected in the current comparison.";
      } else if (metricIdentity(oldMetric) !== metricIdentity(nowMetric)) {
        status = "definition-changed";
        detail =
          "The formula or units differ; a value difference is not calculated.";
      } else if (
        priorPeriod &&
        currentPeriod &&
        !samePeriod(priorPeriod, currentPeriod)
      ) {
        status = "period-changed";
        detail =
          "Reporting start, end and basis must all match before a value difference is calculated.";
      } else if (!oldAvailable && nowAvailable) {
        status = "recovered";
        detail =
          old?.point?.reason ||
          old?.status ||
          "A previously missing observation is now available.";
      } else if (oldAvailable && !nowAvailable) {
        status = "missing";
        detail =
          latest?.point?.reason ||
          nowCompany.status ||
          "The current value is unavailable.";
      } else if (!oldAvailable && !nowAvailable) {
        status = "unavailable";
        detail = latest?.point?.reason || nowCompany.status;
      } else if (!samePeriod(priorPeriod, currentPeriod)) {
        status = "period-changed";
        detail =
          "A complete, identical reporting period is required to compare values.";
      } else if (inputScope(old.point) !== inputScope(latest.point)) {
        status = "inputs-changed";
        detail =
          "Reported concepts, units, source durations or calculation definitions differ. Review the definitions before comparing values; no value difference is calculated.";
      } else if (old.point.value !== latest.point.value) {
        status = "value-changed";
        delta = latest.point.value - old.point.value;
        detail =
          "Same reporting period; review the original and current inputs to explain the difference.";
      } else if (
        comparisonSourceFingerprint(old.point) !==
        comparisonSourceFingerprint(latest.point)
      ) {
        status = "inputs-changed";
        detail =
          "The displayed value is identical but source inputs, calculations or observation metadata changed.";
      } else {
        status = "unchanged";
        detail =
          "Value, reporting period and saved observation evidence match.";
      }
      return {
        id: `${id}:${key}`,
        ticker: (nowCompany || oldCompany).ticker,
        name: (nowCompany || oldCompany).name,
        metric: nowMetric || oldMetric,
        status,
        detail,
        delta,
        prior,
        current: currentEvidence,
      };
    }),
  );
  const settingsDifferences = [
    ...new Set([
      ...Object.keys(snapshot.settings),
      ...Object.keys(present.settings),
    ]),
  ].filter(
    (key) =>
      compareCanonical(snapshot.settings[key]) !==
      compareCanonical(present.settings[key]),
  );
  return {
    rows,
    settingsDifferences,
    counts: rows.reduce(
      (counts, row) => ({
        ...counts,
        [row.status]: (counts[row.status] || 0) + 1,
      }),
      {},
    ),
  };
}
