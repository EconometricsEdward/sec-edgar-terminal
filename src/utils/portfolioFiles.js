import { Inflate, zipSync, strToU8 } from "fflate";
import {
  PORTFOLIO_COLUMNS,
  PORTFOLIO_SCHEMA_VERSION,
  MAX_PORTFOLIO_ROWS,
  MAX_PORTFOLIO_CELL_LENGTH,
} from "./portfolioModel.js";

export const MAX_PORTFOLIO_FILE_BYTES = 2 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_COLUMNS = 50;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const ALIASES = {
  ticker: [
    "ticker",
    "symbol",
    "stock symbol",
    "stock ticker",
    "security ticker",
  ],
  company_name: [
    "company name",
    "company",
    "name",
    "issuer",
    "issuer name",
    "security name",
  ],
  cik: ["cik", "sec cik", "central index key"],
  exchange: ["exchange", "stock exchange"],
  weight_pct: [
    "weight pct",
    "weight",
    "weight percent",
    "weight percentage",
    "allocation",
    "allocation pct",
    "portfolio weight",
    "weight %",
  ],
  market_value: [
    "market value",
    "position value",
    "holding value",
    "total value",
    "value",
  ],
  shares: ["shares", "quantity", "qty", "share count", "number of shares"],
  currency: ["currency", "ccy", "position currency"],
  as_of_date: [
    "as of date",
    "as of",
    "date",
    "holdings date",
    "allocation date",
  ],
  notes: ["notes", "note", "comments", "comment"],
};

const localName = (name) => name.split(":").at(-1);
const normalizeHeader = (value) =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
const isEmpty = (value) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && !value.trim());

function cell(value) {
  if (value == null) return "";
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new Error(
      "Cells must contain ordinary text or finite numbers, not objects or arrays.",
    );
  }
  if (String(value).length > MAX_PORTFOLIO_CELL_LENGTH)
    throw new Error(
      `Each cell is limited to ${MAX_PORTFOLIO_CELL_LENGTH.toLocaleString()} characters.`,
    );
  return typeof value === "string" ? value.trim() : value;
}

