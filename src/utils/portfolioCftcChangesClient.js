// Browser-only orchestration. Keep source loaders and storage credentials out of this module.
export const PORTFOLIO_CFTC_BATCH_SIZE = 24;
const SCHEMA_VERSION = 'edgar.portfolio-cftc-changes.v2';
const COMPANY_STATUSES = new Set(['linked', 'no_matches', 'no_filing', 'unavailable']);
const MARKET_STATUSES = new Set(['ready', 'partial', 'stale', 'unavailable']);
const identity = company => company?.cik || String(company?.ticker || '').toUpperCase();
const marketIdentity = event => `${event.family}:${event.contract}:${event.traderGroup}`;
const increment = (counts, code) => { counts[code || 'SOURCE_UNAVAILABLE'] = (counts[code || 'SOURCE_UNAVAILABLE'] || 0) + 1; };

/** The caller's full universe is the denominator, including companies not yet attempted. */
export function mergePortfolioCftcChanges(previous, incoming, companies) {
  const universe = new Map(companies.map(company => [identity(company), company]));
  const checks = new Map((previous?.companyChecks || []).filter(check => universe.has(identity(check))).map(check => [identity(check), check]));
  const failedMarketKeys = new Set((incoming?.marketChecks || []).filter(check => check.status === 'unavailable').map(check => check.key));
  const fresh = new Set();
  for (const check of incoming?.companyChecks || []) {
    const key = identity(check);
    if (!universe.has(key) || !COMPANY_STATUSES.has(check.status)) continue;
    checks.set(key, { ...check, ...universe.get(key) });
    if (check.status !== 'unavailable') fresh.add(key);
  }
  const events = new Map();
  // Replace a successfully rechecked company's old results, even when it now has no events.
  // Failed checks keep earlier evidence visible, while coverage separately records the failure.
  for (const event of previous?.events || []) {
    const marketFailed = failedMarketKeys.has(marketIdentity(event));
    const related = (event.relatedCompanies || [event]).filter(company => {
      const key = identity(company), check = checks.get(key);
      return universe.has(key) && (!fresh.has(key) || (check?.status === 'linked' && marketFailed && check.marketKeys?.includes(marketIdentity(event))));
    });
    if (related.length) events.set(event.id, { ...event, relatedCompanies: related,
      ...(marketFailed ? { retainedFromPrevious: true, historyStatus: 'stale', refreshWarning: 'The latest market refresh was unavailable. Showing the last successful observation.' } : {}),
    });
  }
  for (const event of incoming?.events || []) {
    const related = new Map((events.get(event.id)?.relatedCompanies || []).map(company => [identity(company), company]));
    for (const company of event.relatedCompanies || [event]) {
      const key = identity(company);
      if (universe.has(key)) related.set(key, { ...company, ...universe.get(key) });
    }
    if (related.size) events.set(event.id, { ...event, relatedCompanies: [...related.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)) });
  }
  const markets = new Map((previous?.marketChecks || []).map(check => [check.key, check]));
  for (const check of incoming?.marketChecks || []) if (check.key && MARKET_STATUSES.has(check.status)) markets.set(check.key, check);
  // Remove market checks no longer referenced by any company's current connection.
  const relevantMarkets = new Set([...checks.values()].flatMap(check => check.marketKeys || []));
  for (const event of events.values()) relevantMarkets.add(marketIdentity(event));
  for (const key of markets.keys()) if (!relevantMarkets.has(key)) markets.delete(key);
  const coverage = {
    totalCompanies: universe.size, requested: checks.size, checked: 0, linked: 0, unavailable: 0,
    noLink: 0, noFiling: 0, identityMismatch: 0, invalidLinks: 0, unavailableReasons: {}, marketUnavailableReasons: {},
    uniqueMarkets: markets.size, marketsChecked: 0, marketUnavailable: 0, staleMarkets: 0, partialMarkets: 0,
    noComparison: 0, belowThreshold: 0, outsideWindow: 0, futureReports: 0, events: events.size,
    pending: universe.size - checks.size, limited: false, companyLimit: PORTFOLIO_CFTC_BATCH_SIZE,
  };
  for (const check of checks.values()) {
    if (check.status === 'unavailable') {
      coverage.unavailable += 1; increment(coverage.unavailableReasons, check.code);
      if (check.code === 'ISSUER_IDENTITY_MISMATCH') coverage.identityMismatch += 1;
    } else {
      coverage.checked += 1;
      if (check.status === 'linked') coverage.linked += 1;
      if (check.status === 'no_matches') coverage.noLink += 1;
      if (check.status === 'no_filing') coverage.noFiling += 1;
    }
    coverage.invalidLinks += check.invalidLinks || 0;
  }
  for (const check of markets.values()) {
    if (check.status === 'unavailable') { coverage.marketUnavailable += 1; increment(coverage.marketUnavailableReasons, check.code); }
    else coverage.marketsChecked += 1;
    if (check.stale || check.status === 'stale') coverage.staleMarkets += 1;
    if (check.partial || check.status === 'partial') coverage.partialMarkets += 1;
    for (const field of ['noComparison', 'belowThreshold', 'outsideWindow', 'futureReports']) coverage[field] += check[field] || 0;
  }
  coverage.limited = coverage.pending > 0;
  const orderedEvents = [...events.values()].sort((a, b) => b.reportDate.localeCompare(a.reportDate) || Math.abs(b.netPctChange || 0) - Math.abs(a.netPctChange || 0) || a.id.localeCompare(b.id));
  return { ...previous, ...incoming, preparation: incoming?.preparation || null, events: orderedEvents, companyChecks: [...checks.values()], marketChecks: [...markets.values()], coverage };
}

