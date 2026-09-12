import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisDisclosureHandoff,
  analysisMetricGuide,
} from "../src/utils/analysisMetricGuide.js";
import { parseDisclosureQuery } from "../src/utils/disclosureQuery.js";

test("guides use model-specific denominator and bank scope, not a generic risk label", () => {
  const loans = analysisMetricGuide(
    { key: "loanDeposits" },
    { value: 55 },
    "banking",
  );
  assert.equal(loans.known, true);
  assert.match(loans.meaning, /net loans/);
  assert.match(loans.caution, /not a regulatory liquidity ratio/);
  const provision = analysisMetricGuide(
    { key: "provisionLoans" },
    { value: 1 },
    "banking",
  );
  assert.match(provision.caution, /ending net loans, not average gross loans/);
  assert.match(provision.caution, /not a default probability/);
  assert.equal(
    analysisMetricGuide({ key: "currentRatio" }, { value: 1 }, "banking").known,
    false,
  );
  assert.equal(
    analysisMetricGuide({ key: "bankRevenue" }, { value: 1 }, "corporate")
      .known,
    false,
  );
});

test("insurance and EPS guidance preserve accounting distinctions", () => {
  assert.match(
    analysisMetricGuide({ key: "premiumsEarned" }, { value: 1 }, "insurance")
      .caution,
    /premiums written/,
  );
  assert.equal(
    analysisMetricGuide({ key: "premiumsEarned" }, { value: 1 }, "corporate")
      .known,
    false,
  );
  assert.match(
    analysisMetricGuide({ key: "epsDiluted" }, { value: 1 }).caution,
    /need not equal consolidated net income/,
  );
  assert.match(
    analysisMetricGuide({ key: "sharesDiluted" }, { value: 1 }).caution,
    /not the number of shares outstanding at period end/,
  );
});

test("opening-balance guides distinguish the observation date from the filing year", () => {
  for (const key of [
    "openingReceivables",
    "openingInventory",
    "openingAccountsPayable",
  ]) {
    const item = analysisMetricGuide({ key }, { value: 94_363_000_000 });
    assert.equal(item.known, true, key);
    assert.match(
      item.meaning,
      /day before the selected reporting period starts/,
      key,
    );
    assert.match(item.caution, /later filing.*comparative column/, key);
    assert.match(item.caution, /balance date, not the filing year/, key);
    assert.equal(
      analysisMetricGuide({ key }, { value: 1 }, "banking").known,
      false,
      `${key} is only generated for operating companies`,
    );
  }
});

test("average-balance guides explain both endpoints rather than a daily or closing-only average", () => {
  for (const [key, balance] of [
    ["averageAssets", "assets"],
    ["averageEquity", "equity"],
  ]) {
    for (const lens of ["corporate", "banking"]) {
      const item = analysisMetricGuide({ key }, { value: 100 }, lens);
      assert.equal(item.known, true, `${key}/${lens}`);
      assert.ok(
        item.meaning.includes(`(opening ${balance} + closing ${balance}) / 2`),
        key,
      );
      assert.match(item.movement, /day before.*closing balance.*end/, key);
      assert.match(item.caution, /Both reported balances are required/, key);
      assert.match(
        item.caution,
        /not a daily average or a single closing balance/,
        key,
      );
    }
  }
});

test("synthetic, unknown, and inherited-object keys receive honest generic methodology", () => {
  for (const key of [
    "revenue:index",
    "customFormula",
    "__proto__",
    "constructor",
    "newMetric",
  ]) {
    const item = analysisMetricGuide({ key }, { value: 100 });
    assert.equal(item.known, false);
    assert.match(item.caution, /No metric-specific interpretation/);
  }
  assert.equal(
    analysisMetricGuide({ key: "revenue", format: "index" }, { value: 100 })
      .known,
    false,
  );
});

test("common-size observations explain the displayed denominator rather than treating the number as currency", () => {
  const item = analysisMetricGuide(
    { key: "netIncome", format: "percent", category: "income" },
    { value: 12, formula: "Net Income / Revenue × 100" },
  );
  assert.match(item.meaning, /common-size percentage/);
  assert.match(item.meaning, /Underlying measure: Profit or loss/);
  assert.doesNotMatch(
    analysisMetricGuide(
      { key: "netMargin", format: "percent", category: "ratios" },
      { value: 12 },
    ).meaning,
    /common-size/,
  );
});

