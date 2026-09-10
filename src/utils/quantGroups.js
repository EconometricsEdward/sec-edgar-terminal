/** Fund-reported sectors for the expanded coverage universe. */
export const QUANT_GROUPS = [
  ['sector-technology', 'Information Technology', 'XLK'],
  ['sector-financials', 'Financials', 'XLF'],
  ['sector-healthcare', 'Health Care', 'XLV'],
  ['sector-consumer-discretionary', 'Consumer Discretionary', 'XLY'],
  ['sector-communication', 'Communication', 'XLC'],
  ['sector-industrials', 'Industrials', 'XLI'],
  ['sector-consumer-staples', 'Consumer Staples', 'XLP'],
  ['sector-energy', 'Energy', 'XLE'],
  ['sector-utilities', 'Utilities', 'XLU'],
  ['sector-real-estate', 'Real Estate', 'XLRE'],
  ['sector-materials', 'Materials', 'XLB'],
].map(([id, label, proxy]) => ({ id, label, proxy }));
export const QUANT_BATCHES = 16;
export const QUANT_COVERAGE_VERSION = 'quant-coverage-v1';
export function quantBatch(cik) { return Number(cik) % QUANT_BATCHES; }
