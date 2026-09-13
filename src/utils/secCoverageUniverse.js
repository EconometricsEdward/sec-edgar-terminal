import snapshot from '../data/sec-coverage-2026-09-08.json' with { type: 'json' };
import { normalizeSecCoverageCik, normalizeSecCoverageTicker, validateSecCoverageUniverse } from './secCoverageMembership.js';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const SEC_COVERAGE_UNIVERSE = freeze(validateSecCoverageUniverse(snapshot));
// Pure reference membership: the existing ACU pilot remains a separate supported issuer.
export const SEC_COVERAGE_COHORT = SEC_COVERAGE_UNIVERSE.issuers;
export const SEC_COVERAGE_MEMBERSHIP_ID = SEC_COVERAGE_UNIVERSE.id;

const byCik = new Map(SEC_COVERAGE_COHORT.map(row => [row.cik, row]));
const byTicker = new Map(SEC_COVERAGE_COHORT.flatMap(row => row.aliases.map(ticker => [ticker, row])));

/** Returns the canonical issuer; consumers retain the requested security in their response. */
export function getSecCoverageCompany(value) {
  const cik = normalizeSecCoverageCik(value);
  return (cik ? byCik.get(cik) : byTicker.get(normalizeSecCoverageTicker(value))) || null;
}
