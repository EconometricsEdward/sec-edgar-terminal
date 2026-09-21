import { createHash } from 'node:crypto';
import { secFetch } from './secClient.js';
import { warmGet, warmSet } from './warmCache.js';
import { stripHtml } from './filingTextParser.js';
import { validFilingDate } from './filingsResearch.js';

const DOCUMENT_CACHE = 'edgar.broker-dealer-document.v1:production';
const MANIFEST_CACHE = 'edgar.broker-dealer-manifest.v1:production';
const local = new Map();
const pending = new Map();
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
export function validBrokerDealerDocumentName(value) {
  return typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(pdf|htm|html|txt|xml)$/i.test(value) && !value.includes('..');
}
function baseUrl(cik, accession) {
  if (!/^[0-9]{1,10}$/.test(String(cik)) || Number(cik) <= 0 || !/^\d{10}-\d{2}-\d{6}$/.test(accession || '')) throw fail('Invalid SEC filing identity.', 400);
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/`;
}
const clean = value => stripHtml(value || '').replace(/\s+/g, ' ').trim();

/** Accept only attachment links physically inside this accession directory. */
export function parseBrokerDealerDocumentIndex(html, cik, filing) {
  const base = baseUrl(cik, filing.accession);
  const documents = new Map();
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x => x[1]);
    if (cells.length < 4) continue;
    const href = cells[2].match(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || /[\\\u0000-\u001f]/.test(href)) continue;
    let url;
    try { url = new URL(href.replaceAll('&amp;', '&'), base); } catch { continue; }
    if (!url.href.startsWith(base) || url.search || url.hash || url.username || url.password) continue;
    const name = url.href.slice(base.length);
    if (!validBrokerDealerDocumentName(name)) continue;
    const format = name.split('.').pop().toLowerCase();
    documents.set(name, { name, url: url.href, format, type: clean(cells[3]).slice(0, 80), description: clean(cells[1]).slice(0, 300) });
  }
  if (!documents.size) throw fail('SEC did not return a usable attachment index. Retry or open the SEC filing index.');
  return [...documents.values()];
}
export function selectBrokerDealerDocument(documents, requested = '') {
  if (requested) {
    if (!validBrokerDealerDocumentName(requested)) throw fail('Invalid SEC document name.', 400);
    const found = documents.find(doc => doc.name === requested);
    if (!found) throw fail('This document is not listed in the selected SEC filing.', 400);
    return found;
  }
  const score = doc => (doc.format === 'pdf' ? 100 : /^(htm|html|txt)$/.test(doc.format) ? 40 : 0)
    + (/^(PUBLIC|FULL)$/i.test(doc.type) ? 30 : 0) + (/financial|annual|public|statement/i.test(`${doc.name} ${doc.description}`) ? 15 : 0)
    - (/consent|exemption|compliance|cover|facing/i.test(`${doc.name} ${doc.description}`) ? 80 : 0);
  return [...documents].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0];
}
export function parseBrokerDealerCover(xml) {
  const field = name => clean(xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '');
  const date = value => {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
    const iso = match ? `${match[3]}-${match[1]}-${match[2]}` : value;
    return validFilingDate(iso) ? iso : '';
  };
  return { reportDate: date(field('periodEnd')), periodBegin: date(field('periodBegin')), accountantName: field('accountantName'), registrantType: field('typeOfBDRegistrant'), amendmentDescription: field('amendmentDescription') };
}
export async function readBrokerDealerBytes(response, maxBytes = 24_000_000) {
  if (!response.ok) throw fail(`SEC document request returned HTTP ${response.status}. Retry or open the SEC original.`);
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw fail('Document exceeds the 24 MB extraction limit. Open the SEC original.', 422);
  if (!response.body) throw fail('SEC returned an empty document.');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw fail('Document exceeds the extraction size limit. Open the SEC original.', 422); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function remember(key, value) {
  let size = JSON.stringify(value).length;
  if (size > 8_000_000) return value;
  for (const item of local.values()) size += item.size;
  while (local.size && (local.size >= 8 || size > 16_000_000)) {
    const first = local.keys().next().value; size -= local.get(first).size; local.delete(first);
  }
  local.set(key, { value, size: JSON.stringify(value).length, expires: Date.now() + 3600000 }); return value;
}
function getLocal(key) { const item = local.get(key); return item?.expires > Date.now() ? item.value : null; }

export function createBrokerDealerDocumentLoader({ fetchSec = secFetch, cacheGet = warmGet, cacheSet = warmSet,
  extractPdf = async (...args) => (await import('./brokerDealerPdf.js')).extractBrokerDealerPdf(...args) } = {}) {
  const fetchBytes = async (url, signal, maxBytes) => readBrokerDealerBytes(await fetchSec(url, {
    signal, timeoutMs: 20000, maxBytes, redirect: 'error', headers: { Accept: 'application/pdf,text/html,application/xml,text/plain' },
  }), maxBytes);
  return async function load(cik, filing, { signal, document = '', refresh = false } = {}) {
    const base = baseUrl(cik, filing.accession), identity = `${String(cik).padStart(10, '0')}:${filing.accession}`;
    const manifestKey = `manifest:${identity}`;
    let manifest = refresh ? null : getLocal(manifestKey) || await cacheGet(MANIFEST_CACHE, identity);
    if (!manifest || manifest.cik !== String(cik).padStart(10, '0') || !Array.isArray(manifest.documents) || !manifest.documents.length || manifest.documents.some(doc => !doc || !validBrokerDealerDocumentName(doc.name) || doc.url !== base + doc.name || doc.format !== doc.name.split('.').pop().toLowerCase())) {
      const html = new TextDecoder().decode(await fetchBytes(`${base}${filing.accession}-index.html`, signal, 2_000_000));
      const documents = parseBrokerDealerDocumentIndex(html, cik, filing);
      let cover = {}, coverWarning = '';
      const coverDoc = documents.find(doc => doc.name === filing.primaryDoc && doc.format === 'xml');
      if (coverDoc) {
        try { cover = parseBrokerDealerCover(new TextDecoder().decode(await fetchBytes(coverDoc.url, signal, 1_000_000))); }
        catch (error) { if (signal?.aborted) throw error; coverWarning = 'The facing-page metadata could not be read; the reporting period uses the SEC submissions record where available.'; }
      }
      manifest = { cik: String(cik).padStart(10, '0'), documents, cover, coverWarning, observedAt: new Date().toISOString() };
      // A transient facing-page failure must not prevent a future retry.
      if (!coverWarning) { remember(manifestKey, manifest); await cacheSet(MANIFEST_CACHE, identity, manifest, 86400 * 7); }
    }
    const selectedDocument = selectBrokerDealerDocument(manifest.documents, document);
    const hash = createHash('sha256').update(selectedDocument.name).digest('hex');
    const cacheKey = `${identity}:${hash}`;
    let extracted = refresh ? null : getLocal(cacheKey) || await cacheGet(DOCUMENT_CACHE, cacheKey);
    if (!extracted || extracted.cik !== String(cik).padStart(10, '0') || !Array.isArray(extracted.pages) || !extracted.extraction || extracted.pages.length > 80) {
      if (pending.has(cacheKey)) extracted = await pending.get(cacheKey);
      else {
        const task = (async () => {
          const bytes = await fetchBytes(selectedDocument.url, signal, 24_000_000);
          let value;
          if (selectedDocument.format === 'pdf') {
            if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw fail('SEC did not return a valid PDF. Retry or open the original.');
            value = await extractPdf(bytes, { signal });
          } else {
            const raw = new TextDecoder().decode(bytes);
            if (/<title>[^<]*(?:access denied|request rate threshold|undeclared automated tool)/i.test(raw)) throw fail('SEC returned a blocked document response. Retry later.');
            const text = stripHtml(raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
            value = { pages: [{ pageNumber: 1, text, lines: text.split('\n').map(text => ({ text })) }], extraction: {
              status: text.length > 30 ? 'text' : 'unavailable', pageCount: 1, pagesRead: 1, pagesWithText: text.length > 30 ? 1 : 0,
              limitations: selectedDocument.format === 'xml' ? ['The facing-page XML identifies the filing; financial figures normally appear in a separate attachment.'] : ['HTML/text extraction does not preserve original PDF page numbers.'],
            } };
          }
          const prepared = { ...value, cik: String(cik).padStart(10, '0'), extractedAt: new Date().toISOString() };
          if (!prepared.extraction?.retryable) remember(cacheKey, prepared);
          // Accession-bound extracts are reusable across history, peers and
          // exports. Fresh mapping runs against the retained source pages.
          if (JSON.stringify(prepared).length <= 8_000_000 && !prepared.extraction?.retryable) await cacheSet(DOCUMENT_CACHE, cacheKey, prepared, 86400 * 30);
          return prepared;
        })();
        pending.set(cacheKey, task);
        try { extracted = await task; } finally { pending.delete(cacheKey); }
      }
    }
    return { ...extracted, documents: manifest.documents, selectedDocument, cover: manifest.cover || {},
      extraction: { ...extracted.extraction, limitations: [...(extracted.extraction.limitations || []), ...(manifest.coverWarning ? [manifest.coverWarning] : [])] },
      text: extracted.pages.map(page => `Page ${page.pageNumber}\n\n${page.text}`).join('\n\n'), format: selectedDocument.format === 'pdf' ? 'pdf-text' : selectedDocument.format === 'xml' ? 'xml-fields' : 'text' };
  };
}
export const loadBrokerDealerDocument = createBrokerDealerDocumentLoader();
