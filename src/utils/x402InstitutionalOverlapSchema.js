const cik = { type: 'string', pattern: '^(?!0000000000)[0-9]{10}$' };
const quarter = { type: 'string', pattern: '^[0-9]{4}-(03-31|06-30|09-30|12-31)$' };
const timestamp = { type: 'string' };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const strings = { type: 'array', items: { type: 'string' } };
const nullableText = { type: ['string', 'null'] };
const number = { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableNumber = { type: ['number', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const percentage = { type: ['number', 'null'], minimum: 0, maximum: 100 };
const source = { type: 'object', required: ['accession', 'form', 'filingDate', 'indexUrl', 'primaryUrl', 'tableUrls', 'isAmendment', 'amendmentType', 'amendmentNumber', 'superseded'], properties: {
  accession: { type: 'string', pattern: '^[0-9]{10}-[0-9]{2}-[0-9]{6}$' }, form: { enum: ['13F-HR', '13F-HR/A'] },
  filingDate: { type: 'string' }, indexUrl: { type: 'string' }, primaryUrl: { type: 'string' }, tableUrls: { type: 'array', minItems: 1, maxItems: 15, items: { type: 'string' } },
  isAmendment: { type: 'boolean' }, amendmentType: nullableText, amendmentNumber: { type: ['integer', 'null'], minimum: 1 }, superseded: { type: 'boolean' },
} };
const cell = { type: 'object', additionalProperties: false, required: ['cik', 'status', 'issuer', 'classTitle', 'quantity', 'valueUsd', 'weightPct'], properties: {
  cik, status: { enum: ['reported', 'not-reported', 'unknown'] }, issuer: nullableText, classTitle: nullableText,
  quantity: nullableNumber, valueUsd: nullableNumber, weightPct: percentage,
} };
const row = { type: 'object', additionalProperties: false, required: ['key', 'cusip', 'putCall', 'quantityType', 'managerCount', 'aggregateReportedValueUsd', 'cells'], properties: {
  key: { type: 'string', pattern: '^[A-Z0-9*@#]{9}\\|(SECURITY|PUT|CALL)\\|(SH|PRN)$' }, cusip: { type: 'string', pattern: '^[A-Z0-9*@#]{9}$' },
  putCall: { enum: [null, 'PUT', 'CALL'] }, quantityType: { enum: ['SH', 'PRN'] }, managerCount: { type: 'integer', minimum: 2, maximum: 4 },
  aggregateReportedValueUsd: number, cells: { type: 'array', minItems: 2, maxItems: 4, items: cell },
} };
const manager = { type: 'object', required: ['cik', 'name', 'period', 'status', 'complete', 'totalValueUsd', 'positionCount', 'top5Pct', 'top10Pct', 'confidentialOmitted', 'publicScopeLimited', 'absenceKnown', 'reportType', 'amendmentCount', 'filings', 'checkedAt', 'freshUntil', 'observedAt', 'stale'], properties: {
  cik, name: { type: 'string' }, period: quarter, status: { const: 'ready' }, complete: { const: true },
  totalValueUsd: number, positionCount: { type: 'integer', minimum: 0, maximum: 20000 }, top5Pct: percentage, top10Pct: percentage,
  confidentialOmitted: { type: 'boolean' }, publicScopeLimited: { type: 'boolean' }, absenceKnown: { type: 'boolean' },
  reportType: { enum: ['13F HOLDINGS REPORT', '13F COMBINATION REPORT'] }, amendmentCount: { type: 'integer', minimum: 0, maximum: 16 },
  filings: { type: 'array', minItems: 1, maxItems: 16, items: source }, checkedAt: timestamp, freshUntil: timestamp, observedAt: timestamp, stale: { type: 'boolean' },
} };
const pair = { type: 'object', required: ['key', 'leftCik', 'rightCik', 'complete', 'percentagesAvailable', 'publicScopeLimited', 'sharedCount', 'unionCount', 'jaccardPct', 'overlapPct', 'leftCommonValueUsd', 'rightCommonValueUsd', 'leftCommonSharePct', 'rightCommonSharePct'], properties: {
  key: { type: 'string' }, leftCik: cik, rightCik: cik, complete: { const: true }, percentagesAvailable: { type: 'boolean' }, publicScopeLimited: { type: 'boolean' },
  sharedCount: { type: 'integer', minimum: 0, maximum: 20000 }, unionCount: { type: 'integer', minimum: 0, maximum: 40000 },
  jaccardPct: percentage, overlapPct: percentage, leftCommonValueUsd: nullableNumber, rightCommonValueUsd: nullableNumber,
  leftCommonSharePct: percentage, rightCommonSharePct: percentage,
} };

/** JSON delivery contract; CSV emits one security/manager cell per row. No runtime or source imports. */
export const X402_INSTITUTIONAL_OVERLAP_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'status', 'period', 'generatedAt', 'stale', 'selection', 'snapshot', 'managers', 'pairs', 'coverage', 'population', 'rows', 'pagination', 'limitations'], properties: {
    schemaVersion: { const: 'edgar.paid-institutional-overlap.v1' }, status: { const: 'ready' }, period: quarter,
    generatedAt: timestamp, stale: { type: 'boolean' },
    selection: { type: 'object', additionalProperties: false, required: ['ciks', 'requestedPeriod', 'minimumManagers', 'sort', 'order'], properties: {
      ciks: { type: 'array', minItems: 2, maxItems: 4, uniqueItems: true, items: cik }, requestedPeriod: { type: 'string' },
      minimumManagers: { type: 'integer', minimum: 2, maximum: 4 }, sort: { enum: ['reportedValue', 'cusip'] }, order: { enum: ['asc', 'desc'] },
    } },
    snapshot: { type: 'object', additionalProperties: false, required: ['earliestCheckedAt', 'latestCheckedAt', 'observations'], properties: {
      earliestCheckedAt: timestamp, latestCheckedAt: timestamp, observations: { type: 'array', minItems: 2, maxItems: 4, items: {
        type: 'object', additionalProperties: false, required: ['cik', 'checkedAt', 'freshUntil', 'observedAt', 'stale', 'sourceChainHash'], properties: {
          cik, checkedAt: timestamp, freshUntil: timestamp, observedAt: timestamp, stale: { type: 'boolean' }, sourceChainHash: hash,
        },
      } },
    } },
    managers: { type: 'array', minItems: 2, maxItems: 4, items: manager }, pairs: { type: 'array', minItems: 1, maxItems: 6, items: pair },
    coverage: { type: 'object', required: ['requestedManagers', 'completeManagers', 'allComplete', 'publicScopeLimitedManagers'], properties: {
      requestedManagers: { type: 'integer', minimum: 2, maximum: 4 }, completeManagers: { type: 'integer', minimum: 2, maximum: 4 },
      allComplete: { const: true }, publicScopeLimitedManagers: { type: 'integer', minimum: 0, maximum: 4 },
    } },
    population: { type: 'object', additionalProperties: false, required: ['unionPositions', 'totalSharedPositions', 'matchingPositions'], properties: {
      unionPositions: { type: 'integer', minimum: 1, maximum: 80000 }, totalSharedPositions: { type: 'integer', minimum: 1, maximum: 40000 },
      matchingPositions: { type: 'integer', minimum: 1, maximum: 40000 },
    } },
    rows: { type: 'array', minItems: 1, maxItems: 100, items: row },
    pagination: { type: 'object', additionalProperties: false, required: ['limit', 'offset', 'total', 'nextOffset', 'truncated', 'snapshot'], properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0, maximum: 9999 },
      total: { type: 'integer', minimum: 1, maximum: 40000 }, nextOffset: { type: ['integer', 'null'], minimum: 1, maximum: 9999 }, truncated: { type: 'boolean' }, snapshot: hash,
    } }, limitations: strings,
  },
});
