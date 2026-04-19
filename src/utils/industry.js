/**
 * Industry classification from SIC code.
 *
 * SIC (Standard Industrial Classification) codes are 4-digit numbers the SEC uses to
 * categorize companies. We group them into analytical buckets that share meaningful ratios.
 *
 * References:
 *   - SEC SIC code list: https://www.sec.gov/info/edgar/siccodes.htm
 *   - NAICS conversion: https://www.census.gov/naics/
 */

export const INDUSTRY_GROUPS = {
  BANKING: 'banking',
  INSURANCE: 'insurance',
  REIT: 'reit',
  OIL_GAS: 'oil_gas',
  AIRLINES: 'airlines',
  TECH: 'tech',
  RETAIL: 'retail',
  PHARMA: 'pharma',
  MANUFACTURING: 'manufacturing',
  UTILITIES: 'utilities',
  GENERAL: 'general',
};

/**
 * Classify a company by SIC code.
 * Returns one of INDUSTRY_GROUPS values.
 */
export function classifyIndustry(sicCode) {
  const sic = parseInt(sicCode, 10) || 0;

  // Depository Institutions, Non-depository Credit, Holding Companies
  if (sic >= 6000 && sic <= 6199) return INDUSTRY_GROUPS.BANKING;

  // Insurance Carriers, Insurance Agents
  if (sic >= 6300 && sic <= 6411) return INDUSTRY_GROUPS.INSURANCE;

  // Real Estate Investment Trusts
  if (sic === 6798 || (sic >= 6500 && sic <= 6799)) return INDUSTRY_GROUPS.REIT;

  // Oil & Gas Extraction / Petroleum Refining
  if (sic === 1311 || sic === 1381 || sic === 1382 || sic === 2911 || sic === 1389) {
    return INDUSTRY_GROUPS.OIL_GAS;
  }

  // Air Transportation
  if (sic === 4512 || sic === 4513) return INDUSTRY_GROUPS.AIRLINES;

  // Prepackaged Software, Computer Services, Computer Programming
  if ((sic >= 7370 && sic <= 7379) || sic === 7389) return INDUSTRY_GROUPS.TECH;

  // Pharmaceutical Preparations, Biological Products
  if (sic === 2834 || sic === 2836 || sic === 2835) return INDUSTRY_GROUPS.PHARMA;

  // Retail Trade (all divisions)
  if (sic >= 5200 && sic <= 5999) return INDUSTRY_GROUPS.RETAIL;

  // Electric / Gas / Water Utilities
  if (sic >= 4900 && sic <= 4939) return INDUSTRY_GROUPS.UTILITIES;

  // Manufacturing (broad)
  if (sic >= 2000 && sic <= 3999) return INDUSTRY_GROUPS.MANUFACTURING;

  return INDUSTRY_GROUPS.GENERAL;
}

/**
 * Human-readable industry label for display.
 */
export function industryLabel(group) {
  const labels = {
    [INDUSTRY_GROUPS.BANKING]: 'Banking',
    [INDUSTRY_GROUPS.INSURANCE]: 'Insurance',
    [INDUSTRY_GROUPS.REIT]: 'Real Estate (REIT)',
    [INDUSTRY_GROUPS.OIL_GAS]: 'Oil & Gas',
    [INDUSTRY_GROUPS.AIRLINES]: 'Airlines',
    [INDUSTRY_GROUPS.TECH]: 'Technology / Software',
    [INDUSTRY_GROUPS.RETAIL]: 'Retail',
    [INDUSTRY_GROUPS.PHARMA]: 'Pharmaceuticals / Biotech',
    [INDUSTRY_GROUPS.MANUFACTURING]: 'Manufacturing',
    [INDUSTRY_GROUPS.UTILITIES]: 'Utilities',
    [INDUSTRY_GROUPS.GENERAL]: 'General',
  };
  return labels[group] || 'General';
}

/**
 * For each industry, which standard ratios make sense and which are non-applicable.
 * Used to hide irrelevant rows rather than showing empty ones.
 */
