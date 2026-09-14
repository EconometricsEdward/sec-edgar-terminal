import { loadCompanyCftcContext } from "./companyCftcServer.js";
import { CFTC_SOURCE_CURRENT_MAX_DAYS, loadCftcHistory } from "./cftcServer.js";
import { CFTC_FAMILIES, CFTC_LAUNCH_CATALOG, CFTC_REPORT_BASIS, cftcDate, cftcGroup } from "./cftc.js";
import { cftcPositionChange } from "./cftcContextAnalytics.js";

export const PORTFOLIO_CFTC_CHANGES_VERSION = "edgar.portfolio-cftc-changes.v2";
export const PORTFOLIO_CFTC_COMPANY_LIMIT = 24;
export const PORTFOLIO_CFTC_CONCURRENCY = 4;
export const PORTFOLIO_CFTC_THRESHOLDS = Object.freeze({ netSharePercentagePoints: 1, openInterestPercent: 5 });

const validTicker = (value) => /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(String(value || ""));
const validCik = (value) => /^\d{10}$/.test(String(value || ""));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const dateValue = (value) => typeof value === "string" && cftcDate(value) === value ? value : "";
const dayMs = 86400000;
const marketKey = (candidate) => `${candidate.family}:${candidate.contract}:${candidate.group}`;
// Only fixed public categories cross the API boundary; provider errors and URLs do not.
const PUBLIC_FAILURE_CODES = new Set([
  "CFTC_DISABLED", "COMPANY_NOT_FOUND", "COMPANY_CFTC_BUSY", "COMPANY_CFTC_TIMEOUT",
  "SEC_USER_AGENT_INVALID", "SEC_RATE_GATE_UNAVAILABLE", "SEC_RATE_GATE_SATURATED",
  "SEC_UPSTREAM_COOLDOWN", "SEC_UPSTREAM_UNAVAILABLE", "SEC_SOURCE_UNAVAILABLE",
  "SEC_SOURCE_INVALID", "SEC_FILING_TEXT_UNAVAILABLE", "SEC_CONTEXT_UNAVAILABLE",
  "CFTC_REPORT_NOT_PREPARED", "CFTC_SOURCE_UNAVAILABLE", "CFTC_REPORT_UNAVAILABLE",
  "CFTC_TIMEOUT", "CFTC_HISTORY_UNAVAILABLE", "UNSUPPORTED_CONTRACT",
]);
function failureCode(value) {
  if (PUBLIC_FAILURE_CODES.has(value?.code)) return value.code;
  if (["AbortError", "TimeoutError"].includes(value?.name)) return "REQUEST_INTERRUPTED";
  return "SOURCE_UNAVAILABLE";
}
function countFailure(counts, code) { counts[code] = (counts[code] || 0) + 1; }

function normalizeCompanies(companies) {
  const unique = new Map();
  for (const item of Array.isArray(companies) ? companies.slice(0, 100) : []) {
    const ticker = String(item?.ticker || "").toUpperCase();
    const cik = String(item?.cik || "");
    if (!validTicker(ticker) || (cik && !validCik(cik)) || unique.has(ticker)) continue;
    unique.set(ticker, {
      ticker,
      cik: validCik(cik) ? cik : "",
      rowId: typeof item?.rowId === "string" ? item.rowId.slice(0, 200) : "",
    });
  }
  return [...unique.values()];
}

/** Separate bounded queues let shared market history warm while SEC discovery continues. */
function limiter(concurrency, signal) {
  let active = 0;
  const queue = [];
  function drain() {
    while (active < concurrency && queue.length) {
      const { task, resolve, reject } = queue.shift();
      if (signal?.aborted) { reject(signal.reason || new Error("Research request was interrupted.")); continue; }
      active += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => { active -= 1; drain(); });
    }
  }
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); drain(); });
}

