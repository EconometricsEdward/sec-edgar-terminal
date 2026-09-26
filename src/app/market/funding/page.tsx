import { buildPageMetadata } from '../../../utils/siteMetadata';
import { getMarketResearch } from '../../../utils/marketPlumbing/server.js';
import { isCftcEnabled } from '../../../utils/cftcFeature.js';
import MarketResearch from '../research/MarketResearch';

export const revalidate = 900;
export const metadata = buildPageMetadata({
  title: 'Funding & Clearing — Repo Rates & Treasury Settlement',
  description: 'Explore SOFR, TGCR and BGCR repo rates, transaction volumes, funding spreads and primary-dealer Treasury settlement fails. Official New York Fed data with historical charts and CSV downloads.',
  path: '/market/funding',
});
export default async function FundingPage() {
  return <MarketResearch kind="funding" initialData={await getMarketResearch('funding')} cftcEnabled={isCftcEnabled()} />;
}
