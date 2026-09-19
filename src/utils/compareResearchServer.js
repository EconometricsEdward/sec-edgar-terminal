import { gzipSync, gunzipSync } from 'node:zlib';
import { loadAnalysisResearchCompany } from './analysisResearchSources.js';
import { analysisSourceCachePolicy, analysisSourcesDegraded } from './analysisSourceCoverage.js';
import { buildCompareCompany, COMPARE_VERSION, COMPARE_MAPPING_VERSION } from './compareResearch.js';
import { packAnalysisCompany } from './analysisResearch.js';
import { matchingCompareResult } from './compareResponseValidation.js';
import { readPreparedCompare } from './preparedResearchStore.js';
import { PreparedSecUnavailableError, preparedCacheControl, preparedDataHeaders } from './secDocumentStore.js';
import { warmGet, warmSet } from './warmCache.js';
import { getOperatingTicker } from './tickerMap.js';

const MAX_PENDING = 8;
const MAX_GZIP_BASE64_BYTES = 8 * 1024 * 1024;
const MAX_DECODE_BYTES = 32 * 1024 * 1024;

function calculationDelivery(payload, cacheSource, now) {
  const policy = analysisSourceCachePolicy(payload), observedAt = Date.parse(payload.observedAt);
  const expiresAt = observedAt + policy.ttlSeconds * 1000;
  const remaining = observedAt > now + 60000 ? 0
    : Math.max(0, Math.min(policy.ttlSeconds, Math.floor((expiresAt - now) / 1000)));
  return { remaining, headers: {
    'Cache-Control': remaining > 0
      ? `public, max-age=${analysisSourcesDegraded(payload) ? 0 : Math.min(60, remaining)}, s-maxage=${remaining}, must-revalidate`
      : 'private, no-store',
    'X-Data-Expires-At': new Date(expiresAt).toISOString(),
    'X-Cache-Source': cacheSource,
  } };
}

/** A dot share-class alias is accepted only when the SEC directory confirms
 * its dashed spelling. Exact symbols always win, and source CIK must agree.
 */
export async function loadCompareResearchCompany(ticker, options, {
  lookup = getOperatingTicker, load = loadAnalysisResearchCompany,
} = {}) {
  let selected = ticker, identity = await lookup(ticker);
  options?.signal?.throwIfAborted();
  if (!identity && ticker.includes('.')) {
    selected = ticker.replaceAll('.', '-');
    identity = await lookup(selected);
  }
  if (!identity) throw new Error('No SEC operating company matched that ticker.');
  options?.signal?.throwIfAborted();
  const company = await load(selected, options);
  if (company.cik !== identity.cik) throw new Error('The SEC company identity changed during comparison retrieval. Retry this issuer.');
  return { ...company, ticker };
}

/** One bounded calculation/storage read per requested selection. Packed and
 * expanded readers share it; completed values keep existing cache lifetimes.
 * Reader cancellation only stops source work after the last reader leaves.
 */
