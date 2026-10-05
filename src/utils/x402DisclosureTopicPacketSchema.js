import { X402_DISCLOSURE_EVIDENCE_SCHEMA } from './x402DisclosureEvidenceSchema.js';

/** Pure contracts and literal topic rules; safe for discovery tooling. */
export const X402_DISCLOSURE_TOPIC_PACKET_VERSION = 'edgar.paid-disclosure-topic-packet.v1';
export const X402_DISCLOSURE_PACKET_TOPICS = Object.freeze([
  { id: 'liquidity', label: 'Liquidity language', query: 'liquidity' },
  { id: 'covenants', label: 'Covenant language', query: 'covenant OR covenants OR "event of default" OR "events of default" OR ((waiver OR waivers) AND (loan OR loans OR credit OR debt OR borrowing OR borrowings))' },
  { id: 'collateral', label: 'Collateral language', query: 'collateral OR pledged OR "security interest" OR "security interests" OR "secured borrowing" OR "secured borrowings" OR "secured debt"' },
  { id: 'customer-concentration', label: 'Customer-concentration language', query: '"customer concentration" OR "major customer" OR "major customers" OR "significant customer" OR "significant customers" OR "largest customer" OR "largest customers" OR "single customer" OR "single customers" OR "customers accounted" OR "customer accounted" OR "customers represented" OR "customer represented"' },
].map(topic => Object.freeze(topic)));
export const X402_DISCLOSURE_PACKET_DEFAULT_TOPICS = Object.freeze(['liquidity', 'covenants', 'collateral']);
export const X402_DISCLOSURE_PACKET_SOURCE_FIELDS = Object.freeze([
  'cik', 'ticker', 'companyName', 'accession', 'primaryDoc', 'form', 'filingDate', 'sourceUrl', 'sourceRetrievedAt', 'indexedAt',
  'documentFingerprint', 'indexedPassages', 'totalPassages', 'documentComplete', 'parserVersion', 'identityProof',
]);
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const fingerprint = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const date = { type: 'string', format: 'date' };
const topicIds = X402_DISCLOSURE_PACKET_TOPICS.map(topic => topic.id);
const retainedRow = X402_DISCLOSURE_EVIDENCE_SCHEMA.properties.rows.items.properties;
const candidateCoverage = object({ ...X402_DISCLOSURE_EVIDENCE_SCHEMA.properties.pagination.properties,
  limit: { const: 5 }, offset: { const: 0 }, verifiedReturned: { type: 'integer', minimum: 0, maximum: 5 },
});
export const X402_DISCLOSURE_TOPIC_PACKET_SCHEMA = object({
  schemaVersion: { const: X402_DISCLOSURE_TOPIC_PACKET_VERSION }, status: { enum: ['ready', 'partial'] },
  generatedAt: { type: 'string', format: 'date-time' }, snapshot: fingerprint,
  selection: object({ cik: retainedRow.cik,
    topics: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: topicIds } }, start: date, end: date }),
  sourceCatalog: { type: 'array', minItems: 1, maxItems: 15, items: object({ id: fingerprint,
    ...Object.fromEntries(X402_DISCLOSURE_PACKET_SOURCE_FIELDS.map(key => [key, retainedRow[key]])) }) },
  evidenceCatalog: { type: 'array', minItems: 1, maxItems: 15, items: object({ id: fingerprint, sourceRef: fingerprint,
    index: retainedRow.index, sectionId: retainedRow.sectionId, section: retainedRow.section,
    quote: retainedRow.quote, fingerprint: retainedRow.fingerprint }) },
  topics: { type: 'array', minItems: 1, maxItems: 3, items: object({ id: { enum: topicIds },
    label: { type: 'string', minLength: 1, maxLength: 100 }, query: { type: 'string', minLength: 2, maxLength: 1000 },
    status: { enum: ['matched', 'no-retained-match'] }, coverage: X402_DISCLOSURE_EVIDENCE_SCHEMA.properties.coverage,
    candidateCoverage,
    filings: { type: 'array', maxItems: 5, items: object({ sourceRef: fingerprint,
      sections: { type: 'array', minItems: 1, maxItems: 5, items: object({ sectionId: retainedRow.sectionId, section: retainedRow.section,
        evidenceRefs: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: fingerprint } }) } }) },
  }) },
  limitations: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
});
export const X402_DISCLOSURE_TOPIC_PACKET_DESCRIPTOR = Object.freeze({
  routePattern: '/api/x402/v1/disclosure-topic-packet', tags: ['finance', 'SEC', 'disclosures', 'risk-evidence', 'csv'],
  input: { cik: '0000019617', topics: 'liquidity,covenants,collateral' },
  inputSchema: { type: 'object', additionalProperties: false, required: ['cik'], properties: {
    cik: { ...retainedRow.cik, description: 'One exact nonzero ten-digit SEC issuer CIK. No ticker or alias resolution.' },
    topics: { type: 'string', pattern: '^(liquidity|covenants|collateral|customer-concentration)(,(liquidity|covenants|collateral|customer-concentration)){0,2}$',
      default: 'liquidity,covenants,collateral', description: 'One to three unique literal language topics; each checks at most 120 candidates and returns at most five full paragraphs.' },
    start: { ...date, description: 'Inclusive filing date within the prepared two-year retention window.' },
    end: { ...date, description: 'Inclusive filing date no later than today.' },
    format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
  } },
});
