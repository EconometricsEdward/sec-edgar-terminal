import { evidenceSources } from "./researchEvidence.js";

// Only explicit scope distinctions belong here. A standard revenue-tag
// migration is not by itself evidence of a change in the reported amount's
// accounting scope, so Revenues and contract-revenue tags remain comparable.
const sourceScopes = {
  NetIncomeLoss: ["income attribution", "parent"],
  ProfitLoss: ["income attribution", "consolidated"],
  NetIncomeLossAvailableToCommonStockholdersBasic: ["income attribution", "common shareholders"],
  StockholdersEquity: ["equity attribution", "parent"],
  StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: ["equity attribution", "consolidated"],
  Cash: ["cash", "cash only"],
  CashAndDueFromBanks: ["cash", "cash and due from banks"],
  CashAndCashEquivalentsAtCarryingValue: ["cash", "cash and equivalents"],
  CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: ["cash", "including restricted cash"],
  CashAndCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect: ["cash-change", "excluding restricted cash"],
  CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect: ["cash-change", "including restricted cash"],
  EffectOfExchangeRateOnCashAndCashEquivalents: ["FX cash", "excluding restricted cash"],
  EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: ["FX cash", "including restricted cash"],
  LongTermDebtNoncurrent: ["noncurrent debt", "debt"],
  LongTermDebtAndCapitalLeaseObligations: ["noncurrent debt", "debt and capital leases"],
  RevenuesNetOfInterestExpense: ["revenue interest", "net of interest expense"],
  Revenues: ["revenue interest", "before interest expense"],
  RevenueFromContractWithCustomerExcludingAssessedTax: ["revenue interest", "before interest expense"],
  SalesRevenueNet: ["revenue interest", "before interest expense"],
};
/** Detect known unit/accounting-scope changes, not every possible taxonomy distinction. */
export function financialSourceScopeIssue(current, before) {
  const sourceSets = [current, before].map(evidenceSources);
  const units = sourceSets.map((sources) => [...new Set(sources.map((source) => source.unit).filter(Boolean))].sort());
  if (units.every((set) => set.length) && units[0].join("|") !== units[1].join("|"))
    return "The reported source units differ between periods; comparable change cannot be established.";
  const scopes = sourceSets.map((sources) => {
    const map = new Map();
    for (const source of sources) {
      const scope = source.taxonomy === "us-gaap" && sourceScopes[source.tag];
      if (!scope) continue;
      const [family, value] = scope;
      if (!map.has(family)) map.set(family, new Set());
      map.get(family).add(value);
    }
    return map;
  });
  for (const [family, values] of scopes[0]) {
    const prior = scopes[1].get(family);
    if (prior && [...values].sort().join("|") !== [...prior].sort().join("|"))
      return `The reported ${family} scopes differ between periods; comparable change cannot be established from these inputs.`;
  }
  return null;
}
