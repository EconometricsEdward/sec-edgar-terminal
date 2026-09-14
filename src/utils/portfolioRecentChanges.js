const DAY_MS = 86400000;
const CIK = /^\d{10}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;

// SEC submission dates are calendar dates, not local-midnight timestamps.
function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
    ? value : null;
}

function instant(value) {
  const time = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value
      : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

function dateWindow(windowDays, now) {
  const time = instant(now);
  const days = Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : 30;
  if (time === null) return { time: null, currentDate: null, cutoffDate: null };
  const currentDate = new Date(time).toISOString().slice(0, 10);
  const midnight = Date.parse(`${currentDate}T00:00:00.000Z`);
  return {
    time,
    currentDate,
    // Last seven calendar days includes today and six preceding dates.
    cutoffDate: new Date(midnight - (Math.max(1, days) - 1) * DAY_MS).toISOString().slice(0, 10),
  };
}

export function isPortfolioRecentDate(value, windowDays = 30, now = Date.now()) {
  const date = calendarDate(value);
  const { currentDate, cutoffDate } = dateWindow(windowDays, now);
  return Boolean(date && cutoffDate && date >= cutoffDate && date <= currentDate);
}

function safeSecDocument(filing, company) {
  try {
    const url = new URL(filing.documentUrl);
    const path = url.pathname.match(/^\/Archives\/edgar\/data\/(\d{1,10})\/(\d{18})\/[^/]+$/);
    if (!path || path[2] !== filing.accession?.replaceAll("-", "")) return false;
    const sourceCik = path[1].padStart(10, "0");
    const continuity = company?.evidenceContinuity;
    // A filing agent's accession prefix can differ from the registrant CIK.
    // Validate the accession directory and source registrant independently.
    const matchesCompany = sourceCik === company?.cik
      || (filing.sourceCik === sourceCik && continuity?.currentCik === company?.cik
        && continuity?.predecessorCiks?.includes(sourceCik)
        && continuity?.filingSourceCiks?.includes(sourceCik));
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname)
      && matchesCompany && (!filing.sourceCik || filing.sourceCik === sourceCik);
  } catch { return false; }
}

function checked(company) {
  return Boolean(company && company.status !== "failed"
    && !["stale", "unavailable"].includes(company.cache?.status)
    && !["pending", "not_checked", "failed", "stale"].includes(company.refreshStatus));
}

function includedRows(rows) {
  const result = new Map();
  for (const row of rows || []) {
    const cik = row.resolution?.cik;
    if (CIK.test(cik || "") && !row.excluded && !row.mergedInto
      && row.duplicateChoice !== "remove" && !result.has(cik)) result.set(cik, row);
  }
  return result;
}

function filingCopy(filing) {
  const form = typeof filing.form === "string" && filing.form.trim() ? filing.form.trim() : "SEC";
  const base = form.replace(/\/A$/, "");
  const amended = /\/A$/.test(form);
  const names = {
    "10-K": "annual report", "20-F": "annual report", "40-F": "annual report",
    "10-Q": "quarterly report", "8-K": "current report", "6-K": "foreign issuer report",
  };
  const title = `${form} ${amended ? "amendment" : names[base] || "filing"} submitted`;
  const reportDate = calendarDate(filing.reportDate);
  const description = `Submitted to the SEC on ${filing.filingDate}.${reportDate ? ` Report date: ${reportDate}.` : ""}${amended
    ? " An amendment does not by itself establish a financial restatement."
    : base === "8-K" || base === "6-K"
      ? "Open the source to review the reported developments; financial impact is not inferred from the form alone."
      : "Open the source to review the disclosed financial results and risks."}`;
  return { title, description };
}

/**
 * Filing publication dates establish recent SEC activity independently of a saved
 * comparison. Baseline differences retain their actual observation timestamp;
 * neither an old capture nor an undated filing is promoted into a recent event.
 */
