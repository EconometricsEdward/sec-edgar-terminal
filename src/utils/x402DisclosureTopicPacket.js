import { createHash } from 'node:crypto';
import { createPaidDisclosureEvidenceReader, paidDisclosureEvidenceSelection } from './x402DisclosureEvidence.js';
import { paidCsvCell } from './x402Products.js';
import { X402_DATA_HEADERS, x402DataError } from './x402Research.js';
import { X402_DISCLOSURE_TOPIC_PACKET_VERSION, X402_DISCLOSURE_PACKET_TOPICS, X402_DISCLOSURE_PACKET_DEFAULT_TOPICS,
  X402_DISCLOSURE_PACKET_SOURCE_FIELDS } from './x402DisclosureTopicPacketSchema.js';
export { X402_DISCLOSURE_TOPIC_PACKET_SCHEMA } from './x402DisclosureTopicPacketSchema.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nowValue = now => typeof now === 'function' ? now() : now;
const topicById = new Map(X402_DISCLOSURE_PACKET_TOPICS.map(topic => [topic.id, topic]));
const unavailable = () => x402DataError('DATA_NOT_PREPARED', 'Validated retained disclosure evidence is unavailable for one or more selected topics. This request is not charged.', 503);
const invalid = () => x402DataError('INVALID_SELECTION', 'Choose one exact issuer CIK and one to three supported disclosure topics. This request is not charged.', 400);
const limitations = Object.freeze([
  'This dossier contains a partial corpus of prepared recent SEC filing paragraphs, not every filing or every paragraph. Each topic coverage count describes the retained corpus before issuer and query filters.',
  'Topics use the displayed literal Boolean queries, verified against full retained paragraphs. They are language matches, not semantic classifications, evidence of an actual event, or a credit rating.',
  'Negations and qualifications remain in full quotes. A no-retained-match topic means no exact match in the checked candidate page; it does not establish topic absence or zero risk.',
  'At most 120 raw candidates are returned per topic and at most five verified paragraphs are delivered. Candidate coverage and remaining raw offsets do not count exhaustive mentions. Further evidence can be requested through disclosure-evidence using the displayed query and issuer.',
  'Source filing dates organize observed matches. These filings are not guaranteed to be the latest SEC reports, consecutive periods, complete sections or an as-filed archive. No added, removed or changed-risk conclusions are made.',
  'Source and evidence catalogs deduplicate references across topics without shortening the original paragraphs. Fingerprints identify delivered quotes and retained document generations.',
  'No new SEC download, ticker resolution, ingestion or persistent storage is performed. Topics can observe different index check times; their coverage remains separately visible.',
]);

export function paidDisclosureTopicPacketSelection(request, { now = Date.now } = {}) {
  try {
    const clock = nowValue(now), query = new URL(request.url).searchParams;
    const allowed = ['cik', 'topics', 'start', 'end', 'format'];
    if (!Number.isFinite(clock) || [...query.keys()].some(key => !allowed.includes(key))
      || allowed.some(key => query.getAll(key).length > 1 || query.has(key) && !query.get(key))) return null;
    const cik = query.get('cik') || '';
    if (!/^(?!0000000000)\d{10}$/.test(cik)) return null;
    const topics = query.has('topics') ? query.get('topics').split(',') : [...X402_DISCLOSURE_PACKET_DEFAULT_TOPICS];
    if (topics.length < 1 || topics.length > 3 || topics.some(topic => !topicById.has(topic)) || new Set(topics).size !== topics.length) return null;
    const shared = new URLSearchParams({ query: 'liquidity', ciks: cik });
    for (const key of ['start', 'end', 'format']) if (query.has(key)) shared.set(key, query.get(key));
    const evidence = paidDisclosureEvidenceSelection({ url: `https://example.invalid/?${shared}` }, { now: clock });
    if (!evidence) return null;
    // Canonical topic order makes identical selections independent of query order.
    return { cik, topics: X402_DISCLOSURE_PACKET_TOPICS.map(topic => topic.id).filter(id => topics.includes(id)),
      start: evidence.start, end: evidence.end, format: evidence.format };
  } catch { return null; }
}

function validSelection(selection, clock) {
  const keys = ['cik', 'topics', 'start', 'end', 'format'];
  if (!record(selection) || Object.keys(selection).length !== keys.length || keys.some(key => !Object.hasOwn(selection, key)) || !Array.isArray(selection.topics)) return false;
  const query = new URLSearchParams(Object.entries(selection).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value)]));
  const validated = paidDisclosureTopicPacketSelection({ url: `https://example.invalid/?${query}` }, { now: clock });
  return validated && keys.every(key => JSON.stringify(validated[key]) === JSON.stringify(selection[key]));
}

const csvColumns = ['schemaVersion', 'snapshot', 'generatedAt', 'selection', 'topicId', 'topicLabel', 'topicQuery', 'topicStatus',
  'topicCoverage', 'candidateCoverage', 'sourceRef', ...X402_DISCLOSURE_PACKET_SOURCE_FIELDS,
  'evidenceRef', 'index', 'sectionId', 'section', 'quote', 'fingerprint', 'limitations'];
