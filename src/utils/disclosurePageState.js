import { legacyDisclosureQuery } from './disclosureQuery.js';

/** Restore the existing share-link grammar without making the landing page
 * request-rendered. The first occurrence of a parameter wins, as on the server.
 * Reader pointer parameters remain in the URL for parseDisclosureReaderState.
 * @param {URLSearchParams} params
 * @returns {Record<string, any>}
 */
export function readDisclosurePageSettings(params) {
  const first = key => params.get(key) || '';
  const query = first('query') || first('keywords');
  const focus = first('focus') || first('ticker') || first('cik') || first('company');
  const exact = first('style') === 'exact' || Boolean(first('keywords'));
  const initial = {
    query: exact ? legacyDisclosureQuery(query, first('match') || first('matchMode')) : query,
    searchStyle: exact ? 'exact' : 'smart',
    tickers: first('tickers') || focus,
    mode: first('mode') === 'companies' ? 'companies' : 'index',
  };
  for (const key of ['start', 'end', 'forms', 'section', 'scope', 'comparison']) {
    const value = first(key);
    if (value) initial[key] = value;
  }
  // Keep invalid values visible for the existing server-side validators.
  // Never silently widen a supplied search scope or filing-date window.
  if (first('depth')) initial.depth = Number(first('depth'));
  initial.amendments = first('amendments') === 'true';
  return initial;
}

/** Deterministic initial markup, followed by current UTC defaults on mount.
 * @param {Record<string, any>} initial
 * @param {string} today ISO calendar date supplied by the renderer or browser
 */
export function createDisclosurePageSettings(initial = {}, today = new Date().toISOString().slice(0, 10)) {
  return {
    tickers: '',
    mode: 'index',
    searchStyle: 'smart',
    start: `${Number(today.slice(0, 4)) - 1}-01-01`,
    end: today,
    forms: '10-K,10-Q,8-K',
    section: 'all',
    scope: 'paragraph',
    depth: 4,
    amendments: false,
    comparison: 'none',
    ...initial,
    query: initial.searchStyle === 'exact' ? legacyDisclosureQuery(initial.query || '') : initial.query || '',
  };
}