export function buildPortfolioRecentSecEvents({
  comparison = null, snapshot = null, rows = [], windowDays = 30,
  now = Date.now(), weights = {},
} = {}) {
  const window = dateWindow(windowDays, now);
  const included = includedRows(rows);
  const companies = new Map((snapshot?.companies || []).map((company) => [company.cik, company]));
  const captureTime = instant(snapshot?.generated_at);
  const observedAt = captureTime !== null && window.time !== null && captureTime <= window.time
    ? new Date(captureTime).toISOString() : null;
  const observedDate = observedAt?.slice(0, 10) || null;
  const result = {
    events: [], coverageEvents: [], warnings: [],
    excludedUndatedFilings: 0, excludedFutureFilings: 0, excludedUnverifiedFilings: 0,
    checkedIssuers: 0, uncheckedIssuers: 0, truncatedIssuers: 0, windowLimitedIssuers: 0,
    snapshotAgeDays: observedAt ? Math.floor((window.time - captureTime) / DAY_MS) : null,
    cutoffDate: window.cutoffDate, currentDate: window.currentDate,
  };
  const recent = (date) => isPortfolioRecentDate(date, windowDays, now);
  for (const [cik, row] of included) {
    const company = companies.get(cik);
    if (checked(company)) result.checkedIssuers++;
    else result.uncheckedIssuers++;
    if (company?.filingCoverage?.truncated) {
      result.truncatedIssuers++;
      const listedDates = (company.filings || [])
        .filter((filing) => safeSecDocument(filing, company))
        .map((filing) => calendarDate(filing.filingDate)).filter(Boolean).sort();
      // An older annual/interim reference outside the ordered feed cannot prove
      // the intervening filing history is complete, so only use the feed itself.
      if (!listedDates.length || (window.cutoffDate && listedDates[0] >= window.cutoffDate))
        result.windowLimitedIssuers++;
    }
    const seen = new Set();
    // Prefer complete source rows if a saved list contains an incomplete duplicate.
    const filings = [...(company?.filings || []), company?.latestAnnualFiling, company?.latestInterimFiling]
      .filter(Boolean)
      .sort((a, b) => Number(safeSecDocument(b, company)) - Number(safeSecDocument(a, company))
        || Number(Boolean(calendarDate(b.filingDate))) - Number(Boolean(calendarDate(a.filingDate))));
    for (const filing of filings) {
      if (seen.has(filing.accession)) continue;
      seen.add(filing.accession);
      if (!ACCESSION.test(filing.accession || "") || !safeSecDocument(filing, company)) {
        result.excludedUnverifiedFilings++;
        continue;
      }
      const eventDate = calendarDate(filing.filingDate);
      if (!eventDate) { result.excludedUndatedFilings++; continue; }
      if (window.currentDate && eventDate > window.currentDate) { result.excludedFutureFilings++; continue; }
      if (!recent(eventDate)) continue;
      result.events.push({
        cik, rowId: row.id, ticker: row.resolution?.ticker || company?.ticker || "",
        companyName: company?.name || row.resolution?.name || cik,
        id: `${cik}:filing:${filing.accession}`, kind: "filing", source: "sec",
        ...filingCopy(filing), eventDate, dateBasis: "filed", observedAt,
        before: "Source-dated SEC filing", after: filing.accession,
        beforeSources: [], afterSources: [filing.documentUrl],
        filing, fresh: checked(company),
        knownWeightPct: Number.isFinite(weights[cik]) ? weights[cik] : null,
      });
    }
  }
  const baselineTime = instant(comparison?.baselineAt);
  // A later checkpoint cannot describe an earlier observation as a new change.
  if (comparison?.state === "ready" && observedAt && (baselineTime === null || baselineTime <= captureTime)) {
    for (const change of comparison.changes || []) {
      if (!included.has(change.cik) || change.kind === "filing") continue;
      const event = {
        ...change, source: "sec", eventDate: observedDate, dateBasis: "observed", observedAt,
        filing: null, knownWeightPct: Number.isFinite(weights[change.cik]) ? weights[change.cik] : null,
      };
      if (change.kind === "coverage") { result.coverageEvents.push(event); continue; }
      if (change.fresh === false || !checked(companies.get(change.cik)) || !recent(observedDate)) continue;
      result.events.push(event);
    }
  }
  if (result.snapshotAgeDays >= 1) result.warnings.push(
    `SEC research was captured ${result.snapshotAgeDays} day${result.snapshotAgeDays === 1 ? "" : "s"} ago. More recent filings may be missing until research is refreshed.`,
  );
  if (snapshot && !observedAt) result.warnings.push(
    "The research capture date is missing, invalid, or in the future. Only filings with valid SEC submission dates can appear as recent activity.",
  );
  if (result.uncheckedIssuers) result.warnings.push(
    `${result.uncheckedIssuers} compan${result.uncheckedIssuers === 1 ? "y needs" : "ies need"} a completed research check. Retained source-dated filings may be shown; filing coverage may be incomplete.`,
  );
  if (result.windowLimitedIssuers) result.warnings.push(
    `${result.windowLimitedIssuers} compan${result.windowLimitedIssuers === 1 ? "y's" : "ies'"} captured filing list may omit filings inside the selected window because the returned history is capped.`,
  );
  if (result.excludedUndatedFilings) result.warnings.push(
    `${result.excludedUndatedFilings} filing${result.excludedUndatedFilings === 1 ? " was" : "s were"} omitted because the SEC submission date is missing or invalid.`,
  );
  if (result.excludedFutureFilings) result.warnings.push(
    `${result.excludedFutureFilings} filing${result.excludedFutureFilings === 1 ? " has" : "s have"} a future submission date and ${result.excludedFutureFilings === 1 ? "was" : "were"} omitted.`,
  );
  if (result.excludedUnverifiedFilings) result.warnings.push(
    `${result.excludedUnverifiedFilings} filing reference${result.excludedUnverifiedFilings === 1 ? " was" : "s were"} omitted because the SEC document URL could not be matched to the filing accession and company or verified predecessor.`,
  );
  if (baselineTime !== null && captureTime !== null && baselineTime > captureTime) result.warnings.push(
    "The comparison checkpoint is later than the current research capture. Evidence comparisons are unavailable until research is refreshed.",
  );
  result.events.sort((a, b) => b.eventDate.localeCompare(a.eventDate)
    || a.ticker.localeCompare(b.ticker) || a.id.localeCompare(b.id));
  return result;
}
