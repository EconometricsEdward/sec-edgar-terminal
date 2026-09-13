const headers = { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*' };
export async function GET() {
  return Response.json({ schema_version: 'edgar.api-retirement.v1', error: 'Market Signals was retired because its contract depended on third-party security-price histories.', code: 'API_RETIRED', retired: true, replacement: null, documentation: '/market/factors', note: 'SEC-only Fundamental Lab is a separate aggregate contract.' }, { status: 410, headers });
}
export function OPTIONS() { return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
