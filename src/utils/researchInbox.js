import { allocationSummary } from "./portfolioModel.js";
import { portfolioReviewPriorities } from "./portfolioInsights.js";

export const RESEARCH_INBOX_KEY = "edgar:research-inbox:v1";
export const RESEARCH_INBOX_LIMIT = 1000;
export const RESEARCH_INBOX_STORAGE_LIMIT = 512 * 1024;
const DAY = 86400000;
const bytes = (value) => new TextEncoder().encode(value).length;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const date = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
const ticker = (value) =>
  typeof value === "string" && /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(value);
const cik = (value) => typeof value === "string" && /^\d{10}$/.test(value);
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const plainKeys = (value, allowed) =>
  object(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Object.keys(value).every((key) => allowed.includes(key));

/** Inbox acknowledgements are independent from filing refresh and company review baselines. */
export function validateResearchInbox(store) {
  requireValue(
    plainKeys(store, ["version", "updatedAt", "items"]) && store.version === 1,
    "The saved research inbox format is invalid.",
  );
  requireValue(
    store.updatedAt === null || date(store.updatedAt),
    "The inbox save date is invalid.",
  );
  requireValue(
    Array.isArray(store.items) && store.items.length <= RESEARCH_INBOX_LIMIT,
    "The inbox supports at most 1,000 saved review decisions. Existing decisions have been preserved.",
  );
  const ids = new Set();
  for (const item of store.items) {
    requireValue(
      plainKeys(item, ["id", "status", "updatedAt", "snoozedUntil"]),
      "An inbox decision contains unsupported fields.",
    );
    requireValue(
      typeof item.id === "string" &&
        /^inbox:[a-z]+:[a-f0-9]{32}$/.test(item.id) &&
        !ids.has(item.id),
      "An inbox decision has an invalid or duplicate identity.",
    );
    ids.add(item.id);
    requireValue(
      ["open", "reviewed", "snoozed"].includes(item.status) &&
        date(item.updatedAt),
      "An inbox decision has an invalid status or date.",
    );
    requireValue(
      item.status === "snoozed"
        ? date(item.snoozedUntil) &&
            Date.parse(item.snoozedUntil) > Date.parse(item.updatedAt)
        : item.snoozedUntil === null,
      "The inbox snooze date is invalid.",
    );
  }
  requireValue(
    bytes(JSON.stringify(store)) <= RESEARCH_INBOX_STORAGE_LIMIT,
    "Saved inbox decisions exceed the 512 KiB storage limit. Existing decisions have been preserved.",
  );
  return store;
}

export function readResearchInbox(raw) {
  if (raw === null || raw === undefined)
    return { version: 1, updatedAt: null, items: [] };
  try {
    requireValue(
      typeof raw === "string" && bytes(raw) <= RESEARCH_INBOX_STORAGE_LIMIT,
      "The inbox data exceeds its storage limit.",
    );
    return validateResearchInbox(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `The research inbox could not be read. Existing browser data has been preserved. ${error instanceof Error ? error.message : "The saved format is invalid."}`,
    );
  }
}

/** Fresh read, conflict check, then one bounded write; never stores source content or private allocations.
 * @param {any} storage
 * @param {{id:string,status:'open'|'reviewed'|'snoozed',snoozedUntil?:string,expectedUpdatedAt?:string|null,now?:string}} options
 */
export function updateResearchInbox(
  storage,
  {
    id,
    status,
    snoozedUntil,
    expectedUpdatedAt,
    now = new Date().toISOString(),
  },
) {
  requireValue(date(now), "The inbox update date is invalid.");
  let original;
  try {
    original = storage.getItem(RESEARCH_INBOX_KEY);
  } catch {
    throw new Error(
      "Browser storage is unavailable. Your inbox decision has not been saved.",
    );
  }
  const current = readResearchInbox(original);
  const existing = current.items.find((item) => item.id === id);
  requireValue(
    expectedUpdatedAt === undefined ||
      expectedUpdatedAt === (existing?.updatedAt || null),
    "This inbox decision changed in another tab. Review the current status and try again.",
  );
  const updatedAt = new Date(
    Math.max(
      Date.parse(now),
      Date.parse(existing?.updatedAt || "") + 1 || 0,
      Date.parse(current.updatedAt || "") + 1 || 0,
    ),
  ).toISOString();
  const next = {
    id,
    status,
    updatedAt,
    snoozedUntil:
      status === "snoozed"
        ? snoozedUntil ||
          new Date(Date.parse(updatedAt) + 7 * DAY).toISOString()
        : null,
  };
  const result = {
    version: 1,
    updatedAt,
    items: [...current.items.filter((item) => item.id !== id), next],
  };
  validateResearchInbox(result);
  try {
    requireValue(
      storage.getItem(RESEARCH_INBOX_KEY) === original,
      "The inbox changed while this update was being prepared. Please try again.",
    );
    storage.setItem(RESEARCH_INBOX_KEY, JSON.stringify(result));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The inbox changed"))
      throw error;
    throw new Error(
      "Browser storage is full or unavailable. Your inbox decision was not saved; existing decisions are unchanged.",
    );
  }
  return result;
}

/** Opaque, deterministic evidence identity. Four independent hashes avoid storing evidence text in local status records. */
function evidenceId(kind, values) {
  const value = JSON.stringify(values);
  const digest = [2166136261, 2246822519, 3266489917, 668265263]
    .map((seed) => {
      let hash = seed;
      for (let index = 0; index < value.length; index++)
        hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
      return (hash >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
  return `inbox:${kind}:${digest}`;
}

export function safeInboxUrl(value, secOnly = false) {
  if (typeof value !== "string" || value.length > 4000) return null;
  if (
    !secOnly &&
    /^\/(?:analysis(?:\/|\?)|filings(?:\/|\?)|disclosures(?:\?|$)|workspace(?:\?|$)|fund(?:\/|\?|$))/.test(
      value,
    ) &&
    !value.includes("\\") &&
    !/[\u0000-\u001f]/.test(value)
  )
    return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const CONDITION = {
  identity: {
    title: "Confirm company identity",
    label: "Resolve identity",
    order: 0,
  },
  coverage: {
    title: "Investigate missing coverage",
    label: "Check evidence gap",
    order: 1,
  },
  freshness: {
    title: "Check evidence freshness",
    label: "Check older evidence",
    order: 2,
  },
  filing: {
    title: "Read a recent filing",
    label: "Read new evidence",
    order: 3,
  },
  queue: {
    title: "Review a saved filing",
    label: "Your saved queue",
    order: 4,
  },
  metric: {
    title: "Investigate a reported result",
    label: "Examine a reported value",
    order: 5,
  },
  watchlist: {
    title: "Review a watchlist company",
    label: "Your review schedule",
    order: 6,
  },
};
const dateText = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : "";

/** Derives visible conditions from validated local research. No network calls or acknowledgement writes.
 * @param {{portfolios?:any[],watchlist?:any[],vault?:any,states?:any,now?:number}} input
 */
export function deriveResearchInbox({
  portfolios = [],
  watchlist = [],
  vault = { entries: [] },
  states = readResearchInbox(null),
  now = Date.now(),
} = {}) {
  validateResearchInbox(states);
  const decisions = new Map(states.items.map((item) => [item.id, item]));
  const items = [];
  const ids = new Set();
  const warnings = [];
  const companyKeys = new Map();
  for (const portfolio of portfolios) {
    for (const row of portfolio.rows || []) {
      if (
        ["resolved", "unsupported"].includes(row.resolution?.status) &&
        ticker(row.resolution?.ticker) &&
        cik(row.resolution?.cik)
      )
        companyKeys.set(row.resolution.ticker, row.resolution.cik);
    }
    for (const company of portfolio.snapshot?.companies || []) {
      if (ticker(company.ticker) && cik(company.cik))
        companyKeys.set(company.ticker, company.cik);
    }
  }
  const push = (kind, identity, details) => {
    const id = evidenceId(kind, identity);
    if (ids.has(id)) return;
    ids.add(id);
    const decision = decisions.get(id);
    const status =
      decision?.status === "snoozed" && Date.parse(decision.snoozedUntil) <= now
        ? "open"
        : decision?.status || "open";
    const condition = CONDITION[kind];
    items.push({
      id,
      kind,
      status,
      title: condition.title,
      priorityLabel: condition.label,
      priorityOrder: condition.order,
      ...details,
      sourceUrl: safeInboxUrl(details.sourceUrl, true),
      companyUrl: safeInboxUrl(details.companyUrl),
      portfolioUrl: safeInboxUrl(details.portfolioUrl),
      stateUpdatedAt: decision?.updatedAt || null,
      snoozedUntil: status === "snoozed" ? decision.snoozedUntil : null,
    });
  };
  for (const portfolio of portfolios) {
    try {
      const companies = portfolio.snapshot?.companies || [];
      const byCik = new Map(companies.map((company) => [company.cik, company]));
      const allocation = allocationSummary(
        portfolio.rows,
        portfolio.allocation,
        Object.fromEntries(byCik),
      );
      const rowsById = new Map(portfolio.rows.map((row) => [row.id, row]));
      const detailsFor = (row, company) => {
        const symbol = ticker(row.resolution?.ticker)
          ? row.resolution.ticker
          : ticker(company?.ticker)
            ? company.ticker
            : "";
        const identity = cik(row.resolution?.cik) ? row.resolution.cik : "";
        return {
          ticker: symbol,
          cik: identity,
          companyKey: identity || symbol || `${portfolio.id}:${row.id}`,
          companyName:
            row.resolution?.name ||
            company?.name ||
            symbol ||
            row.input.company_name ||
            row.input.ticker ||
            "Unidentified row",
          instrumentKind: row.resolution?.kind,
          portfolioId: portfolio.id,
          portfolioName: portfolio.name,
          rowId: row.id,
          source: "Portfolio research",
          capturedAt: date(company?.retrievedAt)
            ? company.retrievedAt
            : undefined,
          companyUrl:
            row.resolution?.kind === "fund"
              ? symbol
                ? `/fund?tickers=${encodeURIComponent(symbol)}`
                : "/fund"
              : symbol
                ? `/analysis/${encodeURIComponent(symbol)}`
                : identity
                  ? `/disclosures?tickers=${identity}&mode=companies`
                  : null,
          portfolioUrl: `/workspace?view=portfolios&portfolio=${encodeURIComponent(portfolio.id)}`,
          evidenceDate: "",
          sourceUrl: null,
        };
      };
      for (const priority of portfolioReviewPriorities(
        portfolio.rows,
        companies,
        allocation,
        now,
      )) {
        if (priority.kind === "filing") continue; // Every accession is assessed below.
        const row = rowsById.get(priority.rowId);
        if (!row) continue;
        if (
          priority.kind === "identity" &&
          row.resolution?.kind === "fund" &&
          row.resolution?.status === "unsupported"
        )
          continue;
        const company = byCik.get(row.resolution?.cik);
        if (priority.kind === "coverage") {
          push(
            "coverage",
            [
              portfolio.id,
              row.id,
              row.resolution?.cik,
              priority.weightPct,
              priority.reason,
              company?.period,
            ],
            {
              ...detailsFor(row, company),
              reason: priority.reason,
              evidenceDate: dateText(company?.period?.end),
            },
          );
          continue;
        }
        const point = company?.metrics?.[priority.metric];
        const capturedSource = (point?.sources || company?.filings || []).find(
          (source) => source.documentUrl === priority.url,
        );
        const identity =
          priority.kind === "metric"
            ? [
                portfolio.id,
                row.resolution?.cik,
                priority.metric,
                point?.value,
                point?.unit,
                point?.period,
                company?.period,
                (point?.sources || [])
                  .map((source) => [source.accession, source.documentUrl])
                  .sort(),
              ]
            : priority.kind === "identity"
              ? [
                  portfolio.id,
                  row.id,
                  row.input.ticker,
                  row.input.company_name,
                  row.input.cik,
                  row.input.exchange,
                  row.resolution?.status,
                  row.resolution?.cik,
                  row.resolution?.kind,
                ]
              : [
                  portfolio.id,
                  priority.key,
                  priority.reason,
                  company?.period,
                  company?.cache?.status === "stale"
                    ? company?.cache?.storedAt
                    : null,
                ];
        push(priority.kind, identity, {
          ...detailsFor(row, company),
          reason: priority.reason,
          evidenceDate: dateText(point?.period?.end || company?.period?.end),
          sourceUrl: priority.url,
          ...(date(capturedSource?.capturedAt)
            ? { capturedAt: capturedSource.capturedAt }
            : {}),
        });
      }
      const seenCompanies = new Set();
      for (const row of portfolio.rows.filter(
        (entry) =>
          !entry.excluded &&
          !entry.mergedInto &&
          entry.duplicateChoice !== "remove" &&
          entry.resolution?.status === "resolved" &&
          entry.resolution?.kind === "company",
      )) {
        const company = byCik.get(row.resolution?.cik);
        if (
          !company ||
          !["company", "foreign"].includes(company.kind) ||
          seenCompanies.has(company.cik)
        )
          continue;
        seenCompanies.add(company.cik);
        for (const filing of company.filings || []) {
          const filed = Date.parse(filing.filingDate);
          if (
            !Number.isFinite(filed) ||
            now - filed < 0 ||
            now - filed > 30 * DAY
          )
            continue;
          push(
            "filing",
            [
              portfolio.id,
              company.cik,
              filing.accession || filing.documentUrl,
              filing.form,
              filing.filingDate,
            ],
            {
              ...detailsFor(row, company),
              title: `${filing.form || "SEC filing"} · ${filing.filingDate}`,
              reason: `This ${filing.form || "filing"} was filed within the last 30 days. Read the source and decide whether it changes your research.`,
              sourceUrl: filing.documentUrl,
              ...(date(filing.capturedAt)
                ? { capturedAt: filing.capturedAt }
                : {}),
              evidenceDate: filing.filingDate,
            },
          );
        }
      }
    } catch {
      warnings.push(
        `Research conditions for ${portfolio?.name || "a saved portfolio"} could not be derived. Its saved data has not been changed.`,
      );
    }
  }
  for (const row of watchlist) {
    if (row.kind !== "company" || !ticker(row.ticker)) continue;
    const reviewedAt = dateText(row.review?.reviewedAt);
    if (reviewedAt && now - Date.parse(reviewedAt) < 90 * DAY) continue;
    push("watchlist", [row.ticker, reviewedAt || "not-reviewed"], {
      ticker: row.ticker,
      cik: cik(row.cik) ? row.cik : "",
      companyKey: cik(row.cik)
        ? row.cik
        : companyKeys.get(row.ticker) || row.ticker,
      companyName: row.name || row.ticker,
      source: "Watchlist",
      portfolioId: "",
      rowId: "",
      reason: reviewedAt
        ? `The last company review was ${reviewedAt.slice(0, 10)}, at least 90 days ago. This is a scheduling reminder, not a new SEC finding.`
        : "No company review is saved for this watchlist entry. Start with its latest filings and record your research.",
      companyUrl: `/analysis/${encodeURIComponent(row.ticker)}`,
      sourceUrl: null,
      portfolioUrl: null,
      evidenceDate: reviewedAt,
    });
  }
  for (const entry of vault.entries || []) {
    if (
      entry.type !== "queue" ||
      !["Disclosures", "Filings"].includes(entry.source)
    )
      continue;
    const symbol = ticker(entry.ticker) ? entry.ticker : "";
    const sources = (entry.sources || [])
      .map((item) => ({
        url: safeInboxUrl(item.url, true),
        capturedAt: date(item.capturedAt) ? item.capturedAt : undefined,
      }))
      .filter((item) => item.url)
      .sort((a, b) => a.url.localeCompare(b.url));
    const sourceUrls = sources.map((item) => item.url);
    push(
      "queue",
      [entry.source, entry.id, entry.date, entry.title, entry.text, sourceUrls],
      {
        ticker: symbol,
        cik: "",
        companyKey: companyKeys.get(symbol) || symbol || entry.source,
        companyName: symbol || entry.source,
        source: `${entry.source} queue`,
        portfolioId: "",
        rowId: "",
        title: entry.title || "Review a saved filing",
        reason: entry.text || "You queued this filing in your saved research.",
        companyUrl: safeInboxUrl(entry.href),
        sourceUrl: sourceUrls[0] || null,
        capturedAt: sources[0]?.capturedAt,
        portfolioUrl: null,
        evidenceDate: dateText(entry.date),
      },
    );
  }
  const names = new Map();
  for (const item of items)
    if (item.companyName && item.companyName !== item.ticker)
      names.set(item.companyKey, item.companyName);
  for (const item of items)
    if (names.has(item.companyKey))
      item.companyName = names.get(item.companyKey);
  items.sort(
    (a, b) =>
      a.priorityOrder - b.priorityOrder ||
      b.evidenceDate.localeCompare(a.evidenceDate) ||
      a.companyName.localeCompare(b.companyName) ||
      a.id.localeCompare(b.id),
  );
  const counts = { open: 0, reviewed: 0, snoozed: 0, total: items.length };
  for (const item of items) counts[item.status]++;
  const companies = [
    ...new Map(
      items.map((item) => [
        item.companyKey,
        {
          key: item.companyKey,
          label: item.ticker
            ? `${item.ticker}${item.companyName !== item.ticker ? ` · ${item.companyName}` : ""}`
            : item.companyName,
        },
      ]),
    ).values(),
  ].sort((a, b) => a.label.localeCompare(b.label));
  return {
    items,
    counts,
    companies,
    kinds: [...new Set(items.map((item) => item.kind))],
    warnings,
  };
}
