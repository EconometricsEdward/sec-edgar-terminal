import {
  packPortfolioSnapshot,
  unpackPortfolioSnapshot,
} from "./portfolioEvidenceCodec.js";
import { allocationSummary, PORTFOLIO_COLUMNS } from "./portfolioModel.js";
import { isCompletePortfolioCheck } from "./portfolioClient.js";
import { createPortfolio, writePortfolio } from "./portfolioStorage.js";
import { demoAllocationSettings } from "./portfolioDemoAllocation.js";

export const DEMO_INPUT_URL = "/portfolio/portfolio-demo-100.json";
export const DEMO_CSV_URL = "/portfolio/portfolio-demo-100.csv";
export const DEMO_XLSX_URL = "/portfolio/portfolio-demo-100.xlsx";
export const DEMO_RESULTS_URL = "/portfolio/portfolio-demo-100-results.json";
export const DEMO_RESULTS_MAX_BYTES = 4 * 1024 * 1024;

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value) =>
  typeof value === "string" &&
  value.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));
const text = (value, max = 2000) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const canonicalTicker = (value) => String(value || "").replaceAll(".", "-");
function requireValue(condition, message) {
  if (!condition)
    throw new Error(`The example could not be opened. ${message}`);
}

/** Reject unsafe or unbounded JSON before any clone or browser-storage write. */
function inspectDemo(value) {
  let nodes = 0;
  function walk(entry, depth = 0) {
    requireValue(
      ++nodes <= 500000 && depth <= 24,
      "The capture is too large or deeply nested.",
    );
    if (Array.isArray(entry)) {
      requireValue(
        entry.length <= 2000,
        "A capture list exceeds the size limit.",
      );
      entry.forEach((item) => walk(item, depth + 1));
    } else if (object(entry)) {
      requireValue(
        [Object.prototype, null].includes(Object.getPrototypeOf(entry)),
        "The capture contains an unsupported object.",
      );
      for (const [key, item] of Object.entries(entry)) {
        requireValue(
          !["__proto__", "constructor", "prototype"].includes(key),
          "The capture contains an unsafe field.",
        );
        walk(item, depth + 1);
      }
    } else {
      requireValue(
        entry === null ||
          typeof entry === "boolean" ||
          (typeof entry === "number" && Number.isFinite(entry)) ||
          (typeof entry === "string" && entry.length <= 20000),
        "The capture contains an unsupported value.",
      );
    }
  }
  walk(value);
  requireValue(
    new TextEncoder().encode(
      JSON.stringify({
        ...value,
        snapshot: packPortfolioSnapshot(value.snapshot),
      }),
    ).length <= DEMO_RESULTS_MAX_BYTES,
    "The capture exceeds the 4 MiB download limit.",
  );
}

function checkCoverage(demo) {
  const { rows, snapshot, coverage } = demo;
  requireValue(object(coverage), "Coverage information is missing.");
  const byCik = Object.fromEntries(
    snapshot.companies.map((company) => [company.cik, company]),
  );
  const allocation = allocationSummary(
    rows,
    { basis: "none", normalize: false },
    byCik,
  );
  const reportingEnds = [
    ...new Set(
      snapshot.companies.map((company) => company.period?.end).filter(Boolean),
    ),
  ].sort();
  const counts = {
    inputRows: rows.length,
    resolvedRows: rows.filter((row) => row.resolution.status === "resolved")
      .length,
    uniqueIssuers: new Set(
      rows.map((row) => row.resolution.cik).filter(Boolean),
    ).size,
    researchedIssuers: snapshot.companies.length,
    ready: snapshot.companies.filter((company) => company.status === "ready")
      .length,
    partial: snapshot.companies.filter(
      (company) => company.status === "partial",
    ).length,
    failed: snapshot.companies.filter((company) => company.status === "failed")
      .length,
    unsupported: snapshot.companies.filter(
      (company) => company.status === "unsupported",
    ).length,
    staleCached: snapshot.companies.filter(
      (company) =>
        company.cache?.status === "stale" || company.refreshStatus === "stale",
    ).length,
    financialEvidence: allocation.coverage.availableCompanies,
    financialEvidencePct: allocation.coverage.companyPct,
    filingCount: snapshot.companies.reduce(
      (count, company) => count + (company.filings?.length || 0),
      0,
    ),
    mismatchedPeriods: reportingEnds.length > 1,
  };
  for (const [key, expected] of Object.entries(counts)) {
    requireValue(
      coverage[key] === expected,
      `The ${key} coverage does not match the captured results.`,
    );
  }
  requireValue(
    Array.isArray(coverage.reportingEnds) &&
      JSON.stringify(coverage.reportingEnds) === JSON.stringify(reportingEnds),
    "Reporting dates do not match the captured results.",
  );
  requireValue(
    text(coverage.filingScope),
    "The filing coverage scope is missing.",
  );
}

