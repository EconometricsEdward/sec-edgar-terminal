import { createHash } from 'node:crypto';
import { searchDisclosureIndexCandidates } from './dataStore.js';
import { matchesQuery, parseDisclosureQuery } from './disclosureQuery.js';
import { buildFilingUrl } from './filingTextParser.js';
import { decodeNumericHtmlEntities } from './htmlEntities.js';
import { paidCsvCell } from './x402Products.js';
import { X402_DATA_HEADERS, x402DataError } from './x402Research.js';
import { DISCLOSURE_INDEX_LIMITS, disclosureIndexDate, disclosureIndexIdentity } from '../../supabase/functions/edgar-data-gateway/disclosurePolicy.js';
import { X402_DISCLOSURE_EVIDENCE_VERSION, X402_DISCLOSURE_FORMS } from './x402DisclosureEvidenceSchema.js';
export { X402_DISCLOSURE_EVIDENCE_SCHEMA } from './x402DisclosureEvidenceSchema.js';

const DAY = 86400000, WINDOW = 10000;
const forms = new Set(X402_DISCLOSURE_FORMS);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const nowValue = now => typeof now === 'function' ? now() : now;
const sectionPattern = /^(?:all|other|risk|mda|notes|8k:\d\.\d{2})$/;
const cikPattern = /^(?!0000000000)\d{10}$/;
const hash = text => createHash('sha256').update(text).digest('hex');
const unavailable = () => x402DataError('DATA_NOT_PREPARED', 'Validated retained disclosure evidence is unavailable. This request is not charged.', 503);
const invalid = () => x402DataError('INVALID_SELECTION', 'Use the documented bounded disclosure evidence selectors. This request is not charged.', 400);
const limitations = Object.freeze([
  'This is a partial corpus of prepared recent SEC filing paragraphs, not all SEC filings or every paragraph in an indexed filing. Counts describe the retained corpus before query filters.',
  'Literal terms, phrases and the complete Boolean expression are verified against each full retained paragraph. Matching is not semantic search, document-wide exclusion, or a claim that an event occurred.',
  'The full retained paragraph includes negation and qualifications. Paragraph fingerprints are SHA-256 of the delivered UTF-8 quote; document fingerprints identify the retained source text generation.',
  'SEC URLs are reconstructed from retained validated filing identifiers. No fresh SEC download, ticker resolution or complete filing review is performed for this request.',
  'Pagination follows ranked raw candidates. Further candidates may fail exact verification; results and offsets can change when the prepared index changes.',
]);

/** Null rejects unknown, duplicate, aliased, empty or out-of-window selectors. */
export function paidDisclosureEvidenceSelection(request, { now = Date.now } = {}) {
  try {
    const nowMs = nowValue(now);
    if (!Number.isFinite(nowMs)) return null;
    const query = new URL(request.url).searchParams;
    const allowed = ['query', 'ciks', 'forms', 'section', 'start', 'end', 'offset', 'limit', 'format'];
    if ([...query.keys()].some(key => !allowed.includes(key))
      || allowed.some(key => query.getAll(key).length > 1 || query.has(key) && !query.get(key))) return null;
    const raw = query.get('query');
    if (!raw || raw.length > 1000 || raw !== raw.trim()) return null;
    const parsed = parseDisclosureQuery(raw);
    if (!integer(parsed.positive.length, 1, 16)) return null;
    const list = key => query.has(key) ? query.get(key).split(',') : [];
    const ciks = list('ciks'), selectedForms = list('forms');
    if (ciks.length > 10 || ciks.some(cik => !cikPattern.test(cik)) || new Set(ciks).size !== ciks.length
      || selectedForms.length > 26 || selectedForms.some(form => !forms.has(form)) || new Set(selectedForms).size !== selectedForms.length) return null;
    const section = query.get('section') || 'all';
    if (!sectionPattern.test(section)) return null;
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const oldest = new Date(nowMs - DISCLOSURE_INDEX_LIMITS.retentionDays * DAY).toISOString().slice(0, 10);
    const start = query.get('start') || oldest, end = query.get('end') || today;
    if (![start, end].every(disclosureIndexDate) || start < oldest || end > today || start > end) return null;
    const number = (key, fallback, min, max) => {
      const rawValue = query.get(key);
      if (rawValue === null) return fallback;
      if (!/^(?:0|[1-9]\d*)$/.test(rawValue)) return null;
      const value = Number(rawValue);
      return integer(value, min, max) ? value : null;
    };
    const offset = number('offset', 0, 0, 9999), limit = number('limit', 10, 1, 20);
    const format = query.get('format') || 'json';
    if (offset === null || limit === null || !['json', 'csv'].includes(format)) return null;
    return { query: raw, ciks, forms: selectedForms, section, start, end, offset, limit, format };
  } catch { return null; }
}

