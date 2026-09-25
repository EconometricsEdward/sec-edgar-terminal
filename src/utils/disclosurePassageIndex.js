/** Server-only, bounded, reproducible index of original public filing passages. */
import { createHash } from 'node:crypto';
import { disclosurePassages, passageSignals } from './disclosureResearch.js';
import { matchesQuery, parseDisclosureQuery } from './disclosureQuery.js';
import { buildFilingUrl } from './filingTextParser.js';
import { decodeNumericHtmlEntities } from './htmlEntities.js';
import { readDisclosureIndexDocument, replaceDisclosureIndexDocument, searchDisclosureIndexCandidates } from './dataStore.js';
import { DISCLOSURE_INDEX_LIMITS as LIMITS, disclosureIndexIdentity, validDisclosureIndexDocument } from '../../supabase/functions/edgar-data-gateway/disclosurePolicy.js';
export { DISCLOSURE_INDEX_LIMITS } from '../../supabase/functions/edgar-data-gateway/disclosurePolicy.js';

const fingerprint = text => createHash('sha256').update(text).digest('hex');
const coverageNote = 'Prepared passages from a bounded selection of recent filings. This is not the complete SEC filing universe; broader SEC discovery continues separately.';
const safeSignal = signal => signal ? AbortSignal.any([signal, AbortSignal.timeout(4500)]) : AbortSignal.timeout(4500);

/** Pure preparation for ingestion and local fixtures. Never truncate a paragraph:
 * doing so could remove NOT terms or the context of a negated statement. */
export function prepareDisclosureIndexDocument({ cik, ticker = '', companyName, filing, text, sourceRetrievedAt = new Date().toISOString() }, nowMs = Date.now()) {
  cik = String(cik || '').padStart(10, '0');
  if (typeof text !== 'string' || text.length < 100 || text.length > 24000000
    || !disclosureIndexIdentity({ cik, ...filing }) || !companyName
    || Date.parse(filing.filingDate) < nowMs - LIMITS.retentionDays * 86400000) return null;
  const extracted = disclosurePassages(text, filing.form);
  const candidates = extracted.paragraphs.filter(p => p.text.length <= LIMITS.passageCharacters);
  const groups = new Map();
  // Round-robin across sections prevents a lengthy first section from occupying
  // the whole index. Narrative paragraphs precede short labels in each group.
  for (const paragraph of candidates) {
    if (!groups.has(paragraph.sectionId)) groups.set(paragraph.sectionId, []);
    groups.get(paragraph.sectionId).push(paragraph);
  }
  const priority = id => id === 'risk' ? 0 : id === 'mda' ? 1 : id.startsWith('8k:') ? 2 : id === 'notes' ? 3 : 4;
  const queues = [...groups].sort(([a], [b]) => priority(a) - priority(b)).map(([, values]) => values.sort((a, b) => Number(b.text.length >= 80) - Number(a.text.length >= 80) || a.index - b.index));
  const passages = []; let characters = 0; let bytes = 0;
  while (queues.some(queue => queue.length) && passages.length < LIMITS.passages) {
    for (const queue of queues) {
      const paragraph = queue.shift();
      if (!paragraph || passages.length >= LIMITS.passages) continue;
      const size = Buffer.byteLength(JSON.stringify(paragraph));
      if (characters + paragraph.text.length > LIMITS.characters || bytes + size > LIMITS.documentBytes - 5000) continue;
      passages.push(paragraph); characters += paragraph.text.length; bytes += size;
    }
  }
  if (!passages.length) return null;
  passages.sort((a, b) => a.index - b.index);
  const document = { cik, accession: filing.accession, primaryDoc: filing.primaryDoc,
    ticker: String(ticker || '').toUpperCase().slice(0, 15), companyName: String(companyName).slice(0, 250),
    form: filing.form, filingDate: filing.filingDate, reportDate: filing.reportDate || '',
    textHash: fingerprint(text), parserVersion: LIMITS.parserVersion, sourceRetrievedAt,
    totalPassages: extracted.paragraphs.length, complete: false, preparedText: null };
  if (passages.length === extracted.paragraphs.length && text.length <= LIMITS.characters) {
    document.complete = true; document.preparedText = text;
    if (!validDisclosureIndexDocument(document, passages, nowMs)) { document.complete = false; document.preparedText = null; }
  }
  return validDisclosureIndexDocument(document, passages, nowMs) ? { document, passages } : null;
}

