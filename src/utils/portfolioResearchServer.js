import { resolveCompanyClassification } from "./companyClassification.js";
import {
  PORTFOLIO_REPORTING_BASES,
  portfolioReportingLabel,
} from "./portfolioReporting.js";
import { buildAnalysisCompany, ANALYSIS_VERSION } from "./analysisResearch.js";
import { gzipSync, gunzipSync } from "node:zlib";
import { getOperatingDirectory, getFundDirectory } from "./tickerMap.js";
import { secResearchJson, submissionRows } from "./secResearchData.js";
import {
  buildCompareCompany,
  COMPARE_METRICS,
  COMPARE_VERSION,
  historicGrowth,
} from "./compareResearch.js";
import { buildMetricRow } from "./xbrlParser.js";
import { sourceDocumentUrl } from "./xbrlPeriods.js";
import { evidenceSources, evidenceCalculations } from "./researchEvidence.js";
import { comparePointQuality } from "./compareQuality.js";
import { classifyIndustry, industryLabel } from "./industry.js";
import { warmGet, warmSet } from "./warmCache.js";
import {
  normalizePortfolioInput,
  createPortfolioRows,
  resolvePortfolioRows,
  allocationSummary,
} from "./portfolioModel.js";

export const PORTFOLIO_API_VERSION = "edgar.portfolio.v1";
export const PORTFOLIO_RESEARCH_BATCH = 5;
export const PORTFOLIO_BODY_BYTES = 256 * 1024;
export const PORTFOLIO_FEED_LIMIT = 30;
const CACHE_NAMESPACE = "portfolio-company-v2-analysis";
const CACHE_FRESH_MS = 5 * 60 * 1000;
const CACHE_MAX_MS = 24 * 60 * 60 * 1000;
const localCache = new Map();
const inFlight = new Map();
let nextSecRequest = 0;

const nowIso = () => new Date().toISOString();
const cikString = (value) => String(value || "").padStart(10, "0");
const failure = (message, status = 400) =>
  Object.assign(new Error(message), { status });

export function validatePortfolioRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw failure("Submit a JSON portfolio object.");
  if (input.schema_version !== PORTFOLIO_API_VERSION)
    throw failure(`schema_version must be ${PORTFOLIO_API_VERSION}.`);
  const action = input.action || "research";
  if (!["resolve", "research"].includes(action))
    throw failure("action must be resolve or research.");
  if (
    input.research?.basis &&
    !PORTFOLIO_REPORTING_BASES.includes(input.research.basis)
  )
    throw failure(
      "Choose annual, quarter, ytd or ttm research; reporting bases are never silently substituted.",
    );
  try {
    const normalized = normalizePortfolioInput(input);
    return { ...normalized, action };
  } catch (error) {
    throw failure(error.message || "The portfolio format is invalid.");
  }
}

export async function readPortfolioRequestBody(request) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") || "",
    )
  )
    throw failure("Use Content-Type: application/json.", 415);
  const declaredLength = Number(request.headers.get("content-length"));
  if (declaredLength > PORTFOLIO_BODY_BYTES)
    throw failure("JSON request exceeds the 256 KiB limit.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw failure("A JSON portfolio body is required.");
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PORTFOLIO_BODY_BYTES) {
        await reader.cancel();
        throw failure("JSON request exceeds the 256 KiB limit.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw failure("The request body must contain valid JSON.");
  }
}

