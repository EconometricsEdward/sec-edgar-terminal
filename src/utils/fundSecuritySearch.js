import {
  fundCsv,
  fundEvidence,
  resolveSecurityGroups,
} from "./fundSecurity.js";

const text = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
const finite = (value) => typeof value === "number" && Number.isFinite(value);

// Preserve small, non-zero weights that would otherwise look like no holding.
export function securityWeight(value) {
  if (!finite(value)) return "Unavailable";
  if (value === 0) return "0.00%";
  if (Math.abs(value) < 0.01) return value < 0 ? "−<0.01%" : "<0.01%";
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

export function normalizeFundSecuritySearch(input = {}) {
  return {
    query: String(input.query ?? "")
      .trim()
      .slice(0, 160),
    asset: String(input.asset ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 20),
    country: String(input.country ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 20),
  };
}

function matchingText(holding, words) {
  const haystack = text(
    [
      holding.name,
      holding.title,
      holding.tickerSymbol,
      holding.cusip,
      holding.isin,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return words.every((word) => haystack.includes(word));
}

function aggregate(positions, key) {
  const known = positions
    .map((position) => position.holding[key])
    .filter(finite);
  const sum = known.length
    ? known.reduce((total, value) => total + value, 0)
    : null;
  const missing = positions.length - known.length;
  // A partial sum is useful evidence, but it is never the portfolio's complete total.
  return {
    total: missing || !finite(sum) ? null : sum,
    known: finite(sum) ? sum : null,
    missing,
    count: known.length,
  };
}

function positionTotals(positions) {
  const value = aggregate(positions, "value");
  const weight = aggregate(positions, "pctOfNav");
  return {
    positionCount: positions.length,
    value: value.total,
    knownValue: value.known,
    missingValueCount: value.missing,
    pctOfNav: weight.total,
    knownWeight: weight.known,
    missingWeightCount: weight.missing,
  };
}

/** Complete portfolios only. Pagination happens after this computation on the server. */
export function searchFundHoldings(portfolios = [], input = {}) {
  const settings = normalizeFundSecuritySearch(input);
  const words = text(settings.query).split(" ").filter(Boolean);
  const filters = (holding) =>
    (!settings.asset ||
      String(holding.assetCat || "").toUpperCase() === settings.asset) &&
    (!settings.country ||
      String(holding.invCountry || "").toUpperCase() === settings.country);
  const identity = resolveSecurityGroups(portfolios);
  const candidates = identity.groups.map((group) => ({
    ...group,
    identityStatus: "matched-identifiers",
  }));
  // Conflicting identifiers and records without usable identifiers remain separate.
  // A matching company name is never a license to merge different securities.
  for (const group of identity.ambiguous) {
    for (const position of group.positions)
      candidates.push({
        key: `conflict:${position.portfolioIndex}:${position.holdingIndex}`,
        ids: position.identity.ids,
        name: position.holding.name || "Unnamed security",
        positions: [position],
        identityStatus: "conflicting-identifiers",
      });
  }
  for (const position of identity.unidentified)
    candidates.push({
      key: `unidentified:${position.portfolioIndex}:${position.holdingIndex}`,
      ids: [],
      name: position.holding.name || "Unnamed security",
      positions: [position],
      identityStatus: "unidentified",
    });
  const matchedCounts = portfolios.map(() => 0);
  const rows = [];
  for (const candidate of candidates) {
    const positions = candidate.positions.filter((position) =>
      filters(position.holding),
    );
    if (!positions.some((position) => matchingText(position.holding, words)))
      continue;
    const funds = portfolios.flatMap((portfolio, portfolioIndex) => {
      const selected = positions.filter(
        (position) => position.portfolioIndex === portfolioIndex,
      );
      if (!selected.length) return [];
      matchedCounts[portfolioIndex] += selected.length;
      const value = aggregate(selected, "value"),
        weight = aggregate(selected, "pctOfNav");
      return [
        {
          ...fundEvidence(portfolio),
          positionCount: selected.length,
          value: value.total,
          knownValue: value.known,
          missingValueCount: value.missing,
          pctOfNav: weight.total,
          knownWeight: weight.known,
          missingWeightCount: weight.missing,
          positions: selected.map(({ holding, holdingIndex }) => ({
            ...holding,
            holdingIndex,
            textMatched: matchingText(holding, words),
          })),
        },
      ];
    });
    rows.push({
      key: candidate.key,
      ids: candidate.ids,
      name: candidate.name,
      identityStatus: candidate.identityStatus,
      fundCount: funds.length,
      positionCount: positions.length,
      funds,
    });
  }
  rows.sort(
    (a, b) =>
      b.fundCount - a.fundCount ||
      a.name.localeCompare(b.name) ||
      a.key.localeCompare(b.key),
  );
  const coverage = portfolios.map((portfolio, i) => ({
    ...fundEvidence(portfolio),
    status: matchedCounts[i] ? "matched" : "no-match",
    searchedPositions: portfolio.holdings?.length || 0,
    matchedPositions: matchedCounts[i],
  }));
  // Summarize the complete result BEFORE the API paginates securities. Keep
  // security identities separate and never add percentages across funds.
  const exposureByFund = portfolios.map((portfolio, index) => {
    const positions = rows.flatMap((row) =>
      row.funds
        .filter((fund) => fund.ticker === portfolio.ticker)
        .flatMap((fund) => fund.positions.map((holding) => ({ holding }))),
    );
    const assets = [
      ...new Set(positions.map(({ holding }) => holding.assetCat || "UNKNOWN")),
    ];
    return {
      ...coverage[index],
      ...positionTotals(positions),
      categories: assets.map((asset) => ({
        asset,
        ...positionTotals(
          positions.filter(
            ({ holding }) => (holding.assetCat || "UNKNOWN") === asset,
          ),
        ),
      })),
      stockPositionCount: positions.filter(
        ({ holding }) => holding.assetCat === "EC",
      ).length,
      derivativeCount: positions.filter(({ holding }) =>
        /^D(IR|CR|FE|E|CO|O)$/.test(holding.assetCat || ""),
      ).length,
      nonLongCount: positions.filter(
        ({ holding }) => text(holding.payoffProfile) !== "long",
      ).length,
    };
  });
  const sameDate =
    new Set(portfolios.map((portfolio) => portfolio.asOf || "unknown")).size <=
    1;
  const series = new Map();
  portfolios.forEach((portfolio) => {
    if (!portfolio.seriesId) return;
    const key = `${portfolio.cik}:${portfolio.seriesId}`;
    series.set(key, [...(series.get(key) || []), portfolio.ticker]);
  });
  return {
    settings,
    rows,
    coverage,
    exposureByFund,
    totalGroups: rows.length,
    matchedFunds: matchedCounts.filter((count) => count > 0).length,
    matchedPositions: matchedCounts.reduce((total, count) => total + count, 0),
    sameDate,
    sharedSeries: [...series.values()].filter((tickers) => tickers.length > 1),
    unidentifiedPositions: rows.filter(
      (row) => row.identityStatus === "unidentified",
    ).length,
    conflictingPositions: rows.filter(
      (row) => row.identityStatus === "conflicting-identifiers",
    ).length,
    options: {
      assets: [
        ...new Set(
          portfolios.flatMap((portfolio) =>
            (portfolio.holdings || [])
              .map((holding) => holding.assetCat)
              .filter(Boolean),
          ),
        ),
      ].sort(),
      countries: [
        ...new Set(
          portfolios.flatMap((portfolio) =>
            (portfolio.holdings || [])
              .map((holding) => holding.invCountry)
              .filter(Boolean),
          ),
        ),
      ].sort(),
    },
    methodology:
      "All search words must appear in the reported name, title, ticker, CUSIP or ISIN. Identifier-linked positions are included across funds, within the chosen asset and country filters. Only consistent reported CUSIP/ISIN links establish a security match. Names and tickers do not establish issuer identity. Signed NAV weights and USD fair values are added within each fund only. Missing observations make the total unavailable; known subtotals are shown separately. Derivative fair value is not underlying exposure. No look-through into other funds.",
  };
}

export function searchFundHoldingsCsv(result) {
  const settings = normalizeFundSecuritySearch(result.settings);
  const headers = [
    "record_type",
    "search_query",
    "asset_filter",
    "country_filter",
    "group_key",
    "identity_status",
    "fund_ticker",
    "portfolio_as_of",
    "filed",
    "accession",
    "sec_series",
    "position_name",
    "title",
    "reported_ticker",
    "cusip",
    "isin",
    "asset_category",
    "country",
    "payoff_profile",
    "position_usd_value",
    "position_nav_weight_pct",
    "group_complete_usd_value",
    "group_known_usd_subtotal",
    "group_missing_values",
    "group_complete_nav_weight_pct",
    "group_known_weight_subtotal_pct",
    "group_missing_weights",
    "searched_positions",
    "matched_positions",
    "notes",
    "sec_source",
    "summary_asset_category",
    "summary_complete_usd_value",
    "summary_known_usd_subtotal",
    "summary_missing_values",
    "summary_complete_nav_weight_pct",
    "summary_known_weight_subtotal_pct",
    "summary_missing_weights",
  ];
  const rows = [headers];
  const add = (entry) =>
    rows.push(
      headers.map(
        (header) =>
          ({
            search_query: settings.query,
            asset_filter: settings.asset,
            country_filter: settings.country,
            ...entry,
          })[header] ?? "",
      ),
    );
  add({ record_type: "methodology", notes: result.methodology });
  for (const fund of result.exposureByFund || []) {
    for (const summary of [{ ...fund, asset: "" }, ...fund.categories]) {
      add({
        record_type: summary.asset ? "asset_summary" : "fund_summary",
        fund_ticker: fund.ticker,
        portfolio_as_of: fund.asOf,
        filed: fund.filingDate,
        accession: fund.accession,
        sec_series: fund.seriesId,
        sec_source: fund.sourceUrl,
        matched_positions: summary.positionCount,
        summary_asset_category: summary.asset,
        summary_complete_usd_value: summary.value,
        summary_known_usd_subtotal: summary.knownValue,
        summary_missing_values: summary.missingValueCount,
        summary_complete_nav_weight_pct: summary.pctOfNav,
        summary_known_weight_subtotal_pct: summary.knownWeight,
        summary_missing_weights: summary.missingWeightCount,
        notes:
          "All search matches within this fund only; not verified issuer exposure. Derivative fair value is not underlying exposure. No match does not prove zero exposure.",
      });
    }
  }
  if (!result.sameDate)
    add({
      record_type: "warning",
      notes:
        "Portfolio dates differ; results are historical snapshots across different dates.",
    });
  for (const tickers of result.sharedSeries || [])
    add({
      record_type: "warning",
      notes: `${tickers.join(", ")} share the same SEC portfolio series. Do not count their holdings as independent portfolios.`,
    });
  for (const fund of result.coverage || [])
    add({
      record_type:
        fund.status === "no-match" ? "searched_no_match" : "searched_matched",
      fund_ticker: fund.ticker,
      portfolio_as_of: fund.asOf,
      filed: fund.filingDate,
      accession: fund.accession,
      sec_series: fund.seriesId,
      searched_positions: fund.searchedPositions,
      matched_positions: fund.matchedPositions,
      sec_source: fund.sourceUrl,
    });
  for (const failure of result.errors || [])
    add({
      record_type: "not_searched",
      fund_ticker: failure.ticker,
      notes:
        failure.message ||
        "Portfolio unavailable; no-match conclusion cannot be drawn.",
    });
  for (const group of result.rows || [])
    for (const fund of group.funds)
      for (const position of fund.positions)
        add({
          record_type: "position",
          group_key: group.key,
          identity_status: group.identityStatus,
          fund_ticker: fund.ticker,
          portfolio_as_of: fund.asOf,
          filed: fund.filingDate,
          accession: fund.accession,
          sec_series: fund.seriesId,
          position_name: position.name,
          title: position.title,
          reported_ticker: position.tickerSymbol,
          cusip: position.cusip,
          isin: position.isin,
          asset_category: position.assetCat,
          country: position.invCountry,
          payoff_profile: position.payoffProfile,
          position_usd_value: position.value,
          position_nav_weight_pct: position.pctOfNav,
          group_complete_usd_value: fund.value,
          group_known_usd_subtotal: fund.knownValue,
          group_missing_values: fund.missingValueCount,
          group_complete_nav_weight_pct: fund.pctOfNav,
          group_known_weight_subtotal_pct: fund.knownWeight,
          group_missing_weights: fund.missingWeightCount,
          notes: position.textMatched
            ? "Reported text matches search"
            : "Included through consistent reported security identifiers",
          sec_source: fund.sourceUrl,
        });
  return fundCsv(rows);
}

export function securitySearchEvidence(row, result) {
  const searched = (result.coverage || [])
    .map((fund) => fund.ticker)
    .join(", ");
  const failed = (result.errors || []).map((fund) => fund.ticker).join(", ");
  const shared = (result.sharedSeries || [])
    .map((group) => group.join(" / "))
    .join("; ");
  return {
    kind: "security",
    title: row.name,
    summary: `${row.positionCount} reported position records across ${row.fundCount} selected funds. Search: ${result.settings.query || "all securities"}; asset: ${result.settings.asset || "all"}; country: ${result.settings.country || "all"}. ${row.ids.join(" / ") || "No usable security identifier; record kept separate."}${row.identityStatus === "conflicting-identifiers" ? " Conflicting identifiers; record kept separate." : ""}${!result.sameDate ? " Portfolio dates differ." : ""}${searched ? ` Search reviewed ${searched}.` : ""}${failed ? ` Not searched: ${failed}; no-match conclusion unavailable.` : ""}${shared ? ` Shared SEC portfolio series: ${shared}.` : ""}`,
    values: row.funds.flatMap((fund) => [
      {
        label: `${fund.ticker} signed NAV weight`,
        value: fund.pctOfNav,
        unit: "%",
      },
      {
        label: `${fund.ticker} USD fair value`,
        value: fund.value,
        unit: "USD",
      },
      { label: `${fund.ticker} position records`, value: fund.positionCount },
      ...(fund.missingWeightCount
        ? [
            {
              label: `${fund.ticker} weights unavailable`,
              value: fund.missingWeightCount,
            },
            {
              label: `${fund.ticker} known weight subtotal`,
              value: fund.knownWeight,
              unit: "%",
            },
          ]
        : []),
      ...(fund.missingValueCount
        ? [
            {
              label: `${fund.ticker} values unavailable`,
              value: fund.missingValueCount,
            },
          ]
        : []),
    ]),
    sources: (result.coverage || row.funds).map((fund) => ({
      ticker: fund.ticker,
      name: fund.name,
      accession: fund.accession,
      asOf: fund.asOf,
      filingDate: fund.filingDate,
      sourceUrl: fund.sourceUrl,
    })),
    methodology: result.methodology,
  };
}
