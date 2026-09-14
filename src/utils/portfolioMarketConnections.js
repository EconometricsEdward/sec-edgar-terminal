import { canonicalPortfolioCik } from "./portfolioModel.js";
import { scenarioMarketCandidates } from "./portfolioScenarioMarket.js";

export const MARKET_CATEGORY_LABELS = Object.freeze({
  rates: "Interest rates",
  currencies: "Currencies",
  energy: "Energy",
  metals: "Metals",
  agriculture: "Agriculture",
  other: "Other markets",
});
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const unique = (values) => [...new Set(values)];
const sum = (values) => values.reduce((total, value) => total + value, 0);

/** The analytics report has already combined included share classes by SEC issuer. */
export function marketConnectionIssuers(report) {
  const byCik = new Map();
  for (const issuer of report?.concentration?.issuers || []) {
    const cik = canonicalPortfolioCik(issuer.cik);
    if (!cik || byCik.has(cik)) continue;
    const tickers = unique(
      (issuer.tickers || []).map((value) => String(value).trim().toUpperCase()),
    ).sort();
    const ticker =
      tickers.find((value) => /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(value)) || "";
    byCik.set(cik, {
      ...issuer,
      cik,
      ticker,
      tickers,
      rowIds: unique(issuer.rowIds || []),
      sector: issuer.sector || "Unclassified",
      eligible: issuer.kind === "company" && Boolean(ticker),
    });
  }
  return [...byCik.values()].sort(
    (a, b) => a.ticker.localeCompare(b.ticker) || a.cik.localeCompare(b.cik),
  );
}

/**
 * Count verified filing connections independently of CFTC history availability.
 * Overlapping contracts/categories use issuer-set unions; no market exposure or
 * diversification score is inferred from text matches or allocation weights.
 */
export function buildPortfolioMarketConnections(
  report,
  results = [],
  { category = "all", basis = "companies", now = new Date() } = {},
) {
  const issuers = marketConnectionIssuers(report);
  const eligible = issuers.filter((issuer) => issuer.eligible);
  const allocationAvailable =
    report?.weighted === true && report?.concentration?.complete === true;
  const useAllocation = basis === "allocation" && allocationAvailable;
  const byIdentity = new Map();
  for (const result of results) {
    const cik = canonicalPortfolioCik(result?.cik);
    if (cik && typeof result.ticker === "string")
      byIdentity.set(`${cik}:${result.ticker}`, result);
  }
  const markets = new Map();
  const coverage = {
    total: issuers.length,
    eligible: eligible.length,
    attempted: 0,
    checked: 0,
    linked: 0,
    noMatch: 0,
    noFiling: 0,
    unavailable: 0,
    unchecked: 0,
    omittedLinks: 0,
    unsupported: issuers.length - eligible.length,
    unresolved: report?.unresolvedCount || 0,
    checkedAllocationPct: allocationAvailable ? 0 : null,
    linkedAllocationPct: allocationAvailable ? 0 : null,
  };
  const companyRows = eligible.map((issuer) => {
    const result = byIdentity.get(`${issuer.cik}:${issuer.ticker}`);
    if (!result) {
      coverage.unchecked++;
      return {
        ...issuer,
        status: "unchecked",
        links: [],
        message: "Filing scan has not completed.",
      };
    }
    coverage.attempted++;
    const context = result.context;
    const discovery = scenarioMarketCandidates(context, issuer, "", now);
    if (
      !discovery.verified ||
      result.status === "unavailable" ||
      context?.status !== result.status
    ) {
      coverage.unavailable++;
      return {
        ...issuer,
        status: "unavailable",
        links: [],
        message: String(
          result.message || "Filing evidence could not be verified.",
        ).slice(0, 300),
      };
    }
    coverage.omittedLinks += discovery.omitted;
    if (context.status === "no_filing") {
      coverage.noFiling++;
      return {
        ...issuer,
        status: "no_filing",
        links: [],
        message: "No usable annual filing was available.",
      };
    }
    coverage.checked++;
    if (allocationAvailable && finite(issuer.weightPct))
      coverage.checkedAllocationPct += issuer.weightPct;
    const links = context.status === "ready" ? discovery.links : [];
    if (!links.length) {
      coverage.noMatch++;
      return {
        ...issuer,
        status: "no_match",
        links: [],
        message:
          "No verified market passage found in the bounded scan. This does not establish zero exposure.",
      };
    }
    coverage.linked++;
    if (allocationAvailable && finite(issuer.weightPct))
      coverage.linkedAllocationPct += issuer.weightPct;
    for (const link of links) {
      if (!markets.has(link.key))
        markets.set(link.key, { ...link, members: [] });
      markets
        .get(link.key)
        .members.push({
          ...issuer,
          evidence: link.evidence,
          reason: link.reason,
          reviewQuestion: link.reviewQuestion,
        });
    }
    return {
      ...issuer,
      status: "linked",
      links,
      message: `${links.length} verified market connections.`,
    };
  });
  const describe = (market) => {
    const ciks = unique(market.members.map((member) => member.cik));
    const members = ciks.map((cik) =>
      market.members.find((member) => member.cik === cik),
    );
    const allocationPct = allocationAvailable
      ? sum(
          members.map((member) =>
            finite(member.weightPct) ? member.weightPct : 0,
          ),
        )
      : null;
    const sectors = unique(members.map((member) => member.sector)).sort();
    return {
      ...market,
      members,
      ciks,
      count: members.length,
      companyPct: eligible.length
        ? (100 * members.length) / eligible.length
        : null,
      allocationPct,
      sectors,
      sectorCount: sectors.filter((value) => value !== "Unclassified").length,
      value: useAllocation ? allocationPct : members.length,
    };
  };
  const allMarkets = [...markets.values()]
    .map(describe)
    .sort(
      (a, b) =>
        b.value - a.value ||
        b.count - a.count ||
        a.label.localeCompare(b.label),
    );
  const categories = Object.entries(MARKET_CATEGORY_LABELS).map(
    ([key, label]) => {
      const selected = allMarkets.filter((market) => market.category === key);
      return describe({
        key,
        label,
        members: selected.flatMap((market) => market.members),
        marketCount: selected.length,
      });
    },
  );
  const visibleMarkets = allMarkets.filter(
    (market) => category === "all" || market.category === category,
  );
  return {
    issuers,
    eligible,
    companyRows,
    coverage,
    allMarkets,
    markets: visibleMarkets,
    categories,
    allocationAvailable,
    basis: useAllocation ? "allocation" : "companies",
    completeScan:
      coverage.unchecked === 0 &&
      coverage.unavailable === 0 &&
      coverage.noFiling === 0 &&
      coverage.omittedLinks === 0,
    broadestMarket: allMarkets[0] || null,
    crossSectorMarkets: allMarkets.filter((market) => market.sectorCount > 1)
      .length,
  };
}