/** Preserve original column labels, including unknown columns, for the review step. */
function parsedRows(rows, metadata = {}, warnings = []) {
  const populated =
    metadata.format === "json"
      ? rows
      : rows.filter((row) => row.some((value) => !isEmpty(value)));
  if (!populated.length)
    throw new Error(
      "This file is empty. Include a header row and at least one company.",
    );
  if (populated.length - 1 > MAX_PORTFOLIO_ROWS)
    throw new Error(
      `Import at most ${MAX_PORTFOLIO_ROWS} holding rows at a time.`,
    );
  const width = Math.max(...populated.map((row) => row.length));
  if (width > MAX_COLUMNS)
    throw new Error(`Import files may contain at most ${MAX_COLUMNS} columns.`);
  const seen = new Set();
  const headers = Array.from({ length: width }, (_, index) => {
    const original =
      String(cell(populated[0][index] ?? "")) || `Column ${index + 1}`;
    let header = original;
    for (let suffix = 2; seen.has(header); suffix++)
      header = `${original} (${suffix})`;
    if (header !== original)
      warnings.push(
        `Repeated column “${original}” was labeled “${header}” for review.`,
      );
    seen.add(header);
    return header;
  });
  const assigned = new Set();
  const suggestedMapping = {};
  for (const header of headers) {
    const canonical = PORTFOLIO_COLUMNS.find((column) =>
      ALIASES[column].includes(normalizeHeader(header)),
    );
    if (canonical && !assigned.has(canonical)) {
      Object.defineProperty(suggestedMapping, header, {
        value: canonical,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      assigned.add(canonical);
    }
  }
  const unmapped = headers.filter(
    (header) => !Object.hasOwn(suggestedMapping, header),
  );
  if (unmapped.length)
    warnings.push(`Review the column mapping for: ${unmapped.join(", ")}.`);
  return {
    headers,
    records: populated
      .slice(1)
      .map((row) => headers.map((_, index) => cell(row[index] ?? ""))),
    suggestedMapping,
    warnings: [...new Set(warnings)],
    metadata,
  };
}

export function parsePortfolioCsv(text) {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > MAX_PORTFOLIO_FILE_BYTES
  )
    throw new Error("Files are limited to 2 MB.");
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [],
    value = "",
    quoted = false,
    closed = false,
    atStart = true;
  const pushCell = () => {
    row.push(cell(value));
    if (row.length > MAX_COLUMNS)
      throw new Error(
        `Import files may contain at most ${MAX_COLUMNS} columns.`,
      );
    value = "";
    closed = false;
    atStart = true;
  };
  const pushRow = () => {
    pushCell();
    if (row.some((item) => !isEmpty(item))) rows.push(row);
    if (rows.length > MAX_PORTFOLIO_ROWS + 1)
      throw new Error(
        `Import at most ${MAX_PORTFOLIO_ROWS} holding rows at a time.`,
      );
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else value += ch;
    } else if (ch === ",") pushCell();
    else if (ch === "\r" || ch === "\n") {
      pushRow();
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else if (ch === '"') {
      if (!atStart || value.trim())
        throw new Error(
          "CSV quoting is invalid. Quote the entire cell and double any quotation marks inside it.",
        );
      value = "";
      quoted = true;
      atStart = false;
    } else if (closed) {
      if (!/\s/.test(ch))
        throw new Error("Unexpected text after a closing CSV quotation mark.");
    } else {
      value += ch;
      if (!/\s/.test(ch)) atStart = false;
    }
    if (value.length > MAX_PORTFOLIO_CELL_LENGTH)
      throw new Error(
        `Each cell is limited to ${MAX_PORTFOLIO_CELL_LENGTH.toLocaleString()} characters.`,
      );
  }
  if (quoted) throw new Error("A CSV quotation mark was not closed.");
  if (row.length || value || closed) pushRow();
  return parsedRows(rows, { format: "csv" });
}

export function mapPortfolioColumns(parsed, mapping = parsed.suggestedMapping) {
  const selected = parsed.headers.map((header) =>
    Object.hasOwn(mapping, header) ? mapping[header] : "",
  );
  const mapped = selected.filter(Boolean);
  if (mapped.some((column) => !PORTFOLIO_COLUMNS.includes(column)))
    throw new Error("Choose one of the documented portfolio columns.");
  if (new Set(mapped).size !== mapped.length)
    throw new Error("Map each portfolio field to only one source column.");
  if (
    !["ticker", "company_name", "cik"].some((column) => mapped.includes(column))
  )
    throw new Error(
      "Map at least one ticker, company_name, or cik column before importing.",
    );
  return parsed.records.map((record) => {
    const holding = Object.fromEntries(
      PORTFOLIO_COLUMNS.map((column) => [column, ""]),
    );
    selected.forEach((column, index) => {
      if (!column) return;
      const value = cell(record[index]);
      holding[column] = ["weight_pct", "market_value", "shares"].includes(
        column,
      )
        ? value
        : String(value);
    });
    holding.original_input = Object.fromEntries(
      parsed.headers.map((header, index) => [header, cell(record[index])]),
    );
    return holding;
  });
}

export function parseTickerList(text) {
  if (typeof text !== "string" || text.length > MAX_PORTFOLIO_FILE_BYTES)
    throw new Error("Paste a ticker list of at most 100 rows.");
  const tokens = text
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (!tokens.length) throw new Error("Paste one or more tickers.");
  if (tokens.length > MAX_PORTFOLIO_ROWS)
    throw new Error(
      `Import at most ${MAX_PORTFOLIO_ROWS} holding rows at a time.`,
    );
  return tokens.map((ticker) => ({
    ticker: cell(ticker),
    original_input: { ticker },
  }));
}

export function parsePortfolioJson(text) {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > MAX_PORTFOLIO_FILE_BYTES
  )
    throw new Error("Files are limited to 2 MB.");
  let input;
  try {
    input = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(
      "This JSON file is not valid JSON. Use the documented portfolio example.",
    );
  }
  if (!input || Array.isArray(input) || typeof input !== "object")
    throw new Error(
      "JSON input must be a portfolio object with schema_version and holdings.",
    );
  if (input.schema_version !== PORTFOLIO_SCHEMA_VERSION)
    throw new Error(`Use schema_version “${PORTFOLIO_SCHEMA_VERSION}”.`);
  const allowed = [
    "schema_version",
    "name",
    "holdings",
    "allocation",
    "research",
    "action",
    "row_choices",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error(
      "The JSON file contains undocumented fields. Use the published schema.",
    );
  if (
    input.name != null &&
    (typeof input.name !== "string" || input.name.length > 200)
  )
    throw new Error("A portfolio name must be text of at most 200 characters.");
  if (
    !Array.isArray(input.holdings) ||
    input.holdings.length > MAX_PORTFOLIO_ROWS
  )
    throw new Error(
      `JSON holdings must be an array of at most ${MAX_PORTFOLIO_ROWS} rows.`,
    );
  if (input.action != null && !["resolve", "research"].includes(input.action))
    throw new Error("The JSON action must be resolve or research.");
  if (input.row_choices != null) {
    const indices = new Set();
    if (
      !Array.isArray(input.row_choices) ||
      input.row_choices.length > MAX_PORTFOLIO_ROWS
    )
      throw new Error(
        "row_choices must be an array of at most 100 duplicate decisions.",
      );
    for (const choice of input.row_choices) {
      if (
        !choice ||
        Array.isArray(choice) ||
        typeof choice !== "object" ||
        Object.keys(choice).some(
          (key) => !["index", "duplicateChoice"].includes(key),
        ) ||
        !Number.isInteger(choice.index) ||
        choice.index < 0 ||
        choice.index >= input.holdings.length ||
        indices.has(choice.index) ||
        !["keep", "remove"].includes(choice.duplicateChoice)
      )
        throw new Error(
          "Each row_choices item needs a distinct, valid holding index and duplicateChoice keep or remove.",
        );
      indices.add(choice.index);
    }
  }
  for (const [key, allowedKeys] of [
    ["allocation", ["basis", "normalize"]],
    ["research", ["basis"]],
  ]) {
    const option = input[key];
    if (option == null) continue;
    if (
      Array.isArray(option) ||
      typeof option !== "object" ||
      Object.keys(option).some((field) => !allowedKeys.includes(field))
    )
      throw new Error(`Invalid ${key} options.`);
  }
  if (
    input.allocation?.basis != null &&
    !["none", "weights", "market_value", "equal"].includes(
      input.allocation.basis,
    )
  )
    throw new Error("Unknown allocation basis.");
  if (
    input.allocation?.normalize != null &&
    typeof input.allocation.normalize !== "boolean"
  )
    throw new Error("allocation.normalize must be true or false.");
  if (
    input.research?.basis != null &&
    !["annual", "ttm"].includes(input.research.basis)
  )
    throw new Error("Research basis must be annual or ttm.");
  const rows = input.holdings.map((holding, index) => {
    if (
      !holding ||
      Array.isArray(holding) ||
      typeof holding !== "object" ||
      Object.keys(holding).some((key) => !PORTFOLIO_COLUMNS.includes(key))
    )
      throw new Error(
        `Holding ${index + 1} must use only the documented portfolio fields.`,
      );
    return PORTFOLIO_COLUMNS.map((column) => {
      const value = holding[column];
      if (value != null && typeof value === "boolean")
        throw new Error(
          `Holding ${index + 1}: ${column} must be text or a number.`,
        );
      if (
        value != null &&
        !["weight_pct", "market_value", "shares"].includes(column) &&
        typeof value !== "string"
      )
        throw new Error(`Holding ${index + 1}: ${column} must be text.`);
      return cell(value);
    });
  });
  return parsedRows([PORTFOLIO_COLUMNS, ...rows], {
    format: "json",
    schema_version: input.schema_version,
    name: input.name || "",
    allocation: input.allocation || { basis: "none", normalize: false },
    research: input.research || { basis: "annual" },
    row_choices: input.row_choices || [],
  });
}

function xmlDecode(value) {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity) => {
      if (entity[0] === "#") {
        const code =
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        if (
          !Number.isInteger(code) ||
          code < 1 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        )
          throw new Error("Invalid XML character.");
        return String.fromCodePoint(code);
      }
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
        entity.toLowerCase()
      ];
    },
  );
}

