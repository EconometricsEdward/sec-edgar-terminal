/**
 * Pre-defined peer groups for one-click comparisons.
 *
 * These are curated lists that users can select from to instantly populate
 * the Compare page. Designed for high-recognition industries where users
 * commonly want to benchmark against a known peer set.
 *
 * Format:
 *   id:      short slug used internally (URL-safe)
 *   label:   display name shown in UI
 *   icon:    emoji (keeps component tree simple vs importing 10 icons)
 *   tickers: list of tickers. First ticker is used as the anchor/primary.
 *
 * When adding new groups, keep to 3-5 tickers to stay within MAX_COMPANIES.
 */

export const PEER_GROUPS = [
  {
    id: 'big-banks',
    label: 'Big Banks',
    icon: '🏦',
    description: 'Money-center and diversified commercial banks',
    tickers: ['JPM', 'BAC', 'WFC', 'C', 'GS'],
  },
  {
    id: 'regional-banks',
    label: 'Regional Banks',
    icon: '🏛️',
    description: 'Major U.S. regional banking groups',
    tickers: ['USB', 'PNC', 'TFC', 'MTB', 'CFG'],
  },
  {
    id: 'mega-tech',
    label: 'Mega-Cap Tech',
    icon: '💻',
    description: 'Largest U.S. technology companies by market cap',
    tickers: ['AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN'],
  },
  {
    id: 'semiconductors',
    label: 'Semiconductors',
    icon: '🔌',
    description: 'Leading U.S. chip designers and manufacturers',
    tickers: ['NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM'],
  },
  {
    id: 'big-oil',
    label: 'Big Oil',
    icon: '🛢️',
    description: 'Integrated oil & gas super-majors',
    tickers: ['XOM', 'CVX', 'COP', 'EOG'],
  },
  {
    id: 'us-airlines',
    label: 'U.S. Airlines',
    icon: '✈️',
    description: 'The four largest U.S. passenger airlines',
    tickers: ['DAL', 'UAL', 'AAL', 'LUV'],
  },
  {
    id: 'big-pharma',
    label: 'Big Pharma',
    icon: '💊',
    description: 'Major pharmaceutical manufacturers',
    tickers: ['JNJ', 'PFE', 'MRK', 'LLY', 'ABBV'],
  },
  {
    id: 'mega-retail',
    label: 'Mass-Market Retail',
    icon: '🛒',
    description: 'Largest U.S. retailers by revenue',
    tickers: ['WMT', 'TGT', 'COST', 'KR'],
  },
  {
    id: 'streaming',
    label: 'Streaming & Media',
    icon: '📺',
    description: 'Digital media and streaming services',
    tickers: ['NFLX', 'DIS', 'WBD', 'PARA'],
  },
  {
    id: 'ev-autos',
    label: 'Auto & EV',
    icon: '🚗',
    description: 'Traditional and electric vehicle makers',
    tickers: ['TSLA', 'F', 'GM', 'RIVN'],
  },
  {
    id: 'credit-cards',
    label: 'Payments Networks',
    icon: '💳',
    description: 'Card networks and payment processors',
    tickers: ['V', 'MA', 'AXP', 'PYPL'],
  },
  {
    id: 'insurance',
    label: 'Insurance',
    icon: '🛡️',
    description: 'P&C and diversified insurance carriers',
    tickers: ['BRK.B', 'PGR', 'TRV', 'ALL', 'CB'],
  },
];

/**
 * Hard-coded color palette used for per-company line colors across all charts.
 * Chosen to be distinguishable both in light and dark themes and to avoid
 * red/green clash (reserved for gain/loss semantics in tables).
 */
export const COMPANY_COLORS = [
  '#fbbf24', // amber
  '#34d399', // emerald
  '#60a5fa', // blue
  '#c084fc', // violet
  '#fb7185', // rose (used sparingly)
];
