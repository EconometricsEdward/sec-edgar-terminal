import { bankStore } from '../../../../utils/bank/store.js';
import { isBankPreview, safeBankError } from '../../../../utils/bank/errors.js';
export const dynamic = 'force-dynamic';
export async function GET() {
  if (!isBankPreview()) return new Response(null, { status: 404 });
  try { return Response.json(await bankStore('read'), { headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' } }); }
  catch (error) { return Response.json(safeBankError(error), { status: 503 }); }
}
