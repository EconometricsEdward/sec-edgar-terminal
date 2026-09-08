import { validatePortfolioBaseline } from "./portfolioChanges.js";

/** Versioned, browser-local portfolio documents. Uploaded file contents are never stored. */
export const PORTFOLIOS_KEY = "edgar:portfolios:v1";
export const PORTFOLIO_LIMIT = 20;
export const PORTFOLIO_ROW_LIMIT = 100;
export const PORTFOLIO_STORAGE_LIMIT = 4 * 1024 * 1024;
export const PORTFOLIO_STORAGE_EVENT = "research-storage";

const INPUT_FIELDS = [
  "ticker",
  "company_name",
  "cik",
  "exchange",
  "weight_pct",
  "market_value",
  "shares",
  "currency",
  "as_of_date",
  "notes",
];
const NUMBER_FIELDS = new Set(["weight_pct", "market_value", "shares"]);
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 2000) =>
  typeof value === "string" && value.length <= max;
const identifier = (value) =>
  text(value, 100) && /^[A-Za-z0-9_-]+$/.test(value);
const timestamp = (value) =>
  text(value, 40) &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));
const bytes = (value) => new TextEncoder().encode(value).length;
const clone = (value) => JSON.parse(JSON.stringify(value));
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function validSourceUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

/** Validate before cloning: JSON round trips alone do not reject malicious prototype fields. */
function inspectPortfolioTree(value) {
  let nodes = 0;
  function walk(entry, depth = 0, key = "") {
    requireValue(
      ++nodes <= 500000 && depth <= 24,
      "Portfolio research is too large or deeply nested.",
    );
    if (key === "comparisonBaseline") {
      validatePortfolioBaseline(entry);
      return;
    }
    if (key === "fundUrl") {
      requireValue(
        typeof entry === "string" &&
          /^\/fund(?:\?tickers=[A-Z0-9][A-Z0-9.%,-]{0,60})?$/.test(entry),
        "The saved fund destination is invalid.",
      );
    } else if (/(?:url|href)s?$/i.test(key) && entry !== null && entry !== "") {
      requireValue(
        typeof entry === "string" ||
          (Array.isArray(entry) &&
            entry.every((item) => typeof item === "string")),
        "Portfolio source links must be text.",
      );
      requireValue(
        (Array.isArray(entry) ? entry : [entry]).every(validSourceUrl),
        "Portfolio source links must use HTTPS on SEC.gov.",
      );
    }
    if (typeof entry === "string") {
      requireValue(
        entry.length <= 20000,
        "A portfolio research field exceeds the 20,000-character limit.",
      );
    } else if (Array.isArray(entry)) {
      requireValue(
        entry.length <= 2000,
        "A portfolio research list exceeds the size limit.",
      );
      entry.forEach((item) => walk(item, depth + 1, key));
    } else if (object(entry)) {
      requireValue(
        [Object.prototype, null].includes(Object.getPrototypeOf(entry)),
        "Unsupported portfolio object.",
      );
      for (const [field, item] of Object.entries(entry)) {
        requireValue(
          !FORBIDDEN.has(field),
          "Unsafe object field in portfolio research.",
        );
        walk(item, depth + 1, field);
      }
    } else {
      requireValue(
        entry === null ||
          typeof entry === "boolean" ||
          (typeof entry === "number" && Number.isFinite(entry)),
        "Unsupported portfolio value.",
      );
    }
  }
  walk(value);
}
function optionalText(record, fields, max = 2000) {
  for (const field of fields)
    requireValue(
      record[field] === undefined ||
        record[field] === null ||
        text(record[field], max),
      `Portfolio ${field} must be text.`,
    );
}
function resolutionRecord(value) {
  requireValue(
    object(value),
    "A portfolio row needs a valid identification status.",
  );
  requireValue(
    ["resolved", "review", "unresolved", "conflict", "unsupported"].includes(
      value.status,
    ),
    "A portfolio identification status is invalid.",
  );
  requireValue(
    ["company", "fund", "unknown"].includes(value.kind),
    "A portfolio instrument classification is invalid.",
  );
  optionalText(value, ["ticker", "name"]);
  requireValue(
    value.cik === undefined ||
      value.cik === null ||
      value.cik === "" ||
      /^\d{10}$/.test(value.cik),
    "A resolved portfolio CIK must contain ten digits.",
  );
  requireValue(
    Array.isArray(value.warnings) &&
      value.warnings.length <= 100 &&
      value.warnings.every((item) => text(item)),
    "Portfolio identification warnings are invalid.",
  );
  requireValue(
    Array.isArray(value.candidates) && value.candidates.length <= 20,
    "A portfolio row supports at most 20 identification candidates.",
  );
  for (const candidate of value.candidates) {
    requireValue(
      object(candidate),
      "A portfolio identification candidate is invalid.",
    );
    optionalText(candidate, [
      "ticker",
      "cik",
      "name",
      "kind",
      "exchange",
      "label",
      "query",
      "status",
    ]);
  }
  for (const field of ["needsVerification", "userReviewed"])
    requireValue(
      value[field] === undefined || typeof value[field] === "boolean",
      `Portfolio ${field} must be a flag.`,
    );
}
function inputRecord(input) {
  requireValue(object(input), "A portfolio input is invalid.");
  requireValue(
    Object.keys(input).every((field) => INPUT_FIELDS.includes(field)),
    "A portfolio row contains an unsupported input column.",
  );
  for (const field of INPUT_FIELDS) {
    const value = input[field];
    requireValue(
      text(value) ||
        (NUMBER_FIELDS.has(field) &&
          typeof value === "number" &&
          Number.isFinite(value)),
      `Portfolio ${field} must contain at most 2,000 characters${NUMBER_FIELDS.has(field) ? " or a finite number" : ""}.`,
    );
  }
}
function rowRecord(row) {
  requireValue(
    object(row) && identifier(row.id),
    "A portfolio row identity is invalid.",
  );
  inputRecord(row.input);
  resolutionRecord(row.resolution);
  requireValue(
    typeof row.excluded === "boolean",
    "A portfolio exclusion must be a flag.",
  );
  requireValue(
    row.duplicateChoice === null ||
      ["keep", "merge", "remove"].includes(row.duplicateChoice),
    "A portfolio duplicate decision is invalid.",
  );
  if (row.mergedInto !== undefined)
    requireValue(
      identifier(row.mergedInto) &&
        row.mergedInto !== row.id &&
        row.excluded &&
        row.duplicateChoice === "remove",
      "A merged source position must remain excluded until its merge is undone.",
    );
  if (
    row.mergedInputs !== undefined ||
    row.mergedRowIds !== undefined ||
    row.duplicateChoice === "merge"
  ) {
    requireValue(
      row.mergedInto === undefined &&
        row.duplicateChoice === "merge" &&
        Array.isArray(row.mergedInputs) &&
        Array.isArray(row.mergedRowIds) &&
        row.mergedInputs.length >= 2 &&
        row.mergedInputs.length <= PORTFOLIO_ROW_LIMIT &&
        row.mergedInputs.length === row.mergedRowIds.length &&
        row.mergedRowIds[0] === row.id &&
        row.mergedRowIds.every(identifier) &&
        new Set(row.mergedRowIds).size === row.mergedRowIds.length,
      "A merged position needs a complete, bounded history of its original rows.",
    );
    row.mergedInputs.forEach(inputRecord);
  }
  if (row.originalInput !== undefined) {
    requireValue(
      object(row.originalInput) && Object.keys(row.originalInput).length <= 100,
      "Original portfolio input is invalid.",
    );
    requireValue(
      Object.values(row.originalInput).every(
        (value) =>
          text(value) ||
          value === null ||
          (typeof value === "number" && Number.isFinite(value)),
      ),
      "Original portfolio input cells are invalid.",
    );
  }
}
function snapshotRecord(snapshot) {
  if (snapshot === null) return;
  requireValue(
    object(snapshot) && snapshot.schema_version === "edgar.portfolio.v1",
    "This portfolio research snapshot version is not supported.",
  );
  requireValue(
    timestamp(snapshot.generated_at) &&
      ["annual", "ttm"].includes(snapshot.basis),
    "The portfolio snapshot date or reporting basis is invalid.",
  );
  requireValue(
    Array.isArray(snapshot.companies) &&
      snapshot.companies.length <= PORTFOLIO_ROW_LIMIT,
    "A portfolio research snapshot supports at most 100 companies.",
  );
  for (const company of snapshot.companies) {
    requireValue(
      object(company),
      "A saved portfolio company result is invalid.",
    );
    optionalText(company, [
      "ticker",
      "cik",
      "name",
      "status",
      "kind",
      "error",
      "reason",
      "basis",
      "retrieved_at",
      "retrievedAt",
      "reporting_basis",
      "lens",
      "sicDescription",
      "industry",
      "industrySystem",
      "refreshError",
    ]);
    requireValue(
      company.refreshStatus === undefined ||
        ["pending", "checked", "failed", "stale", "not_checked"].includes(
          company.refreshStatus,
        ),
      "A saved portfolio refresh status is invalid.",
    );
    requireValue(
      typeof company.cik === "string" && /^\d{10}$/.test(company.cik),
      "A saved research company CIK is invalid.",
    );
    requireValue(
      ["ready", "partial", "failed", "unsupported"].includes(company.status) &&
        ["company", "foreign", "fund"].includes(company.kind),
      "A saved research company status or classification is invalid.",
    );
    if (company.identity !== undefined) {
      requireValue(
        object(company.identity),
        "A saved portfolio company identity is invalid.",
      );
      optionalText(company.identity, [
        "ticker",
        "cik",
        "name",
        "kind",
        "classification",
        "exchange",
        "sic",
        "sicDescription",
      ]);
    }
    for (const field of ["warnings", "limitations"])
      if (company[field] !== undefined)
        requireValue(
          Array.isArray(company[field]) &&
            company[field].every((item) => text(item)),
          `Saved company ${field} are invalid.`,
        );
    for (const field of ["metrics", "coverage"])
      if (company[field] !== undefined && company[field] !== null)
        requireValue(
          object(company[field]),
          `Saved company ${field} are invalid.`,
        );
    for (const field of ["filings", "sources"])
      if (company[field] !== undefined)
        requireValue(
          Array.isArray(company[field]) && company[field].every(object),
          `Saved company ${field} are invalid.`,
        );
    validatePeriod(company.period);
    for (const point of Object.values(company.metrics || {})) {
      requireValue(
        object(point) &&
          (point.value === null ||
            (typeof point.value === "number" && Number.isFinite(point.value))),
        "A saved portfolio metric value is invalid.",
      );
      optionalText(point, [
        "unit",
        "label",
        "formula",
        "reason",
        "classification",
        "note",
      ]);
      validatePeriod(point.period);
      for (const field of ["sources", "calculations"])
        if (point[field] !== undefined) {
          requireValue(
            Array.isArray(point[field]) &&
              point[field].length <= 100 &&
              point[field].every(object),
            `Saved portfolio metric ${field} are invalid.`,
          );
          for (const source of point[field]) {
            optionalText(source, [
              "label",
              "unit",
              "accession",
              "tag",
              "taxonomy",
              "start",
              "end",
              "form",
              "filed",
              "formula",
              "note",
              "classification",
              "revisionNote",
            ]);
            requireValue(
              source.value === undefined ||
                source.value === null ||
                (typeof source.value === "number" &&
                  Number.isFinite(source.value)),
              "A saved portfolio source value is invalid.",
            );
          }
        }
    }
    for (const filing of [
      ...(company.filings || []),
      ...[company.latestAnnualFiling, company.latestInterimFiling].filter(
        (value) => value !== undefined && value !== null,
      ),
    ]) {
      requireValue(object(filing), "A saved portfolio filing is invalid.");
      optionalText(filing, [
        "accession",
        "form",
        "filingDate",
        "reportDate",
        "primaryDoc",
        "description",
      ]);
      requireValue(
        text(filing.documentUrl) && validSourceUrl(filing.documentUrl),
        "A saved portfolio filing needs a valid SEC source URL.",
      );
    }
    if (company.filingCoverage !== undefined) {
      requireValue(
        object(company.filingCoverage),
        "Saved portfolio filing coverage is invalid.",
      );
      optionalText(company.filingCoverage, ["scope"]);
      requireValue(
        company.filingCoverage.source === undefined ||
          validSourceUrl(company.filingCoverage.source),
        "Saved filing coverage must identify an SEC source.",
      );
    }
    if (company.cache !== undefined) {
      requireValue(
        object(company.cache) &&
          ["fresh", "cached", "stale", "unavailable"].includes(
            company.cache.status,
          ),
        "The saved portfolio cache status is invalid.",
      );
      requireValue(
        company.cache.storedAt === null || timestamp(company.cache.storedAt),
        "The saved portfolio retrieval date is invalid.",
      );
    }
  }
}

