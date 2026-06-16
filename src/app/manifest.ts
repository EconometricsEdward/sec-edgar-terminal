import type { MetadataRoute } from 'next';
import { SITE_NAME, SITE_URL } from '../utils/siteMetadata';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} - SEC Filings & Financial Data Explorer`,
    short_name: SITE_NAME,
    description:
      'Free, source-linked explorer for SEC filings, XBRL financials, insider trading, funds, disclosures, and peer comparisons.',
    id: SITE_URL,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#1c1917',
    theme_color: '#1c1917',
    lang: 'en-US',
    categories: ['finance', 'business', 'productivity'],
    icons: [
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}
