import {
  fundCsv,
  fundEvidence,
  resolveSecurityGroups,
  securityEligibility,
} from "./fundSecurity.js";

const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
export function validateFundAllocations(tickers = [], weights = {}) {
  const errors = [],
    parsed = {};
  if (
    !tickers.length ||
    tickers.length > 4 ||
    new Set(tickers).size !== tickers.length
  )
    errors.push(
      "Choose one to four distinct funds before setting allocations.",
    );
  if (!weights || typeof weights !== "object" || Array.isArray(weights))
    weights = {};
  for (const key of Object.keys(weights))
    if (!tickers.includes(key))
      errors.push(
        `Remove the allocation for ${key}; that fund is not selected.`,
      );
  for (const ticker of tickers) {
    const raw = weights[ticker];
    const usable =
      typeof raw === "number"
        ? Number.isFinite(raw)
        : typeof raw === "string" && DECIMAL.test(raw.trim());
    const value = usable ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < 0 || value > 100)
      errors.push(`${ticker}: enter an allocation from 0% to 100%.`);
    else parsed[ticker] = value;
  }
  const sum = Object.values(parsed).reduce((total, value) => total + value, 0);
  if (
    Object.keys(parsed).length === tickers.length &&
    Math.abs(sum - 100) > 1e-8
  )
    errors.push(
      `Allocations total ${Number(sum.toFixed(10))}%. Set the total to 100%.`,
    );
  return { valid: errors.length === 0, sum, weights: parsed, errors };
}
export function equalFundAllocations(tickers = []) {
  if (!tickers.length) return {};
  const weight = Math.floor((100 / tickers.length) * 1000000) / 1000000;
  return Object.fromEntries(
    tickers.map((ticker, index) => [
      ticker,
      String(
        index === tickers.length - 1
          ? Number((100 - weight * index).toFixed(6))
          : weight,
      ),
    ]),
  );
}
const portfolioKey = (fund) =>
  fund.seriesId && fund.cik
    ? `${fund.cik}:${fund.seriesId}`
    : `${fund.cik || "unknown"}:${fund.accession || fund.ticker}`;
