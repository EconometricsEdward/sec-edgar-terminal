import { PORTFOLIO_REPORTING_BASES } from "./portfolioReporting.js";
import { resolveCompanyClassification } from "./companyClassification.js";
/** Pure identity and allocation rules shared by the local workspace and batch API. */
export const PORTFOLIO_SCHEMA_VERSION = "edgar.portfolio.v1";
export const MAX_PORTFOLIO_ROWS = 100;
export const MAX_PORTFOLIO_CELL_LENGTH = 2000;
export const PORTFOLIO_COLUMNS = Object.freeze([
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
]);

const NUMERIC_COLUMNS = new Set(["weight_pct", "market_value", "shares"]);
const BASES = new Set(["none", "weights", "market_value", "equal"]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const present = (value) =>
  value !== null && value !== undefined && String(value).trim() !== "";
const text = (value) =>
  value === null || value === undefined ? "" : String(value).trim();
const sum = (values) => values.reduce((total, value) => total + value, 0);
const unique = (values) => [...new Set(values)];
const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

export function normalizePortfolioInput(input) {
  if (!plain(input)) throw new Error("Portfolio input must be a JSON object.");
  if (input.schema_version !== PORTFOLIO_SCHEMA_VERSION)
    throw new Error(
      `Unsupported schema_version. Use ${PORTFOLIO_SCHEMA_VERSION}.`,
    );
  if (!Array.isArray(input.holdings))
    throw new Error("holdings must be an array.");
  if (input.holdings.length > MAX_PORTFOLIO_ROWS)
    throw new Error(
      `A portfolio supports at most ${MAX_PORTFOLIO_ROWS} holdings.`,
    );
  if (
    present(input.name) &&
    (typeof input.name !== "string" || input.name.length > 200)
  )
    throw new Error("Portfolio name must be text of 200 characters or fewer.");
  const warnings = [];
  const holdings = input.holdings.map((holding, index) => {
    if (!plain(holding))
      throw new Error(`Holding ${index + 1} must be an object.`);
    const clean = {};
    for (const column of PORTFOLIO_COLUMNS) {
      const value = holding[column];
      if (value === null || value === undefined) {
        clean[column] = "";
        continue;
      }
      if (
        typeof value !== "string" &&
        !(
          NUMERIC_COLUMNS.has(column) &&
          typeof value === "number" &&
          Number.isFinite(value)
        )
      )
        throw new Error(
          `Holding ${index + 1}: ${column} must be text${NUMERIC_COLUMNS.has(column) ? " or a finite number" : ""}.`,
        );
      if (String(value).length > MAX_PORTFOLIO_CELL_LENGTH)
        throw new Error(
          `Holding ${index + 1}: ${column} exceeds ${MAX_PORTFOLIO_CELL_LENGTH} characters.`,
        );
      clean[column] = typeof value === "string" ? value.trim() : value;
    }
    if (
      Object.keys(holding).some(
        (key) => !PORTFOLIO_COLUMNS.includes(key) && key !== "original_input",
      )
    )
      warnings.push(
        `Holding ${index + 1}: unrecognized fields were not included in the canonical input.`,
      );
    return clean;
  });
  const allocation = input.allocation ?? {};
  if (
    !plain(allocation) ||
    (own(allocation, "basis") && !BASES.has(allocation.basis))
  )
    throw new Error(
      "allocation.basis must be none, weights, market_value, or equal.",
    );
  if (own(allocation, "normalize") && typeof allocation.normalize !== "boolean")
    throw new Error("allocation.normalize must be true or false.");
  const research = input.research ?? {};
  if (
    !plain(research) ||
    (own(research, "basis") &&
      !PORTFOLIO_REPORTING_BASES.includes(research.basis))
  )
    throw new Error("research.basis must be annual, quarter, ytd, or ttm.");
  const rowChoices = input.row_choices ?? [];
  if (!Array.isArray(rowChoices) || rowChoices.length > holdings.length)
    throw new Error(
      "row_choices must be a bounded array of explicit position decisions.",
    );
  const seenChoices = new Set();
  for (const choice of rowChoices) {
    if (
      !plain(choice) ||
      !Number.isInteger(choice.index) ||
      choice.index < 0 ||
      choice.index >= holdings.length ||
      !["keep", "remove"].includes(choice.duplicateChoice) ||
      seenChoices.has(choice.index)
    )
      throw new Error(
        "Each row choice needs a unique valid zero-based index and duplicateChoice keep or remove.",
      );
    seenChoices.add(choice.index);
  }
  return {
    schema_version: PORTFOLIO_SCHEMA_VERSION,
    name: text(input.name),
    holdings,
    allocation: {
      basis: allocation.basis || "none",
      normalize: allocation.normalize === true,
    },
    research: { basis: research.basis || "annual" },
    row_choices: rowChoices.map((choice) => ({
      index: choice.index,
      duplicateChoice: choice.duplicateChoice,
    })),
    warnings,
  };
}

export function canonicalPortfolioCik(value) {
  const candidate = text(value).replace(/^CIK\s*/i, "");
  return /^\d{1,10}$/.test(candidate) && Number(candidate) > 0
    ? candidate.padStart(10, "0")
    : null;
}

function canonicalTicker(value) {
  return text(value).toUpperCase().replace(/\./g, "-");
}
function canonicalName(value) {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(
      /(?:\s+(?:incorporated|inc|corporation|corp|limited|ltd|plc|llc|company|co))+$/,
      "",
    )
    .trim();
}

function initialResolution() {
  return {
    status: "unresolved",
    kind: "unknown",
    ticker: "",
    cik: "",
    name: "",
    candidates: [],
    warnings: [],
  };
}

export function createPortfolioRows(holdings, rowChoices = []) {
  if (!Array.isArray(holdings) || holdings.length > MAX_PORTFOLIO_ROWS)
    throw new Error(
      `Provide an array of at most ${MAX_PORTFOLIO_ROWS} holdings.`,
    );
  return holdings.map((holding, index) => {
    const input = Object.fromEntries(
      PORTFOLIO_COLUMNS.map((column) => [column, holding?.[column] ?? ""]),
    );
    const row = {
      id: `position-${index + 1}`,
      input,
      resolution: initialResolution(),
      excluded: false,
      duplicateChoice: null,
    };
    if (plain(holding?.original_input))
      row.originalInput = { ...holding.original_input };
    const choice = rowChoices.find((item) => item.index === index);
    if (choice && ["keep", "remove"].includes(choice.duplicateChoice)) {
      row.duplicateChoice = choice.duplicateChoice;
      if (choice.duplicateChoice === "remove") row.excluded = true;
    }
    return row;
  });
}

function directoryEntries(directory) {
  return Object.entries(directory || {})
    .filter(([, entry]) => plain(entry) && canonicalPortfolioCik(entry.cik))
    .map(([ticker, entry]) => ({
      ticker: text(entry.ticker || ticker).toUpperCase(),
      cik: canonicalPortfolioCik(entry.cik),
      name: text(entry.name || entry.title || ticker),
      kind: entry.isFund || entry.kind === "fund" ? "fund" : "company",
      exchange: text(entry.exchange),
    }));
}

function resolved(entry, warnings = []) {
  return {
    status: "resolved",
    kind: entry.kind,
    ticker: entry.ticker,
    cik: entry.cik,
    name: entry.name,
    candidates: [],
    warnings,
  };
}

/** Name matches are candidates, including an exact name: choosing an issuer is explicit. */
export function resolvePortfolioRows(rows, directory = {}) {
  const entries = directoryEntries(directory);
  const byTicker = new Map(
    entries.map((entry) => [canonicalTicker(entry.ticker), entry]),
  );
  return rows.map((row) => {
    const input = row.input || {};
    const ticker = canonicalTicker(input.ticker);
    const rawCik = text(input.cik);
    const cik = canonicalPortfolioCik(rawCik);
    const name = canonicalName(input.company_name);
    const match = byTicker.get(ticker);
    const byCik = cik ? entries.filter((entry) => entry.cik === cik) : [];
    const nameMatches = name
      ? entries.filter((entry) => {
          const candidate = canonicalName(entry.name);
          return (
            candidate === name ||
            candidate.startsWith(`${name} `) ||
            candidate.includes(` ${name} `)
          );
        })
      : [];
    const candidates = uniqueCandidates([
      ...(match ? [match] : []),
      ...byCik,
      ...nameMatches,
    ]);
    let resolution = initialResolution();
    if (rawCik && !cik)
      resolution = {
        ...resolution,
        status: "conflict",
        candidates,
        warnings: [
          "CIK must contain 1–10 digits and identify a nonzero SEC registrant.",
        ],
      };
    else if (match) {
      const issues = [];
      if (cik && cik !== match.cik)
        issues.push(
          "The supplied ticker and CIK identify different companies or funds.",
        );
      if (name && name !== canonicalName(match.name))
        issues.push(
          "The supplied company name does not match the ticker's SEC company name. Review the identification.",
        );
      if (
        present(input.exchange) &&
        match.exchange &&
        text(input.exchange).toUpperCase() !== match.exchange.toUpperCase()
      )
        issues.push(
          "The supplied exchange does not match the directory exchange.",
        );
      resolution = issues.length
        ? { ...resolution, status: "conflict", candidates, warnings: issues }
        : resolved(match);
      if (!issues.length && text(input.ticker).toUpperCase() !== match.ticker)
        resolution.warnings.push(
          `Ticker alias ${text(input.ticker)} resolved to ${match.ticker}.`,
        );
    } else if (ticker) {
      resolution = {
        ...resolution,
        status: cik || nameMatches.length ? "conflict" : "unresolved",
        candidates,
        warnings: [
          cik
            ? "The ticker was not verified. Review it before associating it with the supplied CIK."
            : "Ticker not found in the available SEC company and fund directories.",
        ],
      };
    } else if (cik && byCik.length) {
      const issuer = byCik[0];
      if (name && name !== canonicalName(issuer.name))
        resolution = {
          ...resolution,
          status: "conflict",
          candidates,
          warnings: [
            "The supplied company name and CIK do not match. Choose the correct company or fund.",
          ],
        };
      else {
        resolution = resolved({ ...issuer, ticker: "" }, [
          "CIK identifies a company or fund; no particular share class is assumed.",
        ]);
        if (byCik.some((item) => item.kind !== issuer.kind))
          resolution = {
            ...resolution,
            status: "review",
            candidates,
            warnings: [
              "The registrant has both company and fund entries. Review its classification.",
            ],
          };
      }
    } else if (cik) {
      resolution = {
        ...resolved({
          kind: "company",
          ticker: "",
          cik,
          name: text(input.company_name) || `CIK ${cik}`,
        }),
        needsVerification: true,
        warnings: [
          "Exact CIK will be verified against SEC submissions before company metrics are used.",
        ],
      };
    } else if (name) {
      resolution = {
        ...resolution,
        status: nameMatches.length ? "review" : "unresolved",
        candidates: uniqueCandidates(nameMatches),
        warnings: [
          nameMatches.length
            ? "Choose a company to confirm this name-only match."
            : "No verified company-name match. Supply a ticker or exact CIK, or edit the name.",
        ],
      };
    } else
      resolution.warnings = ["Enter a ticker, company name, or exact CIK."];
    if (resolution.kind === "fund")
      resolution.warnings.push(
        "Fund holdings are retained, but ordinary company financial metrics are not applied. Use the Funds workspace for fund research.",
      );
    return { ...row, resolution };
  });
}

function uniqueCandidates(entries) {
  const found = new Map();
  for (const entry of entries)
    if (!found.has(`${entry.cik}:${entry.ticker}`))
      found.set(`${entry.cik}:${entry.ticker}`, entry);
  return [...found.values()].slice(0, 20);
}

export function resolvePortfolioRowCandidate(row, candidate) {
  const available = (row.resolution?.candidates || []).find(
    (item) => item.cik === candidate?.cik && item.ticker === candidate?.ticker,
  );
  if (!available)
    throw new Error("Choose one of this row's verified candidates.");
  return {
    ...row,
    resolution: {
      ...resolved(available, [
        "Identity explicitly confirmed during import review; original input is retained.",
      ]),
      userReviewed: true,
    },
  };
}

function activeRows(rows) {
  return rows.filter(
    (row) =>
      !row.excluded && !row.mergedInto && row.duplicateChoice !== "remove",
  );
}
function securityKey(row) {
  const ticker = canonicalTicker(row.resolution?.ticker || row.input?.ticker);
  if (ticker) return `ticker:${ticker}`;
  const cik = canonicalPortfolioCik(row.resolution?.cik || row.input?.cik);
  if (cik) return `issuer-only:${cik}`;
  const name = canonicalName(row.input?.company_name);
  return name ? `unverified-name:${name}` : null;
}

export function duplicateGroups(rows) {
  const groups = new Map();
  for (const row of activeRows(rows)) {
    const key = securityKey(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  // An issuer-only position may duplicate a security position in that issuer.
  // The user must decide; a share class cannot be invented to enable a merge.
  const issuerOnly = new Set(
    activeRows(rows)
      .filter(
        (row) => !canonicalTicker(row.resolution?.ticker || row.input?.ticker),
      )
      .map((row) =>
        canonicalPortfolioCik(row.resolution?.cik || row.input?.cik),
      )
      .filter(Boolean),
  );
  for (const cik of issuerOnly) {
    const members = activeRows(rows).filter(
      (row) =>
        canonicalPortfolioCik(row.resolution?.cik || row.input?.cik) === cik,
    );
    if (
      members.some((row) =>
        canonicalTicker(row.resolution?.ticker || row.input?.ticker),
      )
    )
      groups.set(`possible-issuer-duplicate:${cik}`, members);
  }
  return [...groups]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({
      key,
      rowIds: members.map((row) => row.id),
      decided: members.every((row) => row.duplicateChoice === "keep"),
      canMerge: mergeCompatibility(members).length === 0,
      issues: mergeCompatibility(members),
    }));
}

/** A strict decimal parser; null means missing/invalid, never a substitute zero. */
export function portfolioNumber(value) {
  if (!present(value)) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const candidate = text(value);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(candidate)) return null;
  const number = Number(candidate);
  return Number.isFinite(number) ? number : null;
}

function validDate(value) {
  const candidate = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  const date = new Date(`${candidate}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === candidate
  );
}

export function validatePortfolioRow(row) {
  const issues = [];
  const input = row.input || {};
  for (const field of NUMERIC_COLUMNS) {
    if (!present(input[field])) continue;
    const number = portfolioNumber(input[field]);
    if (number === null)
      issues.push({
        field,
        code: "invalid_number",
        message: `${field} must be a finite decimal number.`,
      });
    else if (number < 0)
      issues.push({
        field,
        code: "negative_unsupported",
        message: `Negative ${field} is unsupported in this long-only workspace.`,
      });
  }
  if (present(input.currency) && !/^[A-Za-z]{3}$/.test(text(input.currency)))
    issues.push({
      field: "currency",
      code: "invalid_currency",
      message: "Use a three-letter currency code, such as USD.",
    });
  if (present(input.as_of_date) && !validDate(input.as_of_date))
    issues.push({
      field: "as_of_date",
      code: "invalid_date",
      message: "as_of_date must be a valid YYYY-MM-DD date.",
    });
  return { valid: issues.length === 0, issues };
}

function mergeCompatibility(rows) {
  const issues = [];
  if (rows.length < 2) return issues;
  if (rows.some((row) => row.mergedInto || row.mergedInputs?.length))
    issues.push(
      "Undo the existing merge before merging these positions again.",
    );
  if (unique(rows.map(securityKey)).length !== 1)
    issues.push("Only the same identified security can be merged.");
  if (rows.some((row) => row.resolution?.status !== "resolved"))
    issues.push("Resolve each position's identity before merging.");
  const identities = unique(
    rows
      .map((row) =>
        canonicalPortfolioCik(row.resolution?.cik || row.input?.cik),
      )
      .filter(Boolean),
  );
  if (identities.length > 1)
    issues.push("Conflicting companies cannot be merged.");
  for (const field of ["currency", "as_of_date", "exchange"])
    if (
      unique(rows.map((row) => text(row.input?.[field]).toUpperCase())).length >
      1
    )
      issues.push(
        `Different or missing ${field} values require correction before merging.`,
      );
  for (const field of NUMERIC_COLUMNS) {
    const values = rows.map((row) => row.input?.[field]);
    const supplied = values.filter(present);
    if (supplied.length && supplied.length !== values.length)
      issues.push(
        `Some rows lack ${field}; merge would hide missing position data.`,
      );
    if (
      supplied.some(
        (value) =>
          portfolioNumber(value) === null || portfolioNumber(value) < 0,
      )
    )
      issues.push(`Invalid ${field} values cannot be merged.`);
  }
  if (rows.some((row) => !validatePortfolioRow(row).valid))
    issues.push("Correct invalid allocation fields before merging.");
  return unique(issues);
}

/** Keep is explicit for the whole duplicate group; merge retains removed rows for review. */
export function applyDuplicateDecision(rows, rowIds, decision) {
  const ids = new Set(Array.isArray(rowIds) ? rowIds : [rowIds]);
  const selected = rows.filter((row) => ids.has(row.id) && !row.excluded);
  if (!selected.length) throw new Error("No active positions were selected.");
  if (selected.some((row) => row.mergedInto))
    throw new Error(
      "This source position is already included in a merged position. Undo that merge first.",
    );
  if (!["keep", "merge", "remove"].includes(decision))
    throw new Error("Choose keep, merge, or remove.");
  if (decision === "remove")
    return rows.map((row) =>
      ids.has(row.id)
        ? { ...row, excluded: true, duplicateChoice: "remove" }
        : row,
    );
  if (decision === "keep")
    return rows.map((row) =>
      ids.has(row.id) ? { ...row, duplicateChoice: "keep" } : row,
    );
  const issues = mergeCompatibility(selected);
  if (selected.length < 2 || issues.length)
    throw new Error(
      issues.join(" ") || "Choose at least two compatible positions to merge.",
    );
  const first = selected[0];
  const input = { ...first.input };
  for (const field of NUMERIC_COLUMNS)
    if (present(input[field]))
      input[field] = sum(
        selected.map((row) => portfolioNumber(row.input[field])),
      );
  input.notes = unique(
    selected.map((row) => text(row.input?.notes)).filter(Boolean),
  ).join("\n");
  if (input.notes.length > MAX_PORTFOLIO_CELL_LENGTH)
    throw new Error(
      "Merged notes exceed the cell limit. Shorten the notes or keep the positions separate.",
    );
  return rows.map((row) =>
    row.id === first.id
      ? {
          ...row,
          input,
          duplicateChoice: "merge",
          mergedRowIds: selected.map((item) => item.id),
          mergedInputs: selected.map((item) => ({ ...item.input })),
        }
      : ids.has(row.id)
        ? {
            ...row,
            excluded: true,
            duplicateChoice: "remove",
            mergedInto: first.id,
          }
        : row,
  );
}

export function undoPortfolioMerge(rows, mergedRowId) {
  const primary = rows.find((row) => row.id === mergedRowId);
  if (
    !primary ||
    !Array.isArray(primary.mergedRowIds) ||
    !Array.isArray(primary.mergedInputs) ||
    primary.mergedRowIds.length < 2 ||
    primary.mergedRowIds.length !== primary.mergedInputs.length ||
    primary.mergedRowIds[0] !== primary.id
  )
    throw new Error(
      "This position has no complete original merge history to restore.",
    );
  const originals = new Map(
    primary.mergedRowIds.map((id, index) => [id, primary.mergedInputs[index]]),
  );
  if (
    originals.size !== primary.mergedRowIds.length ||
    primary.mergedRowIds.some(
      (id) =>
        !rows.some(
          (row) =>
            row.id === id &&
            (id === primary.id || row.mergedInto === primary.id),
        ),
    )
  )
    throw new Error(
      "The original merge source positions are incomplete. Restore them from a saved backup instead.",
    );
  return rows.map((row) => {
    if (!originals.has(row.id)) return row;
    const restored = {
      ...row,
      input: { ...originals.get(row.id) },
      excluded: false,
      duplicateChoice: null,
    };
    delete restored.mergedInputs;
    delete restored.mergedRowIds;
    delete restored.mergedInto;
    return restored;
  });
}

export function finiteFinancialMetric(metric) {
  if (typeof metric === "number") return Number.isFinite(metric);
  return (
    !!metric &&
    Number.isFinite(metric.value) &&
    ![
      "not_applicable",
      "unavailable",
      "unsupported",
      "failed",
      "unresolved",
    ].includes(metric.classification) &&
    ![
      "not_applicable",
      "unavailable",
      "unsupported",
      "failed",
      "unresolved",
    ].includes(metric.status)
  );
}

export function companyAvailable(company) {
  return (
    !!company &&
    ["ready", "partial", "ok", "success", "cached", "stale"].includes(
      company.status,
    ) &&
    Object.values(company.metrics || {}).some(finiteFinancialMetric)
  );
}
function companyIndustry(company) {
  return resolveCompanyClassification(company).industry;
}

/** No data retrieval or persistence. Missing evidence never changes the allocation denominator. */
export function allocationSummary(rows, settings = {}, companiesByCik = {}) {
  const config = settings.allocation || settings;
  const basis = BASES.has(config.basis) ? config.basis : "none";
  const active = activeRows(rows);
  const groups = duplicateGroups(active);
  const pending = new Set(
    groups.filter((group) => !group.decided).flatMap((group) => group.rowIds),
  );
  const warnings = [];
  const issues = [];
  const assumptions = [];
  const validations = new Map(
    active.map((row) => [row.id, validatePortfolioRow(row)]),
  );
  for (const row of active)
    for (const issue of validations.get(row.id).issues)
      issues.push({ rowId: row.id, ...issue });
  if (pending.size)
    warnings.push(
      "Duplicate securities need an explicit keep, merge, or remove decision before their allocations are calculated.",
    );
  const dates = unique(
    active.map((row) => text(row.input?.as_of_date)).filter(Boolean),
  );
  const currencies = unique(
    active
      .map((row) => text(row.input?.currency).toUpperCase())
      .filter(Boolean),
  );
  const weightNumbers = active.map((row) =>
    portfolioNumber(row.input?.weight_pct),
  );
  const originalWeightTotal = weightNumbers.some(
    (value) => value !== null && value >= 0,
  )
    ? sum(weightNumbers.filter((value) => value !== null && value >= 0))
    : null;
  const hasWeights = active.some((row) => present(row.input?.weight_pct));
  const hasValues = active.some((row) => present(row.input?.market_value));
  const hasShares = active.some((row) => present(row.input?.shares));
  const allRowDataValid = [...validations.values()].every(
    (validation) => validation.valid,
  );
  let valueBasisValid = true;
  if (basis === "market_value") {
    if (
      currencies.length !== 1 ||
      active.some((row) => !present(row.input?.currency))
    ) {
      valueBasisValid = false;
      warnings.push(
        "Position-value weights require every position to have the same stated currency. No currency conversion is assumed.",
      );
    }
    if (
      dates.length > 1 ||
      (dates.length && active.some((row) => !present(row.input?.as_of_date)))
    ) {
      valueBasisValid = false;
      warnings.push(
        "Position-value weights require compatible as-of dates; fill missing dates or use one common date.",
      );
    }
    if (
      active.some(
        (row) =>
          portfolioNumber(row.input?.market_value) === null ||
          portfolioNumber(row.input?.market_value) < 0,
      )
    ) {
      valueBasisValid = false;
      warnings.push(
        "Every included position needs a valid nonnegative market_value to calculate position-value weights.",
      );
    }
    if (!dates.length)
      warnings.push(
        "No holdings date was supplied; the comparison date of the position values is unverified.",
      );
    if (!allRowDataValid || pending.size) valueBasisValid = false;
  }
  const valueTotal =
    valueBasisValid && basis === "market_value"
      ? sum(active.map((row) => portfolioNumber(row.input?.market_value) || 0))
      : null;
  if (basis === "market_value" && !(valueTotal > 0)) {
    valueBasisValid = false;
    warnings.push(
      "Positive total comparable position value is required to calculate weights.",
    );
  }
  const completeWeights =
    active.length > 0 &&
    weightNumbers.every((value) => value !== null && value >= 0) &&
    allRowDataValid &&
    !pending.size;
  const normalized =
    basis === "weights" &&
    config.normalize === true &&
    completeWeights &&
    originalWeightTotal > 0;
  if (basis === "weights") {
    if (!completeWeights)
      warnings.push(
        "Some allocations are missing, invalid, or awaiting duplicate review. Known weights remain visible; no covered subset is reweighted.",
      );
    if (
      originalWeightTotal !== null &&
      Math.abs(originalWeightTotal - 100) > 0.000001
    )
      warnings.push(
        `Supplied weights total ${Number(originalWeightTotal.toFixed(6))}%, not 100%. An unspecified balance is not assumed to be cash.`,
      );
    if (config.normalize && !normalized)
      warnings.push(
        "Normalization requires a complete set of valid weights and a positive total. Original weights are retained.",
      );
    if (normalized)
      assumptions.push(
        `Explicitly normalized supplied weights from ${Number(originalWeightTotal.toFixed(6))}% to 100%; original inputs are preserved.`,
      );
  }
  if (basis === "equal")
    assumptions.push(
      "Explicit equal-weight model across included positions; these are assumed allocations, not supplied holdings weights.",
    );
  if (basis === "none" && (hasWeights || hasValues))
    warnings.push(
      "Research-universe mode is active. Supplied allocation fields are retained but are not used as economic weights.",
    );
  if (hasShares)
    warnings.push(
      "Shares are retained as metadata. No price, position value, or portfolio weight is inferred from shares.",
    );
  if (hasWeights && hasValues)
    warnings.push(
      `Both weights and market values were supplied. The selected basis is ${basis === "weights" ? "weight_pct" : basis === "market_value" ? "market_value" : basis === "equal" ? "an explicit equal-weight model" : "research universe (no weights)"}; the two allocation fields are not combined.`,
    );
  if (
    hasWeights &&
    hasValues &&
    originalWeightTotal > 0 &&
    completeWeights &&
    currencies.length === 1 &&
    active.every(
      (row) =>
        present(row.input?.currency) &&
        portfolioNumber(row.input?.market_value) !== null &&
        portfolioNumber(row.input?.market_value) >= 0,
    ) &&
    dates.length <= 1 &&
    (!dates.length || active.every((row) => present(row.input?.as_of_date)))
  ) {
    const comparableTotal = sum(
      active.map((row) => portfolioNumber(row.input?.market_value)),
    );
    if (
      comparableTotal > 0 &&
      active.some(
        (row) =>
          Math.abs(
            (portfolioNumber(row.input?.weight_pct) / originalWeightTotal) *
              100 -
              (portfolioNumber(row.input?.market_value) / comparableTotal) *
                100,
          ) > 0.1,
      )
    )
      warnings.push(
        "Supplied weights and comparable market values imply different relative allocations (over 0.1 percentage point for at least one position). Review the inputs; only the selected basis is used.",
      );
  }
  if (dates.length > 1 && basis !== "market_value")
    warnings.push(
      "Holdings have different as-of dates. These inputs do not represent a single verified portfolio snapshot.",
    );
  const equalValid =
    basis === "equal" && active.length > 0 && !pending.size && allRowDataValid;
  const allocations = active.map((row) => {
    const validation = validations.get(row.id);
    const originalWeightPct = portfolioNumber(row.input?.weight_pct);
    let weightPct = null;
    if (!pending.has(row.id) && validation.valid) {
      if (
        basis === "weights" &&
        originalWeightPct !== null &&
        originalWeightPct >= 0
      )
        weightPct = normalized
          ? (originalWeightPct / originalWeightTotal) * 100
          : originalWeightPct;
      if (basis === "market_value" && valueBasisValid)
        weightPct =
          (portfolioNumber(row.input?.market_value) / valueTotal) * 100;
      if (equalValid) weightPct = 100 / active.length;
    }
    const resolvedCik =
      row.resolution?.cik || canonicalPortfolioCik(row.input?.cik) || "";
    const verifiedCompany =
      companiesByCik[resolvedCik] ||
      companiesByCik[String(Number(resolvedCik))];
    const kind =
      verifiedCompany?.kind === "fund"
        ? "fund"
        : row.resolution?.kind || "unknown";
    return {
      rowId: row.id,
      ticker: row.resolution?.ticker || text(row.input?.ticker),
      cik: resolvedCik,
      name:
        row.resolution?.name ||
        text(row.input?.company_name) ||
        text(row.input?.ticker) ||
        "Unidentified position",
      kind,
      status: row.resolution?.status || "unresolved",
      weightPct,
      originalWeightPct,
      marketValue: portfolioNumber(row.input?.market_value),
      currency: text(row.input?.currency).toUpperCase(),
      asOfDate: text(row.input?.as_of_date),
      eligible:
        row.resolution?.status === "resolved" &&
        validation.valid &&
        !pending.has(row.id),
      issues: [
        ...validation.issues,
        ...(pending.has(row.id)
          ? [
              {
                code: "duplicate_review",
                message: "Duplicate position awaits an explicit decision.",
              },
            ]
          : []),
      ],
    };
  });
  const issuerMap = new Map();
  for (const allocation of allocations) {
    if (allocation.status !== "resolved" || !allocation.cik) continue;
    if (!issuerMap.has(allocation.cik))
      issuerMap.set(allocation.cik, {
        cik: allocation.cik,
        name: allocation.name,
        tickers: [],
        rowIds: [],
        kind: allocation.kind,
        weightPct: null,
        missingWeightCount: 0,
      });
    const issuer = issuerMap.get(allocation.cik);
    if (allocation.ticker) issuer.tickers.push(allocation.ticker);
    issuer.rowIds.push(allocation.rowId);
    if (allocation.weightPct !== null)
      issuer.weightPct = (issuer.weightPct || 0) + allocation.weightPct;
    else issuer.missingWeightCount++;
  }
  const issuers = [...issuerMap.values()]
    .map((issuer) => ({
      ...issuer,
      tickers: unique(issuer.tickers),
      weightComplete: issuer.missingWeightCount === 0,
    }))
    .sort(
      (a, b) =>
        (b.weightPct ?? -1) - (a.weightPct ?? -1) ||
        a.name.localeCompare(b.name),
    );
  const available = (cik) =>
    companyAvailable(
      companiesByCik[cik] || companiesByCik[String(Number(cik))],
    );
  const companyIssuers = issuers.filter((issuer) => issuer.kind === "company");
  const availableCompanies = companyIssuers.filter((issuer) =>
    available(issuer.cik),
  ).length;
  const allocatedWeight = allocations.some(
    (allocation) => allocation.weightPct !== null,
  )
    ? sum(allocations.map((allocation) => allocation.weightPct || 0))
    : null;
  const availableWeight =
    allocatedWeight === null
      ? null
      : sum(
          allocations
            .filter(
              (allocation) =>
                allocation.kind === "company" &&
                allocation.status === "resolved" &&
                available(allocation.cik),
            )
            .map((allocation) => allocation.weightPct || 0),
        );
  const distributionMap = new Map();
  for (const issuer of issuers) {
    const company =
      companiesByCik[issuer.cik] || companiesByCik[String(Number(issuer.cik))];
    const label =
      issuer.kind === "fund"
        ? "Funds (company metrics not applicable)"
        : companyIndustry(company);
    if (!distributionMap.has(label))
      distributionMap.set(label, {
        label,
        count: 0,
        weightPct: null,
        classification: "SEC SIC",
      });
    const bucket = distributionMap.get(label);
    bucket.count++;
    if (issuer.weightPct !== null)
      bucket.weightPct = (bucket.weightPct || 0) + issuer.weightPct;
  }
  const unresolved = allocations.filter(
    (allocation) => allocation.status !== "resolved",
  );
  if (unresolved.length)
    distributionMap.set("Unresolved positions", {
      label: "Unresolved positions",
      count: unresolved.length,
      weightPct:
        allocatedWeight === null
          ? null
          : sum(unresolved.map((allocation) => allocation.weightPct || 0)),
      classification: "Unresolved",
    });
  const topHoldings = allocations
    .filter((allocation) => allocation.weightPct !== null)
    .sort((a, b) => b.weightPct - a.weightPct)
    .slice(0, 5);
  const allocationComplete =
    basis === "none"
      ? false
      : active.length > 0 &&
        allocations.every((allocation) => allocation.weightPct !== null);
  const fieldCoverage = {};
  const metricKeys = unique(
    Object.values(companiesByCik).flatMap((company) =>
      Object.keys(company?.metrics || {}),
    ),
  );
  for (const key of metricKeys) {
    const coveredCiks = new Set(
      companyIssuers
        .filter((issuer) => {
          const company =
            companiesByCik[issuer.cik] ||
            companiesByCik[String(Number(issuer.cik))];
          const metric = company?.metrics?.[key];
          return available(issuer.cik) && finiteFinancialMetric(metric);
        })
        .map((issuer) => issuer.cik),
    );
    fieldCoverage[key] = {
      availableCompanies: coveredCiks.size,
      totalCompanies: companyIssuers.length,
      companyPct: companyIssuers.length
        ? (coveredCiks.size / companyIssuers.length) * 100
        : null,
      availableWeight:
        allocatedWeight === null
          ? null
          : sum(
              allocations
                .filter(
                  (allocation) =>
                    allocation.kind === "company" &&
                    allocation.status === "resolved" &&
                    coveredCiks.has(allocation.cik),
                )
                .map((allocation) => allocation.weightPct || 0),
            ),
    };
  }
  return {
    mode: basis === "none" ? "universe" : "weighted",
    basis,
    label:
      basis === "none"
        ? "Research universe · company counts"
        : basis === "equal"
          ? "Equal-weight model · explicit assumption"
          : basis === "market_value"
            ? "Weights from comparable position values"
            : normalized
              ? "Explicitly normalized supplied weights"
              : "Supplied weights · not normalized",
    normalized,
    assumptions,
    originalWeightTotal,
    allocatedWeight,
    valueTotal,
    currencies,
    asOfDates: dates,
    allocations,
    issuers,
    topHoldings,
    topFiveWeightPct: topHoldings.length
      ? sum(topHoldings.map((holding) => holding.weightPct))
      : null,
    topFiveWeightDefinition:
      "Sum of up to five largest known position weights. Missing or unreviewed weights are excluded; this is a known subtotal when allocationComplete is false.",
    topFiveIssuerWeightPct: issuers.some((issuer) => issuer.weightPct !== null)
      ? sum(issuers.slice(0, 5).map((issuer) => issuer.weightPct || 0))
      : null,
    companyCount: companyIssuers.length,
    resolvedCompanyCount: companyIssuers.length,
    holdingCount: active.length,
    unresolvedCount: unresolved.length,
    fundCount: issuers.filter((issuer) => issuer.kind === "fund").length,
    coverage: {
      totalCompanies: companyIssuers.length,
      availableCompanies,
      companyPct: companyIssuers.length
        ? (availableCompanies / companyIssuers.length) * 100
        : null,
      totalWeight: allocatedWeight,
      availableWeight,
      weightPct: availableWeight,
      percentOfSuppliedWeight:
        allocatedWeight > 0 ? (availableWeight / allocatedWeight) * 100 : null,
      unresolvedPositions: unresolved.length,
      excludedPositions: rows.length - active.length,
      companyDefinition:
        "Unique resolved operating companies with at least one supported finite financial metric. Filings-only research, unresolved positions, and funds do not count as financial evidence coverage.",
      weightDefinition:
        "Known analysis percentage points with at least one supported finite company financial metric; filings-only research does not count and the covered subset is never reweighted.",
    },
    fieldCoverage,
    distribution: [...distributionMap.values()],
    warnings: unique(warnings),
    issues,
    allocationComplete,
    reviewRequired:
      issues.length > 0 ||
      pending.size > 0 ||
      unresolved.length > 0 ||
      (basis === "weights" &&
        !normalized &&
        originalWeightTotal !== null &&
        Math.abs(originalWeightTotal - 100) > 0.000001) ||
      (basis !== "none" && !allocationComplete),
    valid:
      issues.length === 0 &&
      !pending.size &&
      (basis === "none" || allocationComplete),
  };
}
