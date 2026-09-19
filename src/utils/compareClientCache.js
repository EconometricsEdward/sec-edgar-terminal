import { analysisSourcesDegraded } from "./analysisSourceCoverage.js";

/** HTTP freshness is independent of when a prepared financial payload was built.
 * Its envelope may have been revalidated without changing the payload. */
export function compareResponseExpiresAt(headers, {
  now = Date.now(), requestStartedAt = now, ttl = 5 * 60 * 1000,
} = {}) {
  if (!headers || typeof headers.get !== "function") return null;
  const control = headers.get("Cache-Control") || "";
  const stale = (headers.get("X-Data-Stale") || "").toLowerCase();
  if (/\b(?:no-store|no-cache)\b/i.test(control)
    || (stale && !["false", "0"].includes(stale))
    || /\b11[01]\b/.test(headers.get("Warning") || "")) return null;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i.exec(control);
  const sharedAge = /(?:^|,)\s*s-maxage\s*=\s*"?(\d+)"?\s*(?:,|$)/i.exec(control);
  const freshSeconds = Number(maxAge?.[1] ?? sharedAge?.[1]);
  if (!Number.isFinite(freshSeconds) || freshSeconds <= 0) return null;
  const fetchedText = headers.get("X-Data-Fetched-At");
  const revalidatedText = headers.get("X-Data-Revalidated-At");
  const fetched = Date.parse(fetchedText || "");
  const revalidated = Date.parse(revalidatedText || "");
  if ((fetchedText && (!Number.isFinite(fetched) || fetched > now + 60000))
    || (revalidatedText && (!Number.isFinite(revalidated) || revalidated > now + 60000))
    || (fetchedText && revalidatedText && fetched > revalidated)) return null;
  const ageText = headers.get("Age");
  if (ageText && !/^\d+$/.test(ageText)) return null;
  const responseDateText = headers.get("Date");
  const responseDate = Date.parse(responseDateText || "");
  if (responseDateText && !Number.isFinite(responseDate)) return null;
  // Account for time at the CDN/browser and time spent receiving this response.
  const responseDelay = Math.max(0, now - requestStartedAt);
  const age = Math.max(Number(ageText || 0) * 1000 + responseDelay,
    Number.isFinite(responseDate) ? Math.max(0, now - responseDate) : 0);
  let remaining = freshSeconds * 1000 - age;
  const expiresText = headers.get("X-Data-Expires-At");
  if (expiresText) {
    const expires = Date.parse(expiresText);
    if (!Number.isFinite(expires)) return null;
    remaining = Math.min(remaining, expires - now);
  }
  return remaining > 0 ? now + Math.min(ttl, remaining) : null;
}

/** A short-lived, bounded cache for this open comparison only. No browser storage. */
export function createCompareClientCache({
  now = Date.now,
  ttl = 5 * 60 * 1000,
  maxEntries = 24,
  maxBytes = 12 * 1024 * 1024,
} = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = (key) => {
    const entry = entries.get(key);
    if (entry) bytes -= entry.bytes;
    return entries.delete(key);
  };
  const prune = () => {
    for (const [key, entry] of entries)
      if (entry.expiresAt <= now()) remove(key);
  };
  const get = (key) => {
    prune();
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  };
  return {
    get,
    has: (key) => Boolean(get(key)),
    delete: remove,
    clear() {
      entries.clear();
      bytes = 0;
    },
    set(key, value, size, freshness = {}) {
      prune();
      remove(key);
      const expiresAt = compareResponseExpiresAt(freshness.headers, {
        now: now(), requestStartedAt: freshness.requestStartedAt, ttl,
      });
      if (!Number.isFinite(size) || size < 1 || size > maxBytes ||
        analysisSourcesDegraded(value) || !expiresAt || expiresAt <= now())
        return false;
      while (entries.size && (entries.size >= maxEntries || bytes + size > maxBytes))
        remove(entries.keys().next().value);
      entries.set(key, { value, bytes: size, expiresAt });
      bytes += size;
      return true;
    },
  };
}
