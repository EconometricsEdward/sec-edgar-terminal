import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import RiskClient from './RiskClient';
import { buildPageMetadata, SITE_URL } from '../../utils/siteMetadata';
import { isCftcEnabled } from '../../utils/cftcFeature.js';
import { parseRiskLocation, riskViewPath } from './riskNavigation.js';

const TITLE = 'Company Risk Profile — Financial Resilience & Business Exposures';
const DESCRIPTION = isCftcEnabled()
  ? 'Understand company liquidity, leverage, capital and earnings through SEC financial trends, business exposures and separately sourced CFTC futures-market context.'
  : 'Understand company liquidity, leverage, capital and earnings through industry-aware SEC financial measures, historical comparisons and source-linked evidence.';

export const metadata: Metadata = buildPageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: '/risk',
});

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RiskPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = new URLSearchParams(Object.entries(params).flatMap(([key, value]) => Array.isArray(value) ? value.map(item => [key, item]) : value == null ? [] : [[key, value]])).toString();
  const cftcEnabled = isCftcEnabled();
  const location = parseRiskLocation(query, cftcEnabled);
  const queryParams = new URLSearchParams(query);
  const requestedView = queryParams.get('view') || queryParams.get('tab');

  // Retired tabs and disabled CFTC views resolve before hydration. Keep the
  // selected company, financial basis and filing cutoff from existing links.
  if (requestedView && (requestedView !== location.view || queryParams.has('tab'))) {
    redirect(riskViewPath(query, location.view, cftcEnabled));
  }

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${SITE_URL}/risk#webpage`,
    url: `${SITE_URL}/risk`,
    name: TITLE,
    description: DESCRIPTION,
    isPartOf: { '@id': `${SITE_URL}/#website` },
    inLanguage: 'en-US',
    isAccessibleForFree: true,
    about: ['Company liquidity', 'Financial leverage', 'Capital adequacy', 'Earnings resilience'].map(name => ({ '@type': 'Thing', name })),
  };

  return <>
    <script id="company-risk-research" type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }} />
    <RiskClient key={`${location.ticker}:${location.view}:${location.basis}:${location.asOf}:${location.entity}`} initialTicker={location.ticker} initialView={location.view} initialBasis={location.basis} initialEntity={location.entity} initialAsOf={location.asOf} cftcEnabled={cftcEnabled} />
  </>;
}
