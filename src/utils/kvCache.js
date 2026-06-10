// ============================================================================
// kvCache — generic namespaced cache with the same backend strategy as
// scannerCache.js: Upstash Redis when env vars exist, in-memory fallback
// otherwise. Kept separate so scannerCache's crypto-scan key format stays
// untouched. Keys: "{namespace}:{key}:v1".
// ============================================================================

let _redisClient = null;
let _initAttempted = false;

async function getRedisClient() {
  if (_initAttempted) return _redisClient;
  _initAttempted = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    _redisClient = new Redis({ url, token });
    return _redisClient;
  } catch (err) {
    console.warn('[kvCache] Upstash init failed, using in-memory fallback:', err.message);
    return null;
  }
}

const _mem = new Map();
function memSet(key, value, ttlSeconds) {
  _mem.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}
function memGet(key) {
  const hit = _mem.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    _mem.delete(key);
    return null;
  }
  return hit.value;
}

const fullKey = (ns, key) => `${ns}:${key}:v1`;

export async function getCached(namespace, key) {
  const k = fullKey(namespace, key);
  try {
    const redis = await getRedisClient();
    if (redis) {
      const raw = await redis.get(k);
      if (raw == null) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
  } catch (err) {
    console.warn(`[kvCache] get failed for ${k}:`, err.message);
  }
  return memGet(k);
}

export async function setCached(namespace, key, value, ttlSeconds) {
  const k = fullKey(namespace, key);
  try {
    const redis = await getRedisClient();
    if (redis) {
      await redis.set(k, JSON.stringify(value), { ex: ttlSeconds });
      return true;
    }
  } catch (err) {
    console.warn(`[kvCache] set failed for ${k}:`, err.message);
  }
  memSet(k, value, ttlSeconds);
  return true;
}
