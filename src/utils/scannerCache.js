// ============================================================================
// scannerCache — Storage abstraction for cached scan results
//
// Supports two backends:
//   1. Upstash Redis (production, via @upstash/redis)
//   2. In-memory Map (local dev fallback, ephemeral)
//
// The backend is selected automatically based on env vars:
//   - If UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set → Upstash
//   - Otherwise → in-memory (resets on server restart)
//
// Key format: "scan:{ticker}:v1" — versioned so we can invalidate if we change
// the scan result shape in future.
//
// Values: JSON objects with { scannedAt, result } structure. TTL: 24 hours.
// ============================================================================

const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const KEY_PREFIX = 'scan:';
const KEY_VERSION = 'v1';

// Lazy-initialized Upstash client
let _redisClient = null;
let _initAttempted = false;

async function getRedisClient() {
  if (_initAttempted) return _redisClient;
  _initAttempted = true;

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // Missing env vars → use in-memory fallback
    return null;
  }

  try {
    // Dynamic import so the package is only required in production builds
    const { Redis } = await import('@upstash/redis');
    _redisClient = new Redis({ url, token });
    return _redisClient;
  } catch (err) {
    console.warn('[scannerCache] Failed to init Upstash Redis, falling back to in-memory:', err.message);
    return null;
  }
}

// ============================================================================
// In-memory fallback
// ============================================================================

const _memoryCache = new Map();

function memSet(key, value, ttlSeconds) {
  const expires = Date.now() + ttlSeconds * 1000;
  _memoryCache.set(key, { value, expires });
}

function memGet(key) {
  const entry = _memoryCache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    _memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

function memDelete(key) {
  _memoryCache.delete(key);
}

// ============================================================================
// Public API
// ============================================================================

function buildKey(ticker) {
  return `${KEY_PREFIX}${ticker.toUpperCase()}:${KEY_VERSION}`;
}

/**
 * Retrieve a cached scan result for a ticker.
 *
 * @param {string} ticker - Uppercase ticker (will be normalized)
 * @returns {Promise<object|null>} - Cached result or null if not found/expired
 */
export async function getCachedScan(ticker) {
  if (!ticker) return null;
  const key = buildKey(ticker);

  const client = await getRedisClient();
  if (client) {
    try {
      const value = await client.get(key);
      // Upstash @upstash/redis auto-deserializes JSON values
      return value || null;
    } catch (err) {
      console.warn('[scannerCache] Redis get failed, falling back to memory:', err.message);
    }
  }

  return memGet(key);
}

/**
 * Store a scan result for a ticker with 24-hour TTL.
 *
 * @param {string} ticker
 * @param {object} result - Scan result object
 * @returns {Promise<boolean>} - true if stored successfully
 */
export async function setCachedScan(ticker, result) {
  if (!ticker || !result) return false;
  const key = buildKey(ticker);
  const payload = {
    scannedAt: new Date().toISOString(),
    result,
  };

  const client = await getRedisClient();
  if (client) {
    try {
      // Upstash supports { ex: seconds } option for TTL
      await client.set(key, payload, { ex: CACHE_TTL_SECONDS });
      return true;
    } catch (err) {
      console.warn('[scannerCache] Redis set failed, falling back to memory:', err.message);
    }
  }

  memSet(key, payload, CACHE_TTL_SECONDS);
  return true;
}

/**
 * Invalidate a cached scan. Useful if user explicitly wants fresh data.
 *
 * @param {string} ticker
 */
export async function invalidateScan(ticker) {
  if (!ticker) return;
  const key = buildKey(ticker);

  const client = await getRedisClient();
  if (client) {
    try {
      await client.del(key);
    } catch (err) {
      console.warn('[scannerCache] Redis del failed:', err.message);
    }
  }

  memDelete(key);
}

/**
 * Check which backend is in use (for diagnostics / admin views).
 *
 * @returns {Promise<'upstash'|'memory'>}
 */
export async function getBackendType() {
  const client = await getRedisClient();
  return client ? 'upstash' : 'memory';
}
