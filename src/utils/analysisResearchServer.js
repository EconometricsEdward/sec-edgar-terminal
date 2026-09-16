import { gzipSync, gunzipSync } from 'node:zlib';
import { loadResearchCompany } from './secResearchData.js';
import { buildAnalysisCompany, packAnalysisCompany, ANALYSIS_VERSION } from './analysisResearch.js';
import { sampleFinancialShadow } from './preparedFinancialData.js';
import { warmGet, warmSet } from './warmCache.js';

const MAX_PENDING = 8;
const MAX_GZIP_BASE64_BYTES = 8 * 1024 * 1024;
const MAX_DECODE_BYTES = 32 * 1024 * 1024;

function matchingResult(value, { ticker, basis, asOf }) {
  return value?.packed === true && value.version === ANALYSIS_VERSION
    && value.ticker === ticker && value.basis === basis && (value.asOf || '') === asOf
    && Array.isArray(value.periods) && Array.isArray(value.definitions)
    && value.metrics && typeof value.metrics === 'object' && !Array.isArray(value.metrics)
    && Array.isArray(value.sourceCatalog) && Array.isArray(value.calculationCatalog);
}

/**
 * Request-driven research for nonprepared issuers and filing cutoffs. Coalesce
 * only in-flight work: completed results retain the existing five-minute shared
 * cache lifetime, and are never enrolled in the immutable prepared universe.
 */
export function createInteractiveAnalysisLoader({
  read = warmGet, write = warmSet, load = loadResearchCompany,
  build = buildAnalysisCompany, pack = packAnalysisCompany, sample = sampleFinancialShadow,
} = {}) {
  const pending = new Map(), unsettled = new Set();
  return async (selection, signal) => {
    const { ticker, basis = 'annual', asOf = '' } = selection;
    const settings = { ticker, basis, asOf };
    const id = `${ANALYSIS_VERSION}:${ticker}:${basis}:${asOf}`;
    signal?.throwIfAborted();
    let entry = pending.get(id);
    if (!entry) {
      // Abandoned cache reads may take a moment to settle. They still occupy
      // capacity even after their selection becomes available for a retry.
      if (unsettled.size >= MAX_PENDING) throw Object.assign(new Error('Financial research is busy. Retry shortly.'), { status: 503 });
      const controller = new AbortController();
      entry = { controller, readers: 0, settled: false, task: null };
      unsettled.add(entry);
      const workSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
      entry.task = (async () => {
        let cached;
        try { cached = await read('analysis-research', id); }
        catch { /* Optional cache failure leaves the bounded source path available. */ }
        workSignal.throwIfAborted();
        if (typeof cached?.gzip === 'string' && cached.gzip.length <= MAX_GZIP_BASE64_BYTES) {
          try {
            const serializedPayload = gunzipSync(Buffer.from(cached.gzip, 'base64'), { maxOutputLength: MAX_DECODE_BYTES }).toString('utf8');
            const payload = JSON.parse(serializedPayload);
            if (matchingResult(payload, settings)) return { payload, serializedPayload, cacheSource: 'warm' };
          } catch { /* Corrupt cached responses cannot prevent a valid recalculation. */ }
        }
        const company = await load(ticker, { signal: AbortSignal.any([workSignal, AbortSignal.timeout(25000)]) });
        workSignal.throwIfAborted();
        const payload = pack(build(company, { basis, asOf }));
        const serializedPayload = JSON.stringify(payload);
        workSignal.throwIfAborted();
        try { await sample(company, payload); }
        catch { /* Shadow diagnostics are optional, not a prerequisite for research. */ }
        controller.signal.throwIfAborted();
        try {
          await write('analysis-research', id, { gzip: gzipSync(serializedPayload).toString('base64') }, 300);
        } catch { /* The valid calculated response survives an optional cache outage. */ }
        // A source deadline expiring during optional persistence must not
        // discard a calculation that completed within its source budget.
        controller.signal.throwIfAborted();
        return { payload, serializedPayload, cacheSource: 'upstream' };
      })().finally(() => {
        entry.settled = true;
        unsettled.delete(entry);
        if (pending.get(id) === entry) pending.delete(id);
      });
      pending.set(id, entry);
    }
    entry.readers++;
    try {
      return await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || new Error('Financial research reader aborted.'));
        signal?.addEventListener('abort', abort, { once: true });
        entry.task.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
        if (signal?.aborted) abort();
      });
    } finally {
      entry.readers--;
      if (!entry.readers && !entry.settled) {
        // A later reader must start fresh instead of joining aborted work.
        // The old task's identity-checked cleanup cannot remove that retry.
        if (pending.get(id) === entry) pending.delete(id);
        entry.controller.abort(new Error('No financial research readers remain.'));
      }
    }
  };
}

export const loadInteractiveAnalysis = createInteractiveAnalysisLoader();
