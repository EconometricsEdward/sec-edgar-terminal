import { warmGet, warmCacheEnabled, warmAcquireLease, warmReleaseLease } from './warmCache.js';
import { MARKET_VERSION } from './marketResearch.js';
import { isMarketAtlas } from './marketResearchValidation.js';
import { buildUniverseSnapshot, UNIVERSE_METRICS, UNIVERSE_VERSION, UNIVERSE_METHOD, UNIVERSE_FRESH_MS, upgradeUniverseSnapshot } from './marketUniverse.js';
import { readSnapshot, writeSnapshot } from './snapshotCache.js';
import { prepareQuantAtlas, publishQuantAtlas, readQuantAtlas } from './quantCoverageServer.js';

const environment = process.env.VERCEL_ENV === 'production' ? 'production' : process.env.VERCEL_ENV === 'preview' ? `preview-${String(process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 12)}` : 'local';
export const FUNDAMENTAL_UNIVERSE_CACHE = `edgar.fundamental-universe.v2:${environment}`;
const RETAIN_SECONDS = 7 * 86400;
const pending = new Map();
const RETIRED_FIELDS = new Set([
  'price_through', 'price_sample', 'price_status', 'price_source', 'price_basis', 'price_model_observations',
  'exposure', 'event', 'co_movement', 'associations', 'sector_proxy', 'market_beta', 'downside_beta', 'sector_beta',
  'residual_volatility', 'response_z', 'price_response_z', 'post_filing_response', 'evidence_gap', 'beta', 'r_squared',
]);
const TOP_LEVEL_FIELDS = new Set([
  'schema_version', 'methodology_version', 'diagnostics_version', 'fundamental_definitions', 'generated_at', 'sec_snapshot_at',
  'sec_stale', 'basis', 'status', 'cache_status', 'refresh_warning', 'universe', 'scopes', 'rows', 'history', 'history_note',
  'limitations', 'links',
]);
const ROW_FIELDS = new Set([
  'ticker', 'cik', 'name', 'group', 'cohorts', 'coverage_fund', 'sec_checked_at', 'facts_retrieved_at', 'financial',
  'metrics', 'source_accessions', 'filed', 'fiscal_end', 'prior_fiscal_end', 'accession', 'source',
]);
const ROW_REQUIRED_FIELDS = [
  'ticker', 'cik', 'name', 'group', 'financial', 'metrics', 'source_accessions', 'filed', 'fiscal_end',
  'prior_fiscal_end', 'accession', 'source',
];
const METRIC_FIELDS = new Set(['current', 'prior', 'change', 'unavailable_reason']);
const METRIC_KEYS = UNIVERSE_METRICS.map(metric => metric.key);
const METRIC_KEY_SET = new Set(METRIC_KEYS);
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const DATE_ONLY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const allowedKeys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.has(key));
const exactKeys = (value, expected) => allowedKeys(value, expected) && Object.keys(value).length === expected.size;
const nullableFinite = value => value === null || (typeof value === 'number' && Number.isFinite(value));
const validTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validOptionalTimestamp = value => value == null || validTimestamp(value);
const validDate = value => {
  if (value === null) return true;
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
};

function validMetric(metric) {
  if (!exactKeys(metric, METRIC_FIELDS) || !nullableFinite(metric.current) || !nullableFinite(metric.prior) || !nullableFinite(metric.change)) return false;
  if (!(metric.unavailable_reason === null || (typeof metric.unavailable_reason === 'string' && metric.unavailable_reason.length > 0))) return false;
  const paired = Number.isFinite(metric.current) && Number.isFinite(metric.prior);
  if (!paired) return metric.change === null && metric.unavailable_reason !== null;
  if (!Number.isFinite(metric.change) || metric.unavailable_reason !== null) return false;
  const expected = metric.current - metric.prior;
  return Math.abs(metric.change - expected) <= 1e-10 * Math.max(1, Math.abs(expected));
}

