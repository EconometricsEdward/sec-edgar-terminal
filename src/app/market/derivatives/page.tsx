import { buildPageMetadata } from '../../../utils/siteMetadata';
import { getMarketResearch } from '../../../utils/marketPlumbing/server.js';
import { isCftcEnabled } from '../../../utils/cftcFeature.js';
import MarketResearch from '../research/MarketResearch';

export const revalidate = 900;
export const metadata = buildPageMetadata({
  title: 'Derivatives Explorer — Swaps Activity, Products & Clearing',
  description: 'Explore CFTC interest-rate, credit and FX swaps by product, currency, tenor and clearing status. Compare weekly activity, notional outstanding and trade counts with historical charts.',
  path: '/market/derivatives',
});
export default async function DerivativesPage() {
  return <MarketResearch kind="derivatives" initialData={await getMarketResearch('derivatives')} cftcEnabled={isCftcEnabled()} />;
}
