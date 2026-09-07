import { METRIC_BY_KEY } from "./compareResearch.js";
import {
  compareFormulaMetric,
  computeCompareFormula,
} from "./compareFormula.js";
import { commonSizeCell } from "./compareCommonSize.js";
import {
  comparePath,
  normalizeCompareSettings,
  normalizeCompareTickers,
} from "./compareNotebook.js";

// Stable observation identity includes input values and contexts, not just accessions.
const ordered = (value) => {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, ordered(value[key])]),
    );
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
};
export function compareCanonical(value) {
  return JSON.stringify(ordered(value));
}
export function comparisonSourceFingerprint(point) {
  const text = compareCanonical(point || null);
  // Two independently seeded 64-bit FNV-1a hashes; an identity check, not a signature.
  const mask = (1n << 64n) - 1n;
  const hash = (seed) => {
    let result = seed;
    for (let i = 0; i < text.length; i++) {
      result ^= BigInt(text.charCodeAt(i));
      result = (result * 1099511628211n) & mask;
    }
    return result.toString(16).padStart(16, "0");
  };
  return hash(14695981039346656037n) + hash(7809847782465536322n);
}
export function comparisonEvidenceIdentity(cell, metric, settings) {
  const point = cell.point || null;
  const period = point?.period || cell.period || {};
  return `${String(cell.cik || cell.ticker)}:${metric.key}:${period.end || ""}:${period.kind || ""}:${comparisonSourceFingerprint({ point, period, definition: metric, settings: normalizeCompareSettings(settings) })}`;
}
const pointerKeys = [
  "obsTicker",
  "obsCik",
  "obsMetric",
  "obsEnd",
  "obsStart",
  "obsKind",
  "obsSource",
];
const date = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export function readCompareEvidencePointer(search) {
  const params =
    search instanceof URLSearchParams
      ? search
      : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  if (!pointerKeys.some((key) => params.has(key))) return null;
  const pointer = {
    ticker: params.get("obsTicker") || "",
    cik: params.get("obsCik") || "",
    metric: params.get("obsMetric") || "",
    end: params.get("obsEnd") || "",
    start: params.get("obsStart") || "",
    kind: params.get("obsKind") || "",
    fingerprint: params.get("obsSource") || "",
  };
  const valid =
    normalizeCompareTickers([pointer.ticker])[0] === pointer.ticker &&
    /^\d{1,10}$/.test(pointer.cik) &&
    /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(pointer.metric) &&
    date(pointer.end) &&
    (!pointer.start || date(pointer.start)) &&
    ["annual", "quarter", "ttm", "ytd", "instant"].includes(pointer.kind) &&
    /^[a-f0-9]{32}$/.test(pointer.fingerprint);
  return valid
    ? pointer
    : {
        invalid: true,
        reason:
          "This observation link is incomplete or invalid. Choose an available observation to inspect its current evidence.",
      };
}
/** @param {any} evidence
 * @param {{ tickers?: string[], origin?: string }} [options]
 */
