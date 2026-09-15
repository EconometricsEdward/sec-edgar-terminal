import { quoteTerm } from './disclosureQuery.js';

export const SEC_DISCLOSURE_WINDOW = 10_000;

/** Strict offsets prevent overlaps caused by silently rounded or clamped input. */
export function disclosureIndexPagination(params) {
  const integer = (name, fallback, min, max) => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Choose ${name} between ${min} and ${max}.`);
    return value;
  };
  const from = integer('from', 0, 0, SEC_DISCLOSURE_WINDOW - 1);
  const limit = Math.min(integer('limit', 20, 1, 100), SEC_DISCLOSURE_WINDOW - from);
  return { from, limit };
}

/**
 * EFTS uses implicit AND and adjacent OR terms, not our nested grammar:
 * https://www.sec.gov/edgar/search/efts-faq.html
 * Build necessary positive clauses rather than reducing every query to OR.
 * Exclusions stay in passage verification: a document can contain an excluded
 * term elsewhere while still containing a valid paragraph or section match.
 */
export function compileDisclosureIndexQuery(parsed) {
  let exclusionsDeferred = false;
  let bounded = false;
  function clauses(node, negated = false) {
    if (node.kind === 'NOT') return clauses(node.child, !negated);
    if (node.kind === 'term') {
      if (negated) { exclusionsDeferred = true; return []; }
      return [[node.value]];
    }
    const kind = negated ? (node.kind === 'AND' ? 'OR' : 'AND') : node.kind;
    const left = clauses(node.left, negated), right = clauses(node.right, negated);
    if (kind === 'AND') return [...left, ...right];
    if (!left.length || !right.length) return [];
    if (left.length * right.length > 128) {
      bounded = true;
      return [[...parsed.positive]];
    }
    return left.flatMap(a => right.map(b => [...new Set([...a, ...b])]));
  }
  const unique = [...new Map(clauses(parsed.ast).map(c => [JSON.stringify([...c].sort()), c])).values()];
  const minimal = unique.filter((clause, i) => !unique.some((other, j) =>
    i !== j && other.length < clause.length && other.every(term => clause.includes(term))));
  const required = minimal.filter(c => c.length === 1).flat();
  const alternatives = minimal.filter(c => c.length > 1).sort((a, b) => a.length - b.length);
  // EFTS documents one OR clause combined with required words. Additional
  // groups are deferred rather than relying on undocumented parentheses.
  const selected = alternatives[0] || [];
  const nestedGroupsDeferred = alternatives.length > 1 || bounded;
  const secQuery = [...required.map(quoteTerm), ...(selected.length ? [selected.map(quoteTerm).join(' OR ')] : [])].join(' ')
    || parsed.positive.map(quoteTerm).join(' OR ');
  const notes = [];
  if (exclusionsDeferred) notes.push('Exclusions are checked in the selected passage or section; they do not exclude an entire filing during discovery.');
  if (nestedGroupsDeferred) notes.push('Some grouped conditions are deferred to passage verification because SEC discovery uses a simpler Boolean grammar.');
  return {
    secQuery,
    exactPositiveLogic: !nestedGroupsDeferred,
    exclusionsDeferred,
    nestedGroupsDeferred,
    notes,
    verification: [...notes, 'SEC candidates are ranked index matches. The complete query, section, and match scope are verified against filing text.'].join(' '),
  };
}

export function disclosureIndexPageCoverage({ from, limit, rawHits, totalHits, totalRelation = 'eq', returnedHits, timedOut = false }) {
  const next = from + rawHits;
  const moreAtSource = rawHits === limit && (totalRelation === 'gte' || next < totalHits);
  const hasMore = moreAtSource && next < SEC_DISCLOSURE_WINDOW;
  return {
    from,
    nextFrom: hasMore ? next : null,
    hasMore,
    coverage: {
      scope: 'returned-sec-index-page',
      startRank: rawHits ? from + 1 : null,
      endRank: rawHits ? next : null,
      searchedHits: rawHits,
      returnedHits,
      pagesSearched: 1,
      windowLimit: SEC_DISCLOSURE_WINDOW,
      windowLimited: !hasMore && moreAtSource,
      incomplete: timedOut,
      verification: 'Filing candidates; passage verification is separate.',
    },
  };
}
