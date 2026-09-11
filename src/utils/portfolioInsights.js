import { companyAvailable, finiteFinancialMetric } from "./portfolioModel.js";

const DAY = 86400000;
const valid = (value) => typeof value === "number" && Number.isFinite(value);
/** Explicit review conditions, not a composite risk score. */
export function portfolioReviewPriorities(
  rows,
  companies,
  allocation,
  now = Date.now(),
) {
  const byCik = new Map(companies.map((company) => [company.cik, company]));
  const priorities = [];
  const seen = new Set();
  const active = rows.filter(
    (entry) =>
      !entry.excluded &&
      !entry.mergedInto &&
      entry.duplicateChoice !== "remove",
  );
  const coverageByRow = new Map();
  // Use the selected allocation basis and original denominator. Share classes
  // belong to one issuer; missing weights never become zero or get reweighted.
  for (const issuer of allocation.issuers) {
    const company = byCik.get(issuer.cik);
    if (
      issuer.kind !== "company" ||
      company?.kind === "fund" ||
      !valid(issuer.weightPct) ||
      issuer.weightPct < 10 ||
      companyAvailable(company)
    )
      continue;
    const row = active.find(
      (entry) =>
        issuer.rowIds.includes(entry.id) &&
        entry.resolution?.status === "resolved" &&
        entry.resolution?.kind === "company",
    );
    if (!row) continue;
    coverageByRow.set(row.id, {
      weightPct: issuer.weightPct,
      label: issuer.tickers.join(" / ") || issuer.name,
      reason: `${issuer.weightPct.toFixed(2)}% allocation has no supported company financial evidence.${company?.filings?.length ? " Filings are available, but supported numeric financial facts are missing." : ""}${!allocation.allocationComplete || !issuer.weightComplete ? " This is a known subtotal; missing position weights are not estimated." : ""}`,
    });
  }
  for (const row of active) {
    const identity = row.resolution || {};
    const name =
      identity.ticker ||
      identity.name ||
      row.input.ticker ||
      row.input.company_name ||
      "Unidentified row";
    const company = byCik.get(identity.cik);
    if (identity.status !== "resolved") {
      priorities.push({
        key: `identity:${row.id}`,
        rowId: row.id,
        label: name,
        reason: "Identity needs review before company evidence can be matched.",
        kind: "identity",
        url: null,
      });
      continue;
    }
    const coverage = coverageByRow.get(row.id);
    if (coverage)
      priorities.push({
        key: `coverage:${row.id}`,
        rowId: row.id,
        label: coverage.label,
        reason: coverage.reason,
        weightPct: coverage.weightPct,
        kind: "coverage",
        url: null,
      });
    if (
      identity.kind !== "company" ||
      !company ||
      !["company", "foreign"].includes(company.kind) ||
      seen.has(company.cik)
    )
      continue;
    seen.add(company.cik);
    const end = company.period?.end;
    const threshold = company.period?.kind === "ttm" ? 200 : 550;
    if (end && now - Date.parse(end) > threshold * DAY)
      priorities.push({
        key: `stale:${company.cik}`,
        rowId: row.id,
        label: name,
        reason: `Reporting period ended ${end}, more than ${threshold} days ago.`,
        kind: "freshness",
        url: company.filings?.[0]?.documentUrl || null,
      });
    if (company.cache?.status === "stale")
      priorities.push({
        key: `cache:${company.cik}`,
        rowId: row.id,
        label: name,
        reason:
          "The current retrieval failed; older cached public evidence is being shown.",
        kind: "freshness",
        url: company.filings?.[0]?.documentUrl || null,
      });
    const recent = company.filings?.find((filing) => {
      const age = now - Date.parse(filing.filingDate);
      return age >= 0 && age <= 30 * DAY;
    });
    if (recent)
      priorities.push({
        key: `filing:${company.cik}`,
        rowId: row.id,
        label: name,
        reason: `${recent.form} filed ${recent.filingDate}, within the last 30 days.`,
        kind: "filing",
        url: recent.documentUrl,
      });
    for (const [key, label] of [
      ["netIncome", "Negative net income"],
      ["stockholdersEquity", "Negative reported equity"],
      ["operatingCashFlow", "Negative operating cash flow"],
    ]) {
      const point = company.metrics?.[key];
      if (
        companyAvailable(company) &&
        (key !== "operatingCashFlow" || company.lens === "corporate") &&
        finiteFinancialMetric(point) &&
        point.value < 0
      )
        priorities.push({
          key: `metric:${company.cik}:${key}`,
          rowId: row.id,
          label: name,
          reason: `${label} in the selected ${company.period?.kind || "reporting"} period ending ${point.period?.end || end || "date unavailable"}.`,
          kind: "metric",
          metric: key,
          cik: company.cik,
          url:
            point.sources?.find((source) => source.documentUrl)?.documentUrl ||
            null,
        });
    }
  }
  return priorities;
}
