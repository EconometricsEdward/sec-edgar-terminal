import { PORTFOLIO_REPORTING_BASES } from "./portfolioReporting.js";
/** Browser orchestrator: only public identifiers leave the user's device. */
export const PORTFOLIO_CLIENT_BATCH_SIZE = 5;
const keyFor = (row) => row?.resolution?.cik;
// API classification is derived from the versioned CIK reference and is rebuilt by
// views/exports. It can cite fund providers, so keep it outside SEC-only captures.
function capturedCompany(company) {
  const capture = { ...company };
  delete capture.companyClassification;
  return capture;
}
const matchesBasis = (company, basis) => {
  const capturedBasis =
    company?.basis || company?.reporting_basis || company?.period?.kind;
  return !capturedBasis || capturedBasis === basis;
};
const failedResult = (holding, rows, message) => ({
  ...holding,
  name:
    rows.find((row) => keyFor(row) === holding.cik)?.resolution?.name ||
    holding.ticker ||
    holding.cik,
  status: "failed",
  kind:
    rows.find((row) => keyFor(row) === holding.cik)?.resolution?.kind === "fund"
      ? "fund"
      : "company",
  retrievedAt: null,
  period: null,
  metrics: {},
  filings: [],
  warnings: [message],
  cache: { status: "unavailable", storedAt: null },
  refreshStatus: "failed",
});

function refreshStatus(company) {
  if (company.status === "failed" || company.cache?.status === "unavailable")
    return "failed";
  if (company.cache?.status === "stale") return "stale";
  return "checked";
}

function needsRetry(company) {
  return (
    !company ||
    company.status === "failed" ||
    ["pending", "not_checked", "stale", "failed"].includes(
      company.refreshStatus,
    ) ||
    ["stale", "unavailable"].includes(company.cache?.status)
  );
}

function retainEarlierEvidence(holding, rows, previous, message) {
  if (!previous || previous.status === "failed")
    return failedResult(holding, rows, message);
  return {
    ...previous,
    refreshStatus: "failed",
    refreshError: message,
    cache: {
      ...previous.cache,
      status: "stale",
      storedAt: previous.cache?.storedAt || previous.retrievedAt || null,
    },
    note: "Refresh failed. Earlier evidence is retained and is not a completed fresh check.",
  };
}

export function portfolioIssuerRequests(rows) {
  const unique = new Map();
  for (const row of rows || []) {
    if (row.excluded || row.mergedInto || row.duplicateChoice === "remove")
      continue;
    const resolution = row.resolution || {};
    if (
      !["resolved", "unsupported"].includes(resolution.status) ||
      !/^\d{10}$/.test(resolution.cik || "")
    )
      continue;
    if (!unique.has(resolution.cik))
      unique.set(resolution.cik, {
        cik: resolution.cik,
        ticker: resolution.ticker || "",
      });
  }
  return [...unique.values()];
}

