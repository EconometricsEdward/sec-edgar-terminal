import { readCoverageRegistry } from './dataStore.js';
import { SEC_COVERAGE_UNIVERSE } from './secCoverageUniverse.js';
import { normalizeSecCoverageCik, normalizeSecCoverageTicker, validateSecCoverageUniverse } from './secCoverageMembership.js';
import { isBroadSecCoverageEnabled } from './dataStoreDeployment.js';
import { QUANT_GROUPS } from './quantGroups.js';

const CACHE_MS = 5 * 60000;
const FAILURE_RETRY_MS = 30000;
const MAX_REGISTRY_BYTES = 524288;
const MAX_ADMITTED_ISSUERS = 2000;
const sectors = new Set(QUANT_GROUPS.map(group => group.label));

export class SecCoverageRegistryUnavailableError extends Error {
  constructor(message = 'Prepared coverage membership is temporarily unavailable.') {
    super(message); this.name = 'SecCoverageRegistryUnavailableError';
    this.code = 'SEC_COVERAGE_REGISTRY_UNAVAILABLE'; this.status = 503;
  }
}
const invalid = () => { throw new SecCoverageRegistryUnavailableError('Prepared coverage membership failed validation.'); };
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const STATIC_REGISTRY = freeze({ schema: 1, active: SEC_COVERAGE_UNIVERSE, candidate: null, retained: [],
  control: { nextCheckAt: null, lastCheckedAt: null, lastError: null, errorCount: 0, leaseUntil: null } });

function validateRetainedIssuer(row) {
  if (!row || row.cik !== normalizeSecCoverageCik(row.cik) || row.ticker !== normalizeSecCoverageTicker(row.ticker)
    || row.fund !== 'IVV' || !sectors.has(row.sector) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 300
    || !Array.isArray(row.aliases) || row.aliases.length < 1 || row.aliases.length > 10
    || !row.aliases.includes(row.ticker) || new Set(row.aliases).size !== row.aliases.length
    || row.aliases.some(ticker => ticker !== normalizeSecCoverageTicker(ticker))) invalid();
}

function validateRegistry(value, now) {
  try {
    if (!value || value.schema !== 1 || Buffer.byteLength(JSON.stringify(value)) > MAX_REGISTRY_BYTES
      || !Array.isArray(value.retained) || value.retained.length > MAX_ADMITTED_ISSUERS
      || (value.candidate !== null && (!value.candidate || typeof value.candidate !== 'object'))) invalid();
    validateSecCoverageUniverse(value.active, { now });
    if (value.candidate) {
      // Pending/history records remain readable as they age. Freshness is an
      // admission/activation gate, never a reason to lose the active registry.
      validateSecCoverageUniverse(value.candidate, { now });
      if (value.candidate.reference.asOf < value.active.reference.asOf) invalid();
    }
    const control = value.control;
    if (!control || !Number.isSafeInteger(control.errorCount) || control.errorCount < 0
      || (control.lastError !== null && (typeof control.lastError !== 'string' || control.lastError.length > 1000))
      || ['nextCheckAt', 'lastCheckedAt', 'leaseUntil'].some(key => control[key] !== null && !Number.isFinite(Date.parse(control[key])))) invalid();
    const active = new Set(value.active.issuers.map(row => row.cik)), retained = new Set();
    for (const row of value.retained) {
      validateRetainedIssuer(row);
      if (active.has(row.cik) || retained.has(row.cik)) invalid();
      retained.add(row.cik);
    }
    const admitted = new Set(), aliases = new Map();
    for (const row of [...value.active.issuers, ...(value.candidate?.issuers || []), ...value.retained]) {
      admitted.add(row.cik);
      for (const ticker of row.aliases) {
        if (aliases.has(ticker) && aliases.get(ticker) !== row.cik) invalid();
        aliases.set(ticker, row.cik);
      }
    }
    if (admitted.size > MAX_ADMITTED_ISSUERS) invalid();
    return freeze(structuredClone(value));
  } catch (error) {
    if (error instanceof SecCoverageRegistryUnavailableError) throw error;
    invalid();
  }
}