test("actual recursively nested source concepts add context without inventing values", () => {
  const point = {
    value: null,
    sources: [
      {
        inputSources: [
          { tag: "ProfitLoss" },
          {
            tag: "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
          },
          { tag: "CashAndDueFromBanks" },
        ],
      },
    ],
  };
  const item = analysisMetricGuide({ key: "cash" }, point, "banking");
  assert.equal(item.scopeNotes.length, 4);
  assert.ok(item.scopeNotes.some((note) => /noncontrolling/.test(note)));
  assert.ok(item.scopeNotes.some((note) => /restricted cash/.test(note)));
  assert.ok(item.scopeNotes.some((note) => /CashAndDueFromBanks/.test(note)));
  assert.ok(
    item.scopeNotes.some((note) => /observation is unavailable/.test(note)),
  );
  assert.deepEqual(
    analysisMetricGuide({ key: "cash" }, { value: 0 }).scopeNotes,
    [],
  );
});

test("disclosure handoff preserves the requested ticker including share classes and exact query", () => {
  const query = '(liquidity OR covenant) AND "credit losses"';
  for (const ticker of ["JPM", "brk.b", "BRK-B"]) {
    const url = new URL(
      analysisDisclosureHandoff({
        ticker,
        cik: "0000000001",
        query,
        section: "notes",
      }),
      "https://secedgarterminal.com",
    );
    assert.equal(url.pathname, "/disclosures");
    assert.equal(url.searchParams.get("tickers"), ticker.toUpperCase());
    assert.equal(url.searchParams.get("mode"), "companies");
    assert.equal(url.searchParams.get("query"), query);
    assert.equal(url.searchParams.get("section"), "notes");
    assert.equal(url.searchParams.get("forms"), "10-K,10-Q");
    assert.equal(url.searchParams.has("end"), false);
  }
});

test("handoff never broadens an invalid company target into an index search", () => {
  for (const ticker of [
    "JPM,AMJB",
    "JPM&tickers=AMJB",
    "https://bad.test",
    "",
    undefined,
  ]) {
    assert.equal(
      analysisDisclosureHandoff({ ticker, query: "liquidity" }),
      null,
    );
  }
  const url = new URL(
    analysisDisclosureHandoff({
      ticker: "",
      cik: "0000019617",
      query: "liquidity",
      section: "injected",
    }),
    "https://secedgarterminal.com",
  );
  assert.equal(url.searchParams.get("tickers"), "0000019617");
  assert.equal(url.searchParams.get("section"), "all");
  assert.equal(analysisDisclosureHandoff({ ticker: "JPM", query: " " }), null);
});

test("historical filing cutoffs carry a matching historical search window and reject invalid dates", () => {
  const url = new URL(
    analysisDisclosureHandoff({
      ticker: "JPM",
      query: "liquidity",
      asOf: "2018-02-28",
    }),
    "https://secedgarterminal.com",
  );
  assert.equal(url.searchParams.get("end"), "2018-02-28");
  assert.equal(url.searchParams.get("start"), "2013-01-01");
  for (const asOf of ["2025-02-30", "2025-13-01", "yesterday"]) {
    const invalid = new URL(
      analysisDisclosureHandoff({ ticker: "JPM", query: "liquidity", asOf }),
      "https://secedgarterminal.com",
    );
    assert.equal(invalid.searchParams.has("end"), false);
  }
});

test("every educational topic tested produces a supported disclosure expression", () => {
  const keys = [
    "revenue",
    "grossProfit",
    "operatingIncome",
    "netIncome",
    "pretaxIncome",
    "incomeTax",
    "epsDiluted",
    "epsBasic",
    "sharesDiluted",
    "operatingCashFlow",
    "freeCashFlow",
    "cashConversion",
    "cashAdjustments",
    "cash",
    "currentRatio",
    "stockholdersEquity",
    "totalAssets",
    "openingReceivables",
    "openingInventory",
    "openingAccountsPayable",
    "averageAssets",
    "averageEquity",
    "equityAssets",
    "roe",
    "roa",
    "debtAssets",
    "bankRevenue",
    "netInterestIncome",
    "deposits",
    "loans",
    "loanDeposits",
    "allowanceForLoanLoss",
    "allowanceLoans",
    "provisionForLoanLoss",
    "provisionLoans",
    "efficiency",
    "premiumsEarned",
    "investmentIncome",
    "grossMargin",
    "operatingMargin",
    "netMargin",
    "bankNetMargin",
    "unknown",
  ];
  for (const key of keys) {
    for (const lens of ["corporate", "banking", "insurance"]) {
      const item = analysisMetricGuide({ key }, { value: 1 }, lens);
      assert.doesNotThrow(
        () => parseDisclosureQuery(item.query),
        `${key}/${lens}`,
      );
      assert.ok(item.meaning && item.movement && item.caution);
    }
  }
});