function candidateEvidence(candidate, cik, today) {
  const catalog = CFTC_LAUNCH_CATALOG.find(item => item.family === candidate?.family && item.code === candidate?.contract);
  if (!catalog || candidate.group !== (candidate.family === "tff" ? "leveraged-funds" : "managed-money")
    || !cftcGroup(candidate.family, candidate.group) || !Array.isArray(candidate.evidence)) return null;
  const evidence = candidate.evidence.slice(0, 2).filter(item => {
    if (!item || !["10-K", "20-F", "40-F"].includes(item.form)
      || !/^\d{10}-\d{2}-\d{6}$/.test(item.accession || "")
      || !dateValue(item.filed) || item.filed > today
      || (item.reportDate != null && (!dateValue(item.reportDate) || item.reportDate > item.filed))
      || typeof item.text !== "string" || item.text.length < 35 || item.text.length > 900) return false;
    const prefix = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${item.accession.replaceAll("-", "")}/`;
    return typeof item.url === "string" && item.url.startsWith(prefix)
      && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(item.url.slice(prefix.length));
  }).map(({ form, filed, url, accession, reportDate, text }) => ({ form, filed, url, accession, reportDate: reportDate || null, text }));
  if (!evidence.length) return null;
  return {
    label: catalog.label,
    reason: String(candidate.reason || "Review the SEC passage to assess this candidate market connection.").slice(0, 1000),
    reviewQuestion: String(candidate.reviewQuestion || "How does this market relate to the business described in the filing?").slice(0, 1000),
    filing: evidence[0],
    evidence,
  };
}

function historyMatches(history, candidate) {
  const config = CFTC_FAMILIES[candidate.family];
  if (!history || !["ready", "partial", "stale"].includes(history.status)
    || history.report_family !== candidate.family || history.report_basis !== CFTC_REPORT_BASIS
    || history.selection?.contract !== candidate.contract || history.selection?.group !== candidate.group
    || history.selected?.code !== candidate.contract || history.selected?.family !== candidate.family
    || history.selected?.reportBasis !== CFTC_REPORT_BASIS || !dateValue(history.selected?.reportDate)
    || history.source?.dataset_id !== config.datasetId || history.source?.report_basis !== CFTC_REPORT_BASIS
    || !Array.isArray(history.history)) return false;
  try {
    const source = new URL(history.source.url);
    return source.protocol === "https:" && source.hostname === "publicreporting.cftc.gov"
      && source.pathname === `/resource/${config.datasetId}.json`;
  } catch { return false; }
}

function normalizedPoint(point) {
  const validPositions = [point?.long, point?.short].every(value => finite(value) && value >= 0);
  const validOi = finite(point?.openInterest) && point.openInterest > 0;
  return { ...point, netPctOi: validPositions && validOi ? 100 * (point.long - point.short) / point.openInterest : null };
}

function marketEvents(market, history, { cutoff, today, now }) {
  const { candidate } = market;
  const counts = { noComparison: 0, belowThreshold: 0, outsideWindow: 0, futureReports: 0 };
  const events = [];
  const latestReportDate = history.selected.reportDate;
  if (latestReportDate > today) return { events, ...counts, futureReports: 1 };
  const sourceAgeDays = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latestReportDate}T00:00:00Z`)) / dayMs);
  const sourceCurrency = sourceAgeDays > CFTC_SOURCE_CURRENT_MAX_DAYS ? "aged" : "current";
  const historyStatus = sourceCurrency === "aged" && history.status === "ready" ? "stale" : history.status;
  // Exact calendar-week comparisons only. A duplicate date is not silently selected.
  const byDate = new Map();
  const duplicates = new Set();
  for (const point of history.history.slice(0, 600)) {
    if (!dateValue(point?.reportDate)) continue;
    if (point.reportDate > today || point.reportDate > latestReportDate) { counts.futureReports += 1; continue; }
    if (byDate.has(point.reportDate)) duplicates.add(point.reportDate);
    byDate.set(point.reportDate, normalizedPoint(point));
  }
  for (const date of duplicates) byDate.delete(date);
  const points = [...byDate.values()].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  const groupLabel = cftcGroup(candidate.family, candidate.group).label;
  const relatedCompanies = market.relatedCompanies.slice().sort((a, b) => a.ticker.localeCompare(b.ticker));
  const leadingCompany = relatedCompanies[0];
  for (const point of points) {
    if (point.reportDate < cutoff) { counts.outsideWindow += 1; continue; }
    const change = cftcPositionChange({ selected: { reportDate: point.reportDate }, history: points }, 1);
    const prior = byDate.get(change.priorDate);
    if (!change.available || !finite(point.netPctOi) || !finite(prior?.netPctOi)) { counts.noComparison += 1; continue; }
    const openInterestChange = point.openInterest - prior.openInterest;
    const openInterestChangePct = 100 * openInterestChange / prior.openInterest;
    const thresholdReasons = [];
    if (Math.abs(change.netPctChange) + 1e-9 >= PORTFOLIO_CFTC_THRESHOLDS.netSharePercentagePoints) thresholdReasons.push("net-share");
    if (Math.abs(openInterestChangePct) + 1e-9 >= PORTFOLIO_CFTC_THRESHOLDS.openInterestPercent) thresholdReasons.push("open-interest");
    if (!thresholdReasons.length) { counts.belowThreshold += 1; continue; }
    const marketQuery = new URLSearchParams({ tab: "positioning", family: candidate.family, contract: candidate.contract,
      group: candidate.group, date: point.reportDate, history: "1y", display: "net-oi" });
    const netShareDescription = `Net share of total open interest changed by ${change.netPctChange > 0 ? "+" : ""}${change.netPctChange.toFixed(2)} percentage points.`;
    const oiDescription = `Total contract open interest changed by ${openInterestChangePct > 0 ? "+" : ""}${openInterestChangePct.toFixed(2)}%.`;
    events.push({
      id: `${marketKey(candidate)}:${point.reportDate}`,
      source: "cftc",
      ...leadingCompany,
      relatedCompanies,
      reportDate: point.reportDate,
      priorDate: change.priorDate,
      title: thresholdReasons.includes("net-share")
        ? `${leadingCompany.candidate.label}: ${groupLabel} net share ${change.netPctChange > 0 ? "increased" : "decreased"}`
        : `${leadingCompany.candidate.label}: total open interest ${openInterestChangePct > 0 ? "increased" : "decreased"}`,
      description: `${change.explanation} ${netShareDescription} ${oiDescription}`,
      family: candidate.family,
      reportBasis: CFTC_REPORT_BASIS,
      contract: candidate.contract,
      contractName: point.contractName || history.selected.contractName || leadingCompany.candidate.label,
      exchange: point.exchange || history.selected.exchange || "",
      traderGroup: candidate.group,
      traderGroupLabel: groupLabel,
      netChange: change.netChange,
      netPctChange: change.netPctChange,
      longChange: change.longChange,
      shortChange: change.shortChange,
      netPctOi: point.netPctOi,
      priorNetPctOi: prior.netPctOi,
      openInterest: point.openInterest,
      priorOpenInterest: prior.openInterest,
      openInterestChange,
      openInterestChangePct,
      thresholdReasons,
      comparisonBasis: "Same contract, futures-only report family and trader category, exactly seven calendar days apart.",
      cftcSource: history.source.url,
      marketPath: `/market?${marketQuery.toString()}`,
      // COT report dates are position observation dates. No release date is inferred.
      publicationTimeVerified: false,
      retrievedAt: typeof history.retrieved_at === "string" && Number.isFinite(Date.parse(history.retrieved_at)) && Date.parse(history.retrieved_at) <= now.getTime() ? history.retrieved_at : null,
      latestReportDate,
      sourceCurrency,
      freshness: { ...history.freshness, report_date: latestReportDate, source_currency: sourceCurrency, source_report_age_days: sourceAgeDays, publication_time_verified: false },
      historyStatus,
      refreshWarning: typeof history.refresh_warning === "string" ? history.refresh_warning.slice(0, 2000) : sourceCurrency === "aged" ? "The latest available source observation is more than 14 days old." : null,
    });
  }
  return { events, ...counts, stale: historyStatus === "stale" || sourceCurrency === "aged", partial: historyStatus === "partial" };
}