/** Share the existing SEC cache, with spaced request starts across batches on this instance. */
async function scheduledSecJson(path, signal) {
  signal?.throwIfAborted();
  const startsAt = Math.max(Date.now(), nextSecRequest);
  nextSecRequest = startsAt + 250;
  const delay = startsAt - Date.now();
  if (delay > 0)
    await new Promise((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(done, delay);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  signal?.throwIfAborted();
  return secResearchJson(path, signal);
}

export async function loadPortfolioDirectory() {
  // If either directory fails, do not silently identify an ETF as an operating company.
  const [operating, funds] = await Promise.all([
    getOperatingDirectory(),
    getFundDirectory(),
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(operating).map(([ticker, entry]) => [
        ticker,
        { ...entry, ticker, isFund: false },
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(funds).map(([ticker, entry]) => [
        ticker,
        {
          ...entry,
          ticker,
          name: operating[ticker]?.name || `${ticker} fund`,
          isFund: true,
        },
      ]),
    ),
  };
}

export function portfolioCompanyKind(submissions, resolved = {}) {
  const forms = submissions?.filings?.recent?.form || [];
  if (
    resolved.kind === "fund" ||
    submissions?.entityType === "investment" ||
    [6722, 6726].includes(Number(submissions?.sic)) ||
    forms.some((form) => /^(NPORT-P|N-CEN|N-1A)(\/A)?$/.test(form))
  )
    return "fund";
  return forms.some((form) => /^(20-F|40-F|6-K)(\/A)?$/.test(form)) &&
    !forms.some((form) => /^(10-K|10-Q)(\/A)?$/.test(form))
    ? "foreign"
    : "company";
}

function unavailablePoint(
  period,
  reason,
  classification = "unavailable",
  unit = "USD",
) {
  return { value: null, unit, period, classification, sources: [], reason };
}

function pointWithSources(point, company, unit, period) {
  if (!point)
    return unavailablePoint(
      period,
      "No compatible observation for the selected reporting basis.",
      "unavailable",
      unit,
    );
  return {
    ...point,
    unit,
    period,
    classification:
      point.value == null && /^Not applicable/.test(point.reason || "")
        ? "not_applicable"
        : point.classification ||
          (point.value == null ? "unavailable" : "reported"),
    sources: evidenceSources(point).map((source) => ({
      ...source,
      documentUrl:
        company.filings?.find((filing) => filing.accession === source.accession)
          ?.documentUrl ||
        source.documentUrl ||
        sourceDocumentUrl(company.cik, source),
    })),
    calculations: evidenceCalculations(point),
    source: undefined,
  };
}

/** Latest compatible period only: missing TTM never falls back to an annual observation. */
export function buildPortfolioCompany(
  company,
  { basis = "annual", retrievedAt = nowIso() } = {},
) {
  const compared = buildCompareCompany(company, {
    basis,
    periodLimit: basis === "annual" ? 2 : 5,
  });
  const period = compared.periods[0] || null;
  const metricDefinitions = Object.fromEntries(
    COMPARE_METRICS.map((metric) => [metric.key, metric]),
  );
  const metrics = Object.fromEntries(
    Object.entries(compared.metrics).map(([key, points]) => {
      const format = metricDefinitions[key].format;
      const unit =
        format === "currency" ? "USD" : format === "percent" ? "%" : "x";
      return [
        key,
        {
          ...pointWithSources(points[0], company, unit, period),
          label: metricDefinitions[key].label,
        },
      ];
    }),
  );
  const rawPoint = (key, label) => {
    if (!period || (basis === "ttm" && !period.start))
      return unavailablePoint(
        period,
        "No complete period is available for the selected reporting basis.",
      );
    return pointWithSources(
      buildMetricRow(
        company.facts,
        key,
        label,
        [period],
        "currency",
        compared.lens === "banking" ? "banking" : company.sic,
      ).values[0],
      company,
      "USD",
      period,
    );
  };
  metrics.capex = {
    ...(compared.lens === "corporate"
      ? rawPoint("capex", "Capital expenditures")
      : unavailablePoint(
          period,
          `Not applicable to this company's ${compared.lens} lens.`,
          "not_applicable",
        )),
    label: "Capital expenditures",
  };
  const debtInputs = [
    rawPoint("shortTermDebt", "Current debt"),
    rawPoint("longTermDebt", "Noncurrent debt"),
  ];
  metrics.debt = {
    ...(compared.lens === "banking"
      ? unavailablePoint(
          period,
          "Not applicable to the banking lens; deposits and funding require a separate assessment.",
          "not_applicable",
        )
      : debtInputs.every(
            (point, index) =>
              Number.isFinite(point.value) &&
              comparePointQuality(
                point,
                index === 0 ? "shortTermDebt" : "longTermDebt",
                period,
              ).valid,
          )
        ? {
            value: debtInputs[0].value + debtInputs[1].value,
            unit: "USD",
            period,
            classification: "calculated",
            formula:
              "Reported current debt + reported noncurrent debt; both components required.",
            sources: debtInputs.flatMap(evidenceSources),
            calculations: debtInputs.flatMap(evidenceCalculations),
          }
        : unavailablePoint(
            period,
            "Both reported current and noncurrent debt components are required; a missing component is not zero.",
          )),
    label: "Reported debt",
  };
  const growth = historicGrowth(compared, "revenue", 0);
  metrics.revenueGrowth = {
    ...(compared.lens !== "corporate"
      ? unavailablePoint(
          period,
          `Not applicable to this company's ${compared.lens} lens.`,
          "not_applicable",
          "%",
        )
      : Number.isFinite(growth.yoy.value)
        ? {
            value: growth.yoy.value,
            unit: "%",
            period,
            classification: "calculated",
            formula:
              "(Current revenue / comparable prior-year revenue − 1) × 100; positive prior revenue required.",
            sources: [
              ...evidenceSources(compared.metrics.revenue[0]),
              ...evidenceSources(growth.prior),
            ],
            calculations: [
              ...evidenceCalculations(compared.metrics.revenue[0]),
              ...evidenceCalculations(growth.prior),
            ],
          }
        : unavailablePoint(
            period,
            growth.yoy.reason ||
              "Comparable prior-year revenue is unavailable.",
            "unavailable",
            "%",
          )),
    label: "Revenue growth",
  };
  // Securities brokers retain common measures; corporate liquidity ratios are not imposed.
  if (compared.businessModel === "broker-dealer") {
    for (const [key, definition] of Object.entries(metricDefinitions)) {
      if (!definition.lenses.includes("common"))
        metrics[key] = {
          ...unavailablePoint(
            period,
            "Not applicable to the common financial lens used for securities brokers.",
            "not_applicable",
            metrics[key].unit,
          ),
          label: definition.label,
        };
    }
    for (const key of ["capex", "debt", "revenueGrowth"])
      metrics[key] = {
        ...unavailablePoint(
          period,
          "Not applicable to the common financial lens used for securities brokers.",
          "not_applicable",
          metrics[key].unit,
        ),
        label: metrics[key].label,
      };
  }
  const analysis = buildAnalysisCompany(company, { basis, latestOnly: true });
  const units = {
    currency: "USD",
    percent: "%",
    decimal: "x",
    eps: "USD/shares",
    shares: "shares",
  };
  for (const definition of analysis.definitions) {
    const existing = metrics[definition.key];
    // Keep established common/broker applicability and explicit debt/growth contracts.
    if (["debt", "revenueGrowth"].includes(definition.key)) continue;
    if (
      compared.businessModel === "broker-dealer" &&
      !["income", "balance", "cashflow"].includes(definition.category) &&
      (!existing || existing.classification === "not_applicable")
    )
      continue;
    const point = analysis.metrics[definition.key]?.[0];
    metrics[definition.key] = {
      ...pointWithSources(
        point,
        company,
        units[definition.format] || "USD",
        period,
      ),
      label: definition.label,
      format: definition.format,
      category: definition.category,
      definitionFormula: definition.formula || null,
    };
  }
  const relevant = Object.values(metrics).filter(
    (point) => point.classification !== "not_applicable",
  );
  const available = relevant.filter((point) => Number.isFinite(point.value));
  const group = classifyIndustry(company.sic);
  const warnings = [compared.note];
  if (compared.lensNote) warnings.push(compared.lensNote);
  if (company.kind === "foreign")
    warnings.push(
      "Foreign company: only supported USD facts in the existing financial engine are used. IFRS/custom concepts, other currencies, and interim coverage may be unavailable.",
    );
  if (!period)
    warnings.push(
      `No supported ${portfolioReportingLabel(basis).toLowerCase()} reporting period was found. Filings remain available.`,
    );
  else if (basis === "ttm" && !period.start)
    warnings.push(
      "Four compatible consecutive quarters are unavailable; TTM metrics remain unavailable.",
    );
  const staleDays = basis === "annual" ? 550 : 200;
  if (
    period &&
    Date.parse(retrievedAt) - Date.parse(period.end) > staleDays * 86400000
  )
    warnings.push(
      `Reporting is stale: the latest supported period ended more than ${staleDays} days before retrieval.`,
    );
  if (available.length < relevant.length)
    warnings.push(
      `${available.length} of ${relevant.length} applicable metrics are available; missing values are not zero.`,
    );
  return {
    cik: company.cik,
    ticker: company.ticker || null,
    tickers: company.tickers || [],
    name: company.companyName,
    status:
      available.length === relevant.length && period ? "ready" : "partial",
    kind: company.kind || "company",
    lens: compared.businessModel === "broker-dealer" ? "common" : compared.lens,
    sic: company.sic || null,
    sicDescription: company.sicDescription || null,
    industry: company.sic ? industryLabel(group) : "Unclassified",
    industrySystem: "SEC SIC analytical groups",
    basis,
    period,
    analysisVersion: ANALYSIS_VERSION,
    metrics,
    filings: company.filings || [],
    latestAnnualFiling: company.latestAnnualFiling || null,
    latestInterimFiling: company.latestInterimFiling || null,
    filingCoverage: company.filingCoverage,
    retrievedAt,
    cache: { status: "fresh", storedAt: retrievedAt },
    warnings,
  };
}

function feedFor(submissions, cik, retrievedAt) {
  const recent = submissions.filings?.recent || {};
  const descriptions = new Map(
    (recent.accessionNumber || []).map((accession, index) => [
      accession,
      recent.primaryDocDescription?.[index] || null,
    ]),
  );
  const filings = [
    ...new Map(
      submissionRows(recent, cik).map((filing) => [
        filing.accession,
        { ...filing, description: descriptions.get(filing.accession) },
      ]),
    ).values(),
  ].sort((a, b) => (b.filingDate || "").localeCompare(a.filingDate || ""));
  return {
    filings: filings.slice(0, PORTFOLIO_FEED_LIMIT),
    latestAnnualFiling:
      filings.find((filing) => /^(10-K|20-F|40-F)(\/A)?$/.test(filing.form)) ||
      null,
    latestInterimFiling:
      filings.find((filing) => /^10-Q(\/A)?$/.test(filing.form)) || null,
    filingCoverage: {
      source: `https://data.sec.gov/submissions/CIK${cik}.json`,
      scope: "recent SEC submissions only",
      archivedSubmissionFilesChecked: 0,
      relevantForms: [
        "10-K",
        "10-Q",
        "20-F",
        "40-F",
        "8-K",
        "6-K",
        "amendments",
      ],
      recentSubmissionCount: recent.accessionNumber?.length || 0,
      matchingRecentCount: filings.length,
      returnedCount: Math.min(filings.length, PORTFOLIO_FEED_LIMIT),
      limit: PORTFOLIO_FEED_LIMIT,
      truncated: filings.length > PORTFOLIO_FEED_LIMIT,
      checkedAt: retrievedAt,
      note: "Up to 30 relevant filings per company from the recent submissions block. Older archive files are not scanned; this is not a complete filing history.",
    },
  };
}

async function freshCompany(
  identity,
  basis,
  { secJson = scheduledSecJson, signal } = {},
) {
  const cik = cikString(identity.cik);
  const retrievedAt = nowIso();
  const submissions = await secJson(`/submissions/CIK${cik}.json`, signal);
  if (cikString(submissions?.cik) !== cik || !submissions.name)
    throw new Error(
      "The SEC company identity could not be verified for this CIK.",
    );
  const kind = portfolioCompanyKind(submissions, identity);
  const feed = feedFor(submissions, cik, retrievedAt);
  const tickers = (submissions.tickers || []).filter(
    (ticker) => typeof ticker === "string",
  );
  const company = {
    cik,
    ticker: tickers.length === 1 ? tickers[0] : null,
    tickers,
    companyName: submissions.name,
    sic: submissions.sic,
    sicDescription: submissions.sicDescription,
    kind,
    ...feed,
  };
  if (kind === "fund")
    return {
      cik,
      ticker: company.ticker,
      tickers,
      name: company.companyName,
      status: "unsupported",
      kind,
      lens: null,
      sic: company.sic || null,
      sicDescription: company.sicDescription || null,
      industry: "Fund",
      industrySystem: "SEC SIC / filing classification",
      period: null,
      metrics: {},
      ...feed,
      retrievedAt,
      cache: { status: "fresh", storedAt: retrievedAt },
      fundUrl: `/fund${identity.ticker ? `?tickers=${encodeURIComponent(identity.ticker)}` : ""}`,
      warnings: [
        "Funds are retained as positions but are not analyzed with operating-company financial metrics. Use the Funds workspace for portfolio holdings research.",
      ],
    };
  try {
    const facts = await secJson(
      `/api/xbrl/companyfacts/CIK${cik}.json`,
      signal,
    );
    if (cikString(facts?.cik) !== cik || !facts.facts)
      throw new Error("SEC company facts did not match the requested company.");
    return buildPortfolioCompany(
      { ...company, facts: facts.facts },
      { basis, retrievedAt },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    const result = buildPortfolioCompany(
      { ...company, facts: {} },
      { basis, retrievedAt },
    );
    result.warnings.push(
      "Company facts could not be retrieved; the verified identity and available filings are retained. Retry this company.",
    );
    result.factsUnavailable = true;
    return result;
  }
}

function decodeCache(value) {
  try {
    const decoded = value?.gzip
      ? JSON.parse(
          gunzipSync(Buffer.from(value.gzip, "base64"), {
            maxOutputLength: 4 * 1024 * 1024,
          }).toString("utf8"),
        )
      : null;
    return decoded &&
      Date.now() - Date.parse(decoded.retrievedAt) <= CACHE_MAX_MS
      ? decoded
      : null;
  } catch {
    return null;
  }
}

async function cachedCompany(identity, basis, options) {
  const key = `${COMPARE_VERSION}:${ANALYSIS_VERSION}:${identity.cik}:${basis}`;
  const candidate =
    localCache.get(key) || decodeCache(await warmGet(CACHE_NAMESPACE, key));
  const cached =
    candidate && Date.now() - Date.parse(candidate.retrievedAt) <= CACHE_MAX_MS
      ? candidate
      : null;
  if (cached && Date.now() - Date.parse(cached.retrievedAt) < CACHE_FRESH_MS)
    return {
      ...cached,
      cache: { status: "cached", storedAt: cached.retrievedAt },
    };
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = (async () => {
    try {
      const company = await freshCompany(identity, basis, options);
      if (company.factsUnavailable && cached)
        return {
          ...cached,
          filings: company.filings,
          latestAnnualFiling: company.latestAnnualFiling,
          latestInterimFiling: company.latestInterimFiling,
          filingCoverage: company.filingCoverage,
          cache: { status: "stale", storedAt: cached.retrievedAt },
          warnings: [
            ...cached.warnings,
            "Company facts could not be refreshed. Financial metrics use the timestamped previous public snapshot; the filing feed was refreshed separately.",
          ],
        };
      if (!company.factsUnavailable) {
        localCache.set(key, company);
        if (localCache.size > 150)
          localCache.delete(localCache.keys().next().value);
        await warmSet(
          CACHE_NAMESPACE,
          key,
          { gzip: gzipSync(JSON.stringify(company)).toString("base64") },
          CACHE_MAX_MS / 1000,
        );
      }
      return company;
    } catch (error) {
      if (cached && !options.signal?.aborted)
        return {
          ...cached,
          cache: { status: "stale", storedAt: cached.retrievedAt },
          warnings: [
            ...cached.warnings,
            "The refresh failed. Showing a previously retrieved public-company snapshot; check its retrieval and reporting dates.",
          ],
        };
      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

function failedCompany(identity, message) {
  return {
    cik: identity.cik,
    ticker: identity.ticker || null,
    name: identity.name || `CIK ${identity.cik}`,
    status: "failed",
    kind: identity.kind || "company",
    lens: null,
    sic: null,
    sicDescription: null,
    industry: "Unclassified",
    period: null,
    metrics: {},
    filings: [],
    filingCoverage: {
      scope: "not retrieved",
      returnedCount: 0,
      limit: PORTFOLIO_FEED_LIMIT,
    },
    retrievedAt: null,
    cache: { status: "unavailable", storedAt: null },
    warnings: [message],
  };
}

/** Same entry point for interactive batches and external clients; user-specific results are never cached. */
export async function runPortfolioResearch(rawInput, dependencies = {}) {
  const input = validatePortfolioRequest(rawInput);
  const directory =
    dependencies.directory ||
    (await (dependencies.loadDirectory || loadPortfolioDirectory)());
  const rows = resolvePortfolioRows(
    createPortfolioRows(input.holdings, input.row_choices),
    directory,
  );
  const readyRows = rows.filter(
    (row) =>
      !row.excluded &&
      ["resolved", "unsupported"].includes(row.resolution?.status) &&
      row.resolution?.cik,
  );
  const identities = [
    ...new Map(
      readyRows.map((row) => [row.resolution.cik, row.resolution]),
    ).values(),
  ];
  if (
    input.action === "research" &&
    identities.length > PORTFOLIO_RESEARCH_BATCH
  )
    throw failure(
      "Research accepts at most 5 distinct resolved companies per request. Resolve up to 100 rows, then send batches of 5 companies and combine companies by CIK.",
    );
  const companies = [];
  if (input.action === "research") {
    const loadCompany = dependencies.loadCompany || cachedCompany;
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, identities.length) }, async () => {
        while (index < identities.length) {
          const identity = identities[index++];
          try {
            dependencies.signal?.throwIfAborted();
            companies.push(
              await loadCompany(identity, input.research.basis, {
                signal: dependencies.signal,
              }),
            );
          } catch {
            companies.push(
              failedCompany(
                identity,
                dependencies.signal?.aborted
                  ? "Retrieval was cancelled or exceeded the request time limit. Retry this company."
                  : "SEC company data could not be retrieved. Retry this company; other companies remain usable.",
              ),
            );
          }
        }
      }),
    );
    companies.sort(
      (a, b) =>
        identities.findIndex((identity) => identity.cik === a.cik) -
        identities.findIndex((identity) => identity.cik === b.cik),
    );
  }
  companies.forEach((company, index) => {
    companies[index] = {
      ...company,
      companyClassification: resolveCompanyClassification(company),
    };
  });
  const byCik = Object.fromEntries(
    companies.map((company) => [company.cik, company]),
  );
  const allocation = allocationSummary(rows, input.allocation, byCik);
  const endDates = [
    ...new Set(companies.map((company) => company.period?.end).filter(Boolean)),
  ].sort();
  const coverage = {
    inputRows: rows.length,
    excludedRows: rows.filter((row) => row.excluded).length,
    resolvedRows: readyRows.length,
    unresolvedRows:
      rows.filter((row) => !row.excluded).length - readyRows.length,
    uniqueIssuers: identities.length,
    researchedIssuers: companies.length,
    ready: companies.filter((company) => company.status === "ready").length,
    partial: companies.filter((company) => company.status === "partial").length,
    failed: companies.filter((company) => company.status === "failed").length,
    unsupported: companies.filter((company) => company.status === "unsupported")
      .length,
    staleCached: companies.filter((company) => company.cache.status === "stale")
      .length,
    reportingEnds: endDates,
    mismatchedPeriods: endDates.length > 1,
    filingScope: `Recent SEC submissions only; up to ${PORTFOLIO_FEED_LIMIT} relevant filings per company. No archived submission files are scanned.`,
    warnings: [
      ...(input.warnings || []),
      "Coverage describes this request only. Combine company batches by CIK; recompute count and allocation coverage for the full input without reweighting covered companies.",
      ...(endDates.length > 1
        ? [
            "Companies have different reporting period end dates; inspect their periods before making comparisons.",
          ]
        : []),
    ],
  };
  return {
    schema_version: PORTFOLIO_API_VERSION,
    generated_at: nowIso(),
    basis: input.research.basis,
    action: input.action,
    rows,
    companies,
    coverage,
    allocation,
  };
}

export {
  freshCompany as loadFreshPortfolioCompany,
  cachedCompany as loadCachedPortfolioCompany,
};