/** Validate a public capture without changing identities, values, or retrieval status. */
export function validatePortfolioDemo(value) {
  inspectDemo(value);
  value = { ...value, snapshot: unpackPortfolioSnapshot(value.snapshot) };
  requireValue(
    object(value) && value.schema_version === "edgar.portfolio.demo.v1",
    "This capture version is not supported.",
  );
  requireValue(
    text(value.title, 200) && text(value.description),
    "The capture description is missing.",
  );
  requireValue(
    timestamp(value.captured_at) &&
      timestamp(value.capture_started_at) &&
      Date.parse(value.capture_started_at) <= Date.parse(value.captured_at),
    "The capture dates are invalid.",
  );
  requireValue(
    object(value.input) &&
      value.input.schema_version === "edgar.portfolio.v1" &&
      Array.isArray(value.input.holdings) &&
      value.input.holdings.length === 100,
    "The example must contain exactly 100 input tickers.",
  );
  const weighted = value.input.allocation?.basis === "weights";
  requireValue(
    ["none", "weights"].includes(value.input.allocation?.basis) &&
      value.input.allocation.normalize === false &&
      value.input.research?.basis === "annual",
    "The example must use annual research with explicit, unnormalized allocation settings.",
  );
  if (weighted)
    requireValue(
      value.allocation_example?.kind === "hypothetical" &&
        text(value.allocation_example.methodology),
      "Example weights must be explicitly identified as hypothetical.",
    );
  const tickers = value.input.holdings.map((holding) => {
    requireValue(
      object(holding) &&
        typeof holding.ticker === "string" &&
        /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(holding.ticker),
      "Every input needs a valid uppercase ticker.",
    );
    requireValue(
      Object.entries(holding).every(
        ([key, cell]) =>
          key === "ticker" ||
          (weighted &&
            key === "weight_pct" &&
            typeof cell === "number" &&
            Number.isFinite(cell) &&
            cell > 0 &&
            cell <= 100) ||
          (PORTFOLIO_COLUMNS.includes(key) && cell === ""),
      ),
      "The example inputs may contain tickers and hypothetical weights, without private writing or other allocations.",
    );
    if (weighted)
      requireValue(
        typeof holding.weight_pct === "number" && holding.weight_pct > 0,
        "Every example company must have a positive hypothetical weight.",
      );
    return holding.ticker;
  });
  if (weighted)
    requireValue(
      Math.abs(
        value.input.holdings.reduce(
          (sum, holding) => sum + holding.weight_pct,
          0,
        ) - 100,
      ) < 1e-8,
      "Hypothetical weights must total 100% without normalization.",
    );
  requireValue(
    new Set(tickers.map(canonicalTicker)).size === 100,
    "The example must contain 100 different tickers.",
  );
  requireValue(
    Array.isArray(value.rows) && value.rows.length === 100,
    "The reviewed rows do not match the 100 input tickers.",
  );
  requireValue(
    object(value.snapshot) &&
      value.snapshot.generated_at === value.captured_at &&
      value.snapshot.basis === "annual",
    "The captured results have an inconsistent date or reporting basis.",
  );

  // Apply the same source URL, row, metric, identity and size rules as saved research.
  createPortfolio({
    id: "portfolio-demo-validation",
    name: value.title,
    rows: value.rows,
    snapshot: value.snapshot,
    now: value.captured_at,
  });
  value.rows.forEach((row, index) => {
    requireValue(
      row.input.ticker === tickers[index] &&
        PORTFOLIO_COLUMNS.every(
          (column) =>
            column === "ticker" ||
            (weighted && column === "weight_pct"
              ? Number(row.input[column]) ===
                value.input.holdings[index].weight_pct
              : row.input[column] === ""),
        ),
      "The reviewed rows do not match the tickers and weights in the download.",
    );
    requireValue(
      !row.excluded &&
        row.duplicateChoice === null &&
        row.mergedInto === undefined &&
        row.originalInput === undefined,
      "The example cannot hide or merge input rows.",
    );
    requireValue(
      row.resolution.status === "resolved" &&
        row.resolution.kind === "company" &&
        canonicalTicker(row.resolution.ticker) ===
          canonicalTicker(row.input.ticker),
      "Every example ticker must retain its verified company identification.",
    );
  });
  const rowCiks = new Set(value.rows.map((row) => row.resolution.cik));
  const capturedCiks = new Set(
    value.snapshot.companies.map((company) => company.cik),
  );
  requireValue(
    capturedCiks.size === value.snapshot.companies.length &&
      capturedCiks.size === rowCiks.size &&
      [...rowCiks].every((cik) => capturedCiks.has(cik)),
    "The captured companies do not match the reviewed input rows.",
  );
  for (const company of value.snapshot.companies) {
    requireValue(
      !company.ticker ||
        value.rows.some(
          (row) =>
            row.resolution.cik === company.cik &&
            canonicalTicker(row.resolution.ticker) ===
              canonicalTicker(company.ticker),
        ),
      "A captured company ticker does not match its verified company.",
    );
    requireValue(
      company.basis === undefined || company.basis === "annual",
      "A company uses a different reporting basis.",
    );
    requireValue(
      company.retrievedAt === undefined ||
        company.retrievedAt === null ||
        timestamp(company.retrievedAt),
      "A company retrieval date is invalid.",
    );
  }
  requireValue(
    object(value.methodology) &&
      text(value.methodology.source) &&
      text(value.methodology.freshness) &&
      Array.isArray(value.methodology.requests) &&
      value.methodology.requests.length > 0,
    "The capture methodology is missing.",
  );
  for (const request of value.methodology.requests) {
    requireValue(
      object(request) &&
        timestamp(request.started_at) &&
        timestamp(request.completed_at) &&
        Date.parse(request.started_at) <= Date.parse(request.completed_at) &&
        Array.isArray(request.tickers) &&
        request.tickers.length > 0 &&
        request.tickers.every((ticker) => tickers.includes(ticker)),
      "A capture request has invalid dates or tickers.",
    );
  }
  checkCoverage(value);
  return JSON.parse(JSON.stringify(value));
}

