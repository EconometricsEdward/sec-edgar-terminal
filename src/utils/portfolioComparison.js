import { buildPortfolioAnalytics } from "./portfolioAnalytics.js";
import { summarizeHubPortfolio } from "./researchHubOverview.js";
import { portfolioMetricDefinition } from "./portfolioChanges.js";
import { canonicalPortfolioCik } from "./portfolioModel.js";

const finite = (n) => typeof n === "number" && Number.isFinite(n);
const median = (values) => {
  const a = values.filter(finite).sort((x, y) => x - y);
  return a.length
    ? (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2
    : null;
};
const validDate = (d) =>
  typeof d === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  Number.isFinite(Date.parse(d)) &&
  new Date(d).toISOString().slice(0, 10) === d;
const knownDefinition = (p) =>
  Boolean(
    p?.classification &&
      (p.formula ||
        p.sources?.some((s) => s.taxonomy && s.tag) ||
        p.calculations?.some((c) => c.formula)),
  );
const period = (point, company) => point?.period || company?.period;
const samePeriod = (a, b) =>
  a &&
  b &&
  validDate(a.start) &&
  validDate(a.end) &&
  a.start <= a.end &&
  a.start === b.start &&
  a.end === b.end &&
  a.kind === b.kind &&
  ["annual", "ttm"].includes(a.kind);

export function portfolioComparisonProfile(document) {
  const snapshot =
    document?.snapshot?.basis === document?.research?.basis
      ? document.snapshot
      : null;
  return {
    document,
    summary: summarizeHubPortfolio(document),
    report: buildPortfolioAnalytics(
      document.rows,
      document.allocation,
      snapshot?.companies || [],
      { capturedAt: snapshot?.generated_at || null },
    ),
    snapshot,
  };
}

/** Read-only saved-snapshot comparison. Never blends bases, imputes facts or assumes weights. */
export function comparePortfolioProfiles(a, b, metricId = "netMargin") {
  const left = new Map(a.report.concentration.issuers.map((r) => [r.cik, r]));
  const right = new Map(b.report.concentration.issuers.map((r) => [r.cik, r]));
  const union = [...new Set([...left.keys(), ...right.keys()])];
  const shared = union.filter((cik) => left.has(cik) && right.has(cik));
  const complete =
    a.report.concentration.complete && b.report.concentration.complete;
  const members = union.map((cik) => {
    const l = left.get(cik),
      r = right.get(cik);
    return {
      cik,
      name: l?.name || r?.name,
      ticker: (l?.tickers || r?.tickers || []).join(" / "),
      membership: l && r ? "shared" : l ? "left" : "right",
      leftRow: l?.rowIds[0] || null,
      rightRow: r?.rowIds[0] || null,
      leftWeight: l?.weightPct ?? null,
      rightWeight: r?.weightPct ?? null,
      difference: complete ? (r?.weightPct ?? 0) - (l?.weightPct ?? 0) : null,
    };
  });
  const leftMetric = a.report.metrics.find((m) => m.id === metricId),
    rightMetric = b.report.metrics.find((m) => m.id === metricId);
  const leftPoints = new Map(
    (leftMetric?.observations || []).map((p) => [p.cik, p]),
  );
  const rightPoints = new Map(
    (rightMetric?.observations || []).map((p) => [p.cik, p]),
  );
  const leftCompanies = new Map(
    (a.snapshot?.companies || []).map((c) => [canonicalPortfolioCik(c.cik), c]),
  );
  const rightCompanies = new Map(
    (b.snapshot?.companies || []).map((c) => [canonicalPortfolioCik(c.cik), c]),
  );
  const compatible = Boolean(
    a.snapshot &&
      b.snapshot &&
      a.snapshot.basis === b.snapshot.basis &&
      leftMetric &&
      leftMetric.unit === rightMetric?.unit,
  );
  const pairs = [],
    excluded = [];
  for (const cik of shared) {
    const l = leftPoints.get(cik),
      r = rightPoints.get(cik),
      lc = leftCompanies.get(cik),
      rc = rightCompanies.get(cik);
    const reason = !compatible
      ? "Different basis or missing snapshot"
      : !l || !r
        ? "Missing or inapplicable metric"
        : !samePeriod(
              period(lc.metrics[metricId], lc),
              period(rc.metrics[metricId], rc),
            ) || period(lc.metrics[metricId], lc)?.kind !== a.snapshot.basis
          ? "Reporting period differs or is unknown"
          : !knownDefinition(lc.metrics[metricId]) ||
              !knownDefinition(rc.metrics[metricId]) ||
              portfolioMetricDefinition(lc.metrics[metricId]) !==
                portfolioMetricDefinition(rc.metrics[metricId])
            ? "Metric definition differs or is unknown"
            : null;
    if (reason) {
      excluded.push({ cik, reason });
      continue;
    }
    pairs.push({
      cik,
      ticker: l.ticker,
      left: l.value,
      right: r.value,
      difference: r.value - l.value,
      period: period(lc.metrics[metricId], lc),
      leftSource: l.sourceUrl,
      rightSource: r.sourceUrl,
    });
  }
  return {
    version: "1.0.0",
    left: a.summary,
    right: b.summary,
    metricId,
    metricLabel: leftMetric?.label || metricId,
    unit: leftMetric?.unit || null,
    membership: {
      left: left.size,
      right: right.size,
      shared: shared.length,
      leftOnly: left.size - shared.length,
      rightOnly: right.size - shared.length,
      union: union.length,
      jaccardPct: union.length ? (100 * shared.length) / union.length : null,
    },
    allocation: {
      leftBasis: a.document.allocation?.basis || "none",
      rightBasis: b.document.allocation?.basis || "none",
      leftNormalized: Boolean(a.document.allocation?.normalize),
      rightNormalized: Boolean(b.document.allocation?.normalize),
      available: complete,
      overlapPct: complete
        ? union.reduce(
            (total, cik) =>
              total +
              Math.min(
                left.get(cik)?.weightPct ?? 0,
                right.get(cik)?.weightPct ?? 0,
              ),
            0,
          )
        : null,
      reason: complete
        ? null
        : "Both portfolios need complete, resolved allocations totaling 100%. Company lists retain counts; missing weights are not zero.",
    },
    members,
    financial: {
      compatible,
      leftAvailable: leftPoints.size,
      rightAvailable: rightPoints.size,
      leftMedian: leftMetric?.median ?? null,
      rightMedian: rightMetric?.median ?? null,
      pairedCount: pairs.length,
      leftPairedMedian: median(pairs.map((p) => p.left)),
      rightPairedMedian: median(pairs.map((p) => p.right)),
      medianDifference: median(pairs.map((p) => p.difference)),
      pairs,
      excluded,
    },
    interpretation:
      "Allocation differences are right minus left on saved portfolio allocation weights, including any explicit normalization already chosen. Matched financial differences compare the same holding, metric and full reporting period; differences can reflect revisions or retrieval methodology, not subsequent business growth. Whole-list medians can differ because membership differs. Overlap is holding identity overlap, not economic diversification or performance.",
  };
}
