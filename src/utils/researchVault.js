import { readFilingsNotebook } from "./filingsNotebook.js";

export const RESEARCH_STORAGE_EVENT = "research-storage";
export const RESEARCH_BACKUP_LIMIT = 16 * 1024 * 1024;
export const RESEARCH_STORES = [
  {
    key: "edgar:research-workspace:v1",
    label: "Company research",
    source: "Analysis",
  },
  {
    key: "edgar:compare-notebook:v1",
    label: "Peer comparisons",
    source: "Compare",
  },
  {
    key: "edgar:disclosure-notebook:v1",
    label: "Disclosure research",
    source: "Disclosures",
  },
  {
    key: "edgar:filings-notebook:v1",
    label: "Filings notebook",
    source: "Filings",
  },
  {
    key: "edgar:market-research:v1",
    label: "Market watchlist and views",
    source: "Market",
  },
  { key: "edgar-funds-shelf-v1", label: "Saved funds", source: "Funds" },
];
const keys = new Set(RESEARCH_STORES.map((s) => s.key));
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const bytes = (v) => new TextEncoder().encode(v).length;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ticker = (v) =>
  typeof v === "string" && /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(v);
const string = (v) => (typeof v === "string" ? v : "");
const fundNoteTicker = (key) =>
  typeof key === "string" &&
  key.startsWith("edgar-fund-notes:") &&
  ticker(key.slice(17))
    ? key.slice(17)
    : "";
const allowedKey = (key) => keys.has(key) || Boolean(fundNoteTicker(key));
const descriptor = (key) =>
  RESEARCH_STORES.find((s) => s.key === key) || {
    key,
    label: `${fundNoteTicker(key)} fund notes`,
    source: "Funds",
    ticker: fundNoteTicker(key),
    kind: "fund-note",
  };