// OOXML needs only a small, non-executing XML tree. It never resolves an entity,
// URI, instruction, or external resource. Caps prevent pathological XML trees.
function xmlTree(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error(
      "XLSX files with XML document types or entities are not supported.",
    );
  const root = { name: "root", attrs: {}, children: [], text: "" },
    stack = [root];
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_](?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g;
  let match,
    end = 0,
    count = 0;
  while ((match = token.exec(text))) {
    if (match.index !== end) throw new Error("The XLSX XML is malformed.");
    end = token.lastIndex;
    const value = match[0],
      parent = stack.at(-1);
    if (value.startsWith("<!--") || value.startsWith("<?")) continue;
    if (value.startsWith("<![CDATA[")) {
      parent.text += value.slice(9, -3);
      continue;
    }
    if (!value.startsWith("<")) {
      parent.text += xmlDecode(value);
      continue;
    }
    if (value.startsWith("</")) {
      if (stack.length === 1 || value.slice(2, -1).trim() !== parent.name)
        throw new Error("The XLSX XML is malformed.");
      stack.pop();
      continue;
    }
    if (++count > 200000 || stack.length > 64)
      throw new Error("The XLSX XML structure is too complex.");
    const name = /^<([^\s/>]+)/.exec(value)?.[1];
    const attrs = {};
    const attributeText = value.slice(name.length + 1).replace(/\/?\s*>$/, "");
    const attribute = /([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g;
    let entry,
      attributeEnd = 0;
    while ((entry = attribute.exec(attributeText))) {
      if (
        attributeText.slice(attributeEnd, entry.index).trim() ||
        Object.hasOwn(attrs, entry[1])
      )
        throw new Error("The XLSX XML attributes are malformed.");
      Object.defineProperty(attrs, entry[1], {
        value: xmlDecode(entry[2].slice(1, -1)),
        enumerable: true,
      });
      attributeEnd = attribute.lastIndex;
    }
    if (attributeText.slice(attributeEnd).trim())
      throw new Error("The XLSX XML attributes are malformed.");
    const node = { name, attrs, children: [], text: "" };
    parent.children.push(node);
    if (!/\/\s*>$/.test(value)) stack.push(node);
  }
  if (
    end !== text.length ||
    stack.length !== 1 ||
    root.children.length !== 1 ||
    root.text.trim()
  )
    throw new Error("The XLSX XML is malformed.");
  return root.children[0];
}

const children = (node, name) =>
  node.children.filter((child) => localName(child.name) === name);
const first = (node, name) => children(node, name)[0];
const allText = (node) =>
  (node?.text || "") + (node?.children || []).map(allText).join("");

function zipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset--
  ) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("This is not a valid XLSX ZIP archive.");
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    start = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count > 1000 ||
    !count ||
    start + size !== end
  )
    throw new Error(
      "Split, ZIP64, or overly complex XLSX archives are not supported.",
    );
  const entries = new Map();
  let cursor = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error("Invalid XLSX ZIP directory.");
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true),
      expanded = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true),
      extraLength = view.getUint16(cursor + 30, true),
      commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength + extraLength + commentLength > end)
      throw new Error("Invalid XLSX ZIP entry.");
    const name = UTF8.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if (
      !name ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      name.includes("\0") ||
      entries.has(name)
    )
      throw new Error("The XLSX archive contains unsafe or duplicate paths.");
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      compressed === 0xffffffff ||
      expanded === 0xffffffff
    )
      throw new Error(
        "Encrypted or unsupported XLSX compression is not supported.",
      );
    total += expanded;
    if (
      total > MAX_UNCOMPRESSED_BYTES ||
      (expanded > 100000 && expanded / Math.max(compressed, 1) > 200)
    )
      throw new Error(
        "The XLSX archive expands beyond safe import limits (20 MB or excessive compression).",
      );
    if (offset + 30 > start || view.getUint32(offset, true) !== 0x04034b50)
      throw new Error("Invalid XLSX local ZIP entry.");
    const localNameLength = view.getUint16(offset + 26, true),
      localExtra = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + localNameLength + localExtra;
    if (
      dataStart + compressed > start ||
      view.getUint16(offset + 8, true) !== method ||
      view.getUint16(offset + 6, true) !== flags ||
      UTF8.decode(
        bytes.subarray(offset + 30, offset + 30 + localNameLength),
      ) !== name
    )
      throw new Error("The XLSX ZIP entry does not match its directory.");
    if (
      /vba|macros|connections|externallinks|embeddings|activex|ctrlprops|calcchain|(^|\/)(drawings|media|dialogSheets|macroSheets)(\/|$)|\.(bin|exe|dll|js|vbs)$/i.test(
        name,
      )
    )
      throw new Error(
        "Remove macros, external connections, embedded objects, and active content before importing this workbook.",
      );
    entries.set(name, { dataStart, compressed, expanded, method });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) throw new Error("Invalid XLSX ZIP directory size.");
  return entries;
}

