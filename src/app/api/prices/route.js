const headers = { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*' };
export async function GET() {
  return Response.json({ schema_version: 'edgar.api-retirement.v1', error: 'The third-party security-price endpoint has been retired.', code: 'PRICE_DATA_RETIRED', retired: true, replacement: null, note: 'CFTC positioning is separate market context and is not a replacement price feed.' }, { status: 410, headers });
}
export function OPTIONS() { return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