const sumSafe = (values) => {
  const result = values.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(result) ? result : null;
};
export function buildFundAllocation(
  portfolios = [],
  { tickers = portfolios.map((p) => p.ticker), weights = {}, errors = [] } = {},
) {
  const validation = validateFundAllocations(tickers, weights);
  const notes = [
    "Each contribution is the chosen fund allocation × the security’s reported NAV weight ÷ 100. Weights are not rescaled to the holdings that could be matched.",
    "Only positive, explicitly long, non-derivative holdings with unambiguous CUSIP or ISIN identifiers enter security totals. Names and trading tickers do not establish a match.",
    "Excluded and unknown positions remain outside these totals. Any difference from 100% is not cash or a reconciled balance. Gross reported weights can exceed 100%.",
    "This combines historical portfolio snapshots. It does not estimate current holdings, returns, risk, or share-class fees, and does not look through holdings in other funds.",
  ];
  if (!validation.valid)
    return {
      ready: false,
      validation,
      rows: [],
      notes,
      funds: [],
      coverage: null,
      samePortfolioGroups: [],
      mixedDates: false,
      partial: false,
    };
  const active = tickers.filter((ticker) => validation.weights[ticker] > 0);
  const loaded = active
    .map((ticker) =>
      portfolios.find(
        (p) =>
          p.ticker === ticker &&
          Array.isArray(p.holdings) &&
          (!p.status || p.status === "ready"),
      ),
    )
    .filter(Boolean);
  const missing = active.filter(
    (ticker) => !loaded.some((p) => p.ticker === ticker),
  );
  const matched = resolveSecurityGroups(loaded);
  const eligibleKeys = new Set(),
    ambiguousKeys = new Set();
  for (const group of matched.groups)
    for (const position of group.positions)
      eligibleKeys.add(`${position.portfolioIndex}:${position.holdingIndex}`);
  for (const group of matched.ambiguous)
    for (const position of group.positions)
      ambiguousKeys.add(`${position.portfolioIndex}:${position.holdingIndex}`);
  const funds = tickers.map((ticker) => {
    const allocation = validation.weights[ticker],
      portfolioIndex = loaded.findIndex((p) => p.ticker === ticker),
      fund = loaded[portfolioIndex];
    const result = {
      ticker,
      allocation,
      available: Boolean(fund),
      zeroAllocation: allocation === 0,
      source: fund ? fundEvidence(fund) : null,
      error: null,
      positionCount: 0,
      eligibleCount: 0,
      excludedCount: 0,
      unknownWeightCount: 0,
      ambiguousCount: 0,
      unidentifiedCount: 0,
      eligibleWeight: 0,
      excludedPositiveWeight: 0,
      nonpositiveWeight: 0,
    };
    if (!fund) {
      result.error =
        allocation === 0
          ? null
          : errors.find((e) => e.ticker === ticker)?.message ||
            "Portfolio unavailable for this allocation.";
      return result;
    }
    const eligibleWeights = [],
      excludedPositive = [],
      nonpositive = [];
    fund.holdings.forEach((holding, holdingIndex) => {
      result.positionCount++;
      const key = `${portfolioIndex}:${holdingIndex}`;
      if (!Number.isFinite(holding.pctOfNav)) {
        result.unknownWeightCount++;
        result.excludedCount++;
        return;
      }
      const eligible =
        securityEligibility(holding).eligible && eligibleKeys.has(key);
      if (eligible) {
        result.eligibleCount++;
        eligibleWeights.push(holding.pctOfNav);
      } else {
        result.excludedCount++;
        if (ambiguousKeys.has(key)) result.ambiguousCount++;
        else if (!eligibleKeys.has(key)) result.unidentifiedCount++;
        if (holding.pctOfNav > 0) excludedPositive.push(holding.pctOfNav);
        else nonpositive.push(holding.pctOfNav);
      }
    });
    result.eligibleWeight = sumSafe(eligibleWeights);
    result.excludedPositiveWeight = sumSafe(excludedPositive);
    result.nonpositiveWeight = sumSafe(nonpositive);
    return result;
  });
  const rows = matched.groups
    .map((group) => {
      const contributions = loaded
        .map((fund, index) => {
          const positions = group.positions.filter(
            (p) =>
              p.portfolioIndex === index &&
              securityEligibility(p.holding).eligible,
          );
          if (!positions.length) return null;
          const holdingWeight = sumSafe(
            positions.map((p) => p.holding.pctOfNav),
          );
          const contribution =
            holdingWeight == null
              ? null
              : holdingWeight * (validation.weights[fund.ticker] / 100);
          return {
            ticker: fund.ticker,
            allocation: validation.weights[fund.ticker],
            holdingWeight,
            contribution: Number.isFinite(contribution) ? contribution : null,
            positionCount: positions.length,
            source: fundEvidence(fund),
            portfolioKey: portfolioKey(fund),
          };
        })
        .filter(Boolean);
      const weight = contributions.some((c) => c.contribution == null)
        ? null
        : sumSafe(contributions.map((c) => c.contribution));
      const portfolioCount = new Set(contributions.map((c) => c.portfolioKey))
        .size;
      return {
        key: group.key,
        ids: group.ids,
        name: group.name,
        contributions,
        weight,
        fundCount: contributions.length,
        portfolioCount,
        duplicated: portfolioCount > 1,
      };
    })
    .filter((row) => row.contributions.length)
    .sort(
      (a, b) =>
        (b.weight ?? -Infinity) - (a.weight ?? -Infinity) ||
        a.key.localeCompare(b.key),
    );
  const weighted = (key) =>
    !loaded.length
      ? null
      : funds.some((f) => f.available && f[key] == null)
        ? null
        : sumSafe(
            funds
              .filter((f) => f.available)
              .map((f) => f[key] * (f.allocation / 100)),
          );
  const same = new Map();
  for (const fund of loaded) {
    const key = portfolioKey(fund);
    same.set(key, [...(same.get(key) || []), fund.ticker]);
  }
  const coverage = {
    requestedFundCount: active.length,
    reviewedFundCount: loaded.length,
    reviewedAllocation: loaded.reduce(
      (sum, fund) => sum + validation.weights[fund.ticker],
      0,
    ),
    unavailableAllocation: missing.reduce(
      (sum, ticker) => sum + validation.weights[ticker],
      0,
    ),
    eligibleWeight: weighted("eligibleWeight"),
    excludedPositiveWeight: weighted("excludedPositiveWeight"),
    nonpositiveWeight: weighted("nonpositiveWeight"),
    unknownWeightCount: funds.reduce((sum, f) => sum + f.unknownWeightCount, 0),
    ambiguousCount: funds.reduce((sum, f) => sum + f.ambiguousCount, 0),
    unidentifiedCount: funds.reduce((sum, f) => sum + f.unidentifiedCount, 0),
    securityCount: rows.length,
    duplicatedSecurityCount: rows.filter((r) => r.duplicated).length,
    top10Weight: !loaded.length
      ? null
      : rows.slice(0, 10).some((r) => r.weight == null)
        ? null
        : sumSafe(rows.slice(0, 10).map((r) => r.weight)),
    largest: rows[0]
      ? { key: rows[0].key, name: rows[0].name, weight: rows[0].weight }
      : null,
  };
  const mixedDates = new Set(loaded.map((p) => p.asOf)).size > 1;
  const samePortfolioGroups = [...same.values()].filter(
    (group) => group.length > 1,
  );
  if (mixedDates)
    notes.unshift(
      "The selected portfolios have different reporting dates. Combined weights describe those mixed snapshots, not a single point in time.",
    );
  if (samePortfolioGroups.length)
    notes.unshift(
      "Some tickers identify the same SEC portfolio. Their weighted contributions are combined, but they do not count as separate portfolios for duplicated-security labels.",
    );
  if (missing.length)
    notes.unshift(
      `Incomplete coverage: ${missing.join(", ")} could not be reviewed. Their allocations remain missing and the successful funds are not increased to replace them.`,
    );
  if (rows.some((r) => r.weight == null))
    notes.unshift(
      "One or more reported totals exceed numeric limits; affected values are unavailable rather than treated as zero.",
    );
  return {
    ready: true,
    validation,
    rows,
    largestDuplicated: rows.filter((row) => row.duplicated).slice(0, 10),
    funds,
    coverage,
    samePortfolioGroups,
    mixedDates,
    partial: missing.length > 0,
    notes,
  };
}
export function fundAllocationCsv(result) {
  const rows = [
    [
      "Record",
      "Security",
      "Identifiers",
      "Combined allocation %",
      "Fund",
      "Chosen fund allocation %",
      "Holding NAV weight %",
      "Contribution percentage points",
      "Portfolio as of",
      "SEC accession",
      "Filing date",
      "SEC source",
      "Detail",
    ],
  ];
  for (const note of result.notes || [])
    rows.push(["Method", "", "", "", "", "", "", "", "", "", "", "", note]);
  for (const fund of result.funds || [])
    rows.push([
      "Coverage",
      "",
      "",
      "",
      fund.ticker,
      fund.allocation,
      fund.eligibleWeight,
      fund.eligibleWeight == null
        ? null
        : fund.eligibleWeight * (fund.allocation / 100),
      fund.source?.asOf,
      fund.source?.accession,
      fund.source?.filingDate,
      fund.source?.sourceUrl,
      fund.zeroAllocation
        ? "0% allocation; not required for calculation"
        : fund.error ||
          `Eligible positions ${fund.eligibleCount}; excluded ${fund.excludedCount}; unknown weights ${fund.unknownWeightCount}; excluded positive NAV weight ${fund.excludedPositiveWeight}; nonpositive NAV weight ${fund.nonpositiveWeight}`,
    ]);
  for (const row of result.rows || [])
    for (const contribution of row.contributions)
      rows.push([
        "Security contribution",
        row.name,
        row.ids.join(" | "),
        row.weight,
        contribution.ticker,
        contribution.allocation,
        contribution.holdingWeight,
        contribution.contribution,
        contribution.source.asOf,
        contribution.source.accession,
        contribution.source.filingDate,
        contribution.source.sourceUrl,
        row.duplicated
          ? "Held across distinct SEC portfolios"
          : row.fundCount > 1
            ? "Share classes of the same SEC portfolio"
            : "One selected fund",
      ]);
  return fundCsv(rows);
}
