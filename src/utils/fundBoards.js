import { normalizeFundWorkspaceSettings } from "./fundWorkspaceSettings.js";

export const FUND_BOARDS_KEY = "edgar:fund-boards:v1";
export const FUND_BOARD_LIMIT = 12;
export const FUND_EVIDENCE_LIMIT = 40;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const ticker = (value) =>
  typeof value === "string" && /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(value);
const date = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const timestamp = (value) =>
  typeof value === "string" &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
const boundedText = (value, max) =>
  typeof value === "string" && value.length <= max;
export function validFundSourceUrl(value) {
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
function sourceRecord(source) {
  requireValue(
    object(source) &&
      ticker(source.ticker) &&
      /^\d{10}-\d{2}-\d{6}$/.test(source.accession || "") &&
      date(source.asOf) &&
      date(source.filingDate) &&
      validFundSourceUrl(source.sourceUrl),
    "Evidence needs a valid SEC source, ticker, accession, portfolio date, and filing date.",
  );
  requireValue(
    source.name === undefined || boundedText(source.name, 400),
    "Evidence source name is too long.",
  );
  return {
    ticker: source.ticker,
    name: source.name || "",
    accession: source.accession,
    asOf: source.asOf,
    filingDate: source.filingDate,
    sourceUrl: source.sourceUrl,
  };
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function hash(text, seed) {
  let value = seed;
  for (const char of text) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36);
}
export function fundEvidenceKey(evidence) {
  const { id: _id, ...facts } = evidence;
  const text = stable(facts);
  return `fund-evidence-${hash(text, 2166136261)}-${hash(text, 1376312589)}`;
}
export function createFundEvidence(input) {
  requireValue(
    object(input) &&
      ["security", "comparison", "allocation", "change", "coverage"].includes(
        input.kind,
      ),
    "Choose a supported fund evidence type.",
  );
  requireValue(
    boundedText(input.title, 240) && input.title.trim(),
    "Evidence needs a title of at most 240 characters.",
  );
  requireValue(
    boundedText(input.summary || "", 3000) &&
      boundedText(input.methodology || "", 3000),
    "Evidence descriptions must contain at most 3,000 characters each.",
  );
  requireValue(
    Array.isArray(input.values) && input.values.length <= 24,
    "Evidence supports up to 24 recorded values.",
  );
  const values = input.values.map((entry) => {
    requireValue(
      object(entry) &&
        boundedText(entry.label, 200) &&
        entry.label.trim() &&
        (entry.value === null ||
          (typeof entry.value === "number" && Number.isFinite(entry.value)) ||
          boundedText(entry.value, 1000)) &&
        (entry.unit === undefined || boundedText(entry.unit, 80)),
      "Evidence contains an invalid value.",
    );
    return { label: entry.label, value: entry.value, unit: entry.unit || "" };
  });
  requireValue(
    Array.isArray(input.sources) &&
      input.sources.length > 0 &&
      input.sources.length <= 8,
    "Evidence needs between one and eight SEC source reports.",
  );
  const sources = input.sources.map(sourceRecord);
  const evidence = {
    kind: input.kind,
    title: input.title.trim(),
    summary: input.summary || "",
    values,
    sources,
    methodology: input.methodology || "",
  };
  return { id: fundEvidenceKey(evidence), ...evidence };
}
export function validateFundEvidence(evidence) {
  const normalized = createFundEvidence(evidence);
  requireValue(
    stable(evidence) === stable(normalized),
    "Saved fund evidence identity does not match its captured content.",
  );
  return normalized;
}
function snapshotRecord(snapshot) {
  const source = sourceRecord(snapshot);
  requireValue(
    (snapshot.cik === undefined ||
      snapshot.cik === "" ||
      /^\d{10}$/.test(snapshot.cik)) &&
      (snapshot.seriesId === undefined ||
        snapshot.seriesId === null ||
        /^S\d{9}$/.test(snapshot.seriesId)) &&
      (snapshot.classId === undefined ||
        snapshot.classId === null ||
        /^C\d{9}$/.test(snapshot.classId)),
    "Saved fund snapshot identifiers are invalid.",
  );
  const numericFields = (input, keys) =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        typeof input?.[key] === "number" && Number.isFinite(input[key])
          ? input[key]
          : null,
      ]),
    );
  return {
    ...source,
    cik: typeof snapshot.cik === "string" ? snapshot.cik : "",
    seriesId: snapshot.seriesId || null,
    classId: snapshot.classId || null,
    fundInfo: numericFields(snapshot.fundInfo, [
      "netAssets",
      "totAssets",
      "totLiabs",
      "cash",
    ]),
    summary: numericFields(snapshot.summary, [
      "count",
      "valuedCount",
      "weightCount",
      "value",
      "weightTotal",
      "top10Weight",
      "derivativeCount",
    ]),
  };
}
/** @param {{settings: object, snapshots?: any[], evidence?: any[], name: string, notes?: string, id: string, now?: string}} input */
export function captureFundBoard({
  settings,
  snapshots = [],
  evidence = [],
  name,
  notes = "",
  id,
  now = new Date().toISOString(),
}) {
  const normalized = normalizeFundWorkspaceSettings(settings);
  requireValue(
    Array.isArray(evidence) && evidence.length <= FUND_EVIDENCE_LIMIT,
    "A research board holds at most 40 evidence items. Remove an item before adding another.",
  );
  const selected = new Set(normalized.tickers);
  const reports = { ...normalized.reportMap };
  const included = [],
    captured = new Set();
  for (const snapshot of snapshots) {
    if (
      !snapshot ||
      !selected.has(snapshot.ticker) ||
      captured.has(snapshot.ticker) ||
      (snapshot.status && snapshot.status !== "ready")
    )
      continue;
    if (
      reports[snapshot.ticker] &&
      reports[snapshot.ticker] !== snapshot.accession
    )
      continue;
    try {
      included.push(snapshotRecord(snapshot));
      reports[snapshot.ticker] = snapshot.accession;
      captured.add(snapshot.ticker);
    } catch {
      /* Unverified metadata remains explicitly outside snapshot coverage. */
    }
  }
  const board = {
    version: 1,
    id,
    revision: 1,
    name: name?.trim(),
    notes,
    createdAt: now,
    updatedAt: now,
    capturedAt: now,
    settings: normalizeFundWorkspaceSettings({
      ...normalized,
      reportMap: reports,
      board: "",
    }),
    snapshots: included,
    missingSnapshots: normalized.tickers.filter((t) => !captured.has(t)),
    evidence: evidence.map(createFundEvidence),
  };
  validateFundBoard(board);
  return clone(board);
}
export function validateFundBoard(board) {
  requireValue(
    object(board) &&
      board.version === 1 &&
      boundedText(board.id, 100) &&
      /^[A-Za-z0-9_-]+$/.test(board.id) &&
      Number.isSafeInteger(board.revision) &&
      board.revision > 0,
    "Saved fund board identity or revision is invalid.",
  );
  requireValue(
    boundedText(board.name, 120) &&
      board.name.trim() &&
      boundedText(board.notes, 8000),
    "Board names need 1–120 characters and notes support at most 8,000 characters.",
  );
  requireValue(
    [board.createdAt, board.updatedAt, board.capturedAt].every(timestamp),
    "Saved fund board dates are invalid.",
  );
  requireValue(
    object(board.settings) &&
      stable(normalizeFundWorkspaceSettings(board.settings)) ===
        stable(board.settings),
    "Saved fund board settings are invalid.",
  );
  requireValue(
    Array.isArray(board.snapshots) &&
      board.snapshots.length <= 4 &&
      Array.isArray(board.missingSnapshots) &&
      board.missingSnapshots.length <= 4 &&
      board.missingSnapshots.every(ticker),
    "Saved fund board snapshot coverage is invalid.",
  );
  const included = new Set();
  board.snapshots.forEach((snapshot) => {
    const normalized = snapshotRecord(snapshot);
    requireValue(
      stable(normalized) === stable(snapshot) &&
        board.settings.tickers.includes(snapshot.ticker) &&
        board.settings.reportMap[snapshot.ticker] === snapshot.accession &&
        !included.has(snapshot.ticker),
      "Saved fund snapshot does not match its research settings.",
    );
    included.add(snapshot.ticker);
  });
  requireValue(
    stable(board.settings.tickers.filter((t) => !included.has(t))) ===
      stable(board.missingSnapshots),
    "Saved fund snapshot coverage is inconsistent.",
  );
  requireValue(
    Array.isArray(board.evidence) &&
      board.evidence.length <= FUND_EVIDENCE_LIMIT,
    "A research board holds at most 40 evidence items.",
  );
  const evidenceIds = new Set();
  board.evidence.forEach((entry) => {
    validateFundEvidence(entry);
    requireValue(
      !evidenceIds.has(entry.id),
      "Saved fund board contains duplicate evidence.",
    );
    evidenceIds.add(entry.id);
  });
  return board;
}
export function validateFundBoards(data) {
  requireValue(
    object(data) &&
      data.version === 1 &&
      Array.isArray(data.boards) &&
      data.boards.length <= FUND_BOARD_LIMIT,
    "Saved fund boards are invalid or exceed the 12-board limit. Existing data has been preserved.",
  );
  const ids = new Set();
  data.boards.forEach((board) => {
    validateFundBoard(board);
    requireValue(!ids.has(board.id), "Saved fund board IDs must be unique.");
    ids.add(board.id);
  });
  return data;
}
export function readFundBoards(raw) {
  if (raw === null || raw === undefined) return { version: 1, boards: [] };
  requireValue(
    typeof raw === "string" && raw.length <= 8 * 1024 * 1024,
    "Saved fund boards exceed the storage limit.",
  );
  try {
    return validateFundBoards(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Fund boards could not be read. Existing browser data has been preserved. ${error.message}`,
    );
  }
}
export function writeFundBoard(
  storage,
  {
    mode,
    board,
    id = board?.id,
    expectedRevision,
    now = new Date().toISOString(),
  },
) {
  const current = readFundBoards(storage.getItem(FUND_BOARDS_KEY));
  const existing = current.boards.find((item) => item.id === id);
  requireValue(
    ["create", "update", "delete"].includes(mode),
    "Choose a supported board action.",
  );
  if (mode === "create") {
    requireValue(
      !existing,
      "This board already exists. Save with a new identity.",
    );
    requireValue(
      current.boards.length < FUND_BOARD_LIMIT,
      "Your workspace holds 12 boards. Delete a board before saving another.",
    );
    validateFundBoard(board);
    current.boards.unshift(clone(board));
  } else {
    requireValue(
      existing && existing.revision === expectedRevision,
      "This board changed in another tab or was restored from backup. Reload the saved board, or save your draft as a new board.",
    );
    if (mode === "delete")
      current.boards = current.boards.filter((item) => item.id !== id);
    else {
      const next = {
        ...clone(board),
        id: existing.id,
        createdAt: existing.createdAt,
        revision: existing.revision + 1,
        updatedAt: now,
      };
      validateFundBoard(next);
      current.boards = current.boards.map((item) =>
        item.id === id ? next : item,
      );
    }
  }
  validateFundBoards(current);
  const raw = JSON.stringify(current);
  requireValue(
    raw.length <= 8 * 1024 * 1024,
    "Saved fund boards exceed the storage limit. Existing boards have been preserved.",
  );
  storage.setItem(FUND_BOARDS_KEY, raw);
  return current;
}
