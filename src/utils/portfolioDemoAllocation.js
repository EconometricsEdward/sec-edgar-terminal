/** Fixed educational inputs, independent of prices, filings, or investment views. */
export const DEMO_ALLOCATION_TIERS = [
  { weightPct: 5, tickers: ["AAPL", "MSFT", "JPM", "JNJ", "XOM"] },
  {
    weightPct: 2,
    tickers: [
      "AMZN",
      "GOOGL",
      "NVDA",
      "META",
      "COST",
      "WMT",
      "BAC",
      "CAT",
      "GE",
      "CVX",
      "NEE",
      "LIN",
      "PLD",
      "UNH",
      "PG",
    ],
  },
  {
    weightPct: 1,
    tickers: [
      "ORCL",
      "ADBE",
      "CRM",
      "TSLA",
      "HD",
      "LOW",
      "KO",
      "PEP",
      "MDLZ",
      "WFC",
      "C",
      "GS",
      "LLY",
      "MRK",
      "ABBV",
      "DE",
      "HON",
      "RTX",
      "COP",
      "EOG",
      "SLB",
      "DUK",
      "SO",
      "AEP",
      "NFLX",
      "DIS",
      "CMCSA",
      "APD",
      "SHW",
      "AMT",
    ],
  },
];

export const DEMO_ALLOCATION_METHOD =
  "Fixed hypothetical weights: 5 companies at 5% each, 15 at 2%, 30 at 1%, and 50 at 0.3%, totaling 100%. These educational inputs are not derived from market prices, company fundamentals, an index, or actual holdings and are not investment recommendations.";

export function hypotheticalDemoHoldings(tickers) {
  const assigned = new Map(
    DEMO_ALLOCATION_TIERS.flatMap((tier) =>
      tier.tickers.map((ticker) => [ticker, tier.weightPct]),
    ),
  );
  if (
    tickers.length !== 100 ||
    new Set(tickers).size !== 100 ||
    [...assigned.keys()].some((ticker) => !tickers.includes(ticker))
  )
    throw new Error(
      "The hypothetical allocation requires the complete 100-company demo.",
    );
  return tickers.map((ticker) => ({
    ticker,
    weight_pct: assigned.get(ticker) ?? 0.3,
  }));
}

/** A view choice changes allocation assumptions without altering captured SEC evidence. */
export function demoAllocationSettings(demo, basis = "example") {
  if (!["example", "equal", "none"].includes(basis))
    throw new Error(
      "Choose example weights, equal weights, or company counts.",
    );
  return {
    basis: basis === "example" ? demo.input.allocation.basis : basis,
    normalize: false,
  };
}
