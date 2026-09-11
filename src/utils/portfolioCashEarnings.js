import {
  canonicalPortfolioCik,
  companyAvailable,
  finiteFinancialMetric,
} from "./portfolioModel.js";
import { portfolioMetricSourceUrl } from "./portfolioAnalytics.js";
const evidence = (point) =>
  (point?.sources || []).flatMap((source) => {
    const documentUrl = portfolioMetricSourceUrl({ sources: [source] });
    return documentUrl
      ? [
          {
            documentUrl,
            accession: source.accession || source.accn || null,
            filingDate: source.filingDate || source.filed || null,
            taxonomy: source.taxonomy || null,
            tag: source.tag || null,
          },
        ]
      : [];
  });
const validDate = (d) =>
  typeof d === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  Number.isFinite(Date.parse(d)) &&
  new Date(d).toISOString().slice(0, 10) === d;
export function buildCashEarnings(report, companies) {
  const byCik = new Map(
    companies.map((c) => [canonicalPortfolioCik(c.cik), c]),
  );
  const cells = [
    "positive:positive",
    "positive:nonpositive",
    "nonpositive:positive",
    "nonpositive:nonpositive",
  ].map((id) => ({
    id,
    observations: [],
    knownWeightPct: report.weighted ? 0 : null,
    missingWeightCount: 0,
    knownWeightCount: 0,
  }));
  const excluded = { businessType: 0, missing: 0, period: 0 };
  const seen = new Set();
  for (const issuer of report.concentration.issuers) {
    if (seen.has(issuer.cik)) continue;
    seen.add(issuer.cik);
    const c = byCik.get(issuer.cik);
    if (
      issuer.kind !== "company" ||
      Number(c?.sic) === 6798 ||
      (c?.lens && c.lens !== "corporate")
    ) {
      excluded.businessType++;
      continue;
    }
    const income = c?.metrics?.netIncome,
      cash = c?.metrics?.operatingCashFlow;
    if (
      !c?.lens ||
      !companyAvailable(c) ||
      ![income, cash].every((p) => finiteFinancialMetric(p) && p.unit === "USD")
    ) {
      excluded.missing++;
      continue;
    }
    const ip = income.period || c.period,
      cp = cash.period || c.period;
    if (
      !ip ||
      !cp ||
      ![ip.start, ip.end, cp.start, cp.end].every(validDate) ||
      ip.start > ip.end ||
      ip.start !== cp.start ||
      ip.end !== cp.end ||
      ip.kind !== cp.kind ||
      !["annual", "ttm"].includes(ip.kind)
    ) {
      excluded.period++;
      continue;
    }
    const cell = cells.find(
      (x) =>
        x.id ===
        `${income.value > 0 ? "positive" : "nonpositive"}:${cash.value > 0 ? "positive" : "nonpositive"}`,
    );
    cell.observations.push({
      cik: issuer.cik,
      rowId: issuer.rowIds[0],
      ticker: issuer.tickers.join(" / "),
      income: income.value,
      operatingCashFlow: cash.value,
      period: { ...ip },
      incomeSource: portfolioMetricSourceUrl(income),
      cashSource: portfolioMetricSourceUrl(cash),
      incomeEvidence: evidence(income),
      cashEvidence: evidence(cash),
      retrievedAt: c.retrievedAt || null,
    });
    if (report.weighted) {
      if (
        typeof issuer.weightPct === "number" &&
        Number.isFinite(issuer.weightPct)
      ) {
        cell.knownWeightPct += issuer.weightPct;
        cell.knownWeightCount++;
      }
      if (!issuer.weightComplete) cell.missingWeightCount++;
    }
  }
  for (const cell of cells)
    if (report.weighted && cell.observations.length && !cell.knownWeightCount)
      cell.knownWeightPct = null;
  const count = cells.reduce((n, c) => n + c.observations.length, 0),
    profitable = cells[0].observations.length + cells[1].observations.length;
  return {
    version: "1.0.0",
    count,
    profitable,
    confirmed: cells[0].observations.length,
    confirmationPct: profitable
      ? (100 * cells[0].observations.length) / profitable
      : null,
    cells,
    excluded,
    interpretation:
      "Positive net income and positive operating cash flow are compared on identical annual or TTM periods within each corporate company. Non-positive includes zero. Working capital and noncash items can explain disagreement. This measures cash accompaniment, not improving earnings, investment returns or an earnings-quality verdict.",
  };
}