function validTimestamp(value, nowMs) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !disclosureIndexDate(value.slice(0, 10))) return false;
  const time = value.slice(11, 19).split(':').map(Number);
  const parsed = Date.parse(value);
  return time[0] <= 23 && time[1] <= 59 && time[2] <= 59 && Number.isFinite(parsed) && parsed <= nowMs;
}

function publicCoverage(value, nowMs) {
  if (!record(value) || !integer(value.documents, 0, DISCLOSURE_INDEX_LIMITS.documents)
    || !integer(value.passages, value.documents, DISCLOSURE_INDEX_LIMITS.documents * DISCLOSURE_INDEX_LIMITS.passages)
    || value.retentionDays !== DISCLOSURE_INDEX_LIMITS.retentionDays) return null;
  const oldest = new Date(nowMs - DISCLOSURE_INDEX_LIMITS.retentionDays * DAY).toISOString().slice(0, 10);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (value.documents === 0) {
    if (value.passages !== 0 || value.oldestFilingDate !== null || value.newestFilingDate !== null || value.lastIndexedAt !== null) return null;
  } else if (![value.oldestFilingDate, value.newestFilingDate].every(disclosureIndexDate)
    || value.oldestFilingDate < oldest || value.newestFilingDate > today || value.oldestFilingDate > value.newestFilingDate
    || !validTimestamp(value.lastIndexedAt, nowMs)) return null;
  return { scope: 'partial-prepared-paragraph-corpus', partial: true, documents: value.documents,
    indexedPassages: value.passages, oldestFilingDate: value.oldestFilingDate, newestFilingDate: value.newestFilingDate,
    lastIndexedAt: value.lastIndexedAt, retentionDays: DISCLOSURE_INDEX_LIMITS.retentionDays,
    parserVersion: DISCLOSURE_INDEX_LIMITS.parserVersion, queryVerification: 'exact-boolean-on-full-retained-paragraph' };
}

