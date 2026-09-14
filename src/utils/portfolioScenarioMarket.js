import {
  CFTC_FAMILIES,
  CFTC_LAUNCH_CATALOG,
  CFTC_REPORT_BASIS,
  cftcDate,
  cftcGroup,
} from "./cftc.js";
import { canonicalPortfolioCik } from "./portfolioModel.js";
import {
  cftcContextChart,
  cftcPositionChange,
} from "./cftcContextAnalytics.js";

const DAY = 86400000;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const date = (value) => typeof value === "string" && cftcDate(value) === value;
const marketKey = (item) => `${item.family}:${item.contract}:${item.group}`;
const categories = {
  demand: ["energy", "metals", "agriculture", "currencies"],
  recovery: ["energy", "metals", "agriculture", "currencies"],
  cost: ["energy", "metals", "agriculture"],
  combined: ["energy", "metals", "agriculture", "currencies"],
  cash: ["rates", "currencies"],
  assets: ["rates", "currencies"],
};

/** Only SEC-bound discovery candidates become company-linked market choices. */
export function scenarioMarketCandidates(
  context,
  company,
  scenarioId,
  now = new Date(),
) {
  const cik = canonicalPortfolioCik(company?.cik);
  const ticker = String(company?.ticker || company?.tickers?.[0] || "")
    .trim()
    .toUpperCase();
  const today = new Date(now).toISOString().slice(0, 10);
  if (
    !cik ||
    !ticker ||
    context?.schemaVersion !== "edgar.company-cftc-context.v1" ||
    canonicalPortfolioCik(context.cik) !== cik ||
    context.ticker !== ticker ||
    !["ready", "no_matches", "no_filing"].includes(context.status)
  ) {
    return { verified: false, links: [], omitted: 0, preferredCount: 0 };
  }
  const links = new Map();
  let omitted = 0;
  for (const candidate of Array.isArray(context.links)
    ? context.links.slice(0, 8)
    : []) {
    const catalog = CFTC_LAUNCH_CATALOG.find(
      (item) =>
        item.family === candidate?.family && item.code === candidate?.contract,
    );
    if (
      !catalog ||
      candidate.group !==
        (candidate.family === "tff" ? "leveraged-funds" : "managed-money") ||
      !cftcGroup(candidate.family, candidate.group)
    ) {
      omitted++;
      continue;
    }
    const evidence = (
      Array.isArray(candidate.evidence) ? candidate.evidence.slice(0, 2) : []
    )
      .filter((item) => {
        if (
          !item ||
          !["10-K", "20-F", "40-F"].includes(item.form) ||
          !/^\d{10}-\d{2}-\d{6}$/.test(item.accession || "") ||
          !date(item.filed) ||
          item.filed > today ||
          (item.reportDate != null &&
            (!date(item.reportDate) || item.reportDate > item.filed)) ||
          typeof item.text !== "string" ||
          item.text.length < 35 ||
          item.text.length > 900
        )
          return false;
        const prefix = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${item.accession.replaceAll("-", "")}/`;
        return (
          typeof item.url === "string" &&
          item.url.startsWith(prefix) &&
          /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(
            item.url.slice(prefix.length),
          )
        );
      })
      .map(({ text, url, accession, form, filed, reportDate }) => ({
        text,
        url,
        accession,
        form,
        filed,
        reportDate: reportDate || null,
      }));
    if (!evidence.length) {
      omitted++;
      continue;
    }
    const key = marketKey(candidate);
    links.set(key, {
      key,
      family: candidate.family,
      contract: candidate.contract,
      group: candidate.group,
      groupLabel: cftcGroup(candidate.family, candidate.group).label,
      label: catalog.label,
      category: catalog.category,
      evidence,
      preferred: (categories[scenarioId] || []).includes(catalog.category),
      reason: String(
        candidate.reason ||
          "Review the filing passage to assess this market connection.",
      ).slice(0, 1000),
      reviewQuestion: String(
        candidate.reviewQuestion ||
          "Does the market match the disclosed business driver, including its maturity, region and hedges?",
      ).slice(0, 1000),
    });
  }
  const ordered = [...links.values()].sort(
    (a, b) =>
      Number(b.preferred) - Number(a.preferred) ||
      a.label.localeCompare(b.label),
  );
  return {
    verified: true,
    links: ordered,
    omitted,
    preferredCount: ordered.filter((item) => item.preferred).length,
  };
}

/** Validate the dataset and instrument before reusing exact-date CFTC analytics. */
export function scenarioMarketHistory(history, candidate, now = new Date()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const config = CFTC_FAMILIES[candidate?.family];
  if (
    !config ||
    !["ready", "partial", "stale"].includes(history?.status) ||
    history.schema_version !== "edgar.cftc-positioning.v1" ||
    history.report_family !== candidate.family ||
    history.report_basis !== CFTC_REPORT_BASIS ||
    history.selection?.contract !== candidate.contract ||
    history.selection?.group !== candidate.group ||
    history.selected?.code !== candidate.contract ||
    history.selected?.family !== candidate.family ||
    history.selected?.reportBasis !== CFTC_REPORT_BASIS ||
    history.selected?.selectedGroup?.id !== candidate.group ||
    !date(history.selected?.reportDate) ||
    history.selected.reportDate > today ||
    history.source?.dataset_id !== config.datasetId ||
    history.source?.report_basis !== CFTC_REPORT_BASIS ||
    !Array.isArray(history.history)
  )
    return null;
  try {
    const source = new URL(history.source.url);
    if (
      source.protocol !== "https:" ||
      source.hostname !== "publicreporting.cftc.gov" ||
      source.port ||
      source.username ||
      source.password ||
      source.pathname !== `/resource/${config.datasetId}.json`
    )
      return null;
  } catch {
    return null;
  }
  const latest = history.selected.reportDate;
  const earliest = new Date(Date.parse(`${latest}T00:00:00Z`) - 52 * 7 * DAY)
    .toISOString()
    .slice(0, 10);
  const byDate = new Map(),
    duplicates = new Set();
  let excluded = 0;
  for (const point of history.history.slice(0, 600)) {
    if (
      !date(point?.reportDate) ||
      point.reportDate > latest ||
      point.reportDate < earliest ||
      (point.raw &&
        (typeof point.raw.cftc_contract_market_code !== "string" ||
          point.raw.cftc_contract_market_code.trim() !== candidate.contract ||
          point.raw.futonly_or_combined !== "FutOnly"))
    ) {
      excluded++;
      continue;
    }
    if (byDate.has(point.reportDate)) duplicates.add(point.reportDate);
    const validOi = finite(point.openInterest) && point.openInterest > 0;
    const validPositions =
      [point.long, point.short].every((value) => finite(value) && value >= 0) &&
      (!validOi ||
        (point.long <= point.openInterest &&
          point.short <= point.openInterest));
    const net = validPositions ? point.long - point.short : null;
    byDate.set(point.reportDate, {
      reportDate: point.reportDate,
      long: validPositions ? point.long : null,
      short: validPositions ? point.short : null,
      net,
      openInterest: validOi ? point.openInterest : null,
      netPctOi:
        validPositions && validOi ? (100 * net) / point.openInterest : null,
    });
  }
  for (const value of duplicates) {
    byDate.delete(value);
    excluded++;
  }
  const points = [...byDate.values()].sort((a, b) =>
    a.reportDate.localeCompare(b.reportDate),
  );
  const missingWeeks = points.some(
    (point, index) =>
      index > 0 &&
      Date.parse(point.reportDate) - Date.parse(points[index - 1].reportDate) >
        7 * DAY,
  );
  const current = byDate.get(latest) || null;
  const weekly = cftcPositionChange({
    selected: { reportDate: latest },
    history: points,
  });
  const prior = byDate.get(weekly.priorDate);
  const openInterestChangePct =
    finite(current?.openInterest) && finite(prior?.openInterest)
      ? (100 * (current.openInterest - prior.openInterest)) / prior.openInterest
      : null;
  const ageDays = Math.floor(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latest}T00:00:00Z`)) /
      DAY,
  );
  const query = new URLSearchParams({
    tab: "positioning",
    family: candidate.family,
    contract: candidate.contract,
    group: candidate.group,
    date: latest,
    history: "1y",
    display: "net-oi",
  });
  return {
    points,
    current,
    weekly,
    openInterestChangePct,
    reportDate: latest,
    ageDays,
    excluded,
    chart: cftcContextChart(points),
    sourceUrl: history.source.url,
    marketPath: `/market?${query}`,
    incomplete:
      history.status !== "ready" ||
      excluded > 0 ||
      !current ||
      missingWeeks ||
      points.some((point) => point.netPctOi === null),
    stale:
      ageDays > 14 ||
      history.status === "stale" ||
      String(history.freshness?.cache_status).startsWith("stale"),
  };
}