function listResearchStores(storage) {
  const notes = [];
  if (typeof storage.key === "function") {
    const length = storage.length;
    requireShape(
      Number.isInteger(length) && length >= 0 && length <= 10000,
      "Browser storage could not be enumerated completely.",
    );
    for (let i = 0; i < length; i++) {
      const key = storage.key(i);
      if (fundNoteTicker(key)) notes.push(key);
    }
  }
  requireShape(
    notes.length <= 250,
    "This research backup supports at most 250 fund notebooks.",
  );
  return [...RESEARCH_STORES, ...[...new Set(notes)].sort().map(descriptor)];
}
function requireShape(ok, message) {
  if (!ok) throw new Error(message);
}
function array(value, name, max = 10000) {
  requireShape(
    Array.isArray(value) && value.length <= max,
    `${name} must be a bounded list.`,
  );
  return value;
}
function objects(value, name, max) {
  return array(value, name, max).map((v) => {
    requireShape(object(v), `${name} contains an invalid entry.`);
    return v;
  });
}
function optionalText(value, name) {
  requireShape(
    value === undefined || value === null || typeof value === "string",
    `${name} must be text.`,
  );
}
function settings(value) {
  requireShape(object(value), "Saved research settings are invalid.");
  for (const key of [
    "query",
    "tickers",
    "mode",
    "start",
    "end",
    "section",
    "scope",
    "basis",
    "asOf",
    "period",
    "alignment",
    "view",
    "metric",
    "x",
    "y",
    "sort",
    "direction",
    "benchmark",
    "lens",
    "display",
    "units",
    "baseline",
    "search",
    "statement",
    "family",
    "form",
    "item",
    "status",
    "movementScope",
    "movementSort",
    "growthMetric",
    "profitMetric",
    "chartMode",
    "rowScope",
    "vintageDate",
    "formulaA",
    "formulaB",
    "formulaC",
    "formulaOp",
    "formulaScale",
    "briefTitle",
  ])
    optionalText(value[key], `Saved setting ${key}`);
  if (value.forms !== undefined)
    requireShape(
      typeof value.forms === "string" ||
        (Array.isArray(value.forms) &&
          value.forms.every((v) => typeof v === "string")),
      "Saved forms are invalid.",
    );
  for (const key of [
    "depth",
    "years",
    "movementThreshold",
    "scenarioRevenue",
    "scenarioMargin",
    "scenarioLoss",
    "scenarioFunding",
  ])
    requireShape(
      value[key] === undefined ||
        (typeof value[key] === "number" && Number.isFinite(value[key])),
      `Saved setting ${key} must be a number.`,
    );
  for (const key of ["indexed", "descending"])
    requireShape(
      value[key] === undefined || typeof value[key] === "boolean",
      `Saved setting ${key} must be a flag.`,
    );
  if (value.amendments !== undefined)
    requireShape(
      typeof value.amendments === "boolean" ||
        ["include", "exclude", "only"].includes(value.amendments),
      "Saved amendments setting is invalid.",
    );
  for (const key of [
    "pins",
    "chart",
    "metrics",
    "excluded",
    "briefMetrics",
    "briefSections",
  ])
    if (value[key] !== undefined)
      requireShape(
        array(value[key], key, 1000).every((v) => typeof v === "string"),
        `Saved setting ${key} is invalid.`,
      );
}
function financialPeriod(value) {
  if (value === undefined || value === null) return;
  requireShape(object(value), "Saved financial period is invalid.");
  for (const key of ["start", "end", "kind", "fp", "filed", "label", "form"])
    optionalText(value[key], `Period ${key}`);
  for (const key of ["fy", "year", "quarter", "months"])
    requireShape(
      value[key] === undefined ||
        (typeof value[key] === "number" && Number.isFinite(value[key])) ||
        (typeof value[key] === "string" && /^\d+$/.test(value[key])),
      `Period ${key} is invalid.`,
    );
}
function financialSource(value) {
  requireShape(object(value), "Saved financial source is invalid.");
  for (const key of [
    "label",
    "unit",
    "start",
    "end",
    "filed",
    "tag",
    "form",
    "formula",
    "note",
    "accession",
    "taxonomy",
    "revisionNote",
    "classification",
  ])
    optionalText(value[key], `Source ${key}`);
  requireShape(
    value.value === undefined ||
      value.value === null ||
      (typeof value.value === "number" && Number.isFinite(value.value)),
    "Saved source value is invalid.",
  );
}
function evidencePoint(value) {
  if (value === undefined || value === null) return;
  requireShape(object(value), "Saved financial evidence is invalid.");
  requireShape(
    value.value === undefined ||
      value.value === null ||
      (typeof value.value === "number" && Number.isFinite(value.value)),
    "Saved financial value is invalid.",
  );
  for (const k of [
    "formula",
    "note",
    "reason",
    "classification",
    "label",
    "key",
    "format",
  ])
    optionalText(value[k], k);
  financialPeriod(value.period);
  for (const k of ["sources", "calculations"])
    if (value[k] !== undefined)
      objects(value[k], `Financial ${k}`).forEach(financialSource);
  if (value.source != null) financialSource(value.source);
}

/** Reject dangerous or unexpectedly large JSON before a backup can enter existing page components. */
function inspectTree(value) {
  let nodes = 0;
  function walk(v, depth = 0, key = "") {
    requireShape(
      ++nodes <= 500000 && depth <= 40,
      "Research data is too large or deeply nested.",
    );
    if (typeof v === "string") {
      requireShape(
        v.length <= 4 * 1024 * 1024,
        "A research field exceeds the size limit.",
      );
      if (/(?:url|href)$/i.test(key) && v) {
        let url;
        try {
          url = new URL(v);
        } catch {
          throw new Error("A saved source URL is invalid.");
        }
        requireShape(
          url.protocol === "https:" &&
            ["www.sec.gov", "data.sec.gov", "sec.gov"].includes(url.hostname) &&
            !url.username &&
            !url.password &&
            !url.port,
          "Saved source links must use HTTPS on SEC.gov.",
        );
      }
    } else if (Array.isArray(v)) {
      requireShape(
        v.length <= 100000,
        "A research list exceeds the size limit.",
      );
      v.forEach((item) => walk(item, depth + 1, key));
    } else if (object(v)) {
      requireShape(
        [Object.prototype, null].includes(Object.getPrototypeOf(v)),
        "Unsupported research object.",
      );
      for (const [k, item] of Object.entries(v)) {
        requireShape(
          !forbidden.has(k),
          "Unsafe object field in research data.",
        );
        walk(item, depth + 1, k);
      }
    } else
      requireShape(
        v === null ||
          typeof v === "boolean" ||
          (typeof v === "number" && Number.isFinite(v)),
        "Unsupported research value.",
      );
  }
  walk(value);
}

