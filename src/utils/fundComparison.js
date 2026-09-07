import {
  resolveSecurityGroups,
  securityEligibility,
  fundEvidence,
  fundCsv,
} from "./fundSecurity.js";

const samePortfolio = (left, right) =>
  Boolean(
    left.cik &&
    left.cik === right.cik &&
    left.seriesId &&
    left.seriesId === right.seriesId,
  );

function eligibleGroups(portfolios) {
  const resolved = resolveSecurityGroups(portfolios);
  const coverage = portfolios.map((fund) => ({
    ticker: fund.ticker,
    totalPositions: fund.holdings.length,
    eligiblePositions: 0,
    eligibleWeight: 0,
    excludedPositions: 0,
    exclusions: {},
  }));
  const exclude = (position, reason) => {
    const c = coverage[position.portfolioIndex];
    c.excludedPositions++;
    c.exclusions[reason] = (c.exclusions[reason] || 0) + 1;
  };
  resolved.unidentified.forEach((p) =>
    exclude(p, "No usable security identifier"),
  );
  resolved.ambiguous.forEach((group) =>
    group.positions.forEach((p) =>
      exclude(p, "Conflicting security identifiers"),
    ),
  );
  const groups = resolved.groups.map((group) => {
    const weights = portfolios.map(() => null),
      counts = portfolios.map(() => 0);
    group.positions.forEach((position) => {
      const eligibility = securityEligibility(position.holding);
      if (!eligibility.eligible) {
        exclude(position, eligibility.reason);
        return;
      }
      const i = position.portfolioIndex,
        weight = position.holding.pctOfNav;
      weights[i] = (weights[i] || 0) + weight;
      counts[i]++;
      coverage[i].eligiblePositions++;
      coverage[i].eligibleWeight += weight;
    });
    return {
      key: group.key,
      ids: group.ids,
      name: group.name,
      weights,
      counts,
    };
  });
  coverage.forEach((item) => {
    if (!Number.isFinite(item.eligibleWeight)) item.eligibleWeight = null;
  });
  return { groups, coverage };
}
export function compareFundPortfolios(
  portfolios,
  { left, right, scope = "all", query = "" } = {},
) {
  const { groups, coverage } = eligibleGroups(portfolios);
  const pairs = [];
  for (let a = 0; a < portfolios.length; a++)
    for (let b = a + 1; b < portfolios.length; b++) {
      const shared = groups.filter(
        (group) => group.weights[a] != null && group.weights[b] != null,
      );
      const overlap =
        coverage[a].eligibleWeight == null || coverage[b].eligibleWeight == null
          ? null
          : shared.reduce(
              (sum, group) =>
                sum + Math.min(group.weights[a], group.weights[b]),
              0,
            );
      pairs.push({
        left: portfolios[a].ticker,
        right: portfolios[b].ticker,
        overlap: Number.isFinite(overlap) ? overlap : null,
        count: shared.length,
        samePeriod: portfolios[a].asOf === portfolios[b].asOf,
        samePortfolio: samePortfolio(portfolios[a], portfolios[b]),
      });
    }
  const leftIndex = portfolios.findIndex((fund) => fund.ticker === left),
    rightIndex = portfolios.findIndex((fund) => fund.ticker === right);
  const a = leftIndex >= 0 ? portfolios[leftIndex] : null,
    b = rightIndex >= 0 ? portfolios[rightIndex] : null;
  if (
    !a ||
    !b ||
    a.ticker === b.ticker ||
    coverage[leftIndex]?.eligibleWeight == null ||
    coverage[rightIndex]?.eligibleWeight == null
  )
    return {
      available: false,
      reason:
        !a || !b
          ? "Both selected funds need a successfully loaded report."
          : a.ticker === b.ticker
            ? "Choose two different tickers."
            : "Reported weight totals exceed the supported numeric range. The comparison is unavailable; missing results are not zero exposure.",
      pairs,
      coverage,
      rows: [],
      left: a ? fundEvidence(a) : null,
      right: b ? fundEvidence(b) : null,
    };
  const q = String(query || "")
    .trim()
    .toLowerCase()
    .slice(0, 100);
  const rows = groups
    .flatMap((group) => {
      const lw = group.weights[leftIndex],
        rw = group.weights[rightIndex];
      if (lw == null && rw == null) return [];
      const kind =
        lw != null && rw != null ? "shared" : lw != null ? "left" : "right";
      if (scope !== "all" && scope !== kind) return [];
      if (
        q &&
        ![group.name, ...group.ids].some((s) => s.toLowerCase().includes(q))
      )
        return [];
      return [
        {
          key: group.key,
          ids: group.ids,
          name: group.name,
          kind,
          leftWeight: lw ?? 0,
          rightWeight: rw ?? 0,
          difference: (lw ?? 0) - (rw ?? 0),
          sharedWeight: lw != null && rw != null ? Math.min(lw, rw) : 0,
          leftPositions: group.counts[leftIndex],
          rightPositions: group.counts[rightIndex],
        },
      ];
    })
    .sort(
      (x, y) =>
        Math.abs(y.difference) - Math.abs(x.difference) ||
        y.sharedWeight - x.sharedWeight ||
        x.key.localeCompare(y.key),
    );
  const pair = pairs.find(
    (p) =>
      (p.left === left && p.right === right) ||
      (p.right === left && p.left === right),
  );
  const gapDays = Math.abs(Date.parse(a.asOf) - Date.parse(b.asOf)) / 86400000;
  return {
    available: true,
    reason: null,
    left: fundEvidence(a),
    right: fundEvidence(b),
    samePeriod: a.asOf === b.asOf,
    gapDays: Number.isFinite(gapDays) ? gapDays : null,
    samePortfolio: samePortfolio(a, b),
    overlap: pair?.overlap ?? null,
    sharedCount: pair?.count ?? 0,
    pairs,
    coverage,
    rows,
    query: q,
    scope,
    methodology:
      "Security-level comparison of positive NAV weights from explicitly long, non-derivative positions. CUSIP and ISIN aliases are reconciled only when unambiguous; names and tickers never establish a match. Weights are not renormalized. A zero means no eligible matching position, not proof of no economic exposure. Derivatives, missing identifiers, and unknown direction are excluded. There is no look-through into funds held by these funds.",
  };
}
export function fundComparisonCsv(result) {
  const evidence = (fund) => [
    fund?.ticker,
    fund?.asOf,
    fund?.filingDate,
    fund?.accession,
    fund?.sourceUrl,
  ];
  return fundCsv([
    ["Research type", "Security comparison"],
    ["Methodology", result.methodology || result.reason],
    ["Filter scope", result.scope, "Query", result.query],
    ...(result.errors || []).map((error) => [
      "Unavailable fund",
      error.ticker,
      error.message,
    ]),
    [],
    [
      "Security",
      "Identifiers",
      "Presence among eligible positions",
      "Left NAV weight %",
      "Right NAV weight %",
      "Left minus right percentage points",
      "Shared NAV weight percentage points",
      "Left ticker",
      "Left portfolio date",
      "Left filed date",
      "Left accession",
      "Left SEC source",
      "Right ticker",
      "Right portfolio date",
      "Right filed date",
      "Right accession",
      "Right SEC source",
    ],
    ...(result.rows || []).map((row) => [
      row.name,
      row.ids.join("; "),
      row.kind,
      row.leftWeight,
      row.rightWeight,
      row.difference,
      row.sharedWeight,
      ...evidence(result.left),
      ...evidence(result.right),
    ]),
  ]);
}