/** Only full fingerprint-verified original text can shortcut full review. */
export async function readPreparedDisclosureText({ cik, filing, signal }, { read = readDisclosureIndexDocument } = {}) {
  try {
    const value = await read({ cik: String(cik).padStart(10, '0'), accession: filing.accession, primaryDoc: filing.primaryDoc, parserVersion: LIMITS.parserVersion }, { signal: safeSignal(signal) });
    if (!value?.complete || typeof value.text !== 'string' || fingerprint(value.text) !== value.textHash) return null;
    return { text: value.text, sourceRetrievedAt: value.sourceRetrievedAt };
  } catch (error) { if (signal?.aborted) throw error; return null; }
}

/** Best-effort ingestion is awaited and bounded; a cache failure cannot block research. */
export async function indexDisclosureText(input, { write = replaceDisclosureIndexDocument } = {}) {
  const prepared = prepareDisclosureIndexDocument(input);
  if (!prepared) return { stored: false, reason: 'outside_index_bounds' };
  try { return await write(prepared, { signal: safeSignal(input.signal) }); }
  catch (error) { if (input.signal?.aborted) throw error; return { stored: false, reason: 'index_unavailable' }; }
}

function preview(passage, parsed) {
  const signals = passageSignals(passage.text, parsed.positive, passage.sectionId);
  // Retain the entire bounded paragraph. Cropping near the matched term can
  // erase a preceding negation or qualification and misrepresent the filing.
  return { ...passage, ...signals, previewTruncated: false, change: 'uncompared' };
}

export async function searchDisclosurePassageIndex(settings, { tickers = [], ciks = [], signal, offset = 0, limit = 20 } = {}, { search = searchDisclosureIndexCandidates } = {}) {
  const parsed = settings.parsed || parseDisclosureQuery(settings.query);
  const unavailable = reason => ({ results: [], hasMore: false, nextOffset: offset, coverage: { available: false, partial: true, reason, note: coverageNote } });
  // A document-wide NOT predicate requires every paragraph, including material
  // outside this deliberately partial index. Defer to the full review path.
  if (settings.scope === 'document') return unavailable('document_scope_requires_full_review');
  try {
    const forms = settings.amendments ? settings.forms.flatMap(form => [form, `${form}/A`]) : settings.forms;
    const selectors = [...new Set(tickers.map(ticker => String(ticker).toUpperCase()))];
    const response = await search({ terms: parsed.positive, start: settings.start, end: settings.end, forms,
      ciks: [...ciks, ...selectors.filter(value => /^\d{1,10}$/.test(value)).map(value => value.padStart(10, '0'))],
      tickers: selectors.filter(value => !/^\d{1,10}$/.test(value)), section: settings.section || 'all',
      offset, limit: LIMITS.candidateLimit, parserVersion: LIMITS.parserVersion }, { signal: safeSignal(signal) });
    if (!response || !Array.isArray(response.results)) return unavailable('index_unavailable');
    const grouped = new Map(); let checked = 0;
    for (const row of response.results) {
      // Database full-text ranking proposes candidates; only the existing exact
      // Boolean parser can turn the original passage into a verified match.
      if (!row?.passage || !disclosureIndexIdentity(row) || row.parserVersion !== LIMITS.parserVersion) { checked++; continue; }
      const passage = { ...row.passage, text: decodeNumericHtmlEntities(row.passage.text) };
      if ((settings.section && settings.section !== 'all' && passage.sectionId !== settings.section) || !matchesQuery(passage.text, parsed)) { checked++; continue; }
      const key = `${row.cik}:${row.accession}:${row.primaryDoc}`;
      if (!grouped.has(key)) {
        if (grouped.size >= limit) break;
        grouped.set(key, { cik: row.cik, ticker: row.ticker || row.cik, companyName: row.companyName,
          accession: row.accession, primaryDoc: row.primaryDoc, form: row.form, filingDate: row.filingDate, reportDate: row.reportDate,
          documentUrl: buildFilingUrl(row.cik, row.accession, row.primaryDoc),
          status: 'indexed-match', matched: true, previews: [], matchCount: 0,
          preparedRank: row.rank, indexedAt: row.indexedAt, indexCoverage: { partial: !row.complete, indexedPassages: row.indexedPassages, totalPassages: row.totalPassages },
          extraction: 'Query verified against retained original passages. Open the filing to review all matching passages and context.' });
      }
      checked++;
      const result = grouped.get(key); result.matchCount++;
      if (result.previews.length < 3) result.previews.push(preview(passage, parsed));
    }
    return { results: [...grouped.values()], hasMore: response.hasMore || checked < response.results.length,
      nextOffset: offset + checked, coverage: { ...response.coverage, available: true, partial: true,
        candidatePassagesChecked: checked, note: coverageNote } };
  } catch (error) { if (signal?.aborted) throw error; return unavailable('index_unavailable'); }
}