function inflateArchiveEntry(compressed, declaredSize) {
  const output = new Uint8Array(declaredSize);
  let written = 0;
  const inflater = new Inflate((chunk) => {
    // Directory sizes are untrusted. Check actual output before copying or
    // feeding another compressed chunk, so a dishonest entry cannot force us
    // to decode its full stream into a silently truncated output buffer.
    if (written + chunk.length > declaredSize)
      throw new Error(
        "The XLSX archive exceeds its declared expanded size limit.",
      );
    output.set(chunk, written);
    written += chunk.length;
  });
  const chunkSize = 1024;
  for (let offset = 0; offset < compressed.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, compressed.length);
    inflater.push(compressed.subarray(offset, end), end === compressed.length);
  }
  if (written !== declaredSize)
    throw new Error("The XLSX archive has an invalid expanded size.");
  return output;
}

function readArchive(bytes) {
  const directory = zipDirectory(bytes),
    parts = new Map();
  for (const [name, entry] of directory) {
    // Small compressed chunks bound work before each actual-output check. The
    // archive preflight also caps the combined declared output at 20 MB.
    const compressed = bytes.subarray(
      entry.dataStart,
      entry.dataStart + entry.compressed,
    );
    const output =
      entry.method === 0
        ? compressed
        : inflateArchiveEntry(compressed, entry.expanded);
    if (output.length !== entry.expanded)
      throw new Error("The XLSX archive has an invalid expanded size.");
    if (
      !/\.(xml|rels)$/i.test(name) &&
      name !== "[Content_Types].xml" &&
      !name.endsWith("/")
    )
      throw new Error("This XLSX file contains unsupported embedded content.");
    if (/\.(xml|rels)$/i.test(name)) {
      const text = UTF8.decode(output).replace(/^\uFEFF/, "");
      if (
        /<!DOCTYPE|<!ENTITY|<\s*(?:[\w]+:)?(?:f|externalReference|oleObject|control|webPublishItem|customSheetView)(?:\s|\/?>)/i.test(
          text,
        )
      )
        throw new Error(
          "Formulas, external references, XML entities, and active workbook content are not supported. Save values only before importing.",
        );
      if (/macroEnabled|vbaProject|externalLink|oleObject|activeX/i.test(text))
        throw new Error("Remove active workbook content before importing.");
      if (name.endsWith(".rels")) {
        const tree = xmlTree(text);
        if (
          children(tree, "Relationship").some(
            (rel) =>
              rel.attrs.TargetMode?.toLowerCase() === "external" ||
              /^(?:[a-z]+:|\/\/)/i.test(rel.attrs.Target || ""),
          )
        )
          throw new Error(
            "External workbook relationships are not supported. Remove links and connections first.",
          );
      }
      parts.set(name, text);
    }
  }
  return parts;
}