function validSecRow(row) {
  if (!allowedKeys(row, ROW_FIELDS) || !ROW_REQUIRED_FIELDS.every(key => Object.hasOwn(row, key))) return false;
  if (![row.ticker, row.cik, row.name, row.group].every(value => typeof value === 'string' && value.length > 0) || !/^\d{1,10}$/.test(row.cik) || Number(row.cik) <= 0 || typeof row.financial !== 'boolean') return false;
  if (Object.hasOwn(row, 'cohorts') && (!Array.isArray(row.cohorts) || row.cohorts.some(value => typeof value !== 'string'))) return false;
  if (Object.hasOwn(row, 'coverage_fund') && !(row.coverage_fund === null || typeof row.coverage_fund === 'string')) return false;
  if (!validOptionalTimestamp(row.sec_checked_at) || !validOptionalTimestamp(row.facts_retrieved_at)) return false;
  if (!exactKeys(row.metrics, METRIC_KEY_SET) || !METRIC_KEYS.every(key => validMetric(row.metrics[key]))) return false;
  if (!Array.isArray(row.source_accessions) || new Set(row.source_accessions).size !== row.source_accessions.length || row.source_accessions.some(value => typeof value !== 'string' || !ACCESSION.test(value))) return false;
  if (![row.filed, row.fiscal_end, row.prior_fiscal_end].every(validDate)) return false;
  if (row.accession === null) return row.source === null;
  if (typeof row.accession !== 'string' || !ACCESSION.test(row.accession) || typeof row.source !== 'string') return false;
  const cik = String(Number(row.cik));
  return row.source === `https://www.sec.gov/Archives/edgar/data/${cik}/${row.accession.replaceAll('-', '')}/`;
}

function validScopeEntries(scopes, rows) {
  if (!record(scopes) || !record(scopes.all)) return false;
  const groups = new Set(rows.map(row => row.group));
  if ([...groups].some(group => !record(scopes[group]))) return false;
  return Object.entries(scopes).every(([key, scope]) => {
    if (scope.id !== key || typeof scope.label !== 'string' || !Number.isSafeInteger(scope.companies) || scope.companies < 0 || !Array.isArray(scope.breadth)) return false;
    const expectedCompanies = key === 'all' ? rows.length : rows.filter(row => row.group === key).length;
    const breadthKeys = scope.breadth.map(metric => metric?.key);
    return scope.companies === expectedCompanies && breadthKeys.length === METRIC_KEYS.length
      && new Set(breadthKeys).size === METRIC_KEYS.length && breadthKeys.every(keyName => METRIC_KEY_SET.has(keyName));
  });
}

