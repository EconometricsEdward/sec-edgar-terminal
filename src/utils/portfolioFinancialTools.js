import { canonicalPortfolioCik } from "./portfolioModel.js";
import { csvString } from "./portfolioFiles.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);

function validEnd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
    ? value
    : null;
}

function quantile(values, proportion) {
  if (!values.length) return null;
  const position = (values.length - 1) * proportion;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return (
    values[lower] * (1 - fraction) + values[Math.ceil(position)] * fraction
  );
}

/** One resolved operating issuer per CIK; funds and unresolved rows stay outside company ratios. */
export function financialToolIssuers(report) {
  const byCik = new Map();
  for (const issuer of report?.concentration?.issuers || []) {
    const cik = canonicalPortfolioCik(issuer?.cik);
    if (issuer?.kind !== "company" || !cik || byCik.has(cik)) continue;
    byCik.set(cik, { ...issuer, cik });
  }
  return [...byCik.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function metricObservations(report, metricId, issuers) {
  const metric = (report?.metrics || []).find((item) => item.id === metricId);
  const included = new Map(issuers.map((issuer) => [issuer.cik, issuer]));
  const observations = new Map();
  for (const point of metric?.observations || []) {
    const cik = canonicalPortfolioCik(point?.cik);
    const issuer = included.get(cik);
    if (!issuer || !finite(point?.value) || observations.has(cik)) continue;
    observations.set(cik, {
      ...point,
      cik,
      name: issuer.name,
      industry: issuer.industry,
      rowId: issuer.rowIds?.includes(point.rowId)
        ? point.rowId
        : issuer.rowIds?.[0],
      periodEnd: validEnd(point.periodEnd),
    });
  }
  return { metric: metric || null, observations };
}

/**
 * Unweighted company-level benchmarks within this portfolio's selected SEC industry.
 * Missing values are never zeros. Midrank = 100 × (below + half of ties) / n.
 * A single observed company has no meaningful peer percentile.
 * @param {any} report
 * @param {{metricId?: string, industry?: string, periodFrom?: string, periodTo?: string}} options
 */
export function buildPeerBenchmarks(report, options = {}) {
  const {
    metricId = "netMargin",
    industry = "",
    periodFrom = "",
    periodTo = "",
  } = options;
  const issuers = financialToolIssuers(report).filter(
    (issuer) => !industry || issuer.industry === industry,
  );
  const { metric, observations } = metricObservations(
    report,
    metricId,
    issuers,
  );
  const from = validEnd(periodFrom);
  const to = validEnd(periodTo);
  const error =
    (periodFrom && !from) || (periodTo && !to)
      ? "Enter valid reporting-end dates."
      : from && to && from > to
        ? "The earliest reporting end must be on or before the latest reporting end."
        : !metric
          ? "Choose an available financial measure."
          : null;
  const dateFiltered = Boolean(from || to);
  const measured = [...observations.values()];
  const undatedExcludedCount = dateFiltered
    ? measured.filter((point) => !point.periodEnd).length
    : 0;
  const outsidePeriodCount = dateFiltered
    ? measured.filter(
        (point) =>
          point.periodEnd &&
          ((from && point.periodEnd < from) || (to && point.periodEnd > to)),
      ).length
    : 0;
  const eligible = error
    ? []
    : measured.filter(
        (point) =>
          !dateFiltered ||
          (point.periodEnd &&
            (!from || point.periodEnd >= from) &&
            (!to || point.periodEnd <= to)),
      );
  const cohortCiks = new Set(issuers.map((issuer) => issuer.cik));
  const countMetadata = (key) =>
    Array.isArray(metric?.[key])
      ? new Set(
          metric[key]
            .map(canonicalPortfolioCik)
            .filter((cik) => cohortCiks.has(cik)),
        ).size
      : null;
  const values = eligible.map((point) => point.value).sort((a, b) => a - b);
  const median = quantile(values, 0.5);
  const ranks = new Map();
  for (let start = 0; start < values.length; ) {
    let end = start + 1;
    while (end < values.length && values[end] === values[start]) end++;
    ranks.set(
      values[start],
      values.length > 1
        ? (100 * (start + (end - start) / 2)) / values.length
        : null,
    );
    start = end;
  }
  return {
    metric,
    industry,
    periodFrom: from,
    periodTo: to,
    error,
    cohortCount: issuers.length,
    eligibleCount: countMetadata("eligibleCiks"),
    missingCount: countMetadata("missingCiks"),
    notApplicableCount: countMetadata("notApplicableCiks"),
    availableBeforeDateCount: measured.length,
    unavailableOrNotApplicableCount: issuers.length - measured.length,
    undatedExcludedCount,
    outsidePeriodCount,
    measuredCount: eligible.length,
    median,
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    min: values[0] ?? null,
    max: values.at(-1) ?? null,
    observations: eligible
      .map((point) => ({
        ...point,
        percentile: ranks.get(point.value),
        differenceFromMedian: median === null ? null : point.value - median,
      }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)),
  };
}

/**
 * Pairs observations by verified issuer CIK, never by row order or ticker.
 * Dates remain separate because equal reporting ends do not prove equal durations.
 * @param {any} report
 * @param {{xMetricId?: string, yMetricId?: string, industry?: string, matchingPeriodOnly?: boolean}} options
 */
export function buildMetricRelationship(report, options = {}) {
  const {
    xMetricId = "revenueGrowth",
    yMetricId = "netMargin",
    industry = "",
    matchingPeriodOnly = false,
  } = options;
  const issuers = financialToolIssuers(report).filter(
    (issuer) => !industry || issuer.industry === industry,
  );
  const x = metricObservations(report, xMetricId, issuers);
  const y = metricObservations(report, yMetricId, issuers);
  const allPairs = [];
  for (const issuer of issuers) {
    const xPoint = x.observations.get(issuer.cik);
    const yPoint = y.observations.get(issuer.cik);
    if (!xPoint || !yPoint) continue;
    allPairs.push({
      cik: issuer.cik,
      rowId: issuer.rowIds[0],
      name: issuer.name,
      ticker: issuer.tickers.join(" / ") || xPoint.ticker || yPoint.ticker,
      industry: issuer.industry,
      x: xPoint.value,
      y: yPoint.value,
      xPoint,
      yPoint,
      samePeriodEnd: Boolean(
        xPoint.periodEnd &&
          yPoint.periodEnd &&
          (report.fullPeriodEvidence
            ? xPoint.periodKey && xPoint.periodKey === yPoint.periodKey
            : xPoint.periodEnd === yPoint.periodEnd),
      ),
    });
  }
  const mismatchedPeriodCount = allPairs.filter(
    (point) =>
      point.xPoint.periodEnd && point.yPoint.periodEnd && !point.samePeriodEnd,
  ).length;
  const unknownPeriodCount = allPairs.filter(
    (point) => !point.xPoint.periodEnd || !point.yPoint.periodEnd,
  ).length;
  const points = matchingPeriodOnly
    ? allPairs.filter((point) => point.samePeriodEnd)
    : allPairs;
  return {
    xMetric: x.metric,
    yMetric: y.metric,
    industry,
    matchingPeriodOnly,
    cohortCount: issuers.length,
    xAvailableCount: x.observations.size,
    yAvailableCount: y.observations.size,
    pairedBeforeDateCount: allPairs.length,
    unavailablePairCount: issuers.length - allPairs.length,
    mismatchedPeriodCount,
    unknownPeriodCount,
    dateExcludedCount: allPairs.length - points.length,
    points,
  };
}

/** @param {any} report @param {string[]} selectedCiks */
export function buildFinancialComparison(report, selectedCiks = []) {
  const issuers = financialToolIssuers(report);
  const byCik = new Map(issuers.map((issuer) => [issuer.cik, issuer]));
  const selected = [
    ...new Set(selectedCiks.map(canonicalPortfolioCik).filter(Boolean)),
  ]
    .map((cik) => byCik.get(cik))
    .filter(Boolean)
    .slice(0, 4);
  return {
    companies: selected,
    metrics: (report?.metrics || []).map((metric) => {
      const { observations } = metricObservations(report, metric.id, selected);
      const notApplicable = new Set(
        (metric.notApplicableCiks || []).map(canonicalPortfolioCik),
      );
      const missing = new Set(
        (metric.missingCiks || []).map(canonicalPortfolioCik),
      );
      return {
        id: metric.id,
        label: metric.label,
        unit: metric.unit,
        description: metric.description,
        values: selected.map((issuer) => observations.get(issuer.cik) || null),
        statuses: selected.map((issuer) =>
          observations.has(issuer.cik)
            ? "available"
            : notApplicable.has(issuer.cik)
              ? "not-applicable"
              : missing.has(issuer.cik)
                ? "missing"
                : "unknown",
        ),
      };
    }),
  };
}

/** A reviewable export of the exact filtered cohort and its reporting evidence. */
export function peerBenchmarksCsv(cohort, capturedAt = null) {
  const header = [
    "Scope",
    "Captured at",
    "SEC industry",
    "Metric",
    "Unit",
    "Reporting end from",
    "Reporting end to",
    "Cohort companies",
    "Measured companies",
    "Applicable companies",
    "Unavailable applicable companies",
    "Not applicable companies",
    "Unavailable or not applicable",
    "Outside date range",
    "Undated excluded",
    "CIK",
    "Ticker",
    "Company",
    "Value",
    "Difference from cohort median",
    "Midrank percentile",
    "Reporting end",
    "Full reporting period",
    "Definition",
    "SEC evidence",
  ];
  const prefix = [
    "Company-level portfolio cohort; unweighted",
    capturedAt,
    cohort.industry || "All included companies",
    cohort.metric?.label,
    cohort.metric?.unit,
    cohort.periodFrom,
    cohort.periodTo,
    cohort.cohortCount,
    cohort.measuredCount,
    cohort.eligibleCount,
    cohort.missingCount,
    cohort.notApplicableCount,
    cohort.unavailableOrNotApplicableCount,
    cohort.outsidePeriodCount,
    cohort.undatedExcludedCount,
  ];
  return csvString([
    header,
    ...cohort.observations.map((point) => [
      ...prefix,
      point.cik,
      point.ticker,
      point.name,
      point.value,
      point.differenceFromMedian,
      point.percentile,
      point.periodEnd,
      point.periodKey,
      point.definition,
      point.evidence || point.sourceUrl,
    ]),
  ]);
}
