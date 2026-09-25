import { bankStore } from '../../../../../utils/bank/store.js';
import { isBankPreview, safeBankError } from '../../../../../utils/bank/errors.js';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  if (!isBankPreview()) return new Response(null, { status: 404 });
  const q = new URL(request.url).searchParams;
  if (!/^[1-9]\d{0,9}$/.test(q.get('rssd') || '') || !/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(q.get('quarter') || '')) return new Response(null, { status: 400 });
  try {
    const source = await bankStore('source', { rssd: Number(q.get('rssd')), reportDate: q.get('quarter') });
    if (!source) return new Response(null, { status: 404 });
    return new Response(source.rawXbrl, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
  } catch (error) { return Response.json(safeBankError(error), { status: 503 }); }
}