export function applicableStandardRatios(group) {
  if (group === INDUSTRY_GROUPS.BANKING) {
    return new Set(['Net Margin', 'Return on Equity (ROE)', 'Return on Assets (ROA)']);
  }
  if (group === INDUSTRY_GROUPS.INSURANCE) {
    return new Set(['Net Margin', 'Return on Equity (ROE)', 'Return on Assets (ROA)', 'Debt-to-Equity']);
  }
  // General companies get everything
  return null; // null means "show all"
}

/**
 * Explanation shown in a banner when user views an industry-specific analysis.
 * Sets expectations about what data is / isn't available.
 */
export function industryDisclosure(group) {
  switch (group) {
    case INDUSTRY_GROUPS.BANKING:
      return {
        tone: 'info',
        title: 'Banking industry detected.',
        body: 'Industry-specific ratios include Net Interest Margin (NIM), Efficiency Ratio, Loan-to-Deposit, and Allowance Coverage. Traditional "Gross Margin" and "Cost of Revenue" are not applicable to banks.',
      };
    case INDUSTRY_GROUPS.INSURANCE:
      return {
        tone: 'info',
        title: 'Insurance industry detected.',
        body: 'Industry-specific ratios include Loss Ratio, Expense Ratio, and Combined Ratio where data permits. Life and P&C insurers report differently — some metrics may be missing for non-P&C carriers.',
      };
    case INDUSTRY_GROUPS.TECH:
      return {
        tone: 'info',
        title: 'Technology / Software industry detected.',
        body: 'Added ratios include R&D Intensity, FCF Margin, and Rule of 40. Note: SaaS-specific metrics like ARR, Net Revenue Retention, and Magic Number are non-GAAP and not available in XBRL data — check investor presentations for those.',
      };
    case INDUSTRY_GROUPS.RETAIL:
      return {
        tone: 'info',
        title: 'Retail industry detected.',
        body: 'Added ratios include Inventory Turnover, Days Sales Outstanding, Asset Turnover. Same-store (comparable) sales is non-GAAP and not available in XBRL — check earnings releases.',
      };
    case INDUSTRY_GROUPS.PHARMA:
      return {
        tone: 'info',
        title: 'Pharmaceutical / Biotech industry detected.',
        body: 'Added ratios include R&D Intensity, Cash Runway. Pipeline valuations and clinical trial data are narrative, not in XBRL.',
      };
    case INDUSTRY_GROUPS.MANUFACTURING:
      return {
        tone: 'info',
        title: 'Manufacturing industry detected.',
        body: 'Added ratios include Asset Turnover, Inventory Turnover, Working Capital Ratio, Operating Leverage indicators.',
      };
    case INDUSTRY_GROUPS.REIT:
      return {
        tone: 'warn',
        title: 'REIT detected — limited XBRL coverage.',
        body: 'Key REIT metrics (FFO, AFFO, NOI, Same-Store NOI) are non-GAAP and not reliably available in SEC XBRL data. Always verify these figures against the REIT\'s supplemental investor package. Standard ratios below may be misleading for REITs.',
      };
    case INDUSTRY_GROUPS.OIL_GAS:
      return {
        tone: 'warn',
        title: 'Oil & Gas detected — limited XBRL coverage.',
        body: 'Industry-critical metrics (proved reserves, reserve life, F&D costs, netbacks) are reported in 10-K narrative and not available in SEC XBRL data. Standard financial ratios below apply but don\'t capture the full operational picture.',
      };
    case INDUSTRY_GROUPS.AIRLINES:
      return {
        tone: 'warn',
        title: 'Airlines detected — limited XBRL coverage.',
        body: 'Operational metrics (load factor, CASM, RASM, yield, available seat miles) are reported in 10-K narrative and investor presentations, not available in SEC XBRL data.',
      };
    case INDUSTRY_GROUPS.UTILITIES:
      return {
        tone: 'warn',
        title: 'Utilities detected — limited XBRL coverage.',
        body: 'Rate base, allowed ROE, and other regulatory metrics come from state PUC filings (not SEC). Standard financial ratios apply but regulatory context is missing.',
      };
    default:
      return null;
  }
}