function resolvePart(base, target) {
  if (!target || /\\|\0|[?#]/.test(target) || /^[a-z]+:/i.test(target))
    throw new Error("Invalid XLSX part relationship.");
  const parts = target.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const item of target.split("/")) {
    if (!item || item === ".") continue;
    if (item === "..") {
      if (!parts.length) throw new Error("Unsafe XLSX relationship path.");
      parts.pop();
    } else parts.push(item);
  }
  return parts.join("/");
}

function styleTypes(parts) {
  if (!parts.has("xl/styles.xml")) return [];
  const style = xmlTree(parts.get("xl/styles.xml"));
  const formats = new Map(
    (first(style, "numFmts")?.children || []).map((fmt) => [
      Number(fmt.attrs.numFmtId),
      fmt.attrs.formatCode || "",
    ]),
  );
  return (first(style, "cellXfs")?.children || []).map((xf) => {
    const id = Number(xf.attrs.numFmtId);
    const format = (formats.get(id) || "").replace(
      /"[^"]*"|\\.|\[[^\]]*\]/g,
      "",
    );
    if (
      (id >= 14 && id <= 22) ||
      (id >= 27 && id <= 36) ||
      (id >= 50 && id <= 58) ||
      /[yd]/i.test(format)
    )
      return "date";
    if ([9, 10].includes(id) || format.includes("%")) return "percent";
    return "number";
  });
}