export function createCompareResearchLoader({
  preparedRead = readPreparedCompare, read = warmGet, write = warmSet,
  load = loadCompareResearchCompany, build = buildCompareCompany, pack = packAnalysisCompany,
  now = Date.now,
} = {}) {
  const pending = new Map(), unsettled = new Set();
  return async ({ ticker, basis = 'annual', asOf = '' }, signal) => {
    const settings = { ticker, basis, asOf };
    // The reviewed shared-storage family stays stable. Mapping changes are
    // checked inside each payload and distinguish concurrent computations.
    const id = `${COMPARE_VERSION}:${ticker}:${basis}:${asOf}`;
    const workId = `${COMPARE_MAPPING_VERSION}:${id}`;
    signal?.throwIfAborted();
    let entry = pending.get(workId);
    if (!entry) {
      if (unsettled.size >= MAX_PENDING) throw Object.assign(new Error('Company comparison retrieval is busy. Retry shortly.'), { status: 503 });
      const controller = new AbortController();
      entry = { controller, readers: 0, settled: false, task: null };
      unsettled.add(entry);
      const workSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
      entry.task = (async () => {
        // A short-lived verified calculation can cover a prepared mapping
        // rollout without downloading and rejecting the same old projection
        // on every new request. Cache reads never renew that calculation.
        let cached;
        try { cached = await read('compare-research', id); }
        catch { /* Optional cache failure leaves the bounded source path available. */ }
        workSignal.throwIfAborted();
        if (typeof cached?.gzip === 'string' && cached.gzip.length <= MAX_GZIP_BASE64_BYTES) {
          try {
            const serializedPayload = gunzipSync(Buffer.from(cached.gzip, 'base64'), { maxOutputLength: MAX_DECODE_BYTES }).toString('utf8');
            const payload = JSON.parse(serializedPayload);
            if (matchingCompareResult(payload, settings)) {
              const delivery = calculationDelivery(payload, 'warm', now());
              if (delivery.remaining > 0) return { payload, serializedPayload, cacheSource: 'warm', headers: delivery.headers };
            }
          } catch { /* Corrupt or old-mapping cache entries require a recalculation. */ }
        }
        let prepared;
        try { prepared = await preparedRead({ ...settings, format: 'packed' }); }
        catch (error) {
          // During a mapping rollout, canonical prepared SEC inputs can
          // supply the bounded calculation before the next prepared build.
          // Their own production scope and identity checks remain enforced.
          if (!(error instanceof PreparedSecUnavailableError)) throw error;
        }
        workSignal.throwIfAborted();
        if (prepared && matchingCompareResult(prepared.payload, settings)) {
          return { payload: prepared.payload, serializedPayload: JSON.stringify(prepared.payload),
            cacheSource: prepared.cacheSource, headers: { 'Cache-Control': preparedCacheControl(prepared),
              ...preparedDataHeaders(prepared, prepared.cacheSource) } };
        }
        const company = await load(ticker, { basis, asOf, signal: AbortSignal.any([workSignal, AbortSignal.timeout(25000)]) });
        workSignal.throwIfAborted();
        const payload = pack(build(company, { basis, asOf }));
        if (!matchingCompareResult(payload, settings)) throw new Error('The company comparison could not be verified for this selection.');
        const serializedPayload = JSON.stringify(payload);
        if (Buffer.byteLength(serializedPayload) > MAX_DECODE_BYTES) throw new Error('The company comparison exceeds its supported response size.');
        const policy = analysisSourceCachePolicy(payload);
        workSignal.throwIfAborted();
        try { await write('compare-research', id, { gzip: gzipSync(serializedPayload).toString('base64') }, policy.ttlSeconds); }
        catch { /* A valid calculation survives optional cache persistence failure. */ }
        // A source deadline during optional persistence must not discard a
        // completed valid calculation, but an abandoned request must stop.
        controller.signal.throwIfAborted();
        return { payload, serializedPayload, cacheSource: 'upstream',
          headers: calculationDelivery(payload, 'upstream', now()).headers };
      })().finally(() => {
        entry.settled = true;
        unsettled.delete(entry);
        if (pending.get(workId) === entry) pending.delete(workId);
      });
      pending.set(workId, entry);
    }
    entry.readers++;
    try {
      return await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || new Error('Company comparison reader aborted.'));
        signal?.addEventListener('abort', abort, { once: true });
        entry.task.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
        if (signal?.aborted) abort();
      });
    } finally {
      entry.readers--;
      if (!entry.readers && !entry.settled) {
        // Allow an immediate new reader to retry without inheriting an abort;
        // the abandoned task still counts toward the bound until it settles.
        if (pending.get(workId) === entry) pending.delete(workId);
        entry.controller.abort(new Error('No company comparison readers remain.'));
      }
    }
  };
}

export const loadCompareResearch = createCompareResearchLoader();
