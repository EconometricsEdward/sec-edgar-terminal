import { REFINANCING_MAX_BYTES, REFINANCING_RETENTION_MS } from './projection.js';

/** Streaming avoids Vercel's buffered response ceiling as coverage grows.
 * Gzip is negotiated explicitly so the browser downloads a compact snapshot;
 * the identity fallback also streams and shares the same finite byte bound.
 */
export function refinancingResponse(value, request, now = Date.now()) {
  const remaining = Math.floor((Date.parse(value.sourceSnapshotAt) + REFINANCING_RETENTION_MS - now) / 1000);
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Refinancing response is outside its retention window.');
  const fresh = Math.min(900, remaining), stale = Math.max(0, remaining - fresh);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > REFINANCING_MAX_BYTES) throw new Error('Refinancing response exceeds its byte bound.');
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset += 64 * 1024));
    },
  });
  const encodings = (request.headers.get('accept-encoding') || '').split(',').map(part => part.trim().split(';'));
  const gzip = encodings.some(([name, ...options]) => name.toLowerCase() === 'gzip'
    && !options.some(option => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(option)));
  return new Response(gzip ? stream.pipeThrough(new CompressionStream('gzip')) : stream, { headers: {
    'Content-Type': 'application/json; charset=utf-8',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    'Vary': 'Accept-Encoding',
    'Cache-Control': `public, max-age=${Math.min(60, remaining)}, s-maxage=${fresh}, stale-while-revalidate=${Math.min(3600, stale)}, stale-if-error=${Math.min(86400, stale)}`,
    'X-Refinancing-Coverage': String(value.coverage.coveredCompanies),
    'X-SEC-Snapshot-At': value.sourceSnapshotAt,
    ...(value.cache?.status === 'stale' ? { 'X-Data-Stale': '1' } : {}),
  } });
}
