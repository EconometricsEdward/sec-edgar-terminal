const headers = { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex' };
const error = (code, status) => Response.json({ schemaVersion: 'edgar.product-availability.v1', ready: false, code }, { status, headers });

/** The same reader checks coverage, but the free response never returns purchased content. */
export function createProductAvailabilityHandler(products, { now = Date.now } = {}) {
  let active = 0, starts = [], lastAt = 0;
  return async request => {
    const url = new URL(request.url), kind = url.searchParams.get('product');
    if (url.searchParams.getAll('product').length !== 1 || !Object.hasOwn(products, kind || '')
      || ['PAYMENT-SIGNATURE', 'X-PAYMENT', 'X-X402-Recovery-Token'].some(key => request.headers.has(key))) return error('INVALID_SELECTION', 400);
    url.searchParams.delete('product');
    const product = products[kind], selection = product.select(new Request(url));
    if (!selection) return error('INVALID_SELECTION', 400);
    // Admission uses one bounded runtime-wide window; it retains no caller identifiers.
    const at = Math.max(now(), lastAt); lastAt = at;
    starts = starts.filter(time => at - time < 60000);
    if (active >= 4 || starts.length >= 30) return new Response(JSON.stringify({ ready: false, code: 'BUSY' }), { status: 429, headers: { ...headers, 'Content-Type': 'application/json', 'Retry-After': '60' } });
    starts.push(at); active++;
    try {
      const response = await product.read({ ...selection, format: 'json' });
      const body = await response.json();
      if (!response.ok) return error(typeof body.code === 'string' && /^[A-Z_]{1,80}$/.test(body.code) ? body.code : 'DATA_NOT_PREPARED', response.status);
      // Only a fixed allowlist of summary fields can leave this free endpoint.
      return Response.json({ schemaVersion: 'edgar.product-availability.v1', product: kind, ready: true,
        checkedAt: new Date(now()).toISOString(), stale: Boolean(body.stale || response.headers.get('X-Data-Stale') === '1'),
        responseSchema: body.schemaVersion,
        resultCount: [body.companies, body.rows, body.evidence].find(Array.isArray)?.length ?? null,
        purchase: { path: product.path, price: '0.01', currency: 'USDC', network: 'Solana mainnet' },
        note: 'Prepared data is ready for this selection at the check time. Coverage can change before purchase; unavailable or invalid delivery is not settled.',
      }, { headers });
    } catch { return error('DATA_NOT_PREPARED', 503); }
    finally { active--; }
  };
}
