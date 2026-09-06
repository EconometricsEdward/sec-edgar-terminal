import { gzipSync, gunzipSync } from "node:zlib";
import { buildFilingUrl, stripHtml } from "./filingTextParser.js";
import { compareDisclosureText } from "./filingChanges.js";
import { disclosurePassages } from "./disclosureResearch.js";
import { warmGet, warmSet } from "./warmCache.js";
import { loadFilingsCompany, loadFilingsArchive } from "./filingsResearchServer.js";
import { validFilingDate } from "./filingsResearch.js";

const MAX_DOCUMENT_BYTES = 24_000_000;
const PAGE_SIZE = 8;
const TEXT_CACHE_NAMESPACE = "filings-reader-text-v2";
const cache = new Map();
let nextRequest = 0;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;

export function filingReaderSettings(params) {
  const ticker = (params.get("ticker") || "").trim().toUpperCase();
  const accession = params.get("accession") || "";
  const prior = params.get("prior") || "";
  const archive = params.get("archive") || "";
  const priorArchive = params.get("priorArchive") || "";
  const filed = params.get("filed") || "";
  const priorFiled = params.get("priorFiled") || "";
  const query = (params.get("query") || "").trim();
  const section = params.get("section") || "all";
  const view = params.get("view") || "document";
  const page = Number(params.get("page") || 1);
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker) || !accessionPattern.test(accession))
    throw error("Provide an exact company ticker and valid SEC accession.");
  if (prior && !accessionPattern.test(prior)) throw error("Invalid prior SEC accession.");
  if ([archive, priorArchive].some((name) => name && !/^CIK\d{10}-submissions-\d+\.json$/.test(name)))
    throw error("Invalid SEC history archive.");
  if ([filed, priorFiled].some((date) => date && !validFilingDate(date)))
    throw error("Provide a valid filing date for archive recovery.");
  if (query.length > 200 || !/^(all|other|risk|mda|notes|8k:\d\.\d{2})$/.test(section) ||
      !["document", "changes"].includes(view) || !Number.isInteger(page) || page < 1 || page > 100000)
    throw error("Invalid reader filters or page.");
  // No caller-supplied URLs or document names are accepted. The primary document
  // is resolved from the SEC manifest belonging to the requested company.
  return { ticker, accession, prior, archive, priorArchive, filed, priorFiled, query, section, view, page };
}

export function validateReaderDocument(cik, filing) {
  if (!/^\d{1,10}$/.test(String(cik)) || !accessionPattern.test(filing?.accession || ""))
    throw error("Invalid SEC document identity.");
  const name = filing.primaryDoc || "";
  if (!/^[\w][\w.\/-]*\.(htm|html|txt|xml)$/i.test(name) || name.includes("..") || name.includes("//"))
    throw error("This document format cannot be read here. Open the original SEC document.", 422);
  return buildFilingUrl(cik, filing.accession, name);
}

function decodeEntities(value) {
  // Decode numeric entities only after markup removal. Otherwise an encoded
  // less-than sign becomes a tag, and supplementary Unicode is truncated by
  // the legacy parser's fromCharCode conversion.
  const entities = [];
  const protectedText = value.replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, decimal) => {
    const point = Number.parseInt(hex || decimal, hex ? 16 : 10);
    entities.push(point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "�");
    return `\uE000${entities.length - 1}\uE001`;
  });
  return stripHtml(protectedText).replace(/\uE000(\d+)\uE001/g, (original, index) => entities[Number(index)] ?? original);
}

/** XML ownership reports retain field labels; they are never presented as a table. */
function xmlFields(xml) {
  const stack = [];
  const fields = [];
  const label = (name) => name.replace(/^.*:/, "").replace(/([a-z\d])([A-Z])/g, "$1 $2");
  const tokens = xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<\/?[A-Za-z_][^>]*>|[^<]+/g);
  for (const token of tokens) {
    const value = token[0];
    if (value.startsWith("</")) { stack.pop(); continue; }
    if (value.startsWith("<")) {
      if (!value.endsWith("/>")) stack.push(value.match(/^<([\w:.-]+)/)?.[1] || "field");
      continue;
    }
    if (!stack.length) continue;
    const text = decodeEntities(value).trim();
    if (!text || /^\s*$/.test(text)) continue;
    const names = stack.filter((name) => !/^(value|ownershipDocument)$/i.test(name.replace(/^.*:/, ""))).slice(-3);
    fields.push(`${names.map(label).join(" / ")}: ${text}`);
  }
  return fields.join("\n\n");
}

