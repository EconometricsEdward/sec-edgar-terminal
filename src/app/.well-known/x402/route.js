import { x402Manifest } from '../../../utils/x402Manifest.js';

export const runtime = 'nodejs';
export const dynamic = 'force-static';

export async function GET() {
  return Response.json(x402Manifest, {
    headers: {
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
