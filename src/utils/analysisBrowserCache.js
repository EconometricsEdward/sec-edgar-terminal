import { ANALYSIS_VERSION, ANALYSIS_MAPPING_VERSION } from "./analysisVersion.js";
import { analysisSourceCachePolicy } from "./analysisSourceCoverage.js";

export function matchesAnalysisResponse(value, { ticker, basis, asOf = "" }) {
  return value?.packed === true && value.version === ANALYSIS_VERSION
    && value.mappingVersion === ANALYSIS_MAPPING_VERSION
    && value.ticker === String(ticker).toUpperCase() && value.basis === basis
    && (value.asOf || "") === asOf && Array.isArray(value.periods)
    && Array.isArray(value.definitions) && Array.isArray(value.sourceCatalog)
    && Array.isArray(value.calculationCatalog) && value.metrics
    && typeof value.metrics === "object" && !Array.isArray(value.metrics);
}

// Keep inactive research results packed. Only the selected result needs its
// complete, unpacked metric evidence in the workspace.
export const ANALYSIS_BROWSER_CACHE_LIMITS = Object.freeze({
  maxEntries: 4,
  maxBytes: 12 * 1024 * 1024,
  ttlMs: 5 * 60 * 1000,
});

export function analysisBrowserCacheKey(ticker, settings) {
  // Period selection uses the same model; a retry replaces this key.
  return JSON.stringify([
    ANALYSIS_VERSION,
    ANALYSIS_MAPPING_VERSION,
    String(ticker).toUpperCase(),
    settings.basis,
    settings.asOf || "",
  ]);
}

export function createAnalysisBrowserCache({
  maxEntries = ANALYSIS_BROWSER_CACHE_LIMITS.maxEntries,
  maxBytes = ANALYSIS_BROWSER_CACHE_LIMITS.maxBytes,
  ttlMs = ANALYSIS_BROWSER_CACHE_LIMITS.ttlMs,
  now = Date.now,
} = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    bytes -= entry.bytes;
    entries.delete(key);
  };
  const prune = () => {
    const time = now();
    for (const [key, entry] of entries)
      if (entry.expiresAt <= time) remove(key);
  };
  return {
    get(key, { bypass = false } = {}) {
      prune();
      if (bypass) {
        remove(key);
        return null;
      }
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return JSON.parse(entry.json);
    },
    set(key, packed) {
      prune();
      remove(key);
      if (packed?.packed !== true || packed.version !== ANALYSIS_VERSION || packed.mappingVersion !== ANALYSIS_MAPPING_VERSION) return false;
      const json = JSON.stringify(packed);
      // Count the UTF-16 string payload, rather than undercounting non-ASCII
      // strings or retaining unbounded object graphs behind a byte estimate.
      const size = json.length * 2;
      if (size > maxBytes || maxEntries < 1 || ttlMs <= 0) return false;
      while (entries.size >= maxEntries || bytes + size > maxBytes)
        remove(entries.keys().next().value);
      entries.set(key, { json, bytes: size, expiresAt: now() + Math.min(ttlMs, analysisSourceCachePolicy(packed).ttlSeconds * 1000) });
      bytes += size;
      return true;
    },
    stats() {
      prune();
      return { entries: entries.size, bytes };
    },
  };
}

// The public HTML describes explicit selectors. Never leave an annual or
// latest-period brief visible above a workspace showing a different vintage.
export function analysisBriefMatches(brief, ticker, settings) {
  return (
    brief.ticker === String(ticker).toUpperCase() &&
    brief.basis === settings.basis &&
    brief.end === (settings.end || "latest") &&
    brief.asof === (settings.asOf || "") &&
    (brief.baseline || "year") === settings.baseline
  );
}
