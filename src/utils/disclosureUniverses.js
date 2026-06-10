/**
 * Curated disclosure-search universes.
 *
 * These are intentionally small, high-recognition operating-company baskets.
 * They let users search across a sector/topic without hand-picking tickers,
 * while keeping each scan bounded enough for SEC fair-access limits.
 */

export const DISCLOSURE_UNIVERSES = [
  {
    id: 'mega-tech',
    label: 'Mega-Cap Tech',
    description: 'Platform, cloud, ecommerce, AI infrastructure, and software leaders',
    tickers: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'ORCL'],
  },
  {
    id: 'semiconductors',
    label: 'Semiconductors',
    description: 'Chip designers, fabs, equipment, and analog/component suppliers',
    tickers: ['NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM', 'MU', 'TXN', 'AMAT'],
  },
  {
    id: 'big-banks',
    label: 'Big Banks',
    description: 'Money-center, investment banking, and major regional lenders',
    tickers: ['JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'USB', 'PNC'],
  },
  {
    id: 'retail-consumer',
    label: 'Retail & Consumer',
    description: 'Mass-market retail, home improvement, apparel, and restaurants',
    tickers: ['WMT', 'COST', 'TGT', 'HD', 'LOW', 'NKE', 'SBUX', 'MCD'],
  },
  {
    id: 'energy',
    label: 'Energy',
    description: 'Integrated oil, E&P, services, refining, and energy infrastructure',
    tickers: ['XOM', 'CVX', 'COP', 'EOG', 'SLB', 'OXY', 'MPC', 'VLO'],
  },
  {
    id: 'healthcare-pharma',
    label: 'Healthcare & Pharma',
    description: 'Pharma, biotech, devices, and healthcare services bellwethers',
    tickers: ['JNJ', 'PFE', 'MRK', 'LLY', 'ABBV', 'BMY', 'GILD', 'AMGN'],
  },
  {
    id: 'airlines-travel',
    label: 'Airlines & Travel',
    description: 'Airlines, cruises, lodging, and travel demand proxies',
    tickers: ['DAL', 'UAL', 'AAL', 'LUV', 'CCL', 'RCL', 'MAR', 'HLT'],
  },
  {
    id: 'media-telecom',
    label: 'Media & Telecom',
    description: 'Streaming, studios, cable, telecom, and digital media companies',
    tickers: ['NFLX', 'DIS', 'WBD', 'FOXA', 'CMCSA', 'T', 'VZ', 'CHTR'],
  },
];

export function getDisclosureUniverse(id) {
  if (!id) return null;
  const normalized = String(id).trim().toLowerCase();
  return DISCLOSURE_UNIVERSES.find((universe) => universe.id === normalized) || null;
}