function validatePeriod(period) {
  if (period === undefined || period === null) return;
  requireValue(
    object(period),
    "A saved portfolio reporting period is invalid.",
  );
  optionalText(period, [
    "start",
    "end",
    "kind",
    "fp",
    "filed",
    "form",
    "label",
  ]);
  for (const field of ["fy", "year", "quarter", "months"])
    requireValue(
      period[field] === undefined ||
        period[field] === null ||
        (typeof period[field] === "number" && Number.isFinite(period[field])) ||
        (typeof period[field] === "string" && /^\d+$/.test(period[field])),
      `Portfolio period ${field} is invalid.`,
    );
}

export function validatePortfolio(portfolio) {
  inspectPortfolioTree(portfolio);
  requireValue(
    object(portfolio) && identifier(portfolio.id),
    "A saved portfolio identity is invalid.",
  );
  requireValue(
    text(portfolio.name, 200) && portfolio.name.trim().length > 0,
    "Give the portfolio a name of 1–200 characters.",
  );
  requireValue(
    timestamp(portfolio.createdAt) && timestamp(portfolio.updatedAt),
    "Saved portfolio dates are invalid.",
  );
  requireValue(
    Array.isArray(portfolio.rows) &&
      portfolio.rows.length <= PORTFOLIO_ROW_LIMIT,
    "A portfolio supports at most 100 rows. Existing research has been preserved.",
  );
  const ids = new Set();
  for (const row of portfolio.rows) {
    rowRecord(row);
    requireValue(!ids.has(row.id), "Portfolio row IDs must be unique.");
    ids.add(row.id);
  }
  const byId = new Map(portfolio.rows.map((row) => [row.id, row]));
  for (const row of portfolio.rows) {
    if (row.mergedInto !== undefined) {
      const primary = byId.get(row.mergedInto);
      requireValue(
        primary?.mergedRowIds?.indexOf(row.id) > 0,
        "A merged source position has no matching primary position.",
      );
    }
    for (const [index, id] of (row.mergedRowIds || []).entries()) {
      const source = byId.get(id);
      requireValue(
        source &&
          (index === 0 ||
            (source.mergedInto === row.id &&
              source.excluded &&
              source.duplicateChoice === "remove")),
        "A saved merge is missing an excluded original source position.",
      );
      if (index > 0)
        requireValue(
          INPUT_FIELDS.every(
            (field) => source.input[field] === row.mergedInputs[index][field],
          ),
          "A merged source position no longer matches its captured original input. Undo the merge before editing it.",
        );
    }
  }
  requireValue(
    object(portfolio.allocation) &&
      ["none", "weights", "market_value", "equal"].includes(
        portfolio.allocation.basis,
      ) &&
      typeof portfolio.allocation.normalize === "boolean",
    "Saved portfolio allocation settings are invalid.",
  );
  requireValue(
    object(portfolio.research) &&
      ["annual", "ttm"].includes(portfolio.research.basis),
    "Saved portfolio reporting settings are invalid.",
  );
  for (const field of ["lastCheckedAt", "previousCheckedAt"])
    requireValue(
      portfolio[field] === null || timestamp(portfolio[field]),
      `Portfolio ${field} is invalid.`,
    );
  snapshotRecord(portfolio.snapshot);
  validatePortfolioBaseline(portfolio.comparisonBaseline);
  return portfolio;
}

