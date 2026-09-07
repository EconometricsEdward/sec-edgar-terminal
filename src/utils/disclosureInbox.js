import { filingEvidenceId } from "./disclosureNotebook.js";

const list = (value) => (Array.isArray(value) ? value : []);

/** One filing can belong to several independently reviewable research queries. */
export function buildDisclosureInbox(searches) {
  const filings = new Map();
  for (const search of list(searches)) {
    for (const item of list(search.inbox)) {
      const id = filingEvidenceId(item);
      if (!filings.has(id))
        filings.set(id, {
          id,
          filing: item,
          memberships: [],
          latestDiscovery: "",
        });
      const row = filings.get(id);
      if (
        row.memberships.some(
          (m) => m.searchId === search.id && m.itemId === item.id,
        )
      )
        continue;
      row.memberships.push({
        searchId: search.id,
        searchName: search.name,
        itemId: item.id,
        filing: item,
        reviewed: Boolean(item.reviewed),
        discoveredAt: item.discoveredAt || "",
        reason: item.reason || "Verified filing match",
        settings: { ...(item.searchSettings || search.settings) },
        capturedSettings: Boolean(item.searchSettings),
      });
      if ((item.discoveredAt || "") > row.latestDiscovery)
        row.latestDiscovery = item.discoveredAt;
    }
  }
  return [...filings.values()].sort(
    (a, b) =>
      b.latestDiscovery.localeCompare(a.latestDiscovery) ||
      String(b.filing.filingDate || "").localeCompare(
        String(a.filing.filingDate || ""),
      ) ||
      a.id.localeCompare(b.id),
  );
}

export function inboxReviewState(memberships) {
  const reviewed = memberships.filter((m) => m.reviewed).length;
  return reviewed === memberships.length
    ? "reviewed"
    : reviewed
      ? "partial"
      : "unreviewed";
}

/** Filters operate on memberships, so a reviewed hit in one query cannot hide another. */
export function filterDisclosureInbox(
  rows,
  {
    company = "",
    search = "",
    form = "",
    status = "unreviewed",
    text = "",
  } = {},
) {
  const needle = text.trim().toLocaleLowerCase();
  return rows.flatMap((row) => {
    if (company && !row.memberships.some((m) => m.filing.ticker === company))
      return [];
    if (form && row.filing.form !== form) return [];
    const memberships = row.memberships.filter(
      (m) => !search || m.searchId === search,
    );
    if (!memberships.length) return [];
    const state = inboxReviewState(memberships);
    if (status === "unreviewed" && state === "reviewed") return [];
    if (status === "reviewed" && state !== "reviewed") return [];
    if (status === "partial" && state !== "partial") return [];
    if (needle) {
      const haystack = [
        row.filing.ticker,
        row.filing.companyName,
        row.filing.cik,
        row.filing.accession,
        row.filing.form,
        row.filing.filingDate,
        ...memberships.flatMap((m) => [
          m.searchName,
          m.settings.query,
          m.reason,
          m.filing.ticker,
        ]),
      ]
        .join(" ")
        .toLocaleLowerCase();
      if (!haystack.includes(needle)) return [];
    }
    return [{ ...row, memberships, reviewState: state }];
  });
}

/** Call inside the storage updater; never replace inbox arrays captured by a render. */
export function reviewDisclosureInbox(current, targets, reviewed) {
  const selected = new Map();
  for (const target of list(targets)) {
    if (!selected.has(target.searchId))
      selected.set(target.searchId, new Set());
    selected.get(target.searchId).add(target.itemId);
  }
  return {
    ...current,
    searches: list(current.searches).map((search) => {
      const ids = selected.get(search.id);
      if (!ids) return search;
      return {
        ...search,
        inbox: list(search.inbox).map((item) =>
          ids.has(item.id) ? { ...item, reviewed: Boolean(reviewed) } : item,
        ),
      };
    }),
  };
}

export function disclosureInboxCoverage(searches) {
  const summaries = list(searches).map((search) => {
    const coverage = list(search.lastCoverage);
    return {
      searchId: search.id,
      hasCheck: Boolean(search.lastChecked),
      companies: coverage.length,
      reviewed: coverage.reduce((n, c) => n + (Number(c.reviewed) || 0), 0),
      failed: coverage.reduce((n, c) => n + (Number(c.failed) || 0), 0),
      unavailable: coverage.reduce(
        (n, c) => n + (Number(c.sectionUnavailable) || 0),
        0,
      ),
      companyErrors: coverage.filter((c) => c.error).length,
      limited: coverage.some((c) => c.limited),
    };
  });
  return summaries;
}
