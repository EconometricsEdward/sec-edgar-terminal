import { createHash } from 'node:crypto';

/** Cache only prepared public research; never cache a missing publication. */
export function publicFundResponse(request, summary, now = Date.now()) {
  const body = JSON.stringify(summary);
  const etag = `W/"${createHash('sha256').update(body).digest('hex')}"`;
  const expires = Date.parse(summary.freshUntil);
  const remaining = Number.isFinite(expires) ? Math.max(0, Math.floor((expires - now) / 1000)) : 0;
  const ttl = summary.stale ? 60 : Math.min(300, remaining);
  const swr = summary.stale ? 60 : Math.min(60, Math.max(0, remaining - ttl));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag',
    ETag: etag,
  };
  const validators = (request.headers.get('if-none-match') || '').split(',').map(value => value.trim().replace(/^W\//, ''));
  if (validators.includes('*') || validators.includes(etag.replace(/^W\//, ''))) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}
