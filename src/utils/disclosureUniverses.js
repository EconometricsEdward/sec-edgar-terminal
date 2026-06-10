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

const MARKET_MAP_LIMIT = 40;

function buildDisclosureMarketMap(limit = MARKET_MAP_LIMIT) {
  const tickers = [];
  const seen = new Set();
  const maxSlots = Math.max(...DISCLOSURE_UNIVERSES.map((universe) => universe.tickers.length));

  for (let slot = 0; slot < maxSlots; slot += 1) {
    for (const universe of DISCLOSURE_UNIVERSES) {
      const ticker = universe.tickers[slot];
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      tickers.push(ticker);
      if (tickers.length >= limit) {
        return {
          id: 'market-map',
          label: 'Market Map',
          description: 'Diversified cross-sector discovery basket drawn from every curated universe',
          tickers,
        };
      }
    }
  }

  return {
    id: 'market-map',
    label: 'Market Map',
    description: 'Diversified cross-sector discovery basket drawn from every curated universe',
    tickers,
  };
}

export const DISCLOSURE_MARKET_MAP = buildDisclosureMarketMap();

export function getDisclosureUniverse(id) {
  if (!id) return null;
  const normalized = String(id).trim().toLowerCase();
  return DISCLOSURE_UNIVERSES.find((universe) => universe.id === normalized) || null;
}

export function getDisclosureMarketMap(limit = MARKET_MAP_LIMIT) {
  return buildDisclosureMarketMap(limit);
}