export function makeCompareEvidenceUrl(
  evidence,
  { tickers = [], origin = "" } = {},
) {
  const { cell, metric } = evidence;
  const period = cell.point?.period || cell.period;
  if (
    !period?.end ||
    !cell.cik ||
    !metric?.key ||
    !cell.point ||
    !evidence.settings
  )
    return null;
  const peers = normalizeCompareTickers([cell.ticker, ...tickers]);
  const [path, search = ""] = comparePath(peers, evidence.settings).split("?");
  const params = new URLSearchParams(search);
  Object.entries({
    obsTicker: cell.ticker,
    obsCik: cell.cik,
    obsMetric: metric.key,
    obsEnd: period.end,
    obsStart: period.start || "",
    obsKind: period.kind,
    obsSource: comparisonSourceFingerprint(cell.point),
  }).forEach(([key, value]) => params.set(key, String(value)));
  const pointer = readCompareEvidencePointer(params);
  if (!pointer || "invalid" in pointer) return null;
  let base = "";
  if (origin) {
    try {
      const url = new URL(origin);
      if (
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname))
      )
        base = url.origin;
    } catch {
      /* Return a same-origin relative URL. */
    }
  }
  return `${base}${path}?${params}`;
}
const normalizedCik = (value) => String(value || "").replace(/^0+/, "");
export function resolveCompareEvidencePointer(
  pointer,
  entries,
  metrics,
  settings,
) {
  const fail = (status, reason) => ({ status, reason, evidence: null });
  if (!pointer) return fail("absent", "No observation was requested.");
  if (pointer.invalid) return fail("invalid", pointer.reason);
  const company = entries.find(
    (entry) =>
      entry.ticker === pointer.ticker &&
      normalizedCik(entry.data?.cik) === normalizedCik(pointer.cik),
  );
  if (!company)
    return fail(
      entries.some((entry) => entry.loading)
        ? "pending"
        : "company-unavailable",
      "The linked company identity is not available in this comparison. No substitute issuer was selected.",
    );
  if (company.loading)
    return fail(
      "pending",
      "Loading the linked company's reported observations.",
    );
  if (company.error)
    return fail(
      "company-unavailable",
      "The linked company could not be loaded. Retry it to inspect this observation.",
    );
  const common = pointer.metric.match(
    /^([A-Za-z][A-Za-z0-9]*)CommonSize(balance|income)$/,
  );
  let metric =
    metrics.find((candidate) => candidate.key === pointer.metric) ||
    METRIC_BY_KEY[pointer.metric];
  let candidates = company.data?.metrics?.[pointer.metric] || [];
  if (pointer.metric === "customFormula") {
    metric = compareFormulaMetric(settings);
    candidates = (company.data?.periods || []).map((period, index) =>
      computeCompareFormula({ ...company, period, index }, settings),
    );
  } else if (common && METRIC_BY_KEY[common[1]]) {
    candidates = (company.data?.periods || []).map((period, index) => {
      const result = commonSizeCell(
        { ...company, period, index },
        common[1],
        common[2],
      );
      metric = {
        ...METRIC_BY_KEY[common[1]],
        key: pointer.metric,
        label: `${METRIC_BY_KEY[common[1]].label} / ${result.denominator.label}`,
        format: "percent",
      };
      return result.calculatedPoint;
    });
  }
  if (!metric)
    return fail(
      "metric-unavailable",
      "The linked metric definition is not available with these settings.",
    );
  const points = candidates.filter(
    (point) =>
      point?.period?.end === pointer.end &&
      (point.period.start || "") === pointer.start &&
      point.period.kind === pointer.kind,
  );
  if (!points.length)
    return fail(
      "period-unavailable",
      "The linked reporting period is not available with this filing cutoff. No newer period was substituted.",
    );
  const point = points.find(
    (candidate) =>
      comparisonSourceFingerprint(candidate) === pointer.fingerprint,
  );
  if (!point)
    return fail(
      "observation-changed",
      "The available observation or its source inputs have changed since this link was created. Choose a current value to review it; the original observation was not substituted.",
    );
  return {
    status: "resolved",
    reason: "Exact observation and input fingerprint verified.",
    evidence: {
      cell: {
        ticker: company.ticker,
        cik: company.data.cik,
        name: company.data.name,
        point,
        period: point.period,
        status: Number.isFinite(point.value) ? "reviewed" : "unavailable",
      },
      metric,
      settings: normalizeCompareSettings(settings),
      linked: true,
    },
  };
}
export function safeCompareSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" &&
      ["www.sec.gov", "sec.gov", "www.data.sec.gov", "data.sec.gov"].includes(
        url.hostname,
      ) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function compareEvidenceCitation(evidence) {
  const { cell, metric } = evidence;
  const point = cell.point,
    period = point?.period || cell.period || {};
  const unit =
    metric.format === "percent"
      ? "%"
      : metric.format === "decimal"
        ? "times"
        : metric.format === "currency"
          ? "USD"
          : metric.format;
  const sources = (point?.sources || []).map(
    (source, index) =>
      `${index + 1}. ${source.taxonomy ? `${source.taxonomy}:` : ""}${source.tag || source.label || "Reported input"}: ${source.value ?? "Unavailable"} ${source.unit || ""}; ${source.start || "Balance at"} to ${source.end || "unknown"}; ${source.form || "filing"}, filed ${source.filed || "unknown"}; accession ${source.accession || "unknown"}${safeCompareSourceUrl(source.documentUrl) ? `; ${safeCompareSourceUrl(source.documentUrl)}` : ""}`,
  );
  return [
    `${cell.ticker} — ${cell.name || ""} (CIK ${cell.cik || "unknown"})`,
    `${metric.label}: ${point?.value ?? "Unavailable"} ${unit || ""}`,
    `Period: ${period.start || "Balance at"} to ${period.end || "unknown"}; ${period.kind || "unknown basis"}. Filing cutoff: ${evidence.settings?.asOf || period.asOf || "latest available filings"}.`,
    `Definition: ${point?.formula || metric.formula || metric.definition || `Reported ${metric.label.toLowerCase()} from the SEC XBRL context below.`}`,
    ...(evidence.capturedAt
      ? [
          `Snapshot captured: ${evidence.capturedAt}${evidence.snapshotName ? ` (${evidence.snapshotName})` : ""}.`,
        ]
      : []),
    ...sources,
    "Source: EDGAR Terminal / SEC company filings. Numeric differences and ranks are not credit ratings.",
  ].join("\n");
}
