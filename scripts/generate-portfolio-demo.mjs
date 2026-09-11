import { packPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
/**
 * Rebuild the public, 100-company demonstration and its literal-value templates.
 * node scripts/generate-portfolio-demo.mjs --refresh
 * Without --refresh, updates hypothetical allocations and templates while preserving SEC evidence.
 * --resume reuses this script's bounded public-data checkpoint after interruption.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PORTFOLIO_COLUMNS,
  allocationSummary,
  normalizePortfolioInput,
} from "../src/utils/portfolioModel.js";
import { createXlsxWorkbook, csvString } from "../src/utils/portfolioFiles.js";
import {
  createPortfolio,
  validatePortfolios,
} from "../src/utils/portfolioStorage.js";
import { validatePortfolioDemo } from "../src/utils/portfolioDemo.js";
import {
  hypotheticalDemoHoldings,
  DEMO_ALLOCATION_METHOD,
} from "../src/utils/portfolioDemoAllocation.js";

const output = fileURLToPath(new URL("../public/portfolio/", import.meta.url));
const resultPath = path.join(output, "portfolio-demo-100-results.json");
const checkpointPath = path.join(
  os.tmpdir(),
  "edgar-portfolio-demo-100-capture.json",
);
const endpoint = "https://secedgarterminal.com/api/v1/portfolio-research";
const tickers = [
  "AAPL",
  "MSFT",
  "NVDA",
  "ORCL",
  "ADBE",
  "CRM",
  "AMD",
  "INTC",
  "CSCO",
  "IBM",
  "AMZN",
  "TSLA",
  "HD",
  "LOW",
  "NKE",
  "MCD",
  "SBUX",
  "TGT",
  "TJX",
  "BKNG",
  "WMT",
  "COST",
  "PG",
  "KO",
  "PEP",
  "MDLZ",
  "CL",
  "KMB",
  "GIS",
  "KHC",
  "JPM",
  "BAC",
  "WFC",
  "C",
  "GS",
  "MS",
  "AXP",
  "SCHW",
  "USB",
  "PNC",
  "UNH",
  "JNJ",
  "LLY",
  "MRK",
  "ABBV",
  "ABT",
  "TMO",
  "DHR",
  "AMGN",
  "GILD",
  "CAT",
  "DE",
  "GE",
  "HON",
  "UPS",
  "FDX",
  "RTX",
  "LMT",
  "NOC",
  "GD",
  "XOM",
  "CVX",
  "COP",
  "EOG",
  "SLB",
  "OXY",
  "PSX",
  "VLO",
  "MPC",
  "KMI",
  "NEE",
  "DUK",
  "SO",
  "AEP",
  "EXC",
  "SRE",
  "XEL",
  "WEC",
  "ED",
  "D",
  "GOOGL",
  "META",
  "NFLX",
  "DIS",
  "CMCSA",
  "VZ",
  "T",
  "CHTR",
  "TTWO",
  "WBD",
  "LIN",
  "APD",
  "SHW",
  "FCX",
  "NEM",
  "NUE",
  "PLD",
  "AMT",
  "SPG",
  "O",
];
const input = {
  schema_version: "edgar.portfolio.v1",
  name: "Hypothetical weighted portfolio · 100-company demo",
  holdings: hypotheticalDemoHoldings(tickers),
  allocation: { basis: "weights", normalize: false },
  research: { basis: "annual" },
};
if (tickers.length !== 100 || new Set(tickers).size !== 100)
  throw new Error("The demonstration requires exactly 100 unique tickers.");
normalizePortfolioInput(input);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(payload) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(115000),
      });
      const result = await response.json();
      if (response.ok) return result;
      if (response.status !== 429 && response.status < 500)
        throw Object.assign(
          new Error(result.error || `HTTP ${response.status}`),
          { terminal: true },
        );
      if (attempt === 2)
        throw new Error(result.error || `HTTP ${response.status}`);
      const retryHeader = response.headers.get("retry-after");
      const retryAfter =
        retryHeader && /^\d+$/.test(retryHeader)
          ? Number(retryHeader) * 1000
          : retryHeader
            ? Date.parse(retryHeader) - Date.now()
            : NaN;
      let remaining =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : 2000 * (attempt + 1);
      console.log(
        `Provider requested a ${Math.ceil(remaining / 1000)} second pause; completed capture batches are retained.`,
      );
      while (remaining > 0) {
        const delay = Math.min(30000, remaining);
        await pause(delay);
        remaining -= delay;
      }
    } catch (error) {
      if (error.terminal || attempt === 2) throw error;
      await pause(2000 * (attempt + 1));
    }
  }
  throw new Error("The public research request could not be completed.");
}

function failedCompany(row, message) {
  return {
    cik: row.resolution.cik,
    ticker: row.resolution.ticker,
    name: row.resolution.name,
    status: "failed",
    kind: "company",
    period: null,
    metrics: {},
    filings: [],
    retrievedAt: null,
    cache: { status: "unavailable", storedAt: null },
    refreshStatus: "failed",
    warnings: [message],
  };
}

async function capture() {
  let checkpoint;
  if (process.argv.includes("--resume")) {
    checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
    if (JSON.stringify(checkpoint.tickers) !== JSON.stringify(tickers))
      throw new Error("The checkpoint belongs to a different research input.");
  } else {
    const resolved = await request({ ...input, action: "resolve" });
    if (
      resolved.rows?.length !== 100 ||
      resolved.rows.some(
        (row) =>
          row.resolution.status !== "resolved" ||
          row.resolution.kind !== "company",
      )
    )
      throw new Error(
        `Every demonstration ticker must resolve to an operating company. Review: ${JSON.stringify(resolved.rows?.filter((row) => row.resolution.status !== "resolved" || row.resolution.kind !== "company").map((row) => ({ ticker: row.input.ticker, resolution: row.resolution })))}`,
      );
    if (new Set(resolved.rows.map((row) => row.resolution.cik)).size !== 100)
      throw new Error(
        "The demonstration contains duplicate issuer share classes.",
      );
    checkpoint = {
      tickers,
      startedAt: new Date().toISOString(),
      rows: resolved.rows,
      companies: [],
      requests: [],
    };
  }
  for (let offset = 0; offset < checkpoint.rows.length; offset += 5) {
    const rows = checkpoint.rows.slice(offset, offset + 5);
    if (
      rows.every((row) =>
        checkpoint.companies.some(
          (company) => company.cik === row.resolution.cik,
        ),
      )
    )
      continue;
    const holdings = rows.map((row) => ({
      ticker: row.resolution.ticker,
      cik: row.resolution.cik,
    }));
    const startedAt = new Date().toISOString();
    let response;
    let errorMessage;
    try {
      response = await request({
        schema_version: input.schema_version,
        action: "research",
        holdings,
        allocation: input.allocation,
        research: input.research,
      });
    } catch (error) {
      errorMessage = error.message;
    }
    for (const row of rows) {
      const company = response?.companies?.find(
        (item) => item.cik === row.resolution.cik,
      );
      const result = company
        ? {
            ...company,
            refreshStatus:
              company.status === "failed" ||
              company.cache?.status === "unavailable"
                ? "failed"
                : company.cache?.status === "stale"
                  ? "stale"
                  : "checked",
          }
        : failedCompany(
            row,
            errorMessage ||
              "The API response omitted this issuer. No financial values were invented.",
          );
      checkpoint.companies = checkpoint.companies.filter(
        (item) => item.cik !== result.cik,
      );
      checkpoint.companies.push(result);
    }
    checkpoint.requests.push({
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      generated_at: response?.generated_at || null,
      tickers: holdings.map((item) => item.ticker),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint));
    console.log(
      `Captured ${Math.min(offset + 5, 100)}/100: ${holdings.map((item) => item.ticker).join(", ")}`,
    );
  }
  const companies = checkpoint.rows.map((row) =>
    checkpoint.companies.find((company) => company.cik === row.resolution.cik),
  );
  const capturedAt = new Date().toISOString();
  const snapshot = {
    schema_version: input.schema_version,
    generated_at: capturedAt,
    basis: "annual",
    companies,
  };
  const allocation = allocationSummary(
    checkpoint.rows,
    input.allocation,
    Object.fromEntries(companies.map((company) => [company.cik, company])),
  );
  const reportingEnds = [
    ...new Set(companies.map((company) => company.period?.end).filter(Boolean)),
  ].sort();
  const coverage = {
    inputRows: checkpoint.rows.length,
    resolvedRows: checkpoint.rows.length,
    uniqueIssuers: companies.length,
    researchedIssuers: companies.length,
    ready: companies.filter((company) => company.status === "ready").length,
    partial: companies.filter((company) => company.status === "partial").length,
    failed: companies.filter((company) => company.status === "failed").length,
    unsupported: companies.filter((company) => company.status === "unsupported")
      .length,
    staleCached: companies.filter(
      (company) => company.cache?.status === "stale",
    ).length,
    financialEvidence: allocation.coverage.availableCompanies,
    financialEvidencePct: allocation.coverage.companyPct,
    filingCount: companies.reduce(
      (total, company) => total + (company.filings?.length || 0),
      0,
    ),
    reportingEnds,
    mismatchedPeriods: reportingEnds.length > 1,
    filingScope:
      "Recent SEC submissions only; up to 30 relevant filings per issuer. No archived submission files are scanned.",
  };
  const result = {
    schema_version: "edgar.portfolio.demo.v1",
    title: input.name,
    description:
      "A format and research-workflow demonstration using 100 identifiable operating companies across industries. This selected list is not an index, a representative market sample, an investment recommendation or an actual portfolio.",
    capture_started_at: checkpoint.startedAt,
    captured_at: capturedAt,
    input,
    rows: checkpoint.rows,
    snapshot,
    coverage,
    methodology: {
      source:
        "SEC EDGAR public company submissions and XBRL company facts, retrieved through the same Portfolio Research API used by the workspace.",
      captureEndpoint: endpoint,
      basis:
        "Annual reporting basis; company fiscal periods may differ. Missing values remain unavailable, and financial-sector companies use the applicable analysis lens.",
      allocation: DEMO_ALLOCATION_METHOD,
      freshness:
        "A captured example, not a live feed. Each company and metric retains its retrieval date, reporting period, source filings and calculation provenance. Refresh a local copy to request newer evidence.",
      requests: checkpoint.requests,
    },
  };
  const document = createPortfolio({
    id: "portfolio-demo-100-validation",
    name: input.name,
    rows: result.rows,
    allocation: input.allocation,
    research: input.research,
    snapshot,
    now: capturedAt,
  });
  validatePortfolios({
    version: 1,
    portfolios: [document],
    activeId: document.id,
  });
  const encodedResult = {
    ...result,
    snapshot: packPortfolioSnapshot(snapshot),
  };
  await fs.writeFile(resultPath, `${JSON.stringify(encodedResult)}\n`);
  console.log(
    JSON.stringify({
      coverage,
      assetBytes: Buffer.byteLength(JSON.stringify(encodedResult)),
      documentBytes: Buffer.byteLength(JSON.stringify(document)),
    }),
  );
}

async function writeTemplates() {
  await fs.mkdir(output, { recursive: true });
  const rows = [
    PORTFOLIO_COLUMNS,
    ...input.holdings.map((holding) =>
      PORTFOLIO_COLUMNS.map((column) => holding[column] || ""),
    ),
  ];
  await fs.writeFile(
    path.join(output, "portfolio-demo-100.csv"),
    csvString(rows).replace(/\r\n/g, "\n"),
  );
  await fs.writeFile(
    path.join(output, "portfolio-demo-100.json"),
    `${JSON.stringify(input, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(output, "portfolio-demo-100.xlsx"),
    createXlsxWorkbook([
      { name: "Holdings", rows },
      {
        name: "Instructions",
        rows: [
          ["Hypothetical weighted portfolio · 100-company demo"],
          [
            "Start",
            "Upload this workbook in Research Hub → Portfolio research. The Holdings sheet contains 100 company tickers and hypothetical weight_pct values totaling 100%. Select Weighted portfolio — supplied weight_pct in Allocation settings after import.",
          ],
          [
            "Expected result",
            "Explore weighted issuer and industry concentration, evidence coverage, scenarios, company metrics and SEC filing sources. Open https://secedgarterminal.com/workspace/demo to compare the example with equal weights or company counts.",
          ],
          [
            "Scope",
            "This is a selected demonstration list, not an index, a representative market sample, actual holdings or an investment recommendation.",
          ],
          ["Hypothetical weights", DEMO_ALLOCATION_METHOD],
          [
            "Weight units",
            "weight_pct uses percentage points: 5 means 5%, and 0.3 means 0.3%. These are literal values. The remaining input fields are blank. Clear the weights to use your own company research list.",
          ],
          [
            "Dates",
            "The example analysis is a dated capture. Running research retrieves current available public evidence; results and coverage may differ.",
          ],
          [
            "Limits",
            "The import supports at most 100 rows. Replace existing tickers before adding more. Cells contain literal values, with no formulas or macros.",
          ],
          [
            "Privacy",
            "Imported notes remain in your browser. Interactive research sends company identifiers, not private allocations or notes.",
          ],
        ],
      },
    ]),
  );
  console.log(
    "Wrote matching CSV, XLSX and JSON templates with 100 hypothetical weights totaling 100%.",
  );
}

async function updateAllocationExample() {
  const existing = JSON.parse(await fs.readFile(resultPath, "utf8"));
  if (
    JSON.stringify(existing.input.holdings.map((holding) => holding.ticker)) !==
    JSON.stringify(tickers)
  )
    throw new Error(
      "The financial capture belongs to a different company list. Refresh it before changing demo allocations.",
    );
  const weights = new Map(
    input.holdings.map((holding) => [holding.ticker, holding.weight_pct]),
  );
  const updated = {
    ...existing,
    title: input.name,
    description:
      "A hypothetical 100-company portfolio with fixed illustrative weights and captured public SEC evidence. The allocations are educational inputs, not actual holdings, an index, or investment recommendations. Financial values and evidence dates are preserved independently of the weights.",
    input,
    rows: existing.rows.map((row) => ({
      ...row,
      input: { ...row.input, weight_pct: weights.get(row.input.ticker) },
    })),
    allocation_example: {
      kind: "hypothetical",
      methodology: DEMO_ALLOCATION_METHOD,
    },
    methodology: {
      ...existing.methodology,
      allocation: DEMO_ALLOCATION_METHOD,
    },
  };
  validatePortfolioDemo(updated);
  await fs.writeFile(resultPath, `${JSON.stringify(updated)}\n`);
}

if (process.argv.includes("--refresh") || process.argv.includes("--resume"))
  await capture();
await updateAllocationExample();
await writeTemplates();
