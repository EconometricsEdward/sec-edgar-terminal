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
  const weights = new Map(
    allocation.allocations.map((entry) => [entry.rowId, entry.weightPct]),
  );
  const priorities = [];
  const seen = new Set();
  for (const row of rows.filter(
    (entry) => !entry.excluded && entry.duplicateChoice !== "remove",
  )) {
    const identity = row.resolution || {};
    const name =
      identity.ticker ||
      identity.name ||
      row.input.ticker ||
      row.input.company_name ||
      "Unidentified row";
    const company = byCik.get(identity.cik);
    const weight = weights.get(row.id);
    if (identity.status !== "resolved")
      priorities.push({
        key: `identity:${row.id}`,
        rowId: row.id,
        label: name,
        reason: "Identity needs review before issuer evidence can be matched.",
        kind: "identity",
        url: null,
      });
    if (
      valid(weight) &&
      weight >= 10 &&
      (!company ||
        company.status === "failed" ||
        company.status === "unsupported")
    )
      priorities.push({
        key: `coverage:${row.id}`,
        rowId: row.id,
        label: name,
        reason: `${weight.toFixed(2)}% allocation has no supported company financial evidence.`,
        kind: "coverage",
        url: null,
      });
    if (!company || seen.has(company.cik)) continue;
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
      if (valid(point?.value) && point.value < 0)
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
