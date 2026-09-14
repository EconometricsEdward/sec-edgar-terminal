/** Fixed educational inputs, independent of prices, filings, or investment views. */
export const DEMO_ALLOCATION_TIERS = Object.freeze([
  { count: 5, weightPct: 5 },
  { count: 15, weightPct: 2 },
  { count: 30, weightPct: 1 },
  { count: 50, weightPct: 0.3 },
]);

export const DEMO_ALLOCATION_METHOD =
  "Fixed hypothetical weights by demo order: the first 5 companies receive 5% each, the next 15 receive 2%, the next 30 receive 1%, and the remaining 50 receive 0.3%, totaling 100%. These educational amounts are fixed independently of source fund weights, prices and company fundamentals. They are not actual holdings, index weights or investment recommendations.";

export function hypotheticalDemoHoldings(tickers) {
  if (!Array.isArray(tickers) || tickers.length !== 100 || new Set(tickers).size !== 100
    || tickers.some(ticker => typeof ticker !== "string" || !/^[A-Z][A-Z0-9.-]*$/.test(ticker)))
    throw new Error("The hypothetical allocation requires 100 unique company tickers.");
  const weights = DEMO_ALLOCATION_TIERS.flatMap(tier => Array(tier.count).fill(tier.weightPct));
  return tickers.map((ticker, index) => ({ ticker, weight_pct: weights[index] }));
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
