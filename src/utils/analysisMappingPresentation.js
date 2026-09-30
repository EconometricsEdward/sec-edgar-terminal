// Keep serving-only v2 compatibility wording identical to fresh v3 builds.
export const ANALYSIS_DEBT_LABEL = 'Selected reported debt';
export const ANALYSIS_INSURANCE_LENS_NOTE = 'Insurer views use reported net income and premiums. Generic operating-income tags can represent adjusted earnings and are not treated as comparable GAAP operating profit.';
export function analysisCashScopeNote(tag) {
  return tag === 'CashAndDueFromBanks'
    ? 'Reported cash and due from banks only. Separately reported interest-bearing deposits with banks and other cash-equivalent balances are not included or assumed to be zero.'
    : tag === 'Cash' ? 'Reported cash only; this narrower concept does not establish the combined cash-and-equivalents balance.'
      : "Reported cash and cash equivalents. Restricted-cash-inclusive totals are not substituted; availability for use follows the filing's disclosures.";
}
export function analysisCashLabel(tags) {
  const unique = new Set(tags);
  return unique.size === 1 && unique.has('CashAndDueFromBanks') ? 'Cash and due from banks'
    : unique.size === 1 && unique.has('Cash') ? 'Cash, excluding equivalents'
      : unique.size === 1 && unique.has('CashAndCashEquivalentsAtCarryingValue') ? 'Cash and equivalents'
        : 'Reported cash balance';
}
export function analysisDebtScopeNote(note = '') {
  return 'Selected reported borrowing subtotal, not a complete measure of every debt obligation. Financial filers can exclude secured financing or separately presented subordinated debt from these concepts. Components are not added without evidence that they do not overlap. ' + note;
}
