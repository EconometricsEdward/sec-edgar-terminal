import { getX402PublicConfiguration } from '../../../utils/x402Payments.js';
import { buildX402Catalog } from '../../../utils/x402Catalog.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = {
  'Cache-Control': 'private, no-store',
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
  Link: '</data-access>; rel="describedby"; type="text/html"',
};

export function GET() {
  return Response.json(buildX402Catalog(getX402PublicConfiguration()), { headers });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}
