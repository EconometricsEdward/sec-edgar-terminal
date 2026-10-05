const headers = { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex' };
const error = (code, status) => Response.json({ schemaVersion: 'edgar.product-availability.v1', ready: false, code }, { status, headers });
const SUMMARY_TTL_MS = 30000, MAX_SUMMARIES = 96;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const normalized = value => Array.isArray(value) ? value.map(normalized)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])])) : value;

/** The same reader checks coverage, but the free response never returns purchased content. */
export function createProductAvailabilityHandler(products, { now = Date.now, summaryCacheMaxEntries = MAX_SUMMARIES } = {}) {
  if (!Number.isSafeInteger(summaryCacheMaxEntries) || summaryCacheMaxEntries < 1 || summaryCacheMaxEntries > MAX_SUMMARIES) throw new RangeError('Invalid readiness cache limit');
  let active = 0, starts = [], lastAt = 0;
  // Only public ready summaries are retained. In-flight work is bounded by admission.
  const summaries = new Map(), pending = new Map();
  const clock = () => { lastAt = Math.max(now(), lastAt); return lastAt; };
  const output = result => result.summary ? Response.json(result.summary, { headers }) : error(result.code, result.status);
  return async request => {
    const url = new URL(request.url), kind = url.searchParams.get('product');
    if (url.searchParams.getAll('product').length !== 1 || !Object.hasOwn(products, kind || '')
      || ['PAYMENT-SIGNATURE', 'X-PAYMENT', 'X-X402-Recovery-Token'].some(key => request.headers.has(key))) return error('INVALID_SELECTION', 400);
    url.searchParams.delete('product');
    const product = products[kind], selection = product.select(new Request(url));
    if (!selection) return error('INVALID_SELECTION', 400);
    const preparedSelection = { ...selection, format: 'json' };
    const key = JSON.stringify([kind, normalized(preparedSelection)]), at = clock();
    const saved = summaries.get(key);
    if (saved) {
      summaries.delete(key);
      if (saved.expiresAt > at) {
        summaries.set(key, saved);
        return output(saved);
      }
    }
    if (pending.has(key)) return output(await pending.get(key));
    // Admission uses one bounded runtime-wide window; it retains no caller identifiers.
    starts = starts.filter(time => at - time < 60000);
    if (active >= 4 || starts.length >= 30) return new Response(JSON.stringify({ ready: false, code: 'BUSY' }), { status: 429, headers: { ...headers, 'Content-Type': 'application/json', 'Retry-After': '60' } });
    starts.push(at); active++;
    const operation = Promise.resolve().then(async () => {
      try {
        const response = await product.read(preparedSelection);
        const body = await response.json();
        if (!response.ok) return { code: typeof body.code === 'string' && /^[A-Z_]{1,80}$/.test(body.code) ? body.code : 'DATA_NOT_PREPARED', status: response.status };
        const checkedAt = clock(), dataVersion = [body.snapshot, body.snapshot?.id, body.snapshot?.hash].find(hash);
        // Only a fixed allowlist of summary fields can leave or remain in this free endpoint.
        const summary = { schemaVersion: 'edgar.product-availability.v1', product: kind, ready: true,
          checkedAt: new Date(checkedAt).toISOString(), stale: Boolean(body.stale || response.headers.get('X-Data-Stale') === '1'),
          responseSchema: body.schemaVersion,
          resultCount: [body.companies, body.rows, body.evidence, body.banks, body.issuers, body.evidenceCatalog].find(Array.isArray)?.length ?? null,
          ...(dataVersion ? { dataVersion } : {}),
          purchase: { path: product.path, price: '0.01', currency: 'USDC', network: 'Solana mainnet' },
          note: 'Prepared data is ready for this selection at the check time. Coverage can change before purchase; unavailable or invalid delivery is not settled.',
        };
        const result = { summary, expiresAt: checkedAt + SUMMARY_TTL_MS };
        summaries.set(key, result);
        while (summaries.size > summaryCacheMaxEntries) summaries.delete(summaries.keys().next().value);
        return result;
      } catch { return { code: 'DATA_NOT_PREPARED', status: 503 }; }
      finally { active--; pending.delete(key); }
    });
    pending.set(key, operation);
    return output(await operation);
  };
}