/** @param {any[]} rows @param {{basis?:string,previousCompanies?:any[],onlyFailed?:boolean,signal?:AbortSignal,onProgress?:(progress:any)=>void,fetcher?:typeof fetch}} options */
export async function researchPortfolioRows(
  rows,
  {
    basis = "annual",
    previousCompanies = [],
    onlyFailed = false,
    signal,
    onProgress = (_progress) => {},
    fetcher = globalThis.fetch,
  } = {},
) {
  if (!Array.isArray(rows) || rows.length > 100)
    throw new Error("A portfolio supports up to 100 rows.");
  if (!PORTFOLIO_REPORTING_BASES.includes(basis))
    throw new Error("Choose annual, quarter, ytd, or ttm research.");
  const all = portfolioIssuerRequests(rows);
  const allowed = new Set(all.map((item) => item.cik));
  const results = new Map(
    previousCompanies
      .filter(
        (company) => allowed.has(company.cik) && matchesBasis(company, basis),
      )
      .map((company) => [company.cik, capturedCompany(company)]),
  );
  const queue = onlyFailed
    ? all.filter((item) => needsRetry(results.get(item.cik)))
    : all;
  for (const holding of queue) {
    const previous = results.get(holding.cik);
    if (previous)
      results.set(holding.cik, { ...previous, refreshStatus: "pending" });
  }
  const checkedAt = new Date().toISOString();
  let completed = 0;
  const emit = () =>
    onProgress({
      completed,
      total: queue.length,
      companies: [...results.values()],
      checkedAt,
    });
  emit();
  for (
    let offset = 0;
    offset < queue.length;
    offset += PORTFOLIO_CLIENT_BATCH_SIZE
  ) {
    if (signal?.aborted) break;
    const holdings = queue.slice(offset, offset + PORTFOLIO_CLIENT_BATCH_SIZE);
    try {
      const response = await fetcher("/api/v1/portfolio-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: "edgar.portfolio.v1",
          action: "research",
          holdings,
          research: { basis },
          allocation: { basis: "none", normalize: false },
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(115000)])
          : AbortSignal.timeout(115000),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error || `Research request returned HTTP ${response.status}.`,
        );
      if (!Array.isArray(body.companies))
        throw new Error(
          "The research response was incomplete. Retry this batch.",
        );
      if (body.basis && body.basis !== basis)
        throw new Error(
          "The research response used a different reporting basis. Retry this batch.",
        );
      if (signal?.aborted) break;
      for (const holding of holdings) {
        const company = body.companies.find(
          (entry) => entry.cik === holding.cik,
        );
        if (
          !company ||
          refreshStatus(company) === "failed" ||
          !matchesBasis(company, basis)
        ) {
          const message =
            company && !matchesBasis(company, basis)
              ? "The company response used a different reporting basis. Retry this company."
              : company?.warnings?.[0] ||
                "The response omitted this company or returned unavailable research. Retry it.";
          results.set(
            holding.cik,
            retainEarlierEvidence(
              holding,
              rows,
              results.get(holding.cik),
              message,
            ),
          );
        } else {
          results.set(holding.cik, {
            ...capturedCompany(company),
            refreshStatus: refreshStatus(company),
          });
        }
      }
    } catch (error) {
      if (signal?.aborted) break;
      for (const holding of holdings) {
        const previous = results.get(holding.cik);
        results.set(
          holding.cik,
          retainEarlierEvidence(
            holding,
            rows,
            previous,
            error instanceof Error
              ? error.message
              : "Retrieval failed. Retry this company.",
          ),
        );
      }
    }
    completed += holdings.length;
    emit();
  }
  for (const [cik, company] of results) {
    if (company.refreshStatus === "pending")
      results.set(cik, { ...company, refreshStatus: "not_checked" });
  }
  if (signal?.aborted) emit();
  return {
    schema_version: "edgar.portfolio.v1",
    generated_at: new Date().toISOString(),
    basis,
    companies: [...results.values()],
    cancelled: Boolean(signal?.aborted),
    checkedAt,
    completed,
    requested: queue.length,
    onlyFailed,
  };
}

/** A feed baseline only advances after an entire, usable issuer check. */
export function isCompletePortfolioCheck(result, onlyFailed = false) {
  if (
    !result ||
    result.cancelled ||
    onlyFailed ||
    result.onlyFailed ||
    !Number.isInteger(result.requested) ||
    result.requested <= 0 ||
    result.requested !== result.completed ||
    !Array.isArray(result.companies) ||
    result.companies.length !== result.requested ||
    !Number.isFinite(Date.parse(result.checkedAt))
  )
    return false;
  if (
    new Set(result.companies.map((company) => company?.cik)).size !==
    result.requested
  )
    return false;
  return result.companies.every((company) => {
    if (
      !company ||
      !/^\d{10}$/.test(company.cik || "") ||
      company.refreshStatus !== "checked" ||
      ["stale", "unavailable"].includes(company.cache?.status)
    )
      return false;
    if (["ready", "partial"].includes(company.status)) return true;
    return (
      company.status === "unsupported" &&
      company.kind === "fund" &&
      ["fresh", "cached"].includes(company.cache?.status)
    );
  });
}

export function portfolioFilingFeed(
  rows,
  companies,
  { company = "", form = "", start = "", end = "", previousCheck = "" } = {},
) {
  const ids = new Set(
    (rows || [])
      .filter(
        (row) =>
          !row.excluded && !row.mergedInto && row.duplicateChoice !== "remove",
      )
      .map(keyFor)
      .filter(Boolean),
  );
  const prior = Number.isFinite(Date.parse(previousCheck))
    ? previousCheck.slice(0, 10)
    : "";
  const seen = new Set();
  return (companies || [])
    .filter((entry) => ids.has(entry.cik))
    .flatMap((entry) =>
      (entry.filings || []).flatMap((filing) => {
        const key = `${entry.cik}:${filing.accession}`;
        if (seen.has(key)) return [];
        seen.add(key);
        if (
          (company && company !== entry.cik) ||
          (form && !filing.form.startsWith(form)) ||
          (start && filing.filingDate < start) ||
          (end && filing.filingDate > end)
        )
          return [];
        return [
          {
            ...filing,
            cik: entry.cik,
            ticker: entry.ticker,
            companyName: entry.name,
            isNew: Boolean(prior && filing.filingDate > prior),
            sameCheckDay: Boolean(prior && filing.filingDate === prior),
          },
        ];
      }),
    )
    .sort(
      (a, b) =>
        String(b.filingDate).localeCompare(String(a.filingDate)) ||
        String(a.companyName).localeCompare(String(b.companyName)),
    );
}
