const headers = { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Link', Link: '</api/v2/factor-universe>; rel="successor-version"' };
export async function GET() {
  return Response.json({ schema_version: 'edgar.api-retirement.v1', error: 'Factor Universe v1 was retired with third-party price-derived analytics.', code: 'API_VERSION_RETIRED', retired: true, replacement: '/api/v2/factor-universe', documentation: '/market/factors' }, { status: 410, headers });
}
export function OPTIONS() { return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
