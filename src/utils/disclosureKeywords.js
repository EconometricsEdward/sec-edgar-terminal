// ============================================================================
// disclosureKeywords - user-defined keyword matching for SEC filing text
//
// User input is treated as literal words/phrases, never as raw regex. Commas
// separate terms. Whitespace is flexible and hyphens can match either a hyphen
// or a space so "supply-chain" and "supply chain" can both be found.
// ============================================================================

const MAX_TERMS = 12;
const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 80;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTerm(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function patternForTerm(term) {
  const normalized = normalizeTerm(term);
  const escaped = escapeRegExp(normalized)
    .replace(/\s+/g, '\\s+')
    .replace(/-/g, '[-\\s]?');
  const startsWithWord = /^[A-Za-z0-9]/.test(normalized);
  const endsWithWord = /[A-Za-z0-9]$/.test(normalized);
  return new RegExp(`${startsWithWord ? '\\b' : ''}${escaped}${endsWithWord ? '\\b' : ''}`, 'gi');
}

export function parseDisclosureTerms(rawQuery) {
  const seen = new Set();
  const terms = [];
  const rejected = [];
  const parts = String(rawQuery || '')
    .split(/[,\n]/)
    .map(normalizeTerm)
    .filter(Boolean);

  for (const part of parts) {
    if (part.length < MIN_TERM_LENGTH) {
      rejected.push({ term: part, reason: `Use at least ${MIN_TERM_LENGTH} characters` });
      continue;
    }
    if (part.length > MAX_TERM_LENGTH) {
      rejected.push({ term: part.slice(0, 40) + '...', reason: `Use ${MAX_TERM_LENGTH} characters or fewer` });
      continue;
    }

    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(part);
    if (terms.length >= MAX_TERMS) break;
  }

  return { terms, rejected, maxTerms: MAX_TERMS };
}

export function buildKeywordDefinitions(rawQuery) {
  const parsed = parseDisclosureTerms(rawQuery);
  return {
    ...parsed,
    definitions: parsed.terms.map((term) => ({
      term,
      canonical: term,
      category: 'custom',
      pattern: patternForTerm(term),
    })),
  };
}

export function disclosureSignature({ terms, depth, matchMode = 'any' }) {
  return JSON.stringify({
    coverageVersion: 2,
    terms: [...terms].map((term) => term.toLowerCase()).sort(),
    depth,
    matchMode: matchMode === 'all' ? 'all' : 'any',
  });
}

export function findDisclosureMatches(text, definitions) {
  if (!text || !definitions?.length) return [];
  const matches = [];
  const seen = new Set();

  for (const def of definitions) {
    def.pattern.lastIndex = 0;
    let match;
    while ((match = def.pattern.exec(text)) !== null) {
      const key = `${match.index}:${match[0].length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        index: match.index,
        length: match[0].length,
        term: match[0],
        canonical: def.canonical,
        category: def.category,
      });
    }
  }

  matches.sort((a, b) => a.index - b.index);
  return matches;
}

export function extractParagraph(text, matchIndex, matchLength, maxLen = 900) {
  if (!text || matchIndex < 0) {
    return { before: '', match: '', after: '', fullText: '' };
  }

  const paraBreakRegex = /\n\s*\n|\r\n\s*\r\n/g;

  let paraStart = 0;
  let match;
  paraBreakRegex.lastIndex = 0;
  while ((match = paraBreakRegex.exec(text)) !== null) {
    if (match.index + match[0].length > matchIndex) break;
    paraStart = match.index + match[0].length;
  }

  let paraEnd = text.length;
  paraBreakRegex.lastIndex = matchIndex + matchLength;
  const nextBreak = paraBreakRegex.exec(text);
  if (nextBreak) paraEnd = nextBreak.index;

  if (paraEnd - paraStart > maxLen) {
    const contextRadius = Math.floor(maxLen / 2);
    paraStart = Math.max(paraStart, matchIndex - contextRadius);
    paraEnd = Math.min(paraEnd, matchIndex + matchLength + contextRadius);
  }

  const clean = (value) => value.replace(/\s+/g, ' ').trim();
  const before = text.slice(paraStart, matchIndex);
  const highlighted = text.slice(matchIndex, matchIndex + matchLength);
  const after = text.slice(matchIndex + matchLength, paraEnd);

  return {
    before: clean(before),
    match: highlighted,
    after: clean(after),
    fullText: clean(`${before} ${highlighted} ${after}`),
  };
}
