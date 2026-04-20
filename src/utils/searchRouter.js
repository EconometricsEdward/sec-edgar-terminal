// ============================================================================
// searchRouter — Advanced search logic for GlobalSearchBar
//
// Hybrid disambiguation:
//   - Company ticker (AAPL)       → disambiguate: Filings | Analysis
//   - Fund ticker (SPY, IBIT)     → disambiguate: Filings | Fund page
//   - Crypto only (BTC, SOL)      → navigate directly to /crypto
//   - Crypto + company (ETH)      → disambiguate: Crypto | Filings | Analysis
//   - Crypto + fund (BTC=Grayscale)→ disambiguate: Crypto | Filings | Fund page
//   - Comma-separated             → /compare (validate all exist, no crypto)
// ============================================================================

export const CRYPTO_TICKERS = new Set([
  'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH',
]);

export const CRYPTO_NAMES = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  XRP: 'XRP',
  ADA: 'Cardano',
  AVAX: 'Avalanche',
  LINK: 'Chainlink',
  DOT: 'Polkadot',
  LTC: 'Litecoin',
  BCH: 'Bitcoin Cash',
};

// ============================================================================
// Active segment parsing — for multi-ticker autocomplete
// ============================================================================

/**
 * Parses a query to find the "active segment" — the ticker currently being
 * typed by the user. Everything before the last comma is "completed";
 * everything after is the active segment.
 *
 * Examples:
 *   "AAPL"          → { prefix: "",            active: "AAPL",  completed: [] }
 *   "AAPL,MSFT"     → { prefix: "AAPL,",       active: "MSFT",  completed: ["AAPL"] }
 *   "AAPL, MSFT"    → { prefix: "AAPL, ",      active: "MSFT",  completed: ["AAPL"] }
 *   "AAPL,MSFT,"    → { prefix: "AAPL,MSFT,",  active: "",      completed: ["AAPL","MSFT"] }
 */
export function parseActiveSegment(query) {
  if (!query) return { prefix: '', active: '', completed: [] };
  const lastCommaIdx = query.lastIndexOf(',');
  if (lastCommaIdx === -1) {
    return {
      prefix: '',
      active: query.trim().toUpperCase(),
      completed: [],
    };
  }
  const prefix = query.substring(0, lastCommaIdx + 1);
  const active = query.substring(lastCommaIdx + 1).trim().toUpperCase();
  const completed = prefix
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  return { prefix, active, completed };
}

// ============================================================================
// Routing
// ============================================================================

/**
 * Build the list of destination options for a given ticker. Used for:
 *   - Building disambiguation UI on Enter
 *   - Building inline action buttons on autocomplete rows
 *
 * @param {string} ticker - Uppercase ticker
 * @param {object} secEntry - SEC ticker map entry (or null)
 * @returns {Array<{label, path, type}>}
 */
export function buildDestinationOptions(ticker, secEntry) {
  const options = [];
  const upper = ticker.toUpperCase();
  const isCrypto = CRYPTO_TICKERS.has(upper);

  if (isCrypto) {
    options.push({
      label: `${CRYPTO_NAMES[upper] || upper} — Crypto page`,
      shortLabel: 'Crypto',
      path: '/crypto',
      type: 'crypto',
    });
  }

  if (secEntry) {
    // Always offer filings for any SEC ticker
    options.push({
      label: `${secEntry.name} — SEC filings`,
      shortLabel: 'Filings',
      path: `/filings/${upper}`,
      type: 'filings',
    });

    if (secEntry.isFund) {
      options.push({
        label: `${secEntry.name} — Fund holdings`,
        shortLabel: 'Fund',
        path: `/fund/${upper}`,
        type: 'fund',
      });
    } else {
      options.push({
        label: `${secEntry.name} — Financial analysis`,
        shortLabel: 'Analysis',
        path: `/analysis/${upper}`,
        type: 'analysis',
      });
    }
  }

  return options;
}

/**
 * Decides where a search query should navigate.
 * Uses the HYBRID disambiguation model.
 *
 * @param {string} query - User's raw input
 * @param {object} tickerMap - SEC ticker map
 * @returns {object}
 *   { path: '/compare/X,Y' }                            — navigate directly (compare only)
 *   { error: 'Not recognized: FOO' }                    — show error
 *   { disambiguate: { ticker, options: [...] } }        — user picks destination
 *     (single ticker with SEC match ALWAYS produces disambiguate)
 */
