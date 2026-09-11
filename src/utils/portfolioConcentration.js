const finite = (value) => typeof value === "number" && Number.isFinite(value);
const unique = (values) => [...new Set(values)];
const pct = (value) =>
  `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

export const DEFAULT_RESEARCH_LIMITS = Object.freeze({
  issuerPct: 10,
  industryPct: 25,
});

function limitValue(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return finite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

/**
 * Research limits are user inputs, never investment recommendations or saved allocation changes.
 * @param {any} report
 * @param {{issuerPct?: unknown, industryPct?: unknown}} limits
 */
export function buildConcentrationAnalysis(
  report,
  limits = DEFAULT_RESEARCH_LIMITS,
) {
  const concentration = report?.concentration || {};
  const weighted = report?.weighted === true;
  const complete = weighted && concentration.complete === true;
  const issuerLimit = limitValue(limits.issuerPct);
  const industryLimit = limitValue(limits.industryPct);
  const issuers = [...(concentration.issuers || [])];
  const industries = [...(concentration.industries || [])];
  const check = (group, kind, limit) => {
    const knownWeightPct =
      weighted && finite(group.weightPct) ? group.weightPct : null;
    const breached =
      knownWeightPct !== null &&
      limit !== null &&
      knownWeightPct > limit + 1e-8;
    return {
      kind,
      id: kind === "issuer" ? group.cik : group.label,
      label: kind === "issuer" ? group.name : group.label,
      tickers: group.tickers || [],
      rowIds: unique(group.rowIds || []),
      ciks: kind === "issuer" ? [group.cik] : group.ciks || [],
      knownWeightPct,
      limitPct: limit,
      excessPct: breached ? knownWeightPct - limit : null,
      status:
        limit === null
          ? "invalid-limit"
          : !weighted
            ? "unweighted"
            : breached
              ? "breached"
              : complete && knownWeightPct !== null
                ? "within-limit"
                : "not-confirmed",
      lowerBound: weighted && !complete,
    };
  };
  const issuerChecks = issuers.map((group) =>
    check(group, "issuer", issuerLimit),
  );
  const industryChecks = industries.map((group) =>
    check(group, "industry", industryLimit),
  );
  const known = weighted
    ? issuers
        .filter((issuer) => finite(issuer.weightPct))
        .sort(
          (a, b) => b.weightPct - a.weightPct || a.name.localeCompare(b.name),
        )
    : [];
  const hhi = complete
    ? known.reduce((total, issuer) => total + issuer.weightPct ** 2, 0)
    : null;
  let cumulativeWeightPct = 0;
  const curve = known.map((issuer, index) => {
    cumulativeWeightPct += issuer.weightPct;
    const hhiPoints = complete ? issuer.weightPct ** 2 : null;
    return {
      ...issuer,
      rank: index + 1,
      cumulativeWeightPct,
      hhiPoints,
      hhiSharePct:
        hhi > 0 && hhiPoints !== null ? (hhiPoints / hhi) * 100 : null,
    };
  });
  return {
    weighted,
    complete,
    limits: { issuerPct: issuerLimit, industryPct: industryLimit },
    errors: [
      issuerLimit === null ? "Enter a holding limit from 0% to 100%." : null,
      industryLimit === null
        ? "Enter an industry limit from 0% to 100%."
        : null,
    ].filter(Boolean),
    issuerChecks,
    industryChecks,
    breaches: [...issuerChecks, ...industryChecks].filter(
      (entry) => entry.status === "breached",
    ),
    curve,
    hhi,
    cumulativeKnownWeightPct:
      weighted && known.length ? cumulativeWeightPct : null,
    unknownIssuerCount: weighted
      ? issuers.filter(
          (issuer) =>
            !finite(issuer.weightPct) || issuer.weightComplete === false,
        ).length
      : issuers.length,
    unresolvedCount: report?.unresolvedCount || 0,
    halfExposureIssuerCount: complete
      ? (curve.find((issuer) => issuer.cumulativeWeightPct >= 50 - 1e-8)
          ?.rank ?? null)
      : null,
    eightyExposureIssuerCount: complete
      ? (curve.find((issuer) => issuer.cumulativeWeightPct >= 80 - 1e-8)
          ?.rank ?? null)
      : null,
  };
}

/** A factual reading order from existing evidence; no opaque score or all-clear from missing data. */
export function buildPortfolioBriefing(report) {
  const issuers = report?.concentration?.issuers || [];
  const weighted = report?.weighted === true;
  const complete = weighted && report?.concentration?.complete === true;
  const cards = [];
  if (report?.unresolvedCount)
    cards.push({
      id: "identity",
      label: "Confirm identities",
      value: `${report.unresolvedCount} unresolved`,
      text: "Resolve these positions before matching company evidence or confirming total exposure.",
      action: "Review evidence gaps",
      area: "coverage",
      tone: "attention",
      rowId: null,
    });
  if (!weighted)
    cards.push({
      id: "allocation",
      label: "Your analysis basis",
      value: `${report?.issuerCount || 0} holdings`,
      text: "This company list supports financial comparisons. Add an explicit allocation to assess portfolio concentration, or try a temporary equal-weight scenario.",
      action: "Explore a scenario",
      area: "scenario",
      tone: "neutral",
      rowId: null,
    });
  else if (!complete)
    cards.push({
      id: "allocation",
      label: "Complete your allocation",
      value: finite(report?.concentration?.knownWeightPct)
        ? `${pct(report.concentration.knownWeightPct)} supplied`
        : "Weights incomplete",
      text: "Known weights remain visible. Complete the allocation and identity review before relying on full-portfolio concentration or scenarios.",
      action: "Review concentration",
      area: "concentration",
      tone: "attention",
      rowId: null,
    });
  const missingIds = new Set(
    (report?.coverage?.missingRows || []).map((row) => row.rowId),
  );
  const missingIssuers = issuers.filter(
    (issuer) =>
      issuer.kind === "company" &&
      issuer.rowIds.some((id) => missingIds.has(id)),
  );
  if (missingIssuers.length)
    cards.push({
      id: "coverage",
      label: "Financial evidence gaps",
      value: `${missingIssuers.length} ${missingIssuers.length === 1 ? "company" : "companies"}`,
      text: "At least one applicable financial measure is unavailable for these companies. Missing measures are excluded from financial statistics.",
      action: "See missing evidence",
      area: "coverage",
      tone: "attention",
      rowId: null,
    });
  else
    cards.push({
      id: "coverage",
      label: "Evidence context",
      value: `${report?.coverage?.periodEnds?.filter((period) => period.end !== "Unavailable").length || 0} reporting dates`,
      text: "Review period dates and measure coverage before comparing companies. Different business models use different financial measures.",
      action: "Review evidence coverage",
      area: "coverage",
      tone: "neutral",
      rowId: null,
    });
  if (report?.coverage?.staleCount)
    cards.push({
      id: "freshness",
      label: "Review older evidence",
      value: `${report.coverage.staleCount} ${report.coverage.staleCount === 1 ? "company" : "companies"}`,
      text: "Cached evidence or reporting periods are flagged as older. Freshness is assessed against the captured research date when available.",
      action: "Check evidence dates",
      area: "coverage",
      tone: "attention",
      rowId: null,
    });
  const largest = weighted
    ? [...issuers]
        .filter((issuer) => finite(issuer.weightPct))
        .sort((a, b) => b.weightPct - a.weightPct)[0]
    : null;
  const industry = [...(report?.concentration?.industries || [])]
    .filter((group) => group.ciks?.length)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
  if (largest)
    cards.push({
      id: "largest",
      label: complete
        ? "Largest holding exposure"
        : "Largest known holding weight",
      value: pct(largest.weightPct),
      text: `${largest.name}${largest.tickers?.length > 1 ? " (share classes combined)" : ""}.${complete ? " Inspect its financial evidence and contribution to concentration." : " This is a known subtotal; incomplete weights can change the ranking."}`,
      action: "Inspect holding",
      area: "concentration",
      tone: "neutral",
      rowId: largest.rowIds[0] || null,
    });
  else if (industry)
    cards.push({
      id: "industry",
      label: "Most represented SEC industry",
      value: `${industry.count} ${industry.count === 1 ? "holding" : "holdings"}`,
      text: `${industry.label}. This is a holding count, not a portfolio weight or fund look-through exposure.`,
      action: "Explore concentration",
      area: "concentration",
      tone: "neutral",
      rowId: null,
    });
  const condition = [...(report?.conditions || [])]
    .filter((entry) => entry.measuredCount > 0 && entry.matchedCount > 0)
    .sort((a, b) => b.matchedCount - a.matchedCount)[0];
  if (condition)
    cards.push({
      id: "condition",
      label: condition.label,
      value: `${condition.matchedCount} of ${condition.measuredCount} measured`,
      text: `${condition.description}${condition.missingCount ? ` ${condition.missingCount} applicable ${condition.missingCount === 1 ? "holding is" : "holdings are"} unmeasured.` : ""} These observations are research prompts, not an investment rating.`,
      action: "Inspect financial profile",
      area: "financial",
      tone: "neutral",
      rowId: null,
    });
  return cards;
}
