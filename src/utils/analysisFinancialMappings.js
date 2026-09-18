import { buildMetricRow } from "./xbrlParser.js";
import { selectFinancialFact, sumCompatibleFinancialFacts } from "./xbrlPeriods.js";
import { comparePointQuality } from "./compareQuality.js";
import {
  riskDebtBalances,
  riskLiabilitiesBalance,
  riskMarketableSecurities,
} from "./riskFinancialMappings.js";

const unavailable = (period, reason) => ({
  period, value: null, classification: "unavailable", sources: [], reason,
});
const scoped = (point, note) => point && ({
  ...point,
  note,
  source: point.source ? { ...point.source, scopeNote: note } : undefined,
  sources: point.sources.map((source) => ({ ...source, scopeNote: note })),
});

/** Analysis mappings retain the selected period, currency, filing cutoff and
 * reported accounting scope. The cache belongs to one company build only. */
export function createAnalysisFinancialMapper(company) {
  const facts = company.facts;
  const financial = Number(company.sic) >= 6000 && Number(company.sic) <= 6299;
  const debtCache = new Map();
  const select = (tags, period) => selectFinancialFact(facts, tags, period, "USD");
  const selectFlow = (tags, period) => {
    const selected = select(tags, period);
    return selected && comparePointQuality(selected, "revenue", period).valid ? selected : null;
  };
  const debt = (period) => {
    const key = `${period.end}:${period.asOf || ""}`;
    if (!debtCache.has(key)) debtCache.set(key, riskDebtBalances(facts, period));
    return debtCache.get(key);
  };
  const netRevenue = (period) => financial ? scoped(
    selectFlow(["RevenuesNetOfInterestExpense"], period),
    "Reported revenue after interest expense; this is not gross interest income. The same net revenue basis is used by revenue-based calculations.",
  ) : null;

  function point(key, period, fallback) {
    let selected;
    if (key === "revenue") selected = netRevenue(period) || fallback;
    else if (key === "bankRevenue") {
      selected = netRevenue(period) || sumCompatibleFinancialFacts([
        buildMetricRow(facts, "netInterestIncome", "Net interest income", [period], "currency", "banking").values[0],
        buildMetricRow(facts, "noninterestIncome", "Noninterest income", [period], "currency", "banking").values[0],
      ], "Net interest income before provision + noninterest income", period);
    } else if (key === "interestExpense") {
      selected = Number.isFinite(fallback?.value) ? fallback
        : scoped(selectFlow(financial ? ["InterestExpenseOperating", "InterestExpenseNonoperating", "InterestAndDebtExpense"]
          : ["InterestExpenseNonoperating", "InterestAndDebtExpense"], period),
        "Interest expense follows the cited reported concept. Operating interest expense at financial institutions and nonoperating financing expense have different presentation scopes; interest-and-debt expense can include other debt costs.");
    } else if (key === "dividendsPaid") {
      selected = Number.isFinite(fallback?.value) ? fallback
        : scoped(selectFlow(["PaymentsOfOrdinaryDividends"], period),
          "Reported cash payments of ordinary dividends, within the cited common, preferred and noncontrolling-interest scope. Capital distributions and unpaid declared dividends are not added.");
    } else if (key === "shortTermDebt") selected = debt(period).current;
    else if (key === "longTermDebt") selected = debt(period).noncurrent;
    else if (key === "totalDebt") {
      const aggregate = select(["DebtLongtermAndShorttermCombinedAmount"], period);
      // Complete, nonoverlapping balance-sheet components take priority: some
      // filers use the combined concept for a narrower debt-note subtotal.
      selected = Number.isFinite(debt(period).total?.value) ? debt(period).total
        : Number.isFinite(aggregate?.value) && aggregate.value >= 0
        && !aggregate.source?.start && aggregate.source?.end === period.end
        ? scoped(aggregate, "Reported combined short-term and long-term debt. No current/noncurrent allocation is inferred; lease and other obligation scope follows the cited concept.")
        : debt(period).total;
    } else if (key === "shortTermInvestments") selected = riskMarketableSecurities(facts, period, "current");
    else if (key === "longTermInvestments") selected = riskMarketableSecurities(facts, period, "noncurrent");
    else if (key === "totalLiabilities") selected = riskLiabilitiesBalance(facts, period);
    else selected = fallback;
    return { period, ...(selected || unavailable(period, "No compatible reported concept or complete reconciliation is available for this period.")) };
  }

  return {
    point,
    row(row, periods) {
      const values = periods.map((period, index) => point(row.key, period, row.values?.[index]));
      let label = ({ shortTermDebt: "Current debt", longTermDebt: "Noncurrent debt",
        shortTermInvestments: "Current investments", longTermInvestments: "Noncurrent investments",
        totalDebt: "Total reported debt" })[row.key] || row.label;
      if (["revenue", "bankRevenue"].includes(row.key)
        && values.some((value) => value.sources?.some((source) => source.tag === "RevenuesNetOfInterestExpense")))
        label = "Revenue, net of interest expense";
      return { ...row, label, values };
    },
  };
}