function deliver(payload, format) {
  let body;
  try {
    if (format === 'json') body = JSON.stringify(payload);
    else {
      const sources = new Map(payload.sourceCatalog.map(source => [source.id, source]));
      const evidence = new Map(payload.evidenceCatalog.map(paragraph => [paragraph.id, paragraph]));
      const rows = payload.topics.flatMap(topic => {
        const context = { schemaVersion: payload.schemaVersion, snapshot: payload.snapshot, generatedAt: payload.generatedAt,
          selection: payload.selection, topicId: topic.id, topicLabel: topic.label, topicQuery: topic.query, topicStatus: topic.status,
          topicCoverage: topic.coverage, candidateCoverage: topic.candidateCoverage, limitations: payload.limitations };
        const refs = topic.filings.flatMap(filing => filing.sections.flatMap(section => section.evidenceRefs));
        if (!refs.length) return [context];
        return refs.map(ref => {
          const paragraph = evidence.get(ref), source = sources.get(paragraph.sourceRef);
          return { ...context, ...source, ...paragraph, sourceRef: source.id, evidenceRef: paragraph.id };
        });
      });
      body = `${csvColumns.map(paidCsvCell).join(',')}\r\n${rows.map(row => csvColumns.map(key => paidCsvCell(row[key])).join(',')).join('\r\n')}\r\n`;
    }
  } catch { return unavailable(); }
  if (Buffer.byteLength(body) > 1024 * 1024) return x402DataError('PRODUCT_TOO_LARGE', 'The disclosure topic packet exceeds its bounded delivery size. This request is not charged.', 413);
  return new Response(body, { headers: { ...X402_DATA_HEADERS, 'X-Schema-Version': payload.schemaVersion,
    'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    'Access-Control-Expose-Headers': `${X402_DATA_HEADERS['Access-Control-Expose-Headers']}, X-Schema-Version, Content-Disposition`,
    ...(format === 'csv' ? { 'Content-Disposition': 'attachment; filename="disclosure-topic-packet.csv"' } : {}),
  } });
}

/** Reuse the production exact-query reader, with injectable retained search only. */
export function createPaidDisclosureTopicPacketReader({ search, now = Date.now } = {}) {
  return async function readTopicPacket(selection, { signal } = {}) {
    const clock = nowValue(now);
    if (!Number.isFinite(clock) || !validSelection(selection, clock)) return invalid();
    const readEvidence = createPaidDisclosureEvidenceReader({ search, now: () => clock });
    let outcomes;
    try {
      outcomes = await Promise.all(selection.topics.map(async id => {
        const topic = topicById.get(id);
        const evidenceSelection = { query: topic.query, ciks: [selection.cik], forms: [], section: 'all',
          start: selection.start, end: selection.end, offset: 0, limit: 5, format: 'json' };
        const response = await readEvidence(evidenceSelection, { signal });
        if (![200, 404].includes(response.status)) throw new Error('Prepared topic evidence unavailable');
        const result = await response.json();
        return { topic, status: response.status, result };
      }));
    } catch { return unavailable(); }
    const sources = new Map(), evidence = new Map(), topics = [];
    for (const { topic, status, result } of outcomes) {
      const filings = new Map();
      for (const row of status === 200 ? result.rows : []) {
        const sourceIdentity = JSON.stringify([row.cik, row.accession, row.primaryDoc]);
        const source = Object.fromEntries(X402_DISCLOSURE_PACKET_SOURCE_FIELDS.map(key => [key, row[key]]));
        if (sources.has(sourceIdentity) && JSON.stringify(source) !== JSON.stringify(sources.get(sourceIdentity).metadata)) return unavailable();
        if (!sources.has(sourceIdentity)) sources.set(sourceIdentity, { id: hash(source), metadata: source });
        const sourceRef = sources.get(sourceIdentity).id;
        const evidenceIdentity = `${sourceRef}/${row.index}`;
        const paragraph = { sourceRef, index: row.index, sectionId: row.sectionId, section: row.section, quote: row.quote, fingerprint: row.fingerprint };
        if (evidence.has(evidenceIdentity) && JSON.stringify(paragraph) !== JSON.stringify(evidence.get(evidenceIdentity).metadata)) return unavailable();
        if (!evidence.has(evidenceIdentity)) evidence.set(evidenceIdentity, { id: hash(paragraph), metadata: paragraph });
        if (!filings.has(sourceRef)) filings.set(sourceRef, { sourceRef, sections: new Map() });
        const filing = filings.get(sourceRef);
        if (!filing.sections.has(row.sectionId)) filing.sections.set(row.sectionId, { sectionId: row.sectionId, section: row.section, evidenceRefs: [] });
        const section = filing.sections.get(row.sectionId);
        if (section.section !== row.section) return unavailable();
        section.evidenceRefs.push(evidence.get(evidenceIdentity).id);
      }
      topics.push({ ...topic, status: status === 200 ? 'matched' : 'no-retained-match', coverage: result.coverage,
        candidateCoverage: result.pagination, filings: [...filings.values()].map(filing => ({ sourceRef: filing.sourceRef, sections: [...filing.sections.values()] })) });
    }
    if (!evidence.size) return Response.json({ error: 'No selected topic has matching retained evidence in the checked candidate pages. This request is not charged.',
      code: 'NO_MATCHING_EVIDENCE', topics }, { status: 404, headers: X402_DATA_HEADERS });
    const { cik, topics: selectedTopics, start, end } = selection;
    const content = { schemaVersion: X402_DISCLOSURE_TOPIC_PACKET_VERSION, status: topics.every(topic => topic.status === 'matched') ? 'ready' : 'partial',
      selection: { cik, topics: selectedTopics, start, end }, sourceCatalog: [...sources.values()].map(source => ({ id: source.id, ...source.metadata })),
      evidenceCatalog: [...evidence.values()].map(paragraph => ({ id: paragraph.id, ...paragraph.metadata })), topics, limitations };
    return deliver({ ...content, generatedAt: new Date(clock).toISOString(), snapshot: hash(content) }, selection.format);
  };
}
export const paidDisclosureTopicPacketReader = createPaidDisclosureTopicPacketReader();
