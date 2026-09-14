import { loadCompanyCftcContext } from "./companyCftcServer.js";
import { loadCftcHistory } from "./cftcServer.js";
import { cftcPositionChange } from "./cftcContextAnalytics.js";

export const PORTFOLIO_CFTC_CHANGES_VERSION = "edgar.portfolio-cftc-changes.v1";
export const PORTFOLIO_CFTC_COMPANY_LIMIT = 24;

const validTicker = (value) => /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(String(value || ""));
const validCik = (value) => /^\d{10}$/.test(String(value || ""));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const dateValue = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";

function cutoffDate(days, now) {
  const value = new Date(now);
  value.setUTCDate(value.getUTCDate() - Math.max(1, Math.min(90, days)));
  return value.toISOString().slice(0, 10);
}

function normalizeCompanies(companies) {
  const unique = new Map();
  for (const item of companies || []) {
    const ticker = String(item?.ticker || "").toUpperCase();
    const cik = String(item?.cik || "");
    if (!validTicker(ticker) || (cik && !validCik(cik)) || unique.has(ticker)) continue;
    unique.set(ticker, {
      ticker,
      cik: validCik(cik) ? cik : "",
      rowId: typeof item?.rowId === "string" ? item.rowId.slice(0, 200) : "",
    });
    if (unique.size >= PORTFOLIO_CFTC_COMPANY_LIMIT) break;
  }
  return [...unique.values()];
}

async function companyEvent(company, { signal, loadContext, loadHistory }) {
  const context = await loadContext({ ticker: company.ticker }, { signal });
  if (context?.status !== "ready" || !Array.isArray(context.links) || !context.links.length)
    return { status: "no_link", company };
  const candidate = context.links[0];
  const history = await loadHistory({
    family: candidate.family,
    code: candidate.contract,
    group: candidate.group,
    reportDate: "latest",
    window: "1y",
    signal,
  });
  const change = cftcPositionChange(history, 1);
  const selected = history?.selected;
  const values = selected?.selectedGroup;
  if (!change.available || !dateValue(selected?.reportDate))
    return { status: "no_comparison", company };
  const marketQuery = new URLSearchParams({
    tab: "positioning",
    family: candidate.family,
    contract: candidate.contract,
    group: candidate.group,
    date: selected.reportDate,
    history: "1y",
    display: "net-oi",
  });
  const netChange = change.netChange;
  const direction = netChange > 0 ? "increased" : netChange < 0 ? "decreased" : "was unchanged";
  const groupLabel = values?.label || candidate.group;
  return {
    status: "ready",
    event: {
      id: `${company.ticker}:${candidate.family}:${candidate.contract}:${candidate.group}:${selected.reportDate}`,
      source: "cftc",
      ticker: company.ticker,
      cik: company.cik || context.cik || "",
      rowId: company.rowId,
      companyName: context.companyName || company.ticker,
      reportDate: selected.reportDate,
      priorDate: change.priorDate,
      title: `${candidate.label}: ${groupLabel} positioning ${direction}`,
      description: change.explanation,
      family: candidate.family,
      contract: candidate.contract,
      contractName: selected.contractName || candidate.label,
      exchange: selected.exchange || "",
      traderGroup: candidate.group,
      traderGroupLabel: groupLabel,
      netChange,
      netPctChange: finite(change.netPctChange) ? change.netPctChange : null,
      longChange: change.longChange,
      shortChange: change.shortChange,
      netPctOi: finite(values?.netPctOi) ? values.netPctOi : null,
      openInterest: finite(selected.openInterest) ? selected.openInterest : null,
      candidate: {
        label: candidate.label,
        reason: candidate.reason,
        reviewQuestion: candidate.reviewQuestion,
        filing: candidate.evidence?.[0]
          ? {
              form: candidate.evidence[0].form,
              filed: candidate.evidence[0].filed,
              url: candidate.evidence[0].url,
              accession: candidate.evidence[0].accession,
            }
          : null,
      },
      cftcSource: typeof history?.source?.url === "string" ? history.source.url : "",
      marketPath: `/market?${marketQuery.toString()}`,
      freshness: history?.freshness || null,
      historyStatus: history?.status || "unknown",
    },
  };
}

/**
 * Build a compact market-context feed for a bounded priority set of portfolio issuers.
 * A company is included only when an SEC annual filing produced a candidate connection
 * to a supported CFTC market. The CFTC observation remains aggregate market context.
 */
export async function buildPortfolioCftcChanges(
  { companies = [], days = 30 } = {},
  {
    signal,
    now = new Date(),
    loadContext = loadCompanyCftcContext,
    loadHistory = loadCftcHistory,
  } = {},
) {
  const requested = normalizeCompanies(companies);
  const cutoff = cutoffDate(Number(days) || 30, now);
  const settled = await Promise.allSettled(
    requested.map((company) => companyEvent(company, { signal, loadContext, loadHistory })),
  );
  const events = [];
  let linked = 0;
  let checked = 0;
  let unavailable = 0;
  for (const result of settled) {
    if (result.status === "rejected") {
      unavailable += 1;
      continue;
    }
    checked += 1;
    if (result.value.status === "ready") {
      linked += 1;
      if (result.value.event.reportDate >= cutoff) events.push(result.value.event);
    } else if (result.value.status !== "no_link") {
      linked += 1;
    }
  }
  events.sort(
    (a, b) =>
      b.reportDate.localeCompare(a.reportDate) ||
      Math.abs(b.netPctChange || 0) - Math.abs(a.netPctChange || 0) ||
      a.ticker.localeCompare(b.ticker),
  );
  return {
    schemaVersion: PORTFOLIO_CFTC_CHANGES_VERSION,
    generatedAt: new Date(now).toISOString(),
    cutoff,
    events,
    coverage: {
      requested: requested.length,
      checked,
      linked,
      unavailable,
      events: events.length,
      limited: (companies || []).length > requested.length,
      companyLimit: PORTFOLIO_CFTC_COMPANY_LIMIT,
    },
    limitation:
      "CFTC events are aggregate futures positioning for markets linked by candidate SEC filing passages. They do not represent the company’s own futures position, hedge size, cash flow, or a price forecast.",
  };
}