function excelDate(serial, date1904) {
  if (
    !Number.isFinite(serial) ||
    serial < 0 ||
    serial > 2958465 ||
    (!date1904 && Math.floor(serial) === 60)
  )
    throw new Error(
      "A spreadsheet date is invalid. Use YYYY-MM-DD text or a valid Excel date.",
    );
  const days = date1904 ? serial : serial - (serial >= 60 ? 1 : 0);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  return new Date(epoch + Math.floor(days) * 86400000)
    .toISOString()
    .slice(0, 10);
}

function parseSheet(text, strings, styles, date1904, warnings) {
  const tree = xmlTree(text);
  if (localName(tree.name) !== "worksheet")
    throw new Error("The selected XLSX sheet is not a worksheet.");
  if (first(tree, "mergeCells"))
    throw new Error(
      "Unmerge cells in the import sheet so each field has its own column.",
    );
  const rows = [];
  for (const row of first(tree, "sheetData")?.children || []) {
    if (localName(row.name) !== "row") continue;
    const cells = [],
      used = new Set();
    for (const entry of children(row, "c")) {
      const coordinate = /^([A-Z]+)([1-9]\d*)$/.exec(entry.attrs.r || "");
      if (entry.attrs.r && !coordinate)
        throw new Error("The XLSX cell coordinate is invalid.");
      let index = cells.length;
      if (coordinate)
        index =
          [...coordinate[1]].reduce(
            (number, letter) => number * 26 + letter.charCodeAt(0) - 64,
            0,
          ) - 1;
      if (index >= MAX_COLUMNS || used.has(index))
        throw new Error(
          `Import sheets need at most ${MAX_COLUMNS} distinct columns per row.`,
        );
      used.add(index);
      const type = entry.attrs.t,
        raw = first(entry, "v")?.text || "";
      let value = "";
      if (type === "inlineStr") value = allText(first(entry, "is"));
      else if (type === "s") {
        const stringIndex = Number(raw);
        if (
          !/^\d+$/.test(raw) ||
          !Number.isSafeInteger(stringIndex) ||
          stringIndex >= strings.length
        )
          throw new Error("The XLSX shared-string reference is invalid.");
        value = strings[stringIndex];
      } else if (["str", "d"].includes(type)) value = raw;
      else if (type === "e")
        throw new Error(
          "The workbook contains an Excel error cell. Correct it or export plain values first.",
        );
      else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
      else if (raw !== "") {
        if (
          !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ||
          !Number.isFinite(Number(raw))
        )
          throw new Error("The workbook contains an invalid numeric cell.");
        value = Number(raw);
        const style = styles[Number(entry.attrs.s || 0)];
        if (style === "date") value = excelDate(value, date1904);
        if (style === "percent") {
          value *= 100;
          warnings.push(
            "Excel percentage cells were read as displayed percentage points: 12.5% becomes weight_pct 12.5. Review allocation values before importing.",
          );
        }
      }
      cells[index] = cell(value);
    }
    if (cells.some((value) => !isEmpty(value)))
      rows.push(
        Array.from({ length: cells.length }, (_, index) => cells[index] ?? ""),
      );
    if (rows.length > MAX_PORTFOLIO_ROWS + 1)
      throw new Error(
        `Import at most ${MAX_PORTFOLIO_ROWS} holding rows at a time.`,
      );
  }
  return rows;
}