export function validatePortfolios(data) {
  requireValue(
    object(data) &&
      data.version === 1 &&
      Array.isArray(data.portfolios) &&
      data.portfolios.length <= PORTFOLIO_LIMIT,
    "Saved portfolios use an unsupported format or exceed the 20-portfolio limit.",
  );
  inspectPortfolioTree(data);
  const ids = new Set();
  for (const portfolio of data.portfolios) {
    validatePortfolio(portfolio);
    requireValue(!ids.has(portfolio.id), "Saved portfolio IDs must be unique.");
    ids.add(portfolio.id);
  }
  requireValue(
    data.activeId === "" ||
      (identifier(data.activeId) && ids.has(data.activeId)),
    "The active saved portfolio is invalid.",
  );
  requireValue(
    bytes(JSON.stringify(data)) <= PORTFOLIO_STORAGE_LIMIT,
    "Saved portfolios exceed the 4 MiB browser-storage budget. Export a backup and remove an older portfolio or research snapshot before saving again. Existing saved data has been preserved.",
  );
  return data;
}

export function readPortfolios(raw) {
  if (raw === null || raw === undefined)
    return { version: 1, portfolios: [], activeId: "" };
  try {
    requireValue(
      typeof raw === "string" && bytes(raw) <= PORTFOLIO_STORAGE_LIMIT,
      "Saved portfolios exceed the 4 MiB browser-storage budget.",
    );
    return validatePortfolios(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Portfolios could not be read. Existing browser data has been preserved. ${error instanceof Error ? error.message : "The stored format is invalid."}`,
    );
  }
}

const newId = () =>
  `portfolio-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

/**
 * Accepts already reviewed position rows; validation does not resolve or alter user allocations.
 * @param {{id?: string, name?: string, rows?: any[], allocation?: any, research?: any, snapshot?: any, comparisonBaseline?: any, lastCheckedAt?: string | null, previousCheckedAt?: string | null, now?: string}} input
 */
export function createPortfolio({
  id = newId(),
  name = "Untitled research universe",
  rows = [],
  allocation = { basis: "none", normalize: false },
  research = { basis: "annual" },
  snapshot = null,
  comparisonBaseline = null,
  lastCheckedAt = null,
  previousCheckedAt = null,
  now = new Date().toISOString(),
} = {}) {
  const portfolio = {
    id,
    name: name?.trim(),
    createdAt: now,
    updatedAt: now,
    rows,
    allocation,
    research,
    snapshot,
    comparisonBaseline,
    lastCheckedAt,
    previousCheckedAt,
  };
  validatePortfolio(portfolio);
  return clone(portfolio);
}

/**
 * Always reads current browser data before changing one document. Pass expectedUpdatedAt
 * when saving a whole edited document to reject changes made in another tab.
 * localStorage is synchronous but does not provide a cross-tab transaction lock.
 */
export function writePortfolio(storage, options) {
  const {
    mode,
    portfolio,
    patch,
    name,
    expectedUpdatedAt,
    now = new Date().toISOString(),
  } = options;
  const id = options.id || portfolio?.id;
  requireValue(
    ["create", "update", "rename", "duplicate", "delete", "activate"].includes(
      mode,
    ),
    "Choose a supported portfolio action.",
  );
  requireValue(timestamp(now), "The portfolio save date is invalid.");
  let original;
  try {
    original = storage.getItem(PORTFOLIOS_KEY);
  } catch {
    throw new Error(
      "Browser storage is unavailable. Your changes have not been saved. Keep this page open and export your research before leaving.",
    );
  }
  const current = readPortfolios(original);
  const existing = current.portfolios.find((item) => item.id === id);
  if (mode !== "create") {
    requireValue(
      existing,
      "This portfolio was removed or replaced in another tab. Reload your saved portfolios before editing again.",
    );
    requireValue(
      expectedUpdatedAt === undefined ||
        expectedUpdatedAt === existing.updatedAt,
      "This portfolio changed in another tab or was restored from backup. Reload it before replacing the saved document, or save your draft as a new portfolio.",
    );
  }
  if (mode === "create") {
    requireValue(
      !existing,
      "This portfolio already exists. Create it with a new identity.",
    );
    requireValue(
      current.portfolios.length < PORTFOLIO_LIMIT,
      "This browser holds 20 portfolios. Export a backup and remove a portfolio before creating another.",
    );
    validatePortfolio(portfolio);
    current.portfolios.unshift(clone(portfolio));
    current.activeId = portfolio.id;
  } else if (mode === "delete") {
    current.portfolios = current.portfolios.filter((item) => item.id !== id);
    if (current.activeId === id)
      current.activeId = current.portfolios[0]?.id || "";
  } else if (mode === "activate") {
    current.activeId = id;
  } else if (mode === "duplicate") {
    requireValue(
      current.portfolios.length < PORTFOLIO_LIMIT,
      "This browser holds 20 portfolios. Export a backup and remove a portfolio before duplicating another.",
    );
    const copy = createPortfolio({
      ...existing,
      id: options.newId || newId(),
      name: name || `${existing.name.slice(0, 193)} (copy)`,
      now,
    });
    requireValue(
      !current.portfolios.some((item) => item.id === copy.id),
      "A portfolio with the duplicate identity already exists.",
    );
    current.portfolios.unshift(copy);
    current.activeId = copy.id;
  } else {
    if (patch !== undefined) {
      requireValue(object(patch), "Portfolio changes must be an object.");
      inspectPortfolioTree(patch);
    }
    if (portfolio !== undefined) validatePortfolio(portfolio);
    const updatedAt = new Date(
      Math.max(Date.parse(now), Date.parse(existing.updatedAt) + 1),
    ).toISOString();
    const next =
      mode === "rename"
        ? {
            ...existing,
            name: typeof name === "string" ? name.trim() : name,
            updatedAt,
          }
        : {
            ...existing,
            ...(portfolio || {}),
            ...(patch || {}),
            id: existing.id,
            createdAt: existing.createdAt,
            updatedAt,
          };
    validatePortfolio(next);
    current.portfolios = current.portfolios.map((item) =>
      item.id === id ? clone(next) : item,
    );
  }
  validatePortfolios(current);
  const raw = JSON.stringify(current);
  try {
    requireValue(
      storage.getItem(PORTFOLIOS_KEY) === original,
      "Saved portfolios changed while this update was being prepared. Reload and try again.",
    );
    storage.setItem(PORTFOLIOS_KEY, raw);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Saved portfolios changed")
    )
      throw error;
    throw new Error(
      "Browser storage is full or unavailable. Your changes have not been saved; existing saved portfolios are unchanged. Keep this page open, export your research, and free browser storage before trying again.",
    );
  }
  return clone(current);
}
