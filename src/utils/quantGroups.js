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
  ['sector-unclassified', 'Unclassified'],
].map(([id, label]) => ({ id, label }));
export const QUANT_BATCHES = 16;
export const QUANT_TARGET_ISSUERS = 5000;
export const QUANT_MAX_CHECKS_PER_BATCH = 256;
export const QUANT_COVERAGE_VERSION = 'quant-coverage-v2';
export function quantBatch(cik) { return Number(cik) % QUANT_BATCHES; }

/** Broad research grouping from SEC SIC; this is not a licensed GICS mapping. */
export function quantSectorForSic(value) {
  const sic = Number(value);
  if (!Number.isInteger(sic) || sic < 100 || sic > 9999) return 'Unclassified';
  const within = (min, max) => sic >= min && sic <= max;
  if (within(6500, 6599) || sic === 6798) return 'Real Estate';
  if (within(6000, 6799)) return 'Financials';
  if (within(2830, 2839) || within(3840, 3859) || within(8000, 8099)) return 'Health Care';
  if (within(1200, 1399) || within(2900, 2999) || sic === 4922 || sic === 5171 || sic === 5172) return 'Energy';
  if (within(4900, 4999)) return 'Utilities';
  if (within(4800, 4899) || within(7800, 7849) || within(2700, 2799)) return 'Communication';
  if (within(3570, 3579) || within(3660, 3679) || within(7370, 7379)) return 'Information Technology';
  if (within(100, 999) || within(2000, 2199) || within(5400, 5499) || sic === 2840 || sic === 2841 || sic === 2844) return 'Consumer Staples';
  if (within(1000, 1199) || within(1400, 1499) || within(2600, 2699) || within(2800, 2899) || within(3200, 3399)) return 'Materials';
  if (within(2200, 2399) || within(2500, 2599) || within(3000, 3199) || within(3700, 3716) || within(3900, 3999)
    || within(5200, 5399) || within(5500, 5999) || within(7000, 7299) || within(7900, 7999)) return 'Consumer Discretionary';
  if (within(1500, 1799) || within(2400, 2499) || within(3400, 3569) || within(3580, 3659) || within(3690, 3699)
    || within(3720, 3839) || within(4000, 4799) || within(5000, 5199) || within(7300, 7369) || within(7380, 7699) || within(8700, 8799)) return 'Industrials';
  return 'Unclassified';
}
