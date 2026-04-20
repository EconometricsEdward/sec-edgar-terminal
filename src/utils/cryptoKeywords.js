// ============================================================================
// cryptoKeywords — Keyword library for scanning SEC filings for crypto mentions
//
// Organized by category so results can show "this company mentioned X in
// these categories". Each keyword has a regex pattern that handles:
//   - Word boundaries (so "BTC" doesn't match "BTCSE")
//   - Case insensitivity
//   - Common variants (plurals, hyphens)
// ============================================================================

/**
 * @typedef {Object} KeywordDef
 * @property {string} term - Canonical display term
 * @property {RegExp} pattern - Regex for matching in text
 * @property {string} category - Category for grouping
 * @property {string} [aliases] - Optional list of aliases
 */

// Helper: create a word-boundary, case-insensitive regex
function wb(term) {
  // Escape special regex chars
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'gi');
}

// Helper: regex for phrases (handles multi-word terms, hyphens optional)
function phrase(term) {
  const escaped = term
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')  // flexible whitespace
    .replace(/-/g, '[-\\s]?'); // hyphen or space or neither
  return new RegExp(`\\b${escaped}\\b`, 'gi');
}

// ============================================================================
// Keyword definitions — CAREFULLY curated to balance recall and precision
// ============================================================================

export const KEYWORDS = [
  // --- Bitcoin ---
  { term: 'bitcoin', pattern: wb('bitcoin'), category: 'bitcoin', canonical: 'Bitcoin' },
  { term: 'bitcoins', pattern: wb('bitcoins'), category: 'bitcoin', canonical: 'Bitcoin' },
  { term: 'BTC', pattern: wb('BTC'), category: 'bitcoin', canonical: 'Bitcoin' },

  // --- Ethereum ---
  { term: 'ethereum', pattern: wb('ethereum'), category: 'ethereum', canonical: 'Ethereum' },
  { term: 'ether', pattern: wb('ether'), category: 'ethereum', canonical: 'Ethereum' },
  { term: 'ETH', pattern: wb('ETH'), category: 'ethereum', canonical: 'Ethereum' },

  // --- Other major cryptocurrencies ---
  { term: 'solana', pattern: wb('solana'), category: 'altcoins', canonical: 'Solana' },
  { term: 'cardano', pattern: wb('cardano'), category: 'altcoins', canonical: 'Cardano' },
  { term: 'XRP', pattern: wb('XRP'), category: 'altcoins', canonical: 'XRP' },
  { term: 'ripple', pattern: wb('ripple'), category: 'altcoins', canonical: 'XRP / Ripple' },
  { term: 'polkadot', pattern: wb('polkadot'), category: 'altcoins', canonical: 'Polkadot' },
  { term: 'litecoin', pattern: wb('litecoin'), category: 'altcoins', canonical: 'Litecoin' },
  { term: 'chainlink', pattern: wb('chainlink'), category: 'altcoins', canonical: 'Chainlink' },
  { term: 'avalanche', pattern: wb('avalanche'), category: 'altcoins', canonical: 'Avalanche' },
  { term: 'dogecoin', pattern: wb('dogecoin'), category: 'altcoins', canonical: 'Dogecoin' },

  // --- Generic crypto terminology ---
  { term: 'cryptocurrency', pattern: wb('cryptocurrency'), category: 'generic', canonical: 'Cryptocurrency' },
  { term: 'cryptocurrencies', pattern: wb('cryptocurrencies'), category: 'generic', canonical: 'Cryptocurrency' },
  { term: 'crypto-currency', pattern: phrase('crypto-currency'), category: 'generic', canonical: 'Cryptocurrency' },
  { term: 'crypto asset', pattern: phrase('crypto asset'), category: 'generic', canonical: 'Crypto asset' },
  { term: 'crypto assets', pattern: phrase('crypto assets'), category: 'generic', canonical: 'Crypto asset' },
  { term: 'crypto-asset', pattern: phrase('crypto-asset'), category: 'generic', canonical: 'Crypto asset' },
  { term: 'digital asset', pattern: phrase('digital asset'), category: 'generic', canonical: 'Digital asset' },
  { term: 'digital assets', pattern: phrase('digital assets'), category: 'generic', canonical: 'Digital asset' },
  { term: 'digital currency', pattern: phrase('digital currency'), category: 'generic', canonical: 'Digital currency' },
  { term: 'digital currencies', pattern: phrase('digital currencies'), category: 'generic', canonical: 'Digital currency' },
  { term: 'virtual currency', pattern: phrase('virtual currency'), category: 'generic', canonical: 'Virtual currency' },
  { term: 'virtual currencies', pattern: phrase('virtual currencies'), category: 'generic', canonical: 'Virtual currency' },
  { term: 'virtual asset', pattern: phrase('virtual asset'), category: 'generic', canonical: 'Virtual asset' },

  // --- Infrastructure ---
  { term: 'blockchain', pattern: wb('blockchain'), category: 'infrastructure', canonical: 'Blockchain' },
  { term: 'distributed ledger', pattern: phrase('distributed ledger'), category: 'infrastructure', canonical: 'Distributed ledger' },
  { term: 'hashrate', pattern: wb('hashrate'), category: 'infrastructure', canonical: 'Hashrate' },
  { term: 'hash rate', pattern: phrase('hash rate'), category: 'infrastructure', canonical: 'Hashrate' },
  { term: 'mining rig', pattern: phrase('mining rig'), category: 'infrastructure', canonical: 'Mining' },
  { term: 'bitcoin mining', pattern: phrase('bitcoin mining'), category: 'infrastructure', canonical: 'Bitcoin mining' },
  { term: 'crypto mining', pattern: phrase('crypto mining'), category: 'infrastructure', canonical: 'Crypto mining' },

  // --- Business / accounting ---
  { term: 'digital asset holdings', pattern: phrase('digital asset holdings'), category: 'accounting', canonical: 'Digital asset holdings' },
  { term: 'bitcoin holdings', pattern: phrase('bitcoin holdings'), category: 'accounting', canonical: 'Bitcoin holdings' },
  { term: 'impairment of bitcoin', pattern: phrase('impairment of bitcoin'), category: 'accounting', canonical: 'Bitcoin impairment' },
  { term: 'bitcoin strategy', pattern: phrase('bitcoin strategy'), category: 'accounting', canonical: 'Bitcoin strategy' },
  { term: 'treasury reserve', pattern: phrase('treasury reserve'), category: 'accounting', canonical: 'Treasury reserve' },

  // --- Exchanges / trading ---
  { term: 'crypto exchange', pattern: phrase('crypto exchange'), category: 'business', canonical: 'Crypto exchange' },
  { term: 'cryptocurrency exchange', pattern: phrase('cryptocurrency exchange'), category: 'business', canonical: 'Crypto exchange' },
  { term: 'digital asset exchange', pattern: phrase('digital asset exchange'), category: 'business', canonical: 'Digital asset exchange' },
  { term: 'stablecoin', pattern: wb('stablecoin'), category: 'business', canonical: 'Stablecoin' },
  { term: 'stablecoins', pattern: wb('stablecoins'), category: 'business', canonical: 'Stablecoin' },

  // --- Products / ETFs ---
  { term: 'spot bitcoin ETF', pattern: phrase('spot bitcoin ETF'), category: 'products', canonical: 'Spot Bitcoin ETF' },
  { term: 'bitcoin ETF', pattern: phrase('bitcoin ETF'), category: 'products', canonical: 'Bitcoin ETF' },
  { term: 'ethereum ETF', pattern: phrase('ethereum ETF'), category: 'products', canonical: 'Ethereum ETF' },

  // --- DeFi ---
  { term: 'DeFi', pattern: wb('DeFi'), category: 'defi', canonical: 'DeFi' },
  { term: 'decentralized finance', pattern: phrase('decentralized finance'), category: 'defi', canonical: 'DeFi' },
  { term: 'NFT', pattern: wb('NFT'), category: 'defi', canonical: 'NFT' },
  { term: 'NFTs', pattern: wb('NFTs'), category: 'defi', canonical: 'NFT' },
  { term: 'non-fungible token', pattern: phrase('non-fungible token'), category: 'defi', canonical: 'NFT' },
];