function indexRegistry(value) {
  const activeCiks = new Map(value.active.issuers.map(row => [row.cik, row]));
  const activeTickers = new Map(value.active.issuers.flatMap(row => row.aliases.map(ticker => [ticker, row])));
  const admittedCiks = new Map(), admittedTickers = new Map();
  // Candidate identity wins for preparation, while public reads retain active
  // aliases until the complete candidate has been activated atomically.
  for (const row of [...value.retained, ...value.active.issuers, ...(value.candidate?.issuers || [])]) {
    admittedCiks.set(row.cik, row);
    for (const ticker of row.aliases) admittedTickers.set(ticker, row);
  }
  return { value, activeCiks, activeTickers, admittedCiks, admittedTickers };
}
const staticIndex = indexRegistry(STATIC_REGISTRY);
function lookup(ciks, tickers, value) {
  const cik = normalizeSecCoverageCik(value);
  return (cik ? ciks.get(cik) : tickers.get(normalizeSecCoverageTicker(value))) || null;
}

/** Isolated cache factory also permits deterministic outage, expiry, and race tests. */
export function createSecCoverageRegistry({ read = readCoverageRegistry, now = Date.now, env = process.env } = {}) {
  let current = null, expiresAt = 0, retryAt = 0, inFlight = null, epoch = 0;
  const enabled = () => env.VERCEL_ENV === 'production' && isBroadSecCoverageEnabled(env);
  const index = () => enabled() && current ? current : staticIndex;
  function install(value) {
    const registry = validateRegistry(value, now());
    if (current && registry.active.reference.asOf < current.value.active.reference.asOf) invalid();
    current = indexRegistry(registry); epoch++;
    expiresAt = now() + CACHE_MS; retryAt = 0;
    return current.value;
  }
  async function load({ force = false, required = false } = {}) {
    if (!enabled()) return STATIC_REGISTRY;
    if (!force && current && now() < expiresAt) return current.value;
    if (!force && now() < retryAt) {
      if (required) throw new SecCoverageRegistryUnavailableError();
      return current?.value || STATIC_REGISTRY;
    }
    if (!inFlight) {
      const startedEpoch = epoch;
      inFlight = (async () => {
        try {
          const value = await Promise.resolve().then(read);
          // A maintenance publication installed while this read was in flight
          // takes precedence over a response captured before that publication.
          return epoch !== startedEpoch && current ? current.value : install(value);
        } catch (error) {
          if (epoch !== startedEpoch && current) return current.value;
          retryAt = now() + FAILURE_RETRY_MS;
          throw error instanceof SecCoverageRegistryUnavailableError ? error : new SecCoverageRegistryUnavailableError();
        } finally { inFlight = null; }
      })();
    }
    try { return await inFlight; }
    catch (error) { if (required) throw error; return current?.value || STATIC_REGISTRY; }
  }
  return Object.freeze({ load, install,
    getActiveCompany: value => { const selected = index(); return lookup(selected.activeCiks, selected.activeTickers, value); },
    getAdmittedCompany: value => { const selected = index(); return lookup(selected.admittedCiks, selected.admittedTickers, value); },
    isActiveCik: value => index().activeCiks.has(normalizeSecCoverageCik(value)),
    isAdmittedCik: value => index().admittedCiks.has(normalizeSecCoverageCik(value)),
    getActiveCompanies: () => index().value.active.issuers,
  });
}

const registry = createSecCoverageRegistry();
export const loadSecCoverageRegistry = options => registry.load(options);
export const installSecCoverageRegistry = value => registry.install(value);
export const getActiveSecCoverageCompany = value => registry.getActiveCompany(value);
export const getAdmittedSecCoverageCompany = value => registry.getAdmittedCompany(value);
export const isActiveSecCoverageCik = value => registry.isActiveCik(value);
export const isAdmittedSecCoverageCik = value => registry.isAdmittedCik(value);
export const getActiveSecCoverageCompanies = () => registry.getActiveCompanies();
