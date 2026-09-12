import { warmGet, warmCacheEnabled, warmAcquireLease, warmReleaseLease } from './warmCache.js';
import { MARKET_VERSION } from './marketResearch.js';
import { isMarketAtlas } from './marketResearchValidation.js';
import { buildUniverseSnapshot, UNIVERSE_VERSION, UNIVERSE_METHOD, UNIVERSE_FRESH_MS, upgradeUniverseSnapshot } from './marketUniverse.js';
import { readSnapshot, writeSnapshot } from './snapshotCache.js';
import { prepareQuantAtlas, publishQuantAtlas, readQuantAtlas } from './quantCoverageServer.js';

const environment = process.env.VERCEL_ENV === 'production' ? 'production' : process.env.VERCEL_ENV === 'preview' ? `preview-${String(process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 12)}` : 'local';
export const FUNDAMENTAL_UNIVERSE_CACHE = `edgar.fundamental-universe.v2:${environment}`;
const RETAIN_SECONDS = 7 * 86400;
const pending = new Map();
const RETIRED_FIELDS = new Set(['price_through', 'price_sample', 'price_status', 'price_source', 'exposure', 'event', 'co_movement', 'associations', 'sector_proxy']);

export function hasRetiredUniverseFields(value) {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (RETIRED_FIELDS.has(key)) return true;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

export function isUniverseSnapshot(value) {
  return value?.schema_version === UNIVERSE_VERSION
    && value?.methodology_version === UNIVERSE_METHOD
    && ['ttm', 'annual'].includes(value.basis)
    && Array.isArray(value.rows) && value.rows.length > 0
    && value.scopes?.all?.companies === value.rows.length
    && Number.isFinite(Date.parse(value.sec_snapshot_at))
    && Number.isFinite(Date.parse(value.generated_at))
    && !hasRetiredUniverseFields(value);
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
  const retained = isUniverseSnapshot(primary) ? primary : await readSnapshot(FUNDAMENTAL_UNIVERSE_CACHE, `${basis}-last-good`);
  if (isUniverseSnapshot(retained) && retained.basis === basis) {
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
  const age = now - Date.parse(previous?.generated_at);
  const nextByCik = new Map(next.rows.map(row => [String(row.cik), row]));
  const overlap = (previous?.rows || []).filter(row => nextByCik.has(String(row.cik)));
  const degraded = (previous?.scopes?.all?.breadth || []).some(metric => {
    const measured = overlap.filter(row => Number.isFinite(row.metrics?.[metric.key]?.change));
    const current = measured.filter(row => Number.isFinite(nextByCik.get(String(row.cik))?.metrics?.[metric.key]?.change));
    return measured.length >= 8 && current.length < measured.length * .95;
  });
  if (isUniverseSnapshot(previous) && age >= 0 && age < RETAIN_SECONDS * 1000 && (next.rows.length < previous.rows.length * .95 || degraded)) return { ...previous, status: 'stale', cache_status: 'stale', refresh_warning: 'Comparable SEC filing coverage fell in the latest refresh. The prior completed fundamental snapshot is retained with its original dates.' };
  const membershipChanged = Boolean(previous) && previous.universe?.coverage?.membership_id !== next.universe?.coverage?.membership_id;
  return { ...next, history: retainedHistory(previous, next), ...(membershipChanged ? { history_note: 'Coverage membership changed. A new history segment starts here; differences from earlier membership are not a market trend.' } : {}) };
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
      const previous = (await readSnapshot(FUNDAMENTAL_UNIVERSE_CACHE, `${basis}-last-good`)) || await readSnapshot(FUNDAMENTAL_UNIVERSE_CACHE, basis);
      const next = buildUniverseSnapshot(atlas, {}, { basis, now: generationNow });
      const publication = chooseUniversePublication(previous, next);
      if (hasRetiredUniverseFields(publication)) throw new Error('Retired market-data fields cannot be published in the v2 fundamental universe.');
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
