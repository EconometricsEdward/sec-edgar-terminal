/** Fund-reported sectors for the expanded coverage universe. */
export const QUANT_GROUPS = [
  ['sector-technology', 'Information Technology'],
  ['sector-financials', 'Financials'],
  ['sector-healthcare', 'Health Care'],
  ['sector-consumer-discretionary', 'Consumer Discretionary'],
  ['sector-communication', 'Communication'],
  ['sector-industrials', 'Industrials'],
  ['sector-consumer-staples', 'Consumer Staples'],
  ['sector-energy', 'Energy'],
  ['sector-utilities', 'Utilities'],
  ['sector-real-estate', 'Real Estate'],
  ['sector-materials', 'Materials'],
].map(([id, label]) => ({ id, label }));
export const QUANT_BATCHES = 16;
export const QUANT_COVERAGE_VERSION = 'quant-coverage-v2';
export function quantBatch(cik) { return Number(cik) % QUANT_BATCHES; }
