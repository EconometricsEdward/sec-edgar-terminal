const finite = (value) => typeof value === "number" && Number.isFinite(value);

// Allocation and company counts have different denominators. Missing evidence
// never becomes a zero observation, and incomplete weights never imply a ranking.
export function buildPortfolioOverview(report) {
  const concentration = report.concentration;
  const complete = report.weighted && concentration.complete;
  const companies = concentration.issuers.filter(
    (entry) => entry.kind === "company",
  );
  const fundsOnly = companies.length === 0 && report.fundCount > 0;
  const companyIndustries = new Map();
  for (const company of companies) {
    companyIndustries.set(
      company.industry,
      (companyIndustries.get(company.industry) || 0) + 1,
    );
  }
  const industryCount = [...companyIndustries.keys()].filter(
    (label) => label && label !== "Unclassified",
  ).length;
  const mix = complete
    ? concentration.industries
        .filter((entry) => finite(entry.weightPct) && entry.weightPct > 0)
        .map((entry) => ({ label: entry.label, value: entry.weightPct }))
    : fundsOnly
      ? concentration.issuers
          .filter((entry) => entry.kind === "fund")
          .map((entry) => ({
            label: entry.tickers.join(" / ") || entry.name,
            value: 1,
          }))
      : [...companyIndustries].map(([label, value]) => ({ label, value }));
  mix.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const topMix = mix.slice(0, 4);
  const remainder = mix
    .slice(4)
    .reduce((total, entry) => total + entry.value, 0);
  if (remainder > 0) topMix.push({ label: "Other groups", value: remainder });
  const financialGroups = report.coverage.statuses.filter((entry) =>
    ["ready", "partial"].includes(entry.id),
  );
  const financialCount = financialGroups.reduce(
    (total, entry) => total + entry.count,
    0,
  );
  const financialWeight = complete
    ? financialGroups.reduce(
        (total, entry) => total + (entry.weightPct ?? 0),
        0,
      )
    : null;
  const growth = report.metrics.find((entry) => entry.id === "revenueGrowth");
  const loss = report.conditions.find(
    (entry) => entry.id === "negativeNetIncome",
  );
  const pulse = [];
  if (growth?.observations.length) {
    pulse.push({
      id: "growth",
      label: "Growing revenue",
      count: growth.observations.filter((entry) => entry.value > 0).length,
      measured: growth.observations.length,
      context: "Comparable year-over-year revenue",
      tone: "neutral",
    });
  }
  if (loss?.measuredCount > 0) {
    pulse.push({
      id: "loss",
      label: "Reporting a net loss",
      count: loss.matchedCount,
      measured: loss.measuredCount,
      context: "Reported net income below zero",
      tone: "attention",
    });
  }
  return {
    complete,
    companyCount: report.operatingIssuerCount,
    fundCount: report.fundCount,
    industryCount,
    topFiveWeight: complete ? concentration.topFiveIssuerWeightPct : null,
    largestHoldings: complete
      ? concentration.issuers
          .filter((entry) => finite(entry.weightPct) && entry.weightPct > 0)
          .slice(0, 5)
      : [],
    mix: topMix,
    mixTotal: complete ? 100 : fundsOnly ? report.fundCount : companies.length,
    financialCount,
    financialWeight,
    missingFinancialCount: Math.max(
      0,
      report.operatingIssuerCount - financialCount,
    ),
    pulse,
  };
}