export function hasRetiredUniverseFields(value) {
  const stack = [value];
  const visited = new WeakSet();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const [key, child] of Object.entries(current)) {
      if (RETIRED_FIELDS.has(key)) return true;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

export function isUniverseSnapshot(value, expectedBasis = null) {
  if (!allowedKeys(value, TOP_LEVEL_FIELDS) || value.schema_version !== UNIVERSE_VERSION || value.methodology_version !== UNIVERSE_METHOD
    || value.diagnostics_version !== 'fundamental-diagnostics-2.0.0' || !record(value.fundamental_definitions)
    || !['ttm', 'annual'].includes(value.basis) || (expectedBasis !== null && value.basis !== expectedBasis)
    || !['ready', 'partial', 'stale'].includes(value.status) || typeof value.sec_stale !== 'boolean'
    || !validTimestamp(value.sec_snapshot_at) || !validTimestamp(value.generated_at)
    || !Array.isArray(value.rows) || value.rows.length === 0 || !value.rows.every(validSecRow)
    || new Set(value.rows.map(row => row.cik.replace(/^0+/, '') || '0')).size !== value.rows.length
    || !record(value.universe) || value.universe.issuers !== value.rows.length || !Number.isSafeInteger(value.universe.requested)
    || value.universe.requested < value.universe.issuers || !Number.isFinite(value.universe.issuer_coverage)
    || value.universe.issuer_coverage < 0 || value.universe.issuer_coverage > 1
    || !validScopeEntries(value.scopes, value.rows) || !Array.isArray(value.history)
    || !Array.isArray(value.limitations) || value.limitations.some(item => typeof item !== 'string')
    || !record(value.links) || value.links.methodology !== 'https://secedgarterminal.com/market/factors'
    || value.links.schema !== 'https://secedgarterminal.com/schemas/factor-universe-v2.schema.json'
    || value.links.api !== `https://secedgarterminal.com/api/v2/factor-universe?basis=${value.basis}`) return false;
  return !hasRetiredUniverseFields(value);
}

async function cachedAtlas() {
  const expanded = await readQuantAtlas();
  if (expanded) return expanded;
  const values = await Promise.all([warmGet(MARKET_VERSION, 'atlas'), warmGet(MARKET_VERSION, 'atlas-last-good')]);
  return values.find(value => isMarketAtlas(value, MARKET_VERSION) && Date.now() - Date.parse(value.generatedAt) >= 0 && Date.now() - Date.parse(value.generatedAt) < RETAIN_SECONDS * 1000) || null;
}

/** Public reads use prepared v2 data or pure calculations over a prepared SEC atlas. */
export async function readUniverseSnapshot(basis = 'ttm') {
  if (!['ttm', 'annual'].includes(basis)) throw Object.assign(new Error('Use basis=ttm or basis=annual.'), { status: 400, code: 'INVALID_BASIS' });
  const primary = await readSnapshot(FUNDAMENTAL_UNIVERSE_CACHE, basis);
  const retained = isUniverseSnapshot(primary, basis) ? primary : await readSnapshot(FUNDAMENTAL_UNIVERSE_CACHE, `${basis}-last-good`);
  if (isUniverseSnapshot(retained, basis)) {
    const age = Date.now() - Date.parse(retained.generated_at), secAge = Date.now() - Date.parse(retained.sec_snapshot_at);
    if (age >= 0 && age < RETAIN_SECONDS * 1000 && secAge >= 0 && secAge < RETAIN_SECONDS * 1000) {
      const stale = retained.status === 'stale' || age > UNIVERSE_FRESH_MS || secAge > UNIVERSE_FRESH_MS || retained.sec_stale;
      return { ...upgradeUniverseSnapshot(retained), status: stale ? 'stale' : retained.status, sec_stale: secAge > UNIVERSE_FRESH_MS || retained.sec_stale, cache_status: stale ? 'stale' : 'prepared' };
    }
  }
  if (pending.has(basis)) return pending.get(basis);
  const task = (async () => {
    const atlas = await cachedAtlas();
    if (!atlas) throw Object.assign(new Error('The scheduled SEC universe snapshot is unavailable. Please retry later.'), { status: 503, code: 'UNIVERSE_SNAPSHOT_UNAVAILABLE' });
    return { ...buildUniverseSnapshot(atlas, {}, { basis }), cache_status: 'computed-from-prepared-sec' };
  })();
  pending.set(basis, task);
  try { return await task; } finally { pending.delete(basis); }
}

function retainedHistory(previous, next) {
  const comparable = previous?.universe?.coverage?.membership_id === next.universe?.coverage?.membership_id;
  const history = comparable && Array.isArray(previous?.history) ? previous.history : [];
  const scope = next.scopes.all;
  const point = { observed_at: next.generated_at, sec_snapshot_at: next.sec_snapshot_at, issuers: next.rows.map(row => row.cik), breadth: scope.breadth.map(metric => ({ metric: metric.key, higher: metric.higher, lower: metric.lower, eligible: metric.eligible, median_change: metric.change.median })) };
  return [...history.filter(item => item.sec_snapshot_at !== point.sec_snapshot_at), point].slice(-30);
}

/** Publication retention depends only on SEC issuer/comparable-filing coverage. */
export function chooseUniversePublication(previous, next, now = Date.now()) {
  if (!isUniverseSnapshot(next, next?.basis)) throw new Error('The next Fundamental Lab snapshot is not a valid SEC-only v2 publication.');
  const compatiblePrevious = isUniverseSnapshot(previous, next.basis) ? previous : null;
  const age = now - Date.parse(compatiblePrevious?.generated_at);
  const nextByCik = new Map(next.rows.map(row => [String(row.cik), row]));
  const overlap = (compatiblePrevious?.rows || []).filter(row => nextByCik.has(String(row.cik)));
  const degraded = (compatiblePrevious?.scopes?.all?.breadth || []).some(metric => {
    const measured = overlap.filter(row => Number.isFinite(row.metrics?.[metric.key]?.change));
    const current = measured.filter(row => Number.isFinite(nextByCik.get(String(row.cik))?.metrics?.[metric.key]?.change));
    return measured.length >= 8 && current.length < measured.length * .95;
  });
  if (compatiblePrevious && age >= 0 && age < RETAIN_SECONDS * 1000 && (next.rows.length < compatiblePrevious.rows.length * .95 || degraded)) return { ...compatiblePrevious, status: 'stale', cache_status: 'stale', refresh_warning: 'Comparable SEC filing coverage fell in the latest refresh. The prior completed fundamental snapshot is retained with its original dates.' };
  const membershipChanged = Boolean(compatiblePrevious) && compatiblePrevious.universe?.coverage?.membership_id !== next.universe?.coverage?.membership_id;
  return { ...next, history: retainedHistory(compatiblePrevious, next), ...(membershipChanged ? { history_note: 'Coverage membership changed. A new history segment starts here; differences from earlier membership are not a market trend.' } : {}) };
}

export async function refreshUniverseSnapshot({ signal, deadline = Date.now() + 275000 } = {}) {
  if (!warmCacheEnabled()) throw Object.assign(new Error('Shared snapshot storage is unavailable.'), { status: 503 });
  const lease = await warmAcquireLease(FUNDAMENTAL_UNIVERSE_CACHE, 'refresh', 295000);
  if (!lease) return { skipped: 'A Fundamental Lab refresh is already running.' };
  try {
    let atlas;
    try { atlas = await prepareQuantAtlas({ signal, deadline }); }
    catch { atlas = await readQuantAtlas(); }
    if (!atlas) throw new Error('The prepared SEC atlas is unavailable; prior fundamental snapshots remain untouched.');
    const publications = [], outcomes = [], generationNow = new Date();
    for (const basis of ['ttm', 'annual']) {
      if (signal?.aborted || Date.now() > deadline - 10000) throw new Error('Fundamental publication deferred at the deadline.');
      const [lastGood, primary] = await Promise.all([
        readSnapshot(FUNDAMENTAL_UNIVERSE_CACHE, `${basis}-last-good`),
        readSnapshot(FUNDAMENTAL_UNIVERSE_CACHE, basis),
      ]);
      const previous = [lastGood, primary].find(candidate => isUniverseSnapshot(candidate, basis)) || null;
      const next = buildUniverseSnapshot(atlas, {}, { basis, now: generationNow });
      const publication = chooseUniversePublication(previous, next);
      if (!isUniverseSnapshot(publication, basis)) throw new Error('Only a valid SEC-only v2 fundamental universe can be published.');
      publications.push({ basis, publication });
      outcomes.push({ basis, status: publication.status, issuers: publication.rows.length, comparable: publication.scopes.all.comparable_companies });
    }
    await publishQuantAtlas(atlas, { signal, deadline });
    for (const { basis, publication } of publications) {
      if (!await writeSnapshot(FUNDAMENTAL_UNIVERSE_CACHE, basis, publication, RETAIN_SECONDS, { signal, deadline })) throw new Error(`Could not publish ${basis} Fundamental Lab snapshot.`);
      if (publication.status === 'ready' && !await writeSnapshot(FUNDAMENTAL_UNIVERSE_CACHE, `${basis}-last-good`, publication, RETAIN_SECONDS, { signal, deadline })) throw new Error('Last-good fundamental snapshot could not be retained.');
    }
    return { schema_version: UNIVERSE_VERSION, outcomes, membership: atlas.coverage };
  } finally {
    await warmReleaseLease(FUNDAMENTAL_UNIVERSE_CACHE, 'refresh', lease);
  }
}