/** Validation preserves the original payload, including compatible fields added by individual research tools. */
export function validateResearchStore(key, raw) {
  requireShape(allowedKey(key), "Unknown research store.");
  requireShape(
    typeof raw === "string" && bytes(raw) <= RESEARCH_BACKUP_LIMIT,
    "Research store exceeds the size limit.",
  );
  if (fundNoteTicker(key)) {
    requireShape(
      raw.length <= 12000,
      "Fund notes must contain at most 12,000 characters.",
    );
    return raw;
  }
  const data = JSON.parse(raw);
  inspectTree(data);
  if (key === "edgar-funds-shelf-v1") {
    requireShape(
      array(data, "Saved funds", 30).every(ticker),
      "Saved funds contain an invalid ticker.",
    );
    return data;
  }
  requireShape(
    object(data) && data.version === 1,
    "This research format is not supported.",
  );
  if (key === "edgar:filings-notebook:v1") {
    readFilingsNotebook(raw);
    return data;
  }
  if (key === "edgar:research-workspace:v1") {
    requireShape(object(data.companies), "Company research is invalid.");
    requireShape(
      Object.keys(data.companies).length <= 1000,
      "Too many saved companies.",
    );
    for (const [t, company] of Object.entries(data.companies)) {
      requireShape(ticker(t) && object(company), "A saved company is invalid.");
      requireShape(
        company.ticker === undefined || company.ticker === t,
        "Company ticker does not match its saved key.",
      );
      for (const k of ["name", "notes", "reviewedAt", "analysisReviewedAt"])
        optionalText(company[k], k);
      for (const k of ["saved", "alerts"])
        requireShape(
          company[k] === undefined || typeof company[k] === "boolean",
          `${k} must be a flag.`,
        );
      if (company.evidence !== undefined)
        objects(company.evidence, "Company evidence", 1000).forEach((e) => {
          optionalText(e.label, "Evidence label");
          optionalText(e.text, "Evidence text");
          optionalText(e.notes, "Evidence notes");
          optionalText(e.format, "Evidence format");
          optionalText(e.collectedAt, "Evidence collection date");
          evidencePoint(e.point);
        });
      if (company.analysisViews !== undefined)
        objects(company.analysisViews, "Financial views", 1000).forEach((v) => {
          optionalText(v.name, "View name");
          optionalText(v.savedAt, "View save date");
          settings(v.settings);
        });
      for (const k of ["baseline", "analysisBaseline"])
        if (company[k] !== undefined && company[k] !== null) {
          requireShape(object(company[k]), "Review baseline is invalid.");
          for (const field of [
            "basis",
            "asOf",
            "version",
            "observedAt",
            "dataVersion",
            "reportAccession",
          ])
            optionalText(company[k][field], `Baseline ${field}`);
          financialPeriod(company[k].period);
          if (k === "baseline") {
            objects(company[k].metrics, "Review metrics").forEach(
              evidencePoint,
            );
            array(company[k].accessions, "Reviewed accessions");
          } else {
            requireShape(
              object(company[k].metrics),
              "Financial review metrics are invalid.",
            );
            Object.values(company[k].metrics).forEach(evidencePoint);
          }
        }
    }
    if (data.peerGroups !== undefined)
      objects(data.peerGroups, "Peer groups", 1000).forEach((g) => {
        optionalText(g.name, "Peer group name");
        requireShape(
          array(g.tickers, "Peer tickers", 100).every(ticker),
          "Invalid peer ticker.",
        );
      });
  } else if (key === "edgar:compare-notebook:v1") {
    optionalText(data.notes, "Comparison notes");
    optionalText(data.collectionName, "Collection name");
    objects(data.searches, "Saved comparisons", 1000).forEach((s) => {
      requireShape(
        typeof s.id === "string" &&
          typeof s.name === "string" &&
          typeof s.savedAt === "string",
        "Saved comparison metadata is invalid.",
      );
      requireShape(
        array(s.tickers, "Comparison tickers", 100).every(ticker),
        "Invalid comparison ticker.",
      );
      settings(s.settings);
    });
    objects(data.pins, "Comparison evidence", 10000).forEach((p) => {
      requireShape(
        ticker(p.ticker) &&
          typeof p.id === "string" &&
          typeof p.label === "string" &&
          typeof p.savedAt === "string" &&
          object(p.point),
        "Comparison evidence is invalid.",
      );
      for (const key of ["name", "cik", "metric", "format", "version"])
        optionalText(p[key], `Comparison ${key}`);
      evidencePoint(p.point);
      settings(p.settings);
      optionalText(p.notes, "Evidence notes");
      optionalText(p.tags, "Evidence tags");
    });
  } else if (key === "edgar:disclosure-notebook:v1") {
    objects(data.searches, "Disclosure searches", 1000).forEach((s) => {
      requireShape(
        typeof s.id === "string" && typeof s.name === "string",
        "Disclosure search metadata is invalid.",
      );
      settings(s.settings);
      for (const key of ["query", "tickers", "forms", "section", "scope"])
        requireShape(
          typeof s.settings[key] === "string",
          `Disclosure setting ${key} must be text.`,
        );
      requireShape(
        array(s.seen, "Reviewed disclosure IDs").every(
          (id) => typeof id === "string",
        ),
        "Reviewed disclosure IDs must be text.",
      );
      objects(s.inbox, "Disclosure inbox").forEach((i) => {
        requireShape(
          typeof i.id === "string" && typeof i.reviewed === "boolean",
          "Disclosure inbox item is invalid.",
        );
        for (const key of [
          "ticker",
          "form",
          "filingDate",
          "reportDate",
          "accession",
          "reason",
          "discoveredAt",
        ])
          optionalText(i[key], `Inbox ${key}`);
      });
      for (const k of ["createdAt", "lastChecked"]) optionalText(s[k], k);
      if (s.lastCoverage !== undefined)
        objects(s.lastCoverage, "Disclosure coverage").forEach((c) => {
          for (const key of ["ticker", "error"])
            optionalText(c[key], `Coverage ${key}`);
          for (const key of ["reviewed", "failed", "sectionUnavailable"])
            requireShape(
              c[key] === undefined ||
                (typeof c[key] === "number" && Number.isFinite(c[key])),
              `Coverage ${key} must be numeric.`,
            );
          requireShape(
            c.limited === undefined || typeof c.limited === "boolean",
            "Coverage limitation must be a flag.",
          );
        });
    });
    objects(data.collections, "Disclosure collections", 1000).forEach((c) => {
      requireShape(
        typeof c.id === "string" && typeof c.name === "string",
        "Disclosure collection metadata is invalid.",
      );
      objects(c.items, "Disclosure evidence").forEach((e) => {
        for (const k of ["id", "ticker", "quote", "section", "notes", "tags"])
          requireShape(
            typeof e[k] === "string",
            `Disclosure ${k} must be text.`,
          );
        for (const k of [
          "companyName",
          "cik",
          "accession",
          "form",
          "filingDate",
          "reportDate",
          "priorQuote",
          "comparisonAccession",
          "change",
          "languageLabel",
          "observedAt",
        ])
          optionalText(e[k], `Disclosure ${k}`);
        settings(e.settings);
      });
    });
    requireShape(
      data.labels === undefined || object(data.labels),
      "Disclosure labels are invalid.",
    );
  } else if (key === "edgar:market-research:v1") {
    requireShape(
      array(data.watchlist, "Market watchlist", 1000).every(ticker),
      "Invalid market ticker.",
    );
    objects(data.views, "Market views", 12).forEach((v) =>
      requireShape(
        typeof v.name === "string" && typeof v.query === "string",
        "Market view is invalid.",
      ),
    );
    requireShape(
      data.baselines === undefined || object(data.baselines),
      "Market review baselines are invalid.",
    );
    for (const [t, b] of Object.entries(data.baselines || {})) {
      requireShape(
        ticker(t) && object(b) && object(b.metrics) && object(b.reports),
        "Market company baseline is invalid.",
      );
      for (const key of ["name", "ticker", "version", "observedAt"])
        optionalText(b[key], `Market ${key}`);
      Object.values(b.reports).forEach(financialPeriod);
    }
  }
  return data;
}

