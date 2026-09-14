import { packPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
/**
 * Rebuild the public, 100-company demonstration and its literal-value templates.
 * node scripts/generate-portfolio-demo.mjs --refresh
 * Without --refresh, updates hypothetical allocations and templates while preserving SEC evidence.
 * --resume reuses this script's bounded public-data checkpoint after interruption.
 * --retry-failed resumes that checkpoint and retries only failed or unavailable captures.
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
import { validatePortfolioDemoUniverse } from "../src/utils/portfolioDemoUniverse.js";
import { createPortfolioBaseline } from "../src/utils/portfolioChanges.js";
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
const endpoint =
  process.env.PORTFOLIO_DEMO_ENDPOINT ||
  "https://secedgarterminal.com/api/v1/portfolio-research";
const universe = validatePortfolioDemoUniverse(
  JSON.parse(
    await fs.readFile(
      path.join(output, "portfolio-demo-100-universe.json"),
      "utf8",
    ),
  ),
);
const tickers = universe.companies.map((company) => company.ticker);
const identities = new Map(
  universe.companies.map((company) => [company.ticker, company]),
);
const input = {
  schema_version: "edgar.portfolio.v1",
  name: "S&P 500 coverage portfolio · top 100 companies",
  holdings: hypotheticalDemoHoldings(tickers).map((holding) => ({
    ...holding,
    cik: identities.get(holding.ticker).cik,
  })),
  allocation: { basis: "weights", normalize: false },
  research: { basis: "annual" },
};
if (tickers.length !== 100 || new Set(tickers).size !== 100)
  throw new Error("The demonstration requires exactly 100 unique tickers.");
normalizePortfolioInput(input);

const description = `The 100 largest issuer holdings in the stored S&P 500 coverage list, ranked by combined IVV holding weight as of ${universe.source.asOf}. Share classes are combined by SEC issuer. Portfolio allocations are fixed hypothetical examples, independent of IVV weights; this is a dated research demonstration, not an index portfolio or an investment recommendation.`;
const canonicalTicker = (ticker) => String(ticker || "").replaceAll(".", "-");

function assertResolvedRows(rows) {
  if (!Array.isArray(rows) || rows.length !== tickers.length)
    throw new Error(
      "The resolved rows do not match the canonical 100-company universe.",
    );
  rows.forEach((row, index) => {
    const expected = universe.companies[index];
    if (
      row.input?.ticker !== expected.ticker ||
      row.input?.cik !== expected.cik ||
      row.resolution?.status !== "resolved" ||
      row.resolution.kind !== "company" ||
      row.resolution.cik !== expected.cik ||
      canonicalTicker(row.resolution.ticker) !== canonicalTicker(expected.ticker)
    )
      throw new Error(
        `Resolved identity does not match the canonical universe for ${expected.ticker}.`,
      );
  });
}

function assertCapturedIdentity(company, expected) {
  if (
    company.cik !== expected.cik ||
    canonicalTicker(company.ticker) !== canonicalTicker(expected.ticker)
  )
    throw new Error(
      `Captured identity does not match the canonical universe for ${expected.ticker}.`,
    );
}

function failedCapture(company) {
  return (
    !company ||
    company.status === "failed" ||
    company.cache?.status === "unavailable" ||
    company.refreshStatus === "failed"
  );
}

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

function capturedCompany(company) {
  const capture = { ...company };
  // Classification is rebuilt from the versioned public CIK reference. It can
  // cite fund-provider sources, while saved financial captures remain SEC-only.
  delete capture.companyClassification;
  return capture;
}

function validateCaptureStorage(result) {
  const document = createPortfolio({
    id: "portfolio-demo-100-validation",
    name: input.name,
    rows: result.rows,
    allocation: input.allocation,
    research: input.research,
    snapshot: result.snapshot,
    now: result.captured_at,
  });
  // A saved copy must retain enough room to establish its first comparison.
  // Validate that full workflow without adding a baseline to the public capture.
  document.comparisonBaseline = createPortfolioBaseline(document.snapshot);
  validatePortfolios({
    version: 1,
    portfolios: [document],
    activeId: document.id,
  });
  return document;
}

async function capture() {
  let checkpoint;
  const retryFailed = process.argv.includes("--retry-failed");
  if (process.argv.includes("--resume") || retryFailed) {
    checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
    if (
      checkpoint.universe?.membership_id !== universe.membership_id ||
      checkpoint.universe?.source?.sha256 !== universe.source.sha256 ||
      JSON.stringify(checkpoint.holdings) !== JSON.stringify(input.holdings)
    )
      throw new Error(
        "The checkpoint belongs to a different universe, source or research input.",
      );
    assertResolvedRows(checkpoint.rows);
    if (!Array.isArray(checkpoint.companies) || !Array.isArray(checkpoint.requests))
      throw new Error("The capture checkpoint is incomplete.");
    for (const company of checkpoint.companies) {
      const expected = universe.companies.find(
        (candidate) => candidate.cik === company.cik,
      );
      if (!expected)
        throw new Error(
          "The checkpoint contains an issuer outside the canonical universe.",
        );
      assertCapturedIdentity(company, expected);
    }
  } else {
    const resolved = await request({ ...input, action: "resolve" });
    assertResolvedRows(resolved.rows);
    if (new Set(resolved.rows.map((row) => row.resolution.cik)).size !== 100)
      throw new Error(
        "The demonstration contains duplicate issuer share classes.",
      );
    checkpoint = {
      universe,
      holdings: input.holdings,
      startedAt: new Date().toISOString(),
      rows: resolved.rows,
      companies: [],
      requests: [],
    };
  }
  for (let offset = 0; offset < checkpoint.rows.length; offset += 5) {
    const rows = checkpoint.rows.slice(offset, offset + 5).filter((row) => {
      const company = checkpoint.companies.find(
        (item) => item.cik === row.resolution.cik,
      );
      return !company || (retryFailed && failedCapture(company));
    });
    if (!rows.length) continue;
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
    if (response?.companies) {
      if (!Array.isArray(response.companies))
        throw new Error("The research response contains an invalid company list.");
      const returned = new Set();
      for (const company of response.companies) {
        const expected = holdings.find(
          (holding) => holding.cik === company.cik,
        );
        if (!expected || returned.has(company.cik))
          throw new Error(
            "The research response contains an unexpected or duplicate issuer.",
          );
        assertCapturedIdentity(company, expected);
        returned.add(company.cik);
      }
    }
    for (const row of rows) {
      const company = response?.companies?.find(
        (item) => item.cik === row.resolution.cik,
      );
      const result = company
        ? {
            ...capturedCompany(company),
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
      `Captured ${checkpoint.companies.length}/100: ${holdings.map((item) => item.ticker).join(", ")}`,
    );
  }
  const companies = checkpoint.rows.map((row) =>
    capturedCompany(
      checkpoint.companies.find(
        (company) => company.cik === row.resolution.cik,
      ),
    ),
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
    description,
    universe,
    capture_started_at: checkpoint.startedAt,
    captured_at: capturedAt,
    input,
    rows: checkpoint.rows,
    snapshot,
    coverage,
    allocation_example: {
      kind: "hypothetical",
      methodology: DEMO_ALLOCATION_METHOD,
    },
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
  const document = validateCaptureStorage(result);
  const encodedResult = {
    ...result,
    snapshot: packPortfolioSnapshot(snapshot),
  };
  validatePortfolioDemo(encodedResult);
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
          [input.name],
          [
            "Start",
            "Upload this workbook in Research Hub → Portfolio research. The Holdings sheet contains 100 company tickers, their verified SEC CIKs and hypothetical weight_pct values totaling 100%. Select Weighted portfolio — supplied weight_pct in Allocation settings after import.",
          ],
          [
            "Expected result",
            "Explore weighted issuer and industry concentration, evidence coverage, scenarios, company metrics and SEC filing sources. Open https://secedgarterminal.com/workspace/demo to compare the example with equal weights or company counts.",
          ],
          [
            "Scope",
            description,
          ],
          ["Coverage membership", universe.membership_id],
          [
            "Membership source",
            `IVV holdings as of ${universe.source.asOf}; ${universe.source.url}`,
          ],
          ["Company selection", universe.selection.description],
          ["Hypothetical weights", DEMO_ALLOCATION_METHOD],
          [
            "Weight units",
            "weight_pct uses percentage points: 5 means 5%, and 0.3 means 0.3%. These are literal hypothetical allocations, not the IVV weights used to select companies. Other than ticker, CIK and weight_pct, the input fields are blank. Clear the weights to use company counts.",
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
    existing.universe?.membership_id !== universe.membership_id ||
    existing.universe?.source?.sha256 !== universe.source.sha256 ||
    JSON.stringify(existing.input.holdings.map((holding) => holding.ticker)) !==
    JSON.stringify(tickers) ||
    existing.input.holdings.some(
      (holding, index) => holding.cik !== universe.companies[index].cik,
    )
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
    description,
    universe,
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
  const validated = validatePortfolioDemo(updated);
  validateCaptureStorage(validated);
  await fs.writeFile(resultPath, `${JSON.stringify(updated)}\n`);
}

if (
  process.argv.includes("--refresh") ||
  process.argv.includes("--resume") ||
  process.argv.includes("--retry-failed")
)
  await capture();
await updateAllocationExample();
await writeTemplates();