export function routeSearch(query, tickerMap) {
  if (!query || !query.trim()) {
    return { error: 'Type a ticker symbol' };
  }

  const normalized = query.trim().toUpperCase();

  // --- Comma-separated: compare mode ---
  if (normalized.includes(',')) {
    const tickers = normalized
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    if (tickers.length < 2) {
      return { error: 'Compare mode requires at least 2 tickers' };
    }
    if (tickers.length > 5) {
      return { error: 'Compare supports maximum 5 tickers' };
    }

    const cryptoInList = tickers.filter((t) => CRYPTO_TICKERS.has(t));
    if (cryptoInList.length > 0) {
      return {
        error: `Compare mode doesn't support crypto yet: ${cryptoInList.join(', ')}`,
      };
    }

    const unknown = tickers.filter((t) => !tickerMap?.[t]);
    if (unknown.length > 0) {
      return { error: `Not recognized: ${unknown.join(', ')}` };
    }

    return { path: `/compare/${tickers.join(',')}` };
  }

  // --- Single ticker ---
  const isCrypto = CRYPTO_TICKERS.has(normalized);
  const secEntry = tickerMap?.[normalized];

  // Crypto only, no SEC ticker overlap → go directly
  if (isCrypto && !secEntry) {
    return { path: '/crypto' };
  }

  // SEC ticker exists (with or without crypto overlap) → always disambiguate
  // This covers: company alone, fund alone, crypto+company, crypto+fund
  if (secEntry) {
    const options = buildDestinationOptions(normalized, secEntry);
    // If crypto also matches, add it to options
    if (isCrypto) {
      options.unshift({
        label: `${CRYPTO_NAMES[normalized] || normalized} — Crypto page`,
        shortLabel: 'Crypto',
        path: '/crypto',
        type: 'crypto',
      });
    }
    return {
      disambiguate: {
        ticker: normalized,
        name: secEntry.name,
        options,
      },
    };
  }

  // Nothing matched
  return { error: `${normalized} not recognized` };
}

// ============================================================================
// Autocomplete suggestions
// ============================================================================

function scoreTicker(ticker, name, query) {
  if (!ticker || !query) return 0;
  const t = ticker.toUpperCase();
  const n = (name || '').toUpperCase();
  const q = query.toUpperCase();

  if (t === q) return 10000;
  if (t.startsWith(q)) return 5000 - (t.length - q.length);
  if (n.startsWith(q)) return 3000 - (n.length - q.length);

  const nameWords = n.split(/[\s,.\-()]+/);
  for (const word of nameWords) {
    if (word.startsWith(q)) {
      return 2000 - (word.length - q.length);
    }
  }

  if (t.includes(q)) return 1500 - (t.length - q.length);
  if (n.includes(q)) return 1000 - (n.length - q.length);
  return 0;
}

/**
 * Generates autocomplete suggestions.
 * When query contains commas, only suggests for the active (last) segment.
 *
 * @param {string} query
 * @param {object} tickerMap
 * @param {number} limit
 * @returns {{suggestions: Array, active: string, completed: Array, prefix: string}}
 */
export function getSuggestions(query, tickerMap, limit = 10) {
  const parsed = parseActiveSegment(query);
  const { active, completed } = parsed;

  if (!active || active.length === 0) {
    return { suggestions: [], ...parsed };
  }

  const results = [];
  const excludeSet = new Set(completed);
  const isCompareMode = query.includes(',');

  // Crypto suggestions (only when not in compare mode)
  if (!isCompareMode) {
    for (const cryptoTicker of CRYPTO_TICKERS) {
      if (excludeSet.has(cryptoTicker)) continue;
      const score = scoreTicker(cryptoTicker, CRYPTO_NAMES[cryptoTicker], active);
      if (score > 0) {
        results.push({
          ticker: cryptoTicker,
          name: CRYPTO_NAMES[cryptoTicker] || cryptoTicker,
          type: 'crypto',
          score: score + 100,
        });
      }
    }
  }

  // SEC ticker suggestions
  if (tickerMap) {
    for (const entry of Object.values(tickerMap)) {
      const ticker = entry.ticker;
      if (excludeSet.has(ticker)) continue;
      const score = scoreTicker(ticker, entry.name, active);
      if (score > 0) {
        results.push({
          ticker,
          name: entry.name,
          type: entry.isFund ? 'fund' : 'company',
          cik: entry.cik,
          isFund: entry.isFund,
          score,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return {
    suggestions: results.slice(0, limit),
    ...parsed,
  };
}

// ============================================================================
// Recent searches
// ============================================================================

const RECENT_KEY = 'edgar_recent_searches';
const RECENT_LIMIT = 10;

export function loadRecentSearches() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function pushRecentSearch(entry) {
  if (typeof window === 'undefined') return;
  if (!entry || !entry.query) return;
  try {
    const current = loadRecentSearches();
    const filtered = current.filter((r) => r.query !== entry.query);
    const next = [
      { query: entry.query, path: entry.path, ts: Date.now() },
      ...filtered,
    ].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function clearRecentSearches() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(RECENT_KEY);
  } catch {
    // ignore
  }
}
