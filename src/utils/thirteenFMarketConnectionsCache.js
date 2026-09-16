import { createHash } from 'node:crypto';
import { cacheGetMany, cachePut, disposableCacheEnabled } from './disposableCache.js';
import { is13FMarketConnectionResult } from './thirteenFMarketConnections.js';

export const THIRTEEN_F_MARKET_CONNECTIONS_CACHE_TYPE = 'edgar.13f-market-connections.v1:production';
const MAX_BYTES = 1024 * 1024;
const HOLDING_FIELDS = ['key', 'cusip', 'issuer', 'classTitle', 'putCall', 'quantity', 'quantityType', 'valueUsd', 'weightPct'];

/** A new report amendment or denominator invalidates prepared composition,
 * even when the selected security itself has not changed. */
export function thirteenFMarketConnectionsCacheId(report, holding) {
  const portfolio = report.portfolio;
  const binding = {
    holding: HOLDING_FIELDS.map(key => holding[key] ?? null),
    selectedPeriodComplete: report.coverage?.selectedPeriodComplete === true,
    portfolioComplete: portfolio.complete === true,
    totalValueUsd: portfolio.totalValueUsd ?? null, positionCount: portfolio.positionCount ?? portfolio.holdings.length,
    entryCount: portfolio.entryCount ?? null, reportType: portfolio.reportType ?? null,
    confidentialOmitted: portfolio.confidentialOmitted ?? null,
    filings: (portfolio.filings || []).map(filing => [filing.accession, filing.form, filing.filingDate, filing.reportDate,
      filing.primaryUrl, filing.indexUrl, filing.tableUrls, filing.isAmendment, filing.amendmentType, filing.amendmentNumber, filing.superseded]),
  };
  return `${String(report.manager.cik).padStart(10, '0')}:${report.selectedPeriod}:${createHash('sha256').update(JSON.stringify(binding)).digest('hex').toUpperCase()}`;
}

/** Source age, rather than cache insertion time, controls reuse. */
export function thirteenFMarketConnectionsExpiresAt(result, now = Date.now()) {
  if (!result || result.retryable === true || !['ready', 'unresolved'].includes(result.status)) return null;
  const discovery = result.discovery;
  if (result.status === 'ready' && (!['ready', 'no_matches', 'no_filing'].includes(discovery?.status)
    || discovery.retryable === true || discovery.coverage?.searchComplete !== true
    || discovery.coverage?.filingsFailed > 0 || !Array.isArray(discovery.sources)
    || discovery.sources.some(source => source.status !== 'ready'))) return null;
  const timestamps = [result.observedAt, result.identity?.observedAt, ...(discovery ? [discovery.checkedAt] : [])].map(Date.parse);
  if (timestamps.some(value => !Number.isFinite(value) || value > now + 1000)) return null;
  const ttl = result.status === 'unresolved' ? 60000 : discovery.status === 'no_filing' ? 15 * 60000 : discovery.status === 'no_matches' ? 3600000 : 6 * 3600000;
  const expires = Math.min(...timestamps) + ttl;
  return expires > now ? expires : null;
}

/** Optional, bounded shared storage. An outage cannot prevent fresh research;
 * cancellation still stops the caller rather than silently starting new work. */
export function createThirteenFMarketConnectionsCache({ enabled = disposableCacheEnabled, readMany = cacheGetMany,
  write = cachePut, now = Date.now, timeoutMs = 1500 } = {}) {
  async function optional(operation, signal, fallback) {
    signal?.throwIfAborted();
    if (!enabled()) return fallback;
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer, onAbort;
    try {
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(requestSignal.reason);
        requestSignal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => controller.abort(new DOMException('Prepared cache timed out.', 'TimeoutError')), timeoutMs);
      });
      return await Promise.race([operation({ signal: requestSignal, timeoutMs, deadline: now() + timeoutMs }), interrupted]);
    } catch {
      signal?.throwIfAborted();
      return fallback;
    } finally { clearTimeout(timer); requestSignal.removeEventListener('abort', onAbort); }
  }
  function valid(result, report, holding, verify) {
    return is13FMarketConnectionResult(result, { cik: String(report.manager.cik).padStart(10, '0'), period: report.selectedPeriod, holding, now: now() })
      && (result.holding.weightPct ?? null) === (holding.weightPct ?? null)
      && result.coverage?.selectedPeriodComplete === (report.coverage?.selectedPeriodComplete === true)
      && result.coverage?.portfolioComplete === (report.portfolio.complete === true)
      && !!thirteenFMarketConnectionsExpiresAt(result, now()) && verify(result);
  }
  return {
    async getMany(report, holdings, { signal, verify = () => true } = {}) {
      const ids = holdings.map(holding => thirteenFMarketConnectionsCacheId(report, holding));
      const rows = await optional(options => readMany(THIRTEEN_F_MARKET_CONNECTIONS_CACHE_TYPE, ids, options), signal, null);
      signal?.throwIfAborted();
      if (!Array.isArray(rows) || rows.length !== holdings.length) return holdings.map(() => null);
      return rows.map((row, index) => {
        try {
          const payload = row?.payload, expires = Date.parse(row?.expiresAt);
          if (payload?.cik !== String(report.manager.cik).padStart(10, '0') || payload?.binding !== ids[index] || !Number.isFinite(expires) || expires <= now()
            || !valid(payload.result, report, holdings[index], verify)
            || expires > thirteenFMarketConnectionsExpiresAt(payload.result, now())
            || Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) return null;
          return payload.result;
        } catch { return null; }
      });
    },
    async put(report, holding, result, { signal, verify = () => true } = {}) {
      signal?.throwIfAborted();
      try { if (!valid(result, report, holding, verify)) return false; } catch { return false; }
      const expires = thirteenFMarketConnectionsExpiresAt(result, now());
      const ttl = Math.floor((expires - now()) / 1000);
      const id = thirteenFMarketConnectionsCacheId(report, holding), payload = { cik: String(report.manager.cik).padStart(10, '0'), binding: id, result };
      if (ttl < 1 || Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) return false;
      const ack = await optional(options => write(THIRTEEN_F_MARKET_CONNECTIONS_CACHE_TYPE, id, payload, ttl,
        { ...options, expiresAt: new Date(expires).toISOString() }), signal, null);
      return ack?.stored === true;
    },
  };
}

export const thirteenFMarketConnectionsCache = createThirteenFMarketConnectionsCache();