/** Allowlist public evidence; never spread metadata, caller URLs or internal ranks. */
function publicCandidate(row, selection, coverage, nowMs) {
  const passage = row?.passage;
  if (!record(row) || !record(passage) || !disclosureIndexIdentity(row) || !forms.has(row.form)
    || row.parserVersion !== DISCLOSURE_INDEX_LIMITS.parserVersion
    || !disclosureIndexDate(row.filingDate) || row.filingDate < selection.start || row.filingDate > selection.end
    || row.filingDate < coverage.oldestFilingDate || row.filingDate > coverage.newestFilingDate
    || typeof row.ticker !== 'string' || !/^[A-Z0-9.-]{0,15}$/.test(row.ticker)
    || typeof row.companyName !== 'string' || row.companyName.length < 1 || row.companyName.length > 250
    || typeof row.textHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.textHash)
    || !validTimestamp(row.sourceRetrievedAt, nowMs) || !validTimestamp(row.indexedAt, nowMs)
    || Date.parse(row.sourceRetrievedAt) < Date.parse(row.filingDate)
    || Date.parse(row.indexedAt) < Date.parse(row.sourceRetrievedAt) || Date.parse(row.indexedAt) > Date.parse(coverage.lastIndexedAt)
    || !integer(row.totalPassages, 1, 200000) || !integer(row.indexedPassages, 1, DISCLOSURE_INDEX_LIMITS.passages)
    || row.indexedPassages > row.totalPassages || typeof row.complete !== 'boolean'
    || row.complete && row.indexedPassages !== row.totalPassages
    || !integer(passage.index, 0, Math.min(row.totalPassages - 1, 199999))
    || typeof passage.sectionId !== 'string' || !sectionPattern.test(passage.sectionId) || passage.sectionId === 'all'
    || passage.sectionId.startsWith('8k:') && !['8-K', '8-K/A'].includes(row.form)
    || typeof passage.section !== 'string' || passage.section.length < 1 || passage.section.length > 100
    || typeof passage.text !== 'string' || passage.text.length < 1 || passage.text.length > DISCLOSURE_INDEX_LIMITS.passageCharacters
    || /\u0000/.test(passage.text)
    || selection.ciks.length && !selection.ciks.includes(row.cik)
    || selection.forms.length && !selection.forms.includes(row.form)
    || selection.section !== 'all' && selection.section !== passage.sectionId) return null;
  const quote = decodeNumericHtmlEntities(passage.text);
  if (!quote.trim() || quote.length > DISCLOSURE_INDEX_LIMITS.passageCharacters || /\u0000/.test(quote)) return null;
  return { cik: row.cik, ticker: row.ticker, companyName: row.companyName, accession: row.accession,
    primaryDoc: row.primaryDoc, form: row.form, filingDate: row.filingDate,
    sourceUrl: buildFilingUrl(row.cik, row.accession, row.primaryDoc), sourceRetrievedAt: row.sourceRetrievedAt, indexedAt: row.indexedAt,
    index: passage.index, sectionId: passage.sectionId, section: passage.section, quote, fingerprint: hash(quote),
    documentFingerprint: row.textHash, indexedPassages: row.indexedPassages, totalPassages: row.totalPassages,
    documentComplete: row.complete, parserVersion: row.parserVersion, identityProof: 'retained-sec-document-identifiers' };
}

function deliver(payload, format) {
  const rowColumns = Object.keys(payload.rows[0]);
  const columns = ['schemaVersion', 'generatedAt', 'selection', 'coverage', 'pagination', ...rowColumns, 'limitations'];
  const body = format === 'csv'
    ? `${columns.map(paidCsvCell).join(',')}\r\n${payload.rows.map(row => columns.map(column => paidCsvCell(Object.hasOwn(row, column) ? row[column] : payload[column])).join(',')).join('\r\n')}\r\n`
    : JSON.stringify(payload);
  return new Response(body, { headers: { ...X402_DATA_HEADERS, 'X-Schema-Version': payload.schemaVersion,
    'Access-Control-Expose-Headers': `${X402_DATA_HEADERS['Access-Control-Expose-Headers']}, X-Schema-Version, Content-Disposition`,
    'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    ...(format === 'csv' ? { 'Content-Disposition': 'attachment; filename="edgar-disclosure-evidence.csv"' } : {}),
  } });
}