function pathWithSettings(path, input = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (
      /^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(key) &&
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        Array.isArray(value))
    )
      params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return `${path}${params.size ? `?${params}` : ""}`;
}
const joinedTickers = (values) =>
  (Array.isArray(values) ? values : String(values || "").split(/[\s,;]+/))
    .filter(ticker)
    .join(",");
function compareDestination(values, settings = {}) {
  const peers = [...new Set(joinedTickers(values).split(",").filter(Boolean))];
  return peers.length >= 2 && peers.length <= 5
    ? pathWithSettings(`/compare/${peers.join(",")}`, settings)
    : "/compare";
}
const pointSummary = (point) =>
  !point
    ? ""
    : [
        point.value !== null && point.value !== undefined
          ? `Saved value: ${point.value}`
          : "Saved value unavailable",
        point.period?.end
          ? `${point.period.kind || "Period"} ending ${point.period.end}`
          : "",
        point.formula || point.note || "",
      ]
        .filter(Boolean)
        .join(" · ");
function entriesFor(source, data, store = {}) {
  const rows = [];
  const add = (type, t, title, text, href, date = "", id = "") =>
    rows.push({
      id: `${source}:${type}:${id || rows.length}`,
      type,
      source,
      ticker: string(t),
      title: string(title),
      text: string(text),
      href,
      date: string(date),
    });
  if (store.kind === "fund-note") {
    if (data)
      add(
        "note",
        store.ticker,
        `${store.ticker} fund research notes`,
        data,
        `/fund/${store.ticker}?tab=notebook`,
        "",
        `fund:${store.ticker}`,
      );
    return rows;
  }
  if (source === "Analysis") {
    for (const [t, c] of Object.entries(data.companies)) {
      if (c.saved)
        add(
          "company",
          t,
          c.name || t,
          "Saved company",
          `/analysis/${t}`,
          c.analysisReviewedAt || c.reviewedAt,
          t,
        );
      if (c.notes)
        add(
          "note",
          t,
          `${t} research notes`,
          c.notes,
          `/analysis/${t}?view=notebook`,
          c.analysisReviewedAt || c.reviewedAt,
          t,
        );
      for (const [i, e] of (c.evidence || []).entries())
        add(
          "evidence",
          t,
          e.label || "Collected financial evidence",
          [pointSummary(e.point), e.notes, e.text].filter(Boolean).join(" · "),
          `/analysis/${t}?view=notebook`,
          e.collectedAt || e.point?.period?.end,
          `${t}:${i}`,
        );
      for (const [i, v] of (c.analysisViews || []).entries())
        add(
          "search",
          t,
          v.name || "Saved financial view",
          `${v.settings.basis || "Annual"} financials`,
          pathWithSettings(`/analysis/${t}`, v.settings),
          v.savedAt,
          `${t}:${i}`,
        );
    }
    for (const [i, g] of (data.peerGroups || []).entries())
      add(
        "search",
        joinedTickers(g.tickers),
        g.name || "Saved peer group",
        "Peer comparison",
        compareDestination(g.tickers),
        "",
        `peers:${i}`,
      );
  } else if (source === "Compare") {
    const firstPeers =
      data.searches.find((s) => compareDestination(s.tickers) !== "/compare")
        ?.tickers || data.pins.map((p) => p.ticker);
    if (data.notes)
      add(
        "note",
        "",
        data.collectionName || "Peer research memo",
        data.notes,
        compareDestination(firstPeers, { view: "notebook" }) === "/compare"
          ? "/compare?view=notebook"
          : compareDestination(firstPeers, { view: "notebook" }),
      );
    for (const s of data.searches)
      add(
        "search",
        joinedTickers(s.tickers),
        s.name,
        "Saved comparison",
        compareDestination(s.tickers, s.settings),
        s.savedAt,
        s.id,
      );
    for (const p of data.pins) {
      const peers =
        data.searches.find(
          (s) =>
            s.tickers.includes(p.ticker) &&
            compareDestination(s.tickers) !== "/compare",
        )?.tickers || data.pins.map((p) => p.ticker);
      add(
        "evidence",
        p.ticker,
        p.label,
        [pointSummary(p.point), p.notes, p.tags].filter(Boolean).join(" · "),
        compareDestination(peers, { ...p.settings, view: "notebook" }) ===
          "/compare"
          ? pathWithSettings(`/compare/${p.ticker}`, {
              ...p.settings,
              view: "notebook",
            })
          : compareDestination(peers, { ...p.settings, view: "notebook" }),
        p.savedAt,
        p.id,
      );
    }
  } else if (source === "Disclosures") {
    for (const s of data.searches) {
      const href = pathWithSettings("/disclosures", s.settings);
      add(
        "search",
        s.settings.tickers,
        s.name,
        s.settings.query,
        href,
        s.lastChecked || s.createdAt,
        s.id,
      );
      for (const f of s.inbox.filter((f) => !f.reviewed))
        add(
          "queue",
          f.ticker,
          `${f.form || "Filing"} · ${s.name}`,
          f.reason || "Unreviewed disclosure match",
          href,
          f.discoveredAt || f.filingDate,
          `${s.id}:${f.id}`,
        );
    }
    for (const c of data.collections)
      for (const e of c.items)
        add(
          "evidence",
          e.ticker,
          `${c.name} · ${e.section}`,
          [e.quote, e.notes, e.tags].filter(Boolean).join(" · "),
          pathWithSettings("/disclosures", e.settings),
          e.observedAt || e.filingDate,
          `${c.id}:${e.id}`,
        );
  } else if (source === "Filings") {
    for (const [t, c] of Object.entries(data.companies)) {
      for (const [id, r] of Object.entries(c.records)) {
        const href = `/filings/${t}?view=notebook`;
        if (r.queued && !r.reviewedAt)
          add(
            "queue",
            t,
            `${r.filing.form} · ${r.filing.filingDate}`,
            r.notes || `Accession ${id}`,
            href,
            r.filing.filingDate,
            `${t}:${id}`,
          );
        else if (r.notes)
          add(
            "note",
            t,
            `${r.filing.form} filing notes`,
            r.notes,
            href,
            r.reviewedAt || r.filing.filingDate,
            `${t}:${id}`,
          );
      }
      for (const e of c.evidence)
        add(
          "evidence",
          t,
          `${e.filing.form} · ${e.paragraph.section || "Filing passage"}`,
          [e.paragraph.text, e.notes, (e.tags || []).join(", ")]
            .filter(Boolean)
            .join(" · "),
          `/filings/${t}?view=notebook`,
          e.filing.filingDate,
          `${t}:${e.id}`,
        );
      for (const v of c.views)
        add(
          "search",
          t,
          v.name,
          "Saved filings filter",
          pathWithSettings(`/filings/${t}`, v.settings),
          v.createdAt,
          `${t}:${v.id}`,
        );
    }
  } else if (source === "Market") {
    for (const t of data.watchlist)
      add(
        "company",
        t,
        data.baselines?.[t]?.name || t,
        "Market watchlist",
        `/market?q=${t}&tab=companies`,
        data.baselines?.[t]?.observedAt,
        t,
      );
    for (const [i, v] of data.views.entries())
      add(
        "search",
        "",
        v.name,
        "Saved market screen",
        pathWithSettings(
          "/market",
          Object.fromEntries(new URLSearchParams(v.query)),
        ),
        "",
        String(i),
      );
  } else if (source === "Funds")
    for (const t of data) add("fund", t, t, "Saved fund", `/fund/${t}`, "", t);
  return rows;
}