export function unfinishedPortfolioCftcCompanies(data, companies, { includeStale = false } = {}) {
  const checks = new Map((data?.companyChecks || []).map(check => [identity(check), check]));
  const failedMarkets = new Set((data?.marketChecks || []).filter(check => check.status === 'unavailable'
    || (includeStale && (check.status === 'stale' || check.status === 'partial' || check.stale || check.partial))).map(check => check.key));
  return companies.filter(company => {
    const check = checks.get(identity(company));
    return !check || check.status === 'unavailable' || (check.marketKeys || []).some(key => failedMarkets.has(key));
  });
}

function abortError(signal) { return signal?.reason || new DOMException('Research request was interrupted.', 'AbortError'); }
function assertActive(signal) { if (signal?.aborted) throw abortError(signal); }
function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    assertActive(signal);
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Prepared coverage is one read. A cache miss scans distinct batches, then retries only gaps once.
 * @param {Array<{ticker: string, cik?: string, rowId?: string}>} companies
 * @param {{
 *   signal?: AbortSignal,
 *   previous?: any,
 *   retryOnly?: boolean,
 *   onUpdate?: (data: any) => void,
 *   fetchImpl?: typeof fetch,
 *   delay?: (milliseconds: number, signal?: AbortSignal) => Promise<unknown>,
 *   requestTimeoutMs?: number,
 *   retryDelayMs?: number
 * }} [options]
 * @returns {Promise<any>}
 */
export async function loadPortfolioCftcChanges(companies, {
  signal, previous = null, retryOnly = false, onUpdate = (_data) => {}, fetchImpl = fetch,
  delay = wait, requestTimeoutMs = 58_000, retryDelayMs = 1500,
} = {}) {
  let data = previous;
  let requestCount = 0;
  const requested = new Set();
  const maxRequests = 10; // At most 5 initial + 5 gap retries, within the endpoint's 12/10-minute quota.
  async function request(batch) {
    assertActive(signal);
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl('/api/v1/cftc/portfolio-changes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companies: batch, days: 60 }), signal: requestSignal,
    });
    assertActive(requestSignal);
    const body = await response.json();
    assertActive(requestSignal);
    if (!response.ok) {
      const seconds = Number(response.headers.get('retry-after'));
      const retryAt = response.status === 429 ? Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000 : 0;
      throw Object.assign(new Error(body.error || 'CFTC market context is temporarily unavailable.'), { status: response.status, retryAt });
    }
    if (body.schemaVersion !== SCHEMA_VERSION || !Array.isArray(body.companyChecks) || !Array.isArray(body.marketChecks))
      throw new Error('CFTC coverage could not be verified. Please retry after the update finishes.');
    requestCount += 1;
    for (const check of body.companyChecks) requested.add(identity(check));
    data = mergePortfolioCftcChanges(data, body, companies);
    onUpdate(data);
    return body;
  }
  retryOnly = retryOnly && !previous?.preparation;
  let remaining = retryOnly ? unfinishedPortfolioCftcCompanies(previous, companies, { includeStale: true }) : companies;
  if (!remaining.length) return data;
  // The first complete-universe request lets the server return the shared prepared snapshot.
  const firstBatch = retryOnly ? remaining.slice(0, PORTFOLIO_CFTC_BATCH_SIZE) : remaining;
  const first = await request(firstBatch);
  if (first.preparation) return data; // Background preparation owns stale/partial demo refreshes.
  for (const company of firstBatch.slice(0, PORTFOLIO_CFTC_BATCH_SIZE)) requested.add(identity(company));
  remaining = remaining.filter(company => !requested.has(identity(company)));
  while (remaining.length && requestCount < maxRequests) {
    const batch = remaining.slice(0, PORTFOLIO_CFTC_BATCH_SIZE);
    await request(batch);
    remaining = remaining.slice(batch.length);
  }
  const retryCompanies = unfinishedPortfolioCftcCompanies(data, companies);
  if (retryCompanies.length && requestCount < maxRequests) {
    await delay(retryDelayMs, signal);
    for (let index = 0; index < retryCompanies.length && requestCount < maxRequests; index += PORTFOLIO_CFTC_BATCH_SIZE) {
      await request(retryCompanies.slice(index, index + PORTFOLIO_CFTC_BATCH_SIZE));
    }
  }
  assertActive(signal);
  return data;
}