export function parsePortfolioXlsx(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PORTFOLIO_FILE_BYTES)
    throw new Error("Files are limited to 2 MB.");
  const parts = readArchive(bytes);
  if (
    !parts.has("[Content_Types].xml") ||
    !parts.has("xl/workbook.xml") ||
    !parts.has("xl/_rels/workbook.xml.rels")
  )
    throw new Error("This archive is not a supported XLSX workbook.");
  const contentTypes = xmlTree(parts.get("[Content_Types].xml"));
  const workbookType =
    children(contentTypes, "Override").find(
      (entry) => entry.attrs.PartName === "/xl/workbook.xml",
    )?.attrs.ContentType ||
    children(contentTypes, "Default").find(
      (entry) => entry.attrs.Extension === "xml",
    )?.attrs.ContentType;
  if (
    workbookType !==
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
  )
    throw new Error(
      "Only standard .xlsx workbooks are supported, without macros.",
    );
  const workbook = xmlTree(parts.get("xl/workbook.xml"));
  const relationships = xmlTree(parts.get("xl/_rels/workbook.xml.rels"));
  const sheets = (first(workbook, "sheets")?.children || []).filter(
    (sheet) =>
      localName(sheet.name) === "sheet" &&
      sheet.attrs.name?.toLowerCase() !== "instructions",
  );
  const preferred = sheets.find(
    (sheet) => sheet.attrs.name?.toLowerCase() === "holdings",
  );
  if (preferred) sheets.splice(0, sheets.length, preferred);
  const shared = parts.has("xl/sharedStrings.xml")
    ? xmlTree(parts.get("xl/sharedStrings.xml"))
    : null;
  const strings = shared
    ? children(shared, "si").map((item) => cell(allText(item)))
    : [];
  const styles = styleTypes(parts),
    date1904 = ["1", "true"].includes(
      first(workbook, "workbookPr")?.attrs.date1904,
    );
  const warnings = [];
  for (const sheet of sheets) {
    const relationId =
      sheet.attrs["r:id"] ||
      Object.entries(sheet.attrs).find(([key]) => key.endsWith(":id"))?.[1];
    const relationship = children(relationships, "Relationship").find(
      (entry) => entry.attrs.Id === relationId,
    );
    if (!relationship?.attrs.Type?.endsWith("/worksheet"))
      throw new Error("The XLSX sheet relationship is not a data worksheet.");
    const path = resolvePart("xl/workbook.xml", relationship.attrs.Target);
    if (!parts.has(path)) throw new Error("The XLSX data sheet is missing.");
    const rows = parseSheet(
      parts.get(path),
      strings,
      styles,
      date1904,
      warnings,
    );
    if (rows.length)
      return parsedRows(
        rows,
        { format: "xlsx", sheet: sheet.attrs.name },
        warnings,
      );
  }
  throw new Error(
    "No importable Holdings or data sheet was found. The Instructions sheet is ignored.",
  );
}

/** Browser-local parsing: no file contents are sent to a server. */
export async function parsePortfolioFile(input, filename = "") {
  const name =
    typeof filename === "string"
      ? filename || input?.name || ""
      : filename?.name || input?.name || "";
  if (input?.size > MAX_PORTFOLIO_FILE_BYTES)
    throw new Error("Files are limited to 2 MB.");
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : input?.arrayBuffer
          ? new Uint8Array(await input.arrayBuffer())
          : null;
  if (!bytes || !bytes.length)
    throw new Error("Choose a nonempty CSV, XLSX, or JSON file.");
  if (bytes.length > MAX_PORTFOLIO_FILE_BYTES)
    throw new Error("Files are limited to 2 MB.");
  const extension = name.split(".").at(-1).toLowerCase();
  if (!["csv", "xlsx", "json"].includes(extension))
    throw new Error(
      "Choose a CSV, XLSX, or documented JSON file. Older .xls files are not supported.",
    );
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (extension === "xlsx") {
    if (!zipped)
      throw new Error("This file does not have a valid XLSX signature.");
    return parsePortfolioXlsx(bytes);
  }
  if (zipped || bytes.includes(0))
    throw new Error(
      "The file contents do not match a plain UTF-8 CSV or JSON file.",
    );
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new Error("Save this CSV or JSON file as UTF-8 before importing it.");
  }
  if (/^\s*(?:<!doctype|<html|<script|<\?xml)/i.test(text))
    throw new Error(
      "HTML and XML files are not supported as portfolio uploads.",
    );
  return extension === "json"
    ? parsePortfolioJson(text)
    : parsePortfolioCsv(text);
}

