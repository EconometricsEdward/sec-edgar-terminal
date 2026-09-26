import { SITE_URL } from '../../../../utils/siteMetadata';
import { bankScopeStore } from '../../../../utils/bank/scopeStore.js';
import { bankSitemapXml } from '../../../../utils/bank/seo.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const directory = await bankScopeStore('search', { query: '' });
    return new Response(bankSitemapXml(directory, SITE_URL), { headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch {
    return new Response('Bank sitemap is temporarily unavailable.', { status: 503, headers: {
      'Cache-Control': 'no-store', 'Retry-After': '300', 'X-Robots-Tag': 'noindex',
    } });
  }
}