/** A read-only index. No migration or repair is attempted if an individual store is unreadable. */
export function readResearchVault(storage) {
  const entries = [],
    stores = [],
    issues = [],
    data = {};
  let descriptors = RESEARCH_STORES;
  try {
    descriptors = listResearchStores(storage);
  } catch (error) {
    issues.push({
      key: "fund-notes",
      label: "Fund notes",
      message:
        error instanceof Error
          ? error.message
          : "Fund notes could not be enumerated.",
    });
  }
  for (const store of descriptors) {
    let raw = null;
    try {
      raw = storage.getItem(store.key);
      const parsed =
        raw === null ? null : validateResearchStore(store.key, raw);
      const rows =
        parsed === null ? [] : entriesFor(store.source, parsed, store);
      if (parsed !== null) data[store.key] = parsed;
      entries.push(...rows);
      stores.push({
        ...store,
        present: raw !== null,
        valid: true,
        bytes: raw === null ? 0 : bytes(raw),
        count: rows.length,
        error: "",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Saved data is unavailable.";
      stores.push({
        ...store,
        present: raw !== null,
        valid: false,
        bytes: typeof raw === "string" ? bytes(raw) : 0,
        count: 0,
        error: message,
      });
      issues.push({ key: store.key, label: store.label, message });
    }
  }
  entries.sort(
    (a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
  );
  return {
    entries,
    stores,
    issues,
    data,
    totals: {
      entries: entries.length,
      evidence: entries.filter((e) => e.type === "evidence").length,
      searches: entries.filter((e) => e.type === "search").length,
      queued: entries.filter((e) => e.type === "queue").length,
      companies: new Set(
        entries.flatMap((e) => e.ticker.split(",").filter(ticker)),
      ).size,
    },
  };
}

/** Raw strings ensure a backup preserves even an unreadable store without silently normalizing it. */
export function exportResearchBackup(storage, now = new Date().toISOString()) {
  const stores = Object.fromEntries(
    listResearchStores(storage).map((s) => [s.key, storage.getItem(s.key)]),
  );
  const raw = JSON.stringify(
    { format: "edgar-research-backup", version: 1, exportedAt: now, stores },
    null,
    2,
  );
  requireShape(
    bytes(raw) <= RESEARCH_BACKUP_LIMIT,
    "Backup exceeds the 16 MiB portable file limit.",
  );
  return raw;
}

export function parseResearchBackup(raw) {
  requireShape(
    typeof raw === "string" && bytes(raw) <= RESEARCH_BACKUP_LIMIT,
    "Choose a JSON backup no larger than 16 MiB.",
  );
  let data = JSON.parse(raw);
  requireShape(object(data), "This file is not a research backup.");
  if (
    data.version === 1 &&
    object(data.companies) &&
    data.format === undefined
  ) {
    data = {
      format: "edgar-research-backup",
      version: 1,
      exportedAt: "",
      stores: { "edgar:research-workspace:v1": raw },
    };
  }
  requireShape(
    data.format === "edgar-research-backup" &&
      data.version === 1 &&
      object(data.stores),
    "This backup format is not supported.",
  );
  requireShape(
    Object.keys(data).every((k) =>
      ["format", "version", "exportedAt", "stores"].includes(k),
    ),
    "Unexpected fields in backup file.",
  );
  requireShape(
    Object.keys(data.stores).length > 0 &&
      Object.keys(data.stores).length <= 256 &&
      Object.keys(data.stores).every(allowedKey),
    "Backup contains an unknown research store or too many fund notebooks.",
  );
  const stores = {},
    issues = [];
  for (const [key, value] of Object.entries(data.stores)) {
    requireShape(
      value === null || typeof value === "string",
      "Backup stores must contain raw JSON text.",
    );
    stores[key] = value;
    if (value !== null)
      try {
        validateResearchStore(key, value);
      } catch (error) {
        issues.push({
          key,
          message:
            error instanceof Error ? error.message : "Invalid research store.",
        });
      }
  }
  return {
    format: data.format,
    version: 1,
    exportedAt: string(data.exportedAt),
    stores,
    issues,
  };
}

export function previewResearchRestore(storage, backup) {
  return Object.keys(backup.stores)
    .map(descriptor)
    .map((s) => {
      const incoming = backup.stores[s.key];
      let current,
        error = backup.issues.find((i) => i.key === s.key)?.message || "";
      try {
        current = storage.getItem(s.key);
        if (current !== null) validateResearchStore(s.key, current);
      } catch {
        error =
          error ||
          "Existing data is unreadable. This store cannot be replaced.";
      }
      let incomingCount = 0,
        currentCount = 0;
      if (!error) {
        if (incoming !== null)
          incomingCount = entriesFor(
            s.source,
            validateResearchStore(s.key, incoming),
            s,
          ).length;
        if (current !== null)
          currentCount = entriesFor(
            s.source,
            validateResearchStore(s.key, current),
            s,
          ).length;
      }
      return {
        ...s,
        incomingCount,
        currentCount,
        identical: current === incoming,
        conflict: current !== null && current !== incoming,
        available: incoming !== null && !error && current !== incoming,
        error,
        incomingEmpty: incoming === null,
      };
    });
}

/** Commit only explicitly selected stores, with a fresh conflict check and rollback on failed writes. */
export function restoreResearchVault(
  storage,
  backup,
  selectedKeys,
  beforeBackup,
) {
  const selected = [...new Set(selectedKeys)];
  requireShape(
    selected.length > 0 && selected.every(allowedKey),
    "Select at least one available research store.",
  );
  const before = parseResearchBackup(beforeBackup);
  const preview = previewResearchRestore(storage, backup);
  const originals = {};
  for (const key of selected) {
    requireShape(
      preview.find((s) => s.key === key)?.available,
      "A selected store is unavailable or already matches this backup.",
    );
    const expected = Object.hasOwn(before.stores, key)
      ? before.stores[key]
      : fundNoteTicker(key)
        ? null
        : undefined;
    requireShape(
      storage.getItem(key) === expected,
      "Saved research changed after the safety backup. Download a fresh backup and review the replacement again.",
    );
    originals[key] = storage.getItem(key);
    validateResearchStore(key, backup.stores[key]);
  }
  const written = [];
  try {
    for (const key of selected) {
      storage.setItem(key, backup.stores[key]);
      written.push(key);
    }
  } catch {
    const failed = [];
    for (const key of written.reverse()) {
      try {
        if (originals[key] === null) storage.removeItem(key);
        else storage.setItem(key, originals[key]);
      } catch {
        failed.push(key);
      }
    }
    throw new Error(
      failed.length
        ? "Restore failed and some prior data could not be restored automatically. Keep your downloaded safety backup and this page open."
        : "Restore failed. Previous saved data was restored; browser storage may be full or unavailable.",
    );
  }
  return { restored: selected.length };
}
