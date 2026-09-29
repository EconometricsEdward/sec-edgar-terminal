import { buildPageMetadata } from '../../../utils/siteMetadata';
import { isCftcEnabled } from '../../../utils/cftcFeature.js';
import RefinancingLoader from './RefinancingLoader';

// All visitors share a static shell and one prepared, CDN-cached data resource.
// Filtering never changes the server cache key or starts SEC extraction.
export const dynamic = 'force-static';

export const metadata = buildPageMetadata({
  title: 'Refinancing Wall — Corporate Debt Maturities',
  description: 'Explore corporate debt maturity schedules from SEC annual filings. Filter by sector, compare upcoming principal repayments with cash and operating cash flow, and inspect the filing evidence.',
  path: '/market/refinancing',
});

export default function RefinancingPage() {
  return <RefinancingLoader cftcEnabled={isCftcEnabled()} />;
}
