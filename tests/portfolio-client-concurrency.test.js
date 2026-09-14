import test from "node:test";
import assert from "node:assert/strict";
import {
  PORTFOLIO_CLIENT_BATCH_SIZE,
  PORTFOLIO_CLIENT_CONCURRENCY,
  researchPortfolioRows,
} from "../src/utils/portfolioClient.js";

function row(index) {
  return {
    id: `r${index}`,
    input: { ticker: `T${index}` },
    resolution: {
      status: "resolved",
      kind: "company",
      ticker: `T${index}`,
      cik: String(index).padStart(10, "0"),
    },
  };
}

test("large portfolio refreshes use bounded parallel batches", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const rows = Array.from({ length: 20 }, (_, index) => row(index + 1));
  const result = await researchPortfolioRows(rows, {
    fetcher: async (_url, options) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const holdings = JSON.parse(options.body).holdings;
      assert.equal(holdings.length, PORTFOLIO_CLIENT_BATCH_SIZE);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return {
        ok: true,
        json: async () => ({
          companies: holdings.map((holding) => ({
            ...holding,
            status: "ready",
            cache: { status: "fresh" },
          })),
        }),
      };
    },
  });
  assert.equal(calls, 4);
  assert.equal(maxInFlight, PORTFOLIO_CLIENT_CONCURRENCY);
  assert.equal(result.completed, 20);
  assert.equal(result.companies.length, 20);
});
