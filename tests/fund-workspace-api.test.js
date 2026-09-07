import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "../src/app/api/fund-workspace/route.js";
import {
  fundWorkspaceMetadata,
  loadWorkspaceFunds,
} from "../src/utils/fundWorkspaceServer.js";

for (const [name, query] of [
  ["unknown modes", "mode=unknown&tickers=VOO"],
  ["more than four funds", "tickers=VOO,VTI,SPY,QQQ,BND"],
  ["malformed tickers", "tickers=VOO,https://example.com"],
  [
    "reports for an unselected fund",
    "tickers=VOO&reports=" +
      encodeURIComponent(JSON.stringify({ VTI: "0000000001-26-000001" })),
  ],
  [
    "invalid accessions",
    "tickers=VOO&reports=" +
      encodeURIComponent(JSON.stringify({ VOO: "latest<script>" })),
  ],
  ["array report maps", "tickers=VOO&reports=[]"],
  ["multiple tickers in changes", "mode=changes&ticker=VOO,VTI"],
  [
    "identical changes reports",
    "mode=changes&ticker=VOO&before=0000000001-26-000001&after=0000000001-26-000001",
  ],
  [
    "blank allocation entries",
    "mode=allocation&tickers=VOO&weights=" +
      encodeURIComponent(JSON.stringify({ VOO: "" })),
  ],
  [
    "non-100-percent allocation totals",
    "mode=allocation&tickers=VOO,VTI&weights=" +
      encodeURIComponent(JSON.stringify({ VOO: "60", VTI: "50" })),
  ],
])
  test(`fund workspace rejects ${name} before contacting SEC`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("Unexpected network request");
    };
    try {
      const response = await GET(
        new Request(`https://secedgarterminal.com/api/fund-workspace?${query}`),
      );
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(typeof (await response.json()).error, "string");
    } finally {
      globalThis.fetch = original;
    }
  });
test("workspace metadata excludes full holdings while retaining report identity and complete portfolio summaries", () => {
  const metadata = fundWorkspaceMetadata({
    ticker: "VOO",
    holdings: [{ name: "one" }],
    accession: "0000000001-26-000001",
    reports: [{ accession: "0000000001-26-000001" }],
    summary: { count: 10000 },
    fundInfo: { netAssets: 100 },
  });
  assert.equal("holdings" in metadata, false);
  assert.equal(metadata.summary.count, 10000);
  assert.equal(metadata.reports.length, 1);
  assert.equal(metadata.complete, true);
});

test("partial loads retain successful complete portfolios and never replace a failed selected accession with latest", async () => {
  const calls = [],
    reports = { AAA: "0000000001-26-000001", BAD: "0000000001-26-000002" };
  const result = await loadWorkspaceFunds(["AAA", "BAD", "CCC"], reports, {
    loader: async (ticker, accession) => {
      calls.push({ ticker, accession });
      if (ticker === "BAD")
        throw new Error("Requested historical report unavailable");
      return {
        ticker,
        status: "ready",
        holdings: Array.from({ length: 123 }, (_, i) => ({ id: i })),
        accession: accession || "0000000001-26-000003",
      };
    },
  });
  assert.deepEqual(
    result.portfolios.map((p) => p.ticker),
    ["AAA", "CCC"],
  );
  assert.equal(result.portfolios[0].holdings.length, 123);
  assert.equal(result.portfolios[0].complete, true);
  assert.deepEqual(result.errors, [
    { ticker: "BAD", message: "Requested historical report unavailable" },
  ]);
  assert.deepEqual(
    calls.filter((call) => call.ticker === "BAD"),
    [{ ticker: "BAD", accession: reports.BAD }],
  );
});
test("full portfolio requests use no more than two concurrent loader calls", async () => {
  let active = 0,
    maxActive = 0;
  const result = await loadWorkspaceFunds(
    ["AAA", "BBB", "CCC", "DDD"],
    {},
    {
      loader: async (ticker) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { ticker, status: "ready", holdings: [] };
      },
    },
  );
  assert.equal(maxActive, 2);
  assert.equal(result.portfolios.length, 4);
});
test("a timed-out report is unavailable without discarding another successfully loaded fund", async () => {
  const result = await loadWorkspaceFunds(
    ["SLOW", "OK"],
    {},
    {
      timeoutMs: 5,
      loader: async (ticker) =>
        ticker === "SLOW"
          ? new Promise(() => {})
          : { ticker, status: "ready", holdings: [] },
    },
  );
  assert.equal(result.portfolios[0].ticker, "OK");
  assert.equal(result.errors[0].ticker, "SLOW");
  assert.match(result.errors[0].message, /timed out/);
});
