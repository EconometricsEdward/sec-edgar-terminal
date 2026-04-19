// ============================================================================
// 8-K Item Parser
//
// When a company files an 8-K with SEC, the filing declares which "items" it
// reports under. Items are categorized disclosures — Item 1.01 is entry into a
// material agreement, Item 2.02 is earnings results, Item 5.02 is executive
// departure/appointment, Item 9.01 is financial exhibits, etc.
//
// The item list is available two ways:
//   1. In the submissions/CIK{cik}.json response, as a `items` field on each
//      recent filing (modern SEC responses include this)
//   2. In the filing's index page HTML (fallback for older filings)
//
// This utility handles both cases and returns item codes + human-readable labels.
// ============================================================================

// Mapping of 8-K item codes to short, scannable labels.
// Reference: https://www.sec.gov/files/form8-k.pdf
// Only the most common items are labeled; unknown items fall back to code-only display.
export const ITEM_8K_LABELS = {
  // Section 1 — Registrant's Business and Operations
  '1.01': 'Material Agreement',
  '1.02': 'Terminated Agreement',
  '1.03': 'Bankruptcy',
  '1.04': 'Mine Safety',
  '1.05': 'Cybersecurity Incident',

  // Section 2 — Financial Information
  '2.01': 'Acquisition/Disposition',
  '2.02': 'Earnings Release',
  '2.03': 'Off-BS Arrangement',
  '2.04': 'Accelerated Obligation',
  '2.05': 'Exit/Disposal Costs',
  '2.06': 'Material Impairment',

  // Section 3 — Securities and Trading Markets
  '3.01': 'Listing/Delisting',
  '3.02': 'Unregistered Sale',
  '3.03': 'Modified Shareholder Rights',

  // Section 4 — Matters Related to Accountants and Financial Statements
  '4.01': 'Change of Accountant',
  '4.02': 'Non-Reliance on Prior Financials',

  // Section 5 — Corporate Governance and Management
  '5.01': 'Change of Control',
  '5.02': 'Executive Change',
  '5.03': 'Bylaws/Charter Change',
  '5.04': 'Blackout Period',
  '5.05': 'Ethics Waiver',
  '5.06': 'Shell Company Status',
  '5.07': 'Shareholder Vote',
  '5.08': 'Shareholder Director Nominations',

  // Section 6 — Asset-Backed Securities
  '6.01': 'ABS Informational',
  '6.02': 'Change of Servicer',
  '6.03': 'Change in Credit Enhancement',
  '6.04': 'Failure to Make Distribution',
  '6.05': 'Securities Act Updating Disclosure',

  // Section 7 — Regulation FD
  '7.01': 'Regulation FD Disclosure',

  // Section 8 — Other Events
  '8.01': 'Other Events',

  // Section 9 — Financial Statements and Exhibits
  '9.01': 'Financial Exhibits',
};

/**
 * Get a short, human-readable label for an 8-K item code.
 * Returns the code itself if no label is defined.
 */
export function getItemLabel(code) {
  return ITEM_8K_LABELS[code] || `Item ${code}`;
}

/**
 * Extract 8-K item codes from a filing's items field (if present in submissions.json).
 * SEC includes items in recent filings data. Returns an array of item code strings.
 *
 * The items field in the SEC submissions API comes as a string with codes separated
 * by commas and/or the literal text "Item" prefix. Examples:
 *   "2.02,9.01"
 *   "Item 2.02, Item 9.01"
 *   "5.02"
 * We normalize all variations to just the numeric codes.
 */
export function parseItemsFromSubmissions(itemsField) {
  if (!itemsField || typeof itemsField !== 'string') return [];
  // Match patterns like "1.01", "2.02", "5.02" etc. — one or more digits, dot, two digits
  const matches = itemsField.match(/\b\d+\.\d{2}\b/g);
  return matches || [];
}

/**
 * Get display-ready info for 8-K items: array of { code, label } objects.
 * Sorted by item code numerically.
 */
export function getItemsInfo(itemsField) {
  const codes = parseItemsFromSubmissions(itemsField);
  return codes
    .map((code) => ({ code, label: getItemLabel(code) }))
    .sort((a, b) => {
      const [aMaj, aMin] = a.code.split('.').map(Number);
      const [bMaj, bMin] = b.code.split('.').map(Number);
      if (aMaj !== bMaj) return aMaj - bMaj;
      return aMin - bMin;
    });
}
