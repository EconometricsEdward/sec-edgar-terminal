import { createHash } from 'node:crypto';
import { readPreparedAnalysis } from './preparedFinancialData.js';
import { preparedEnvelopeUsable } from './secDocumentStore.js';
import { ANALYSIS_VERSION } from './analysisResearch.js';
import { ANALYSIS_MAPPING_VERSION } from './analysisVersion.js';
import { readUniverseSnapshot } from './marketUniverseServer.js';
import { readCachedRefinancingWall } from './refinancing/publicRead.js';

export const X402_DATA_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-X402-Price, X-Data-Stale, Link',
  'X-Robots-Tag': 'noindex',
  Link: '</data-access>; rel="help"',
});
export function x402DataError(code, message, status = 400) {
  return Response.json({ error: message, code }, { status, headers: X402_DATA_HEADERS });
}
export function x402DataOptions() {
  return new Response(null, { status: 204, headers: { ...X402_DATA_HEADERS,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, PAYMENT-SIGNATURE',
    'Access-Control-Max-Age': '600',
  } });
}
export function x402DataHead() {
  return new Response(null, { status: 405, headers: { ...X402_DATA_HEADERS, Allow: 'GET, OPTIONS' } });
}
export function paidResearchSelection(request, kind, ticker = '') {
  const query = new URL(request.url).searchParams;
  const financial = kind === 'financials';
  const allowed = financial ? ['basis'] : kind === 'factor-universe' ? ['basis', 'limit', 'offset', 'snapshot'] : ['limit', 'offset', 'snapshot'];
  if ([...query.keys()].some(key => !allowed.includes(key)) || allowed.some(key => query.getAll(key).length > 1 || query.has(key) && !query.get(key))) return null;
  const basis = query.get('basis') || (financial ? 'annual' : 'ttm');
  if ((financial ? ['annual', 'quarter', 'ytd', 'ttm'] : ['annual', 'ttm']).includes(basis) === false) return null;
  if (financial) {
    // Numeric CIKs can invoke expensive public PDF extraction elsewhere; this
    // paid reader is strictly a prepared SEC financial-model retrieval.
    if (typeof ticker !== 'string' || !/^[A-Za-z][A-Za-z0-9.-]{0,14}$/.test(ticker)) return null;
    return { ticker: ticker.toUpperCase(), basis };
  }
  const limit = query.get('limit') || '100', offset = query.get('offset') || '0', snapshot = query.get('snapshot') || '';
  if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100 || !/^(0|[1-9]\d{0,3})$/.test(offset) || snapshot && !/^[a-f0-9]{64}$/.test(snapshot)) return null;
  return { ...(kind === 'factor-universe' ? { basis } : {}), limit: Number(limit), offset: Number(offset), snapshot };
}

const modelKeys = ['version', 'mappingVersion', 'ticker', 'cik', 'name', 'lens', 'businessModel', 'lensNote', 'basis', 'asOf',
  'observedAt', 'periods', 'definitions', 'metrics', 'sourceCatalog', 'calculationCatalog', 'packed', 'revenueKey', 'highlights', 'note', 'sourceCoverage', 'mappingCompatibility'];
const unavailable = () => x402DataError('DATA_NOT_PREPARED', 'Verified prepared research is unavailable. This request does not start source downloads and is not charged.', 503);

/** Dependency injection keeps payment/data tests offline and proves cache-only reads. */
export function createPaidResearchReaders({ financialRead = readPreparedAnalysis, universeRead = readUniverseSnapshot,
  refinancingRead = readCachedRefinancingWall, now = Date.now } = {}) {
  return {
    async financials(selection) {
      let envelope;
      try { envelope = await financialRead({ ...selection, asOf: '' }); } catch { return unavailable(); }
      const data = envelope?.payload;
      if (!preparedEnvelopeUsable(envelope, now()) || data?.packed !== true || data.version !== ANALYSIS_VERSION
        || data.mappingVersion !== ANALYSIS_MAPPING_VERSION || data.ticker !== selection.ticker || data.basis !== selection.basis
        || data.asOf || !/^(?!0+$)\d{10}$/.test(data.cik || '') || !Array.isArray(data.periods) || !data.periods.length
        || !Array.isArray(data.definitions) || !Array.isArray(data.sourceCatalog) || !Array.isArray(data.calculationCatalog)
        || !data.metrics || typeof data.metrics !== 'object') return unavailable();
      // Return public model fields, never leases, storage paths or caller input.
      const model = Object.fromEntries(modelKeys.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
      const stale = Boolean(envelope.stale || Date.parse(envelope.metadata.expiresAt) <= now());
      return Response.json({ schemaVersion: 'edgar.paid-financials.v1', status: 'ready', stale,
        fetchedAt: envelope.metadata.fetchedAt, checkedAt: envelope.metadata.revalidatedAt || envelope.metadata.fetchedAt,
        freshUntil: envelope.metadata.expiresAt, model,
        limitations: ['Prepared normalized SEC financial history with reported inputs and calculated metrics. Missing values are not zero.',
          'Historical periods use the latest filed values in this model, including revisions; this is not an as-filed point-in-time archive.',
          'History, concepts and source coverage vary by company and reporting basis.'],
      }, { headers: { ...X402_DATA_HEADERS, 'X-Data-Stale': stale ? '1' : '0' } });
    },
    async page(kind, selection) {
      let value;
      try { value = kind === 'factor-universe' ? await universeRead(selection.basis) : await refinancingRead(); } catch { return unavailable(); }
      const field = kind === 'factor-universe' ? 'rows' : 'companies';
      if (!Array.isArray(value?.[field]) || !value[field].length) return unavailable();
      // A computed fallback has a new clock on every read. Paid pagination
      // requires a retained snapshot with a stable identity across requests.
      if (kind === 'factor-universe' && value.cache_status === 'computed-from-prepared-sec') return unavailable();
      // Hash the complete retained snapshot so pages cannot silently mix
      // corrected values, membership or clocks even when timestamps coincide.
      const snapshotId = createHash('sha256').update(JSON.stringify(value)).digest('hex');
      if (selection.snapshot && selection.snapshot !== snapshotId) return x402DataError('SNAPSHOT_CHANGED', 'The prepared snapshot changed. Restart pagination without a snapshot token; this response is not charged.', 409);
      const total = value[field].length;
      if (selection.offset >= total) return x402DataError('PAGE_OUT_OF_RANGE', 'The offset is beyond this snapshot. This response is not charged.', 416);
      const keys = kind === 'factor-universe'
        ? ['schema_version', 'methodology_version', 'diagnostics_version', 'generated_at', 'sec_snapshot_at', 'sec_stale', 'basis', 'status', 'cache_status', 'universe', 'fundamental_definitions', 'limitations', 'links']
        : ['version', 'extractionVersion', 'generatedAt', 'sourceSnapshotAt', 'membershipId', 'coverage', 'sectors', 'cache'];
      const snapshot = Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
      const nextOffset = selection.offset + selection.limit < total ? selection.offset + selection.limit : null;
      return Response.json({ schemaVersion: kind === 'factor-universe' ? 'edgar.paid-factor-page.v1' : 'edgar.paid-refinancing-page.v1',
        snapshot, [field]: value[field].slice(selection.offset, selection.offset + selection.limit),
        pagination: { ...selection, snapshot: snapshotId, total, nextOffset },
      }, { headers: { ...X402_DATA_HEADERS, 'X-Data-Stale': value.status === 'stale' || value.cache?.status === 'stale' ? '1' : '0' } });
    },
  };
}
export const paidResearchReaders = createPaidResearchReaders();