export function extractFilingReaderText(raw, filename = "filing.htm") {
  if (/<title>[^<]*(?:access denied|request rate threshold|undeclared automated tool)/i.test(raw) ||
      /<h1[^>]*>\s*(?:access denied|request rate threshold)/i.test(raw))
    throw error("SEC did not return usable filing text. Open the original or try again.", 502);
  const xml = /\.xml$/i.test(filename) && !/<html\b/i.test(raw);
  // Inline XBRL headers contain thousands of hidden contexts, dimensions and
  // units. Remove those containers before stripping tags, otherwise technical
  // member names become apparent narrative paragraphs. Visible inline facts
  // (nonFraction/nonNumeric) outside these containers remain readable.
  const cleaned = raw.replace(/<(ix:header|ix:resources|ix:references|ix:hidden|xbrli:context|xbrli:unit)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<link:(schemaRef|linkbaseRef)\b[^>]*(?:\/>|>[\s\S]*?<\/link:\1\s*>)/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?(?:\]>|>)/gi, "");
  const text = xml ? xmlFields(cleaned) : decodeEntities(cleaned);
  if (text.length < 30) throw error("SEC returned too little usable text. Open the original document.", 502);
  return { text, format: xml ? "xml-fields" : "text" };
}

/** Enforce the limit while reading, including servers that omit Content-Length. */
export async function readBoundedFilingResponse(response, maxBytes = MAX_DOCUMENT_BYTES) {
  if (Number(response.headers.get("content-length") || 0) > maxBytes)
    throw error("Document exceeds the 24 MB reader limit. Open the SEC original.", 422);
  if (!response.body) throw error("SEC returned an empty document body.", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw error("Document exceeds the 24 MB reader limit. Open the SEC original.", 422);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export async function fetchReaderDocument(cik, filing, { signal } = {}) {
  const url = validateReaderDocument(cik, filing);
  const key = `${cik}:${filing.accession}:${filing.primaryDoc}`;
  const local = cache.get(key);
  if (local && local.expires > Date.now()) return local.value;
  const cached = await warmGet(TEXT_CACHE_NAMESPACE, key);
  let value;
  if (cached?.gzip) {
    try {
      const text = gunzipSync(Buffer.from(cached.gzip, "base64"), { maxOutputLength: MAX_DOCUMENT_BYTES }).toString("utf8");
      if (text.length >= 30) value = { text, format: cached.format || "text" };
    } catch { /* A corrupt entry is a miss; a failed fetch is never cached. */ }
  }
  if (!value) {
    const slot = Math.max(Date.now(), nextRequest);
    nextRequest = slot + 180;
    if (slot > Date.now()) await new Promise((resolve) => setTimeout(resolve, slot - Date.now()));
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(18000);
    const response = await fetch(url, {
      headers: { "User-Agent": process.env.SEC_USER_AGENT || "EDGAR Terminal research@secedgarterminal.com", Accept: "text/html,text/plain,application/xml" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw error(`SEC document request returned HTTP ${response.status}. Try again or open the original.`, 502);
    const contentType = response.headers.get("content-type") || "";
    if (/application\/pdf|image\/|application\/(?:zip|octet-stream)/i.test(contentType))
      throw error("SEC returned a non-text document. Open the original SEC document.", 422);
    value = extractFilingReaderText(await readBoundedFilingResponse(response), filing.primaryDoc);
    await warmSet(TEXT_CACHE_NAMESPACE, key, { gzip: gzipSync(value.text).toString("base64"), format: value.format }, 86400 * 7);
  }
  let size = value.text.length;
  for (const item of cache.values()) size += item.value.text.length;
  while (cache.size && (size > 20_000_000 || cache.size >= 16)) {
    const first = cache.keys().next().value;
    size -= cache.get(first).value.text.length;
    cache.delete(first);
  }
  if (value.text.length < 20_000_000) cache.set(key, { value, expires: Date.now() + 3600000 });
  return value;
}

export function validateReaderPair(current, prior) {
  if (!prior) return { allowed: false, kind: "unavailable", reason: "No comparable prior report is selected. Load older history if needed." };
  if (!/^(10-K|10-Q)(\/A)?$/.test(current.form))
    return { allowed: false, kind: "unsupported", reason: "Passage comparison covers Risk Factors and MD&A in 10-K and 10-Q reports. Other forms remain available in the document reader." };
  if (prior.accession === current.accession || prior.form.replace(/\/A$/, "") !== current.form.replace(/\/A$/, "") ||
      !current.reportDate || !prior.reportDate || prior.filingDate > current.filingDate ||
      (prior.filingDate === current.filingDate && prior.accession > current.accession))
    return { allowed: false, kind: "incompatible", reason: "The baseline must be an earlier filing of the same report form." };
  if (current.form.endsWith("/A")) {
    if (prior.reportDate !== current.reportDate)
      return { allowed: false, kind: "incompatible", reason: "An amendment must be compared with a preceding filing for the same reporting period." };
    return { allowed: true, kind: "amendment", reason: "Amendment versus the same reporting period. Amendments may replace only part of a report; unmatched text is not labeled as added or removed." };
  }
  if (prior.form.endsWith("/A") || prior.reportDate >= current.reportDate)
    return { allowed: false, kind: "incompatible", reason: "Compare full periodic reports for different reporting periods; amendments are separate evidence." };
  return { allowed: true, kind: "periodic", reason: "Same-form reporting periods. Paragraph matching is approximate; check the original reports before interpreting changes." };
}

export function paginateReaderText(text, form, { query = "", section = "all", page = 1 } = {}) {
  const extracted = disclosurePassages(text, form);
  // Some SEC HTML contains one enormous paragraph. Split it without dropping text
  // so one reader page and one saved passage stay manageable.
  const paragraphs = extracted.paragraphs.flatMap((p) => {
    if (p.text.length <= 6000) return [{ ...p, part: 1, parts: 1 }];
    const chunks = [];
    let remaining = p.text;
    while (remaining.length > 6000) {
      const cut = remaining.lastIndexOf(" ", 6000);
      const end = cut > 3000 ? cut : 6000;
      chunks.push(remaining.slice(0, end));
      remaining = remaining.slice(end).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks.map((chunk, i) => ({ ...p, text: chunk, part: i + 1, parts: chunks.length }));
  });
  const matched = paragraphs.flatMap((p, i) =>
    (section === "all" || p.sectionId === section) && (!query || p.text.toLowerCase().includes(query.toLowerCase()))
      ? [{ ...p, beforeContext: paragraphs[i - 1]?.text || "", afterContext: paragraphs[i + 1]?.text || "" }] : []);
  const actualPage = Math.min(page, Math.max(1, Math.ceil(matched.length / PAGE_SIZE)));
  return {
    paragraphs: matched.slice((actualPage - 1) * PAGE_SIZE, actualPage * PAGE_SIZE),
    sections: extracted.sections,
    coverage: { totalParagraphs: paragraphs.length, matchedParagraphs: matched.length, page: actualPage, pageSize: PAGE_SIZE, extraction: extracted.extraction, splitParagraphs: paragraphs.some((p) => p.parts > 1) },
  };
}

export function compareReaderDocuments(currentText, priorText, current, prior) {
  const pair = validateReaderPair(current, prior);
  if (!pair.allowed) return { status: "unavailable", ...pair, changes: [], coverage: [] };
  const result = compareDisclosureText(priorText, currentText, prior.form, current.form);
  const changes = result.changes.filter((change) => pair.kind !== "amendment" || change.type !== "removed")
    .map((change, index) => ({ ...change, index, type: pair.kind === "amendment" && change.type === "added" ? "unmatched" : change.type }));
  return { ...result, ...pair, status: result.coverage.some((section) => section.currentFound && section.priorFound) ? "reviewed" : "section-unavailable", changes,
    totalChanges: pair.kind === "amendment" ? changes.length : result.totalChanges,
    limitation: "Risk Factors and MD&A only; up to 220 narrative paragraphs per section and 40 changes. Exact repeated paragraphs are suppressed. Formatting, tables, footnotes and exhibits require the SEC original. An unmatched or removed paragraph is not proof of a new or resolved risk." };
}

export async function readFilingsDocument(settings, { signal } = {}) {
  const company = await loadFilingsCompany(settings.ticker, { signal });
  if (company.kind === "fund") throw error("This ticker identifies a fund. Open its Funds page.", 422);
  const archiveRows = new Map();
  for (const name of [...new Set([settings.archive, settings.view === "changes" ? settings.priorArchive : ""].filter(Boolean))]) {
    if (!company.archives.some((archive) => archive.name === name)) throw error("This history archive does not belong to the requested company.");
  }
  const archivedRows = async (name) => {
    if (!archiveRows.has(name)) {
      const result = await loadFilingsArchive(company.ticker, name, { signal });
      archiveRows.set(name, result.filings.map((filing) => ({ ...filing, archive: name })));
    }
    return archiveRows.get(name);
  };
  const resolve = async (accession, archive, filed) => {
    const recent = company.filings.find((row) => row.accession === accession);
    if (recent) return recent;
    if (archive) {
      const found = (await archivedRows(archive)).find((row) => row.accession === accession);
      if (found) return found;
    }
    // Saved recent-feed records have no archive name. A date is only a lookup
    // hint: both the archive manifest and the accession inside it still have to
    // belong to this exact issuer before a document URL can be constructed.
    const candidates = validFilingDate(filed) ? company.archives.filter((item) =>
      item.name !== archive && item.filingFrom <= filed && item.filingTo >= filed) : [];
    let failed = 0;
    for (const candidate of candidates.slice(0, 8)) {
      try {
        const found = (await archivedRows(candidate.name)).find((row) => row.accession === accession);
        if (found) return found;
      } catch (failure) {
        if (signal?.aborted) throw failure;
        failed++;
      }
    }
    if (candidates.length > 8) throw error(`Archive recovery checked 8 of ${candidates.length} date-matched SEC archives${failed ? `; ${failed} could not be read` : ""}. Load the correct history archive to open this filing.`, 422);
    if (failed) throw error(`${failed} of ${candidates.length} potential SEC history archives could not be read. Retry or load the correct archive; this filing has not been located.`, 502);
    throw error("This accession was not found in the requested company's recent feed or date-matched SEC archives. Load its history archive before opening it.", 404);
  };
  const filing = await resolve(settings.accession, settings.archive, settings.filed);
  // Current-document reading stays usable even if a separate baseline archive
  // cannot be fetched. Prior provenance is verified when comparison is requested.
  const prior = settings.prior && settings.view === "changes" ? await resolve(settings.prior, settings.priorArchive, settings.priorFiled) :
    company.filings.find((row) => row.accession === settings.prior) || null;
  const document = await fetchReaderDocument(company.cik, filing, { signal });
  const result = paginateReaderText(document.text, filing.form, settings);
  let comparison = { status: "not-requested", ...validateReaderPair(filing, prior), changes: [], coverage: [] };
  if (settings.view === "changes") {
    if (!comparison.allowed) comparison.status = "unavailable";
    else {
      try {
        const previous = await fetchReaderDocument(company.cik, prior, { signal });
        comparison = compareReaderDocuments(document.text, previous.text, filing, prior);
      } catch (failure) {
        if (signal?.aborted) throw failure;
        comparison = { ...comparison, status: "fetch-failed", reason: `Prior document was not reviewed: ${failure.message}` };
      }
    }
    const sectionName = settings.section === "risk" ? "Risk factors" : settings.section === "mda" ? "Management discussion and analysis" : "";
    const matched = comparison.changes.filter((change) =>
      (settings.section === "all" || change.section === sectionName) &&
      (!settings.query || `${change.before} ${change.after}`.toLowerCase().includes(settings.query.toLowerCase())));
    const page = Math.min(settings.page, Math.max(1, Math.ceil(matched.length / PAGE_SIZE)));
    comparison = { ...comparison, matchedChanges: matched.length, page, pageSize: PAGE_SIZE, changes: matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
  }
  return { ticker: company.ticker, cik: company.cik, name: company.name, filing, prior, ...result, format: document.format, comparison, observedAt: new Date().toISOString() };
}