// ============================================================================
// Category metadata for display
// ============================================================================

export const CATEGORIES = {
  bitcoin: { label: 'Bitcoin', color: 'amber', priority: 1 },
  ethereum: { label: 'Ethereum', color: 'sky', priority: 2 },
  altcoins: { label: 'Altcoins', color: 'violet', priority: 3 },
  generic: { label: 'General crypto', color: 'emerald', priority: 4 },
  infrastructure: { label: 'Infrastructure', color: 'stone', priority: 5 },
  accounting: { label: 'Accounting/treasury', color: 'rose', priority: 6 },
  business: { label: 'Business/trading', color: 'teal', priority: 7 },
  products: { label: 'ETFs/products', color: 'fuchsia', priority: 8 },
  defi: { label: 'DeFi/NFT', color: 'indigo', priority: 9 },
};

// ============================================================================
// Matching utilities
// ============================================================================

/**
 * Find all keyword matches in a text with their positions.
 *
 * @param {string} text - Text to scan (should be plain text, not HTML)
 * @returns {Array<{index: number, term: string, category: string, canonical: string}>}
 */
export function findMatches(text) {
  if (!text) return [];
  const matches = [];
  const seenAtIndex = new Set(); // Prevent overlapping matches at same position

  for (const kw of KEYWORDS) {
    // Reset regex lastIndex for fresh search
    kw.pattern.lastIndex = 0;
    let m;
    while ((m = kw.pattern.exec(text)) !== null) {
      // Skip if we already have a match at this exact position (shorter keyword won't override)
      if (seenAtIndex.has(m.index)) continue;
      seenAtIndex.add(m.index);
      matches.push({
        index: m.index,
        length: m[0].length,
        term: m[0],
        canonical: kw.canonical,
        category: kw.category,
      });
    }
  }

  // Sort by position
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

/**
 * Given a match position in text, extract the surrounding paragraph.
 * A "paragraph" is defined as: text bounded by double newlines, or sentence
 * breaks if no paragraph boundaries exist nearby.
 *
 * @param {string} text - Full text
 * @param {number} matchIndex - Position of the match
 * @param {number} matchLength - Length of the matched term
 * @param {number} [maxLen=800] - Max paragraph length (truncate if longer)
 * @returns {{before: string, match: string, after: string, fullText: string}}
 */
export function extractParagraph(text, matchIndex, matchLength, maxLen = 800) {
  if (!text || matchIndex < 0) {
    return { before: '', match: '', after: '', fullText: '' };
  }

  // Find paragraph boundaries (double newline or major break)
  const paraBreakRegex = /\n\s*\n|\r\n\s*\r\n/g;

  // Find paragraph start (last para break before matchIndex)
  let paraStart = 0;
  let m;
  paraBreakRegex.lastIndex = 0;
  while ((m = paraBreakRegex.exec(text)) !== null) {
    if (m.index + m[0].length > matchIndex) break;
    paraStart = m.index + m[0].length;
  }

  // Find paragraph end (first para break after matchIndex)
  let paraEnd = text.length;
  paraBreakRegex.lastIndex = matchIndex + matchLength;
  const nextBreak = paraBreakRegex.exec(text);
  if (nextBreak) paraEnd = nextBreak.index;

  // If paragraph is too long, truncate around the match
  if (paraEnd - paraStart > maxLen) {
    const contextRadius = Math.floor(maxLen / 2);
    const desiredStart = Math.max(paraStart, matchIndex - contextRadius);
    const desiredEnd = Math.min(paraEnd, matchIndex + matchLength + contextRadius);

    // Try to start/end on sentence boundaries for readability
    let truncStart = desiredStart;
    if (truncStart > paraStart) {
      const sentenceBreak = text.slice(paraStart, desiredStart).match(/[.!?]\s+[A-Z][^.!?]*$/);
      if (sentenceBreak) {
        truncStart = paraStart + sentenceBreak.index + sentenceBreak[0].indexOf(' ') + 1;
      }
    }

    let truncEnd = desiredEnd;
    const afterText = text.slice(desiredEnd, paraEnd);
    const nextSentenceEnd = afterText.search(/[.!?]\s/);
    if (nextSentenceEnd !== -1) {
      truncEnd = desiredEnd + nextSentenceEnd + 1;
    }

    paraStart = truncStart;
    paraEnd = truncEnd;
  }

  const before = text.slice(paraStart, matchIndex).trim();
  const match = text.slice(matchIndex, matchIndex + matchLength);
  const after = text.slice(matchIndex + matchLength, paraEnd).trim();

  // Clean up extra whitespace
  const clean = (s) => s.replace(/\s+/g, ' ').trim();

  return {
    before: clean(before),
    match,
    after: clean(after),
    fullText: clean(`${before} ${match} ${after}`),
  };
}

/**
 * Summarize matches across a body of text into category counts.
 *
 * @param {string} text
 * @returns {{totalMatches: number, byCategory: Object, byKeyword: Object, uniqueKeywords: Array}}
 */
export function summarizeMatches(text) {
  const matches = findMatches(text);
  const byCategory = {};
  const byKeyword = {};

  for (const m of matches) {
    byCategory[m.category] = (byCategory[m.category] || 0) + 1;
    byKeyword[m.canonical] = (byKeyword[m.canonical] || 0) + 1;
  }

  return {
    totalMatches: matches.length,
    byCategory,
    byKeyword,
    uniqueKeywords: Object.keys(byKeyword),
    matches,
  };
}
