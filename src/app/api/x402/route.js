import { getX402PublicConfiguration } from '../../../utils/x402Payments.js';
import { getX402LivePublicConfiguration } from '../../../utils/x402SolanaRecipient.js';
import { buildX402Catalog } from '../../../utils/x402Catalog.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = {
  'Cache-Control': 'private, no-store',
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, follow',
  Link: '</data-access>; rel="describedby"; type="application/json"',
};

export async function GET() {
  const configuration = await getX402LivePublicConfiguration(getX402PublicConfiguration());
  return Response.json(buildX402Catalog(configuration), { headers });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}
