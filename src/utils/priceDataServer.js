import {
  warmAcquireLease,
  warmCacheEnabled,
  warmCooldownRemaining,
  warmExtendCooldown,
  warmGet,
  warmReleaseLease,
  warmSet,
} from './warmCache.js';

const FETCH_TIMEOUT_MS = 12_000;
const PROVIDER_START_INTERVAL_MS = 250;
const PROVIDER_GATE_WAIT_MS = 3_000;
const PROVIDER_GATE_LEASE_MS = 5_000;
const PRICE_REFRESH_LEASE_MS = 40_000;
const MAX_PROVIDER_COOLDOWN_MS = 5 * 60_000;
const YAHOO_MAX_BYTES = 8 * 1024 * 1024;
const STOOQ_MAX_BYTES = 5 * 1024 * 1024;
const DEPLOYED_RUNTIME = Boolean(process.env.VERCEL_ENV || process.env.VERCEL)
  || process.env.NODE_ENV === 'production';
const pending = new Map();
const localProviderNextStart = new Map();
const localProviderCooldownUntil = new Map();

export class PriceDataError extends Error {
  constructor(message, { code = 'PRICE_DATA_UNAVAILABLE', status = 502, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PriceDataError';
    this.code = code;
    this.status = status;
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The request was aborted.', 'AbortError');
}

async function wait(ms, signal) {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(abortError(signal));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export function parsePriceRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_PROVIDER_COOLDOWN_MS, Math.ceil(seconds * 1000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(MAX_PROVIDER_COOLDOWN_MS, Math.max(0, date - now))
    : null;
}

export function normalizePriceTicker(value) {
  const ticker = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : null;
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validDateTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Parse Yahoo's chart response while keeping provider, cache, raw-close, and
 * adjustment concepts separate. `close` remains the adjusted return series
 * for backward compatibility with existing charts.
 */
export function parseYahooPayload(data, fromIso) {
  if (data?.chart?.error) {
    throw new PriceDataError(`Yahoo error: ${data.chart.error.description || data.chart.error.code}`);
  }
  const result = data?.chart?.result?.[0];
  if (!result) throw new PriceDataError('Yahoo returned no result.');

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
  if (!timestamps.length) throw new PriceDataError('Yahoo returned an empty price series.');

  const prices = [];
  let adjustedCount = 0;
  for (let index = 0; index < timestamps.length; index += 1) {
    const adjustedClose = Number.isFinite(adjusted[index]) ? adjusted[index] : null;
    const rawClose = Number.isFinite(quote.close?.[index]) ? quote.close[index] : null;
    const close = adjustedClose ?? rawClose;
    if (!Number.isFinite(close) || close <= 0) continue;
    const date = new Date(timestamps[index] * 1000).toISOString().slice(0, 10);
    if (fromIso && date < fromIso) continue;
    if (adjustedClose != null) adjustedCount += 1;
    prices.push({
      date,
      open: Number.isFinite(quote.open?.[index]) ? quote.open[index] : null,
      high: Number.isFinite(quote.high?.[index]) ? quote.high[index] : null,
      low: Number.isFinite(quote.low?.[index]) ? quote.low[index] : null,
      close,
      adjustedClose,
      rawClose,
      volume: Number.isFinite(quote.volume?.[index]) ? quote.volume[index] : null,
    });
  }
  if (!prices.length) throw new PriceDataError('Yahoo series had no valid rows.');
  return {
    prices,
    provider: 'yahoo_finance',
    priceBasis: adjustedCount === prices.length ? 'adjusted_close' : 'mixed_adjusted_and_raw_close',
    adjustmentCoverage: prices.length ? adjustedCount / prices.length : 0,
  };
}

export function parseStooqCsv(text, fromIso) {
  const cleaned = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned || cleaned.length < 50 || cleaned.startsWith('<') || cleaned.startsWith('No data')) {
    throw new PriceDataError('Stooq returned no usable price series.');
  }
  if (cleaned.toLowerCase().includes('exceeded') && cleaned.length < 500) {
    throw new PriceDataError('Stooq rate limit was reached.', { code: 'PRICE_PROVIDER_RATE_LIMITED', status: 503 });
  }
  const lines = cleaned.split(/\r?\n/);
  const header = (lines[0] || '').toLowerCase();
  if (!header.includes('date') || !header.includes('close')) {
    throw new PriceDataError('Stooq response was not a price CSV.');
  }
  const prices = [];
  for (let index = 1; index < lines.length; index += 1) {
    const [date, open, high, low, close, volume] = lines[index].split(',');
    const closeNumber = Number.parseFloat(close);
    if (!validIsoDate(date) || !Number.isFinite(closeNumber) || closeNumber <= 0) continue;
    if (fromIso && date < fromIso) continue;
    prices.push({
      date,
      open: Number.isFinite(Number.parseFloat(open)) ? Number.parseFloat(open) : null,
      high: Number.isFinite(Number.parseFloat(high)) ? Number.parseFloat(high) : null,
      low: Number.isFinite(Number.parseFloat(low)) ? Number.parseFloat(low) : null,
      close: closeNumber,
      adjustedClose: null,
      rawClose: closeNumber,
      volume: Number.isFinite(Number.parseInt(volume, 10)) ? Number.parseInt(volume, 10) : null,
    });
  }
  if (!prices.length) throw new PriceDataError('Stooq CSV had no parseable rows.');
  return {
    prices,
    provider: 'stooq',
    priceBasis: 'provider_close_adjustment_unverified',
    adjustmentCoverage: 0,
  };
}

async function publishProviderCooldown(provider, delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const bounded = Math.min(MAX_PROVIDER_COOLDOWN_MS, Math.ceil(delayMs));
  localProviderCooldownUntil.set(
    provider,
    Math.max(localProviderCooldownUntil.get(provider) || 0, Date.now() + bounded),
  );
  if (warmCacheEnabled()) await warmExtendCooldown('price-provider-cooldown', provider, bounded);
}

function responseCooldown(response) {
  const explicit = parsePriceRetryAfter(response?.headers?.get('retry-after'));
  if (response?.status === 403) return explicit ?? 30_000;
  if (response?.status === 429) return explicit ?? 5_000;
  if (response?.status === 503) return explicit ?? 2_000;
  return explicit;
}

async function acquireProviderPermit(provider, signal) {
  if (!warmCacheEnabled()) {
    if (DEPLOYED_RUNTIME) {
      throw new PriceDataError('Shared price-provider coordination is unavailable.', {
        code: 'PRICE_PROVIDER_GATE_UNAVAILABLE',
        status: 503,
      });
    }
    const now = Date.now();
    const scheduledAt = Math.max(
      now,
      localProviderNextStart.get(provider) || 0,
      localProviderCooldownUntil.get(provider) || 0,
    );
    localProviderNextStart.set(provider, scheduledAt + PROVIDER_START_INTERVAL_MS);
    await wait(scheduledAt - now, signal);
    return null;
  }
  const deadline = Date.now() + PROVIDER_GATE_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal);
    const cooldown = await warmCooldownRemaining('price-provider-cooldown', provider);
    if (cooldown === null && DEPLOYED_RUNTIME) {
      throw new PriceDataError('Shared price-provider coordination could not be checked.', {
        code: 'PRICE_PROVIDER_GATE_UNAVAILABLE',
        status: 503,
      });
    }
    if (cooldown > 0) {
      if (cooldown >= deadline - Date.now()) {
        throw new PriceDataError('The price provider requested a shared cooldown.', {
          code: 'PRICE_PROVIDER_COOLDOWN',
          status: 503,
        });
      }
      await wait(cooldown, signal);
      continue;
    }
    const token = await warmAcquireLease('price-provider-start', provider, PROVIDER_GATE_LEASE_MS);
    if (token) return token;
    await wait(75 + Math.floor(Math.random() * 76), signal);
  }
  throw new PriceDataError('Price-provider coordination is temporarily saturated.', {
    code: 'PRICE_PROVIDER_GATE_SATURATED',
    status: 503,
  });
}

export async function readBoundedPriceText(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new PriceDataError('Price-provider response exceeded the configured size limit.', {
      code: 'PRICE_PROVIDER_RESPONSE_TOO_LARGE',
      status: 502,
    });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new PriceDataError('Price-provider response exceeded the configured size limit.', {
        code: 'PRICE_PROVIDER_RESPONSE_TOO_LARGE',
        status: 502,
      });
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function providerFetch(provider, url, options = {}, { signal, maxBytes } = {}) {
  const token = await acquireProviderPermit(provider, signal);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    let outcome;
    try {
      outcome = Promise.resolve(fetch(url, { ...options, signal: combinedSignal })).then(
        (response) => ({ response }),
        (error) => ({ error }),
      );
      const spacing = wait(PROVIDER_START_INTERVAL_MS - (Date.now() - startedAt));
      const early = await Promise.race([outcome, spacing.then(() => null)]);
      if (early?.response) {
        const cooldown = responseCooldown(early.response);
        if (cooldown) await publishProviderCooldown(provider, cooldown);
      }
      await spacing;
    } finally {
      if (token) await warmReleaseLease('price-provider-start', provider, token);
    }
    const settled = await outcome;
    if (settled.error) {
      await publishProviderCooldown(provider, 1_000);
      throw settled.error;
    }
    const cooldown = responseCooldown(settled.response);
    if (cooldown) await publishProviderCooldown(provider, cooldown);
    const body = await readBoundedPriceText(settled.response, maxBytes);
    return { response: settled.response, body };
  } finally {
    clearTimeout(timeout);
  }
}

export function yahooWarmEnvelope(raw, parsed, exclusiveEnd, retrievedAt = new Date().toISOString()) {
  const completedThrough = parsed?.prices
    ?.filter((row) => row.date < exclusiveEnd)
    .at(-1)?.date || null;
  if (!validIsoDate(completedThrough)) {
    throw new PriceDataError('Yahoo returned no completed daily observations.', {
      code: 'PRICE_PROVIDER_RESPONSE_INCOMPLETE',
      status: 502,
    });
  }
  return {
    version: 'stock-yahoo-cache-v2',
    retrievedAt,
    completedThrough,
    raw,
  };
}

async function yahooSeries(ticker, fromIso, toEpoch, exclusiveEnd, signal) {
  const yahooTicker = ticker.replace(/\./g, '-');
  const fromEpoch = Math.floor(Date.parse(`${fromIso}T00:00:00Z`) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`
    + `?period1=${fromEpoch}&period2=${toEpoch}&interval=1d&events=history&includeAdjustedClose=true`;
  const { response, body } = await providerFetch('yahoo', url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; EDGARTerminal/1.0; +https://secedgarterminal.com/about)',
      Accept: 'application/json,text/plain,*/*',
    },
  }, { signal, maxBytes: YAHOO_MAX_BYTES });
  if (!response.ok) {
    throw new PriceDataError(`Yahoo returned HTTP ${response.status}.`, {
      code: response.status === 429 ? 'PRICE_PROVIDER_RATE_LIMITED' : 'PRICE_PROVIDER_ERROR',
      status: response.status === 429 ? 503 : 502,
    });
  }
  let raw;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    throw new PriceDataError('Yahoo returned invalid JSON.', { code: 'PRICE_PROVIDER_RESPONSE_INVALID', cause: error });
  }
  const parsed = parseYahooPayload(raw, fromIso);
  const retrievedAt = new Date().toISOString();
  const envelope = yahooWarmEnvelope(raw, parsed, exclusiveEnd, retrievedAt);
  await warmSet('stock-raw-yahoo', ticker, envelope, 25 * 3600);
  return { ...parsed, cacheStatus: 'upstream', retrievedAt };
}

async function stooqSeries(ticker, fromIso, signal) {
  const stooqTicker = `${ticker.toLowerCase().replace(/\./g, '-')}.us`;
  const { response, body } = await providerFetch('stooq', `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqTicker)}&i=d`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; EDGARTerminal/1.0; +https://secedgarterminal.com/about)',
      Accept: 'text/csv,text/plain,*/*',
    },
  }, { signal, maxBytes: STOOQ_MAX_BYTES });
  if (!response.ok) throw new PriceDataError(`Stooq returned HTTP ${response.status}.`);
  if (body.toLowerCase().includes('exceeded') && body.length < 500) {
    await publishProviderCooldown('stooq', 30_000);
  }
  return {
    ...parseStooqCsv(body, fromIso),
    cacheStatus: 'upstream',
    retrievedAt: new Date().toISOString(),
  };
}

export function warmYahooSeries(envelope, fromIso) {
  if (envelope?.version !== 'stock-yahoo-cache-v2'
    || !validIsoDate(envelope.completedThrough)
    || !envelope.raw) {
    throw new PriceDataError('Warm Yahoo series lacks a completed-session boundary.', {
      code: 'PRICE_WARM_CACHE_LEGACY',
      status: 503,
    });
  }
  const raw = envelope.raw;
  const firstTimestamp = raw?.chart?.result?.[0]?.timestamp?.[0];
  const coverageStart = Number.isFinite(firstTimestamp)
    ? new Date(firstTimestamp * 1000).toISOString().slice(0, 10)
    : null;
  if (!coverageStart || Date.parse(`${coverageStart}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`) > 7 * 86400000) {
    throw new PriceDataError(`Warm Yahoo series does not cover the requested start date ${fromIso}.`);
  }
  const parsed = parseYahooPayload(raw, fromIso);
  const prices = parsed.prices.filter((row) => row.date <= envelope.completedThrough);
  if (!prices.length) throw new PriceDataError(`Warm Yahoo series has no completed rows from ${fromIso}.`);
  const adjustedCount = prices.filter((row) => Number.isFinite(row.adjustedClose)).length;
  return {
    ...parsed,
    prices,
    priceBasis: adjustedCount === prices.length ? 'adjusted_close' : 'mixed_adjusted_and_raw_close',
    adjustmentCoverage: adjustedCount / prices.length,
    cacheStatus: 'warm',
    retrievedAt: validDateTime(envelope.retrievedAt) ? envelope.retrievedAt : null,
  };
}

async function loadUncached(ticker, fromIso, toEpoch, exclusiveEnd, forceRefresh = false, signal) {
  const attempts = [];
  const warm = forceRefresh ? null : await warmGet('stock-raw-yahoo', ticker);
  if (warm) {
    try {
      const result = warmYahooSeries(warm, fromIso);
      attempts.push({ provider: 'yahoo_finance', cacheStatus: 'warm', status: 'success', rowCount: result.prices.length });
      return { ticker, ...result, attempts };
    } catch (error) {
      attempts.push({ provider: 'yahoo_finance', cacheStatus: 'warm', status: 'insufficient', error: error.message });
    }
  }

  if (!forceRefresh && await warmGet('stock-price-failure-v1', ticker)) {
    throw new PriceDataError('A recent bounded refresh failed for this ticker. Retry shortly.', {
      code: 'PRICE_REFRESH_COOLDOWN',
      status: 503,
    });
  }

  const lease = await warmAcquireLease('stock-price-refresh', ticker, PRICE_REFRESH_LEASE_MS);
  if (warmCacheEnabled() && !lease) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await wait(250, signal);
      const candidate = await warmGet('stock-raw-yahoo', ticker);
      if (!candidate) continue;
      try {
        const result = warmYahooSeries(candidate, fromIso);
        attempts.push({ provider: 'yahoo_finance', cacheStatus: 'warm-after-wait', status: 'success', rowCount: result.prices.length });
        return { ticker, ...result, cacheStatus: 'warm-after-wait', attempts };
      } catch {
        break;
      }
    }
    throw new PriceDataError('Another worker is refreshing this price series.', {
      code: 'PRICE_REFRESH_IN_PROGRESS',
      status: 503,
    });
  }

  try {
    for (const [provider, loader] of [
      ['yahoo_finance', () => yahooSeries(ticker, fromIso, toEpoch, exclusiveEnd, signal)],
      ['stooq', () => stooqSeries(ticker, fromIso, signal)],
    ]) {
      try {
        const result = await loader();
        attempts.push({ provider, cacheStatus: result.cacheStatus, status: 'success', rowCount: result.prices.length });
        return { ticker, ...result, attempts };
      } catch (error) {
        attempts.push({ provider, cacheStatus: 'upstream', status: 'failed', error: error.message });
        if (signal?.aborted) throw abortError(signal);
        if (error?.code === 'PRICE_PROVIDER_GATE_UNAVAILABLE') throw error;
      }
    }
  } finally {
    if (lease) await warmReleaseLease('stock-price-refresh', ticker, lease);
  }
  await warmSet('stock-price-failure-v1', ticker, { failedAt: new Date().toISOString(), attempts }, 60);
  throw new PriceDataError(`Price sources are unavailable for ${ticker}.`, { code: 'PRICE_DATA_UNAVAILABLE' });
}

export async function loadPriceSeries({ ticker: inputTicker, fromIso, now = new Date(), forceRefresh = false, signal }) {
  const ticker = normalizePriceTicker(inputTicker);
  if (!ticker) throw new PriceDataError('Invalid ticker format.', { code: 'INVALID_TICKER', status: 400 });
  if (!validIsoDate(fromIso)) throw new PriceDataError('Invalid price start date.', { code: 'INVALID_START_DATE', status: 400 });
  const toEpoch = Math.floor(now.getTime() / 1000) + 86400;
  const exclusiveEnd = now.toISOString().slice(0, 10);
  const key = `${ticker}:${fromIso}:${forceRefresh ? 'refresh' : 'cached'}`;
  if (pending.has(key)) return pending.get(key);
  if (signal?.aborted) throw abortError(signal);
  const task = loadUncached(ticker, fromIso, toEpoch, exclusiveEnd, forceRefresh, signal);
  pending.set(key, task);
  try {
    const result = await task;
    // Yahoo can expose a still-forming daily candle. Publish only sessions
    // whose UTC date is already complete; the prior US session becomes
    // eligible shortly after midnight UTC without requiring an exchange-
    // holiday guess in this transport layer.
    const prices = result.prices.filter((row) => row.date >= fromIso && row.date < exclusiveEnd);
    if (!prices.length) throw new PriceDataError(`No prices for ${ticker} in the requested range.`);
    const adjustedCount = prices.filter((row) => Number.isFinite(row.adjustedClose)).length;
    const priceBasis = result.provider === 'yahoo_finance'
      ? adjustedCount === prices.length ? 'adjusted_close' : 'mixed_adjusted_and_raw_close'
      : result.priceBasis;
    const adjustmentCoverage = result.provider === 'yahoo_finance' ? adjustedCount / prices.length : result.adjustmentCoverage;
    return { ...result, prices, priceBasis, adjustmentCoverage, from: prices[0].date, to: prices.at(-1).date, count: prices.length };
  } finally {
    pending.delete(key);
  }
}
