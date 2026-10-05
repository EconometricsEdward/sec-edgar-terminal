/** Pure schemas: safe for discovery tooling without loading server data access. */
export const X402_DISCLOSURE_EVIDENCE_VERSION = 'edgar.paid-disclosure-evidence.v1';
export const X402_DISCLOSURE_FORMS = Object.freeze(['10-K', '10-Q', '8-K', '20-F', '40-F', '6-K', 'S-1', 'S-3', 'S-4', 'DEF 14A', 'DEFM14A', 'N-CSR', 'NPORT-P']
  .flatMap(form => [form, `${form}/A`]));
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const date = { type: 'string', format: 'date' };
const timestamp = { type: 'string', format: 'date-time' };
const nullableDate = { anyOf: [date, { type: 'null' }] };
const nullableTimestamp = { anyOf: [timestamp, { type: 'null' }] };
const count = maximum => ({ type: 'integer', minimum: 0, maximum });
const fingerprint = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const sectionId = { type: 'string', pattern: '^(other|risk|mda|notes|8k:[0-9]\\.[0-9]{2})$' };
export const X402_DISCLOSURE_EVIDENCE_SCHEMA = object({
  schemaVersion: { const: X402_DISCLOSURE_EVIDENCE_VERSION }, status: { const: 'ready' }, generatedAt: timestamp,
  selection: object({ query: { type: 'string', minLength: 2, maxLength: 1000 },
    ciks: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', pattern: '^(?!0000000000)[0-9]{10}$' } },
    forms: { type: 'array', maxItems: 26, uniqueItems: true, items: { enum: X402_DISCLOSURE_FORMS } },
    section: { type: 'string', pattern: '^(all|other|risk|mda|notes|8k:[0-9]\\.[0-9]{2})$' }, start: date, end: date }),
  coverage: object({ scope: { const: 'partial-prepared-paragraph-corpus' }, partial: { const: true },
    documents: count(600), indexedPassages: count(108000), oldestFilingDate: nullableDate, newestFilingDate: nullableDate,
    lastIndexedAt: nullableTimestamp, retentionDays: { const: 730 }, parserVersion: { const: 1 },
    queryVerification: { const: 'exact-boolean-on-full-retained-paragraph' } }),
  pagination: object({ offset: count(9999), limit: { type: 'integer', minimum: 1, maximum: 20 },
    rawCandidatesReturned: count(120), rawCandidatesScanned: count(120), verifiedReturned: { type: 'integer', minimum: 1, maximum: 20 },
    nextOffset: { anyOf: [count(9999), { type: 'null' }] }, hasMore: { type: 'boolean' },
    windowLimited: { type: 'boolean' }, moreMeaning: { const: 'additional-candidates-not-confirmed-exact-matches' } }),
  rows: { type: 'array', minItems: 1, maxItems: 20, items: object({
    cik: { type: 'string', pattern: '^(?!0000000000)[0-9]{10}$' }, ticker: { type: 'string', pattern: '^[A-Z0-9.-]{0,15}$' },
    companyName: { type: 'string', minLength: 1, maxLength: 250 }, accession: { type: 'string', pattern: '^[0-9]{10}-[0-9]{2}-[0-9]{6}$' },
    primaryDoc: { type: 'string', minLength: 1, maxLength: 250 }, form: { enum: X402_DISCLOSURE_FORMS }, filingDate: date,
    sourceUrl: { type: 'string', pattern: '^https://www\\.sec\\.gov/Archives/edgar/data/' }, sourceRetrievedAt: timestamp, indexedAt: timestamp,
    index: count(199999), sectionId, section: { type: 'string', minLength: 1, maxLength: 100 }, quote: { type: 'string', minLength: 1, maxLength: 6000 },
    fingerprint, documentFingerprint: fingerprint, indexedPassages: { type: 'integer', minimum: 1, maximum: 180 },
    totalPassages: { type: 'integer', minimum: 1, maximum: 200000 }, documentComplete: { type: 'boolean' }, parserVersion: { const: 1 },
    identityProof: { const: 'retained-sec-document-identifiers' },
  }) },
  limitations: { type: 'array', minItems: 1, items: { type: 'string' } },
});