export function marketConnectionCsvRows(model) {
  const headers = [
    "record_type",
    "ticker",
    "cik",
    "company",
    "sector",
    "scan_status",
    "family",
    "contract",
    "market",
    "trader_group",
    "linked_company_count",
    "eligible_company_denominator",
    "allocation_in_linked_companies_pct",
    "company_allocation_pct",
    "form",
    "filed",
    "report_date",
    "accession",
    "sec_source",
    "filing_passage",
  ];
  const rows = [headers];
  for (const market of model.allMarkets)
    for (const member of market.members)
      for (const evidence of member.evidence)
        rows.push([
          "connection",
          member.ticker,
          member.cik,
          member.name,
          member.sector,
          "linked",
          market.family,
          market.contract,
          market.label,
          market.group,
          market.count,
          model.coverage.eligible,
          market.allocationPct ?? "",
          model.allocationAvailable ? member.weightPct : "",
          evidence.form,
          evidence.filed,
          evidence.reportDate || "",
          evidence.accession,
          evidence.url,
          evidence.text,
        ]);
  for (const company of model.companyRows.filter(
    (company) => company.status !== "linked",
  ))
    rows.push([
      "coverage",
      company.ticker,
      company.cik,
      company.name,
      company.sector,
      company.status,
      "",
      "",
      "",
      "",
      "",
      model.coverage.eligible,
      "",
      model.allocationAvailable ? company.weightPct : "",
      "",
      "",
      "",
      "",
      "",
      company.message,
    ]);
  rows.push([
    "methodology",
    "",
    "",
    "Market groups overlap. Weights measure allocation in linked companies, not market exposure. Only bounded annual-filing passages are scanned. Counts exclude fund look-through and unresolved positions.",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    model.coverage.eligible,
  ]);
  return rows;
}