/** @param {any} demo @param {{id?: string, now?: string, allocationBasis?: string}} options */
export function createDemoPortfolio(demo, options = {}) {
  const capture = validatePortfolioDemo(demo);
  const allocation = demoAllocationSettings(capture, options.allocationBasis);
  const label =
    allocation.basis === "weights"
      ? "Hypothetical weighted demo"
      : allocation.basis === "equal"
        ? "Hypothetical equal-weight demo"
        : capture.input.allocation.basis === "weights"
          ? "Hypothetical demo · company counts"
          : "100-company demo";
  const complete = isCompletePortfolioCheck({
    companies: capture.snapshot.companies,
    requested: new Set(capture.rows.map((row) => row.resolution.cik)).size,
    completed: capture.snapshot.companies.length,
    checkedAt: capture.captured_at,
    cancelled: false,
  });
  return createPortfolio({
    id: options.id,
    now: options.now,
    name: `${label} · captured ${capture.captured_at.slice(0, 10)}`,
    rows: capture.rows,
    allocation,
    research: { basis: "annual" },
    snapshot: capture.snapshot,
    lastCheckedAt: complete ? capture.captured_at : null,
  });
}

/** Always create a new copy; an existing or edited portfolio is never replaced. */
export function saveDemoPortfolio(storage, demo, options = {}) {
  const portfolio = createDemoPortfolio(demo, options);
  const store = writePortfolio(storage, {
    mode: "create",
    portfolio,
    now: options.now,
  });
  return { portfolio, store };
}