/** One bounded retained-index query; no SEC acquisition or ticker-map lookup. */
export function createPaidDisclosureEvidenceReader({ search = searchDisclosureIndexCandidates, now = Date.now } = {}) {
  return async function readDisclosureEvidence(selection, { signal } = {}) {
    const nowMs = nowValue(now);
    // Revalidate caller-supplied selections before the data-store query.
    if (!record(selection) || !Number.isFinite(nowMs)) return invalid();
    const keys = ['query', 'ciks', 'forms', 'section', 'start', 'end', 'offset', 'limit', 'format'];
    if (Object.keys(selection).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(selection, key))
      || !Array.isArray(selection.ciks) || !Array.isArray(selection.forms)) return invalid();
    const params = new URLSearchParams();
    for (const key of keys) {
      const value = selection[key];
      if (Array.isArray(value)) { if (value.length) params.set(key, value.join(',')); }
      else params.set(key, String(value));
    }
    const checkedSelection = paidDisclosureEvidenceSelection({ url: `https://secedgarterminal.com/?${params}` }, { now: nowMs });
    if (!checkedSelection || keys.some(key => JSON.stringify(checkedSelection[key]) !== JSON.stringify(selection[key]))) return invalid();
    const parsed = parseDisclosureQuery(selection.query);
    let response;
    try {
      response = await search({ terms: parsed.positive, start: selection.start, end: selection.end,
        forms: selection.forms, ciks: selection.ciks, tickers: [], section: selection.section,
        offset: selection.offset, limit: Math.min(DISCLOSURE_INDEX_LIMITS.candidateLimit, WINDOW - selection.offset),
        parserVersion: DISCLOSURE_INDEX_LIMITS.parserVersion },
      { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4500)]) : AbortSignal.timeout(4500) });
    } catch { return unavailable(); }
    const coverage = publicCoverage(response?.coverage, nowMs);
    if (!coverage || !coverage.documents || !Array.isArray(response.results) || response.results.length > Math.min(DISCLOSURE_INDEX_LIMITS.candidateLimit, WINDOW - selection.offset)
      || typeof response.hasMore !== 'boolean' || !response.results.length && response.hasMore
      || response.results.length > coverage.indexedPassages) return unavailable();
    const candidates = response.results.map(row => publicCandidate(row, selection, coverage, nowMs));
    if (candidates.some(row => !row)) return unavailable();
    const identities = candidates.map(row => `${row.cik}/${row.accession}/${row.primaryDoc}/${row.index}`);
    if (new Set(identities).size !== identities.length) return unavailable();
    const documents = new Map();
    for (const row of candidates) {
      const identity = `${row.cik}/${row.accession}/${row.primaryDoc}`;
      const metadata = JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => !['index', 'sectionId', 'section', 'quote', 'fingerprint'].includes(key))));
      if (documents.has(identity) && documents.get(identity) !== metadata || row.indexedPassages > coverage.indexedPassages) return unavailable();
      documents.set(identity, metadata);
    }
    if (documents.size > coverage.documents) return unavailable();
    const rows = []; let scanned = 0;
    for (const row of candidates) {
      scanned++;
      if (matchesQuery(row.quote, parsed)) rows.push(row);
      if (rows.length === selection.limit) break;
    }
    const moreCandidates = scanned < candidates.length || response.hasMore;
    const next = selection.offset + scanned;
    const hasMore = moreCandidates && next < WINDOW;
    const pagination = { offset: selection.offset, limit: selection.limit, rawCandidatesReturned: candidates.length,
      rawCandidatesScanned: scanned, verifiedReturned: rows.length, nextOffset: hasMore ? next : null, hasMore,
      windowLimited: moreCandidates && !hasMore, moreMeaning: 'additional-candidates-not-confirmed-exact-matches' };
    if (!rows.length) return Response.json({ error: 'No retained paragraphs in this candidate page satisfy the complete query. This request is not charged.',
      code: 'NO_MATCHING_EVIDENCE', coverage, pagination }, { status: 404, headers: X402_DATA_HEADERS });
    const { query, ciks, forms: selectedForms, section, start, end } = selection;
    return deliver({ schemaVersion: X402_DISCLOSURE_EVIDENCE_VERSION, status: 'ready', generatedAt: new Date(nowMs).toISOString(),
      selection: { query, ciks, forms: selectedForms, section, start, end }, coverage, pagination, rows, limitations }, selection.format);
  };
}
export const paidDisclosureEvidenceReader = createPaidDisclosureEvidenceReader();