function safeCsvCell(value) {
  if (value == null) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (
    typeof value !== "number" &&
    (/^[\s\u0000-\u001f\u007f\u200b-\u200d\uFEFF]*[=+\-@]/.test(text) ||
      /^[\t\r\n]/.test(text))
  )
    text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvString(rows) {
  return `\uFEFF${rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n")}\r\n`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[character],
    );
}

function columnName(index) {
  let result = "";
  for (index++; index > 0; index = Math.floor((index - 1) / 26))
    result = String.fromCharCode(65 + ((index - 1) % 26)) + result;
  return result;
}

/** Lightweight application export codec. Every string is literal inline text,
 * including strings beginning with '='. This never emits formulas or links. */
export function createXlsxWorkbook(sheets) {
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > 20)
    throw new Error("Export requires 1–20 worksheets.");
  const names = new Set(),
    files = {};
  const sheetEntries = [],
    relationships = [],
    overrides = [];
  for (let index = 0; index < sheets.length; index++) {
    const sheet = sheets[index],
      name = String(sheet.name || `Sheet ${index + 1}`)
        .replace(/[\\/?*:[\]]/g, " ")
        .slice(0, 31);
    if (!name.trim() || names.has(name.toLowerCase()))
      throw new Error("Worksheet names must be distinct and nonempty.");
    names.add(name.toLowerCase());
    if (
      !Array.isArray(sheet.rows) ||
      sheet.rows.length > 100000 ||
      sheet.rows.some((row) => !Array.isArray(row) || row.length > 100)
    )
      throw new Error(
        "Export worksheets are limited to 100,000 rows and 100 columns.",
      );
    const rows = sheet.rows
      .map(
        (row, rowIndex) =>
          `<row r="${rowIndex + 1}">${row
            .map((value, colIndex) => {
              const reference = `${columnName(colIndex)}${rowIndex + 1}`;
              if (value == null || value === "") return "";
              if (typeof value === "number")
                return Number.isFinite(value)
                  ? `<c r="${reference}"><v>${value}</v></c>`
                  : "";
              if (typeof value === "boolean")
                return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
              if (value instanceof Date && !Number.isNaN(value.getTime()))
                return `<c r="${reference}" s="2"><v>${(value.getTime() - Date.UTC(1899, 11, 30)) / 86400000}</v></c>`;
              const text =
                typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value);
              return `<c r="${reference}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
            })
            .join("")}</row>`,
      )
      .join("");
    const width = sheet.rows.reduce(
      (maximum, row) => Math.max(maximum, row.length),
      1,
    );
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(
      `${XML_HEADER}<worksheet xmlns="${MAIN_NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${width}" width="22" customWidth="1"/></cols><sheetData>${rows}</sheetData></worksheet>`,
    );
    sheetEntries.push(
      `<sheet name="${xmlEscape(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    );
    relationships.push(
      `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    );
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    );
  }
  files["xl/workbook.xml"] = strToU8(
    `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheetEntries.join("")}</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">${relationships.join("")}<Relationship Id="rStyles" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
  );
  files["_rels/.rels"] = strToU8(
    `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files["xl/styles.xml"] = strToU8(
    `${XML_HEADER}<styleSheet xmlns="${MAIN_NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF172033"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  files["[Content_Types].xml"] = strToU8(
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides.join("")}</Types>`,
  );
  return zipSync(files, { level: 6 });
}

export function blankTemplateBytes(format = "csv") {
  if (format === "csv") return strToU8(csvString([PORTFOLIO_COLUMNS]));
  if (format === "json")
    return strToU8(
      JSON.stringify(
        {
          schema_version: PORTFOLIO_SCHEMA_VERSION,
          holdings: [],
          allocation: { basis: "none", normalize: false },
          research: { basis: "annual" },
        },
        null,
        2,
      ),
    );
  throw new Error(
    "Download the formatted Excel template from /portfolio/portfolio-template.xlsx.",
  );
}