/**
 * Recent material-sized weekly changes in SEC-linked CFTC market context.
 * Thresholds are editorial noise filters, not statistical significance or issuer risk signals.
 * Histories are loaded once per unique market; every supported SEC candidate is considered.
 */
export async function buildPortfolioCftcChanges(
  { companies = [], days = 30 } = {},
  { signal, now = new Date(), loadContext = loadCompanyCftcContext, loadHistory = loadCftcHistory } = {},
) {
  now = new Date(now);
  const allCompanies = normalizeCompanies(companies);
  const requested = allCompanies.slice(0, PORTFOLIO_CFTC_COMPANY_LIMIT);
  const today = now.toISOString().slice(0, 10);
  const windowDays = Math.max(1, Math.min(90, Math.floor(Number(days) || 30)));
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - (windowDays - 1) * dayMs).toISOString().slice(0, 10);
  const contextLimit = limiter(PORTFOLIO_CFTC_CONCURRENCY, signal);
  const historyLimit = limiter(PORTFOLIO_CFTC_CONCURRENCY, signal);
  const markets = new Map();
  const coverage = {
    totalCompanies: allCompanies.length, requested: requested.length, checked: 0, linked: 0, unavailable: 0,
    noLink: 0, noFiling: 0, identityMismatch: 0, invalidLinks: 0, unavailableReasons: {}, marketUnavailableReasons: {},
    uniqueMarkets: 0, marketsChecked: 0, marketUnavailable: 0, staleMarkets: 0, partialMarkets: 0,
    noComparison: 0, belowThreshold: 0, outsideWindow: 0, futureReports: 0, events: 0,
    limited: allCompanies.length > requested.length, companyLimit: PORTFOLIO_CFTC_COMPANY_LIMIT,
  };
  const discovered = await Promise.allSettled(requested.map(company => contextLimit(async () => {
    const context = await loadContext({ ticker: company.ticker }, { signal });
    if (!["ready", "no_matches", "no_filing"].includes(context?.status)) {
      coverage.unavailable += 1; countFailure(coverage.unavailableReasons, failureCode(context)); return;
    }
    if (!validCik(context.cik) || (company.cik && company.cik !== context.cik)
      || (context.ticker && context.ticker !== company.ticker)) {
      coverage.identityMismatch += 1; coverage.unavailable += 1;
      countFailure(coverage.unavailableReasons, "ISSUER_IDENTITY_MISMATCH"); return;
    }
    coverage.checked += 1;
    if (context.status === "no_matches") { coverage.noLink += 1; return; }
    if (context.status === "no_filing") { coverage.noFiling += 1; return; }
    let linked = false;
    for (const candidate of Array.isArray(context.links) ? context.links.slice(0, 8) : []) {
      const evidence = candidateEvidence(candidate, context.cik, today);
      if (!evidence) { coverage.invalidLinks += 1; continue; }
      const key = marketKey(candidate);
      if (!markets.has(key)) {
        markets.set(key, {
          candidate, relatedCompanies: [],
          // Attach rejection handling immediately: discovery and history run concurrently.
          result: historyLimit(() => loadHistory({ family: candidate.family, code: candidate.contract, group: candidate.group, reportDate: "latest", window: "1y", signal }))
            .then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason })),
        });
      }
      const market = markets.get(key);
      if (!market.relatedCompanies.some(item => item.ticker === company.ticker)) {
        market.relatedCompanies.push({ ...company, cik: context.cik, companyName: String(context.companyName || company.ticker).slice(0, 500), candidate: evidence });
      }
      linked = true;
    }
    if (linked) coverage.linked += 1;
  })));
  for (const result of discovered) {
    if (result.status !== "rejected") continue;
    coverage.unavailable += 1; countFailure(coverage.unavailableReasons, failureCode(result.reason));
  }
  coverage.uniqueMarkets = markets.size;
  const events = [];
  for (const market of markets.values()) {
    const result = await market.result;
    if (result.status !== "fulfilled" || !historyMatches(result.value, market.candidate)) {
      coverage.marketUnavailable += 1;
      countFailure(coverage.marketUnavailableReasons, result.status === "rejected" ? failureCode(result.reason) : "CFTC_IDENTITY_UNVERIFIED");
      continue;
    }
    coverage.marketsChecked += 1;
    const built = marketEvents(market, result.value, { cutoff, today, now });
    events.push(...built.events);
    for (const key of ["noComparison", "belowThreshold", "outsideWindow", "futureReports"]) coverage[key] += built[key];
    if (built.stale) coverage.staleMarkets += 1;
    if (built.partial) coverage.partialMarkets += 1;
  }
  events.sort((a, b) => b.reportDate.localeCompare(a.reportDate) || Math.abs(b.netPctChange) - Math.abs(a.netPctChange) || a.id.localeCompare(b.id));
  coverage.events = events.length;
  return {
    schemaVersion: PORTFOLIO_CFTC_CHANGES_VERSION, generatedAt: now.toISOString(), cutoff, events, coverage,
    thresholds: PORTFOLIO_CFTC_THRESHOLDS,
    methodology: "Show a weekly change when absolute net share of total open interest moves at least 1 percentage point, or total contract open interest changes at least 5%. These are display thresholds, not statistical significance tests. Compare observations exactly seven calendar days apart; missing weeks are not substituted. Report dates are position observation dates, not verified publication dates.",
    limitation: "CFTC events are aggregate futures positioning for markets linked by candidate SEC filing passages. They do not represent the company’s own futures position, hedge size, cash flow, or a price forecast. Only the latest accessible annual SEC filing is scanned for each checked company; a candidate is not a measured or confirmed exposure.",
  };
}
