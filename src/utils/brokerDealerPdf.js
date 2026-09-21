/** Bounded server-only PDF text extraction, with local English OCR for scanned
 * or broken-font pages. OCR assets are pinned npm files; no runtime downloads. */
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';

// These files are explicitly included in Next's output file tracing. Keep their
// paths as filesystem paths: Turbopack rewrites require.resolve(...) to numeric
// module identifiers, which are invalid for dirname() and Node Worker().
function dependencyPath(...parts) { return join(process.cwd(), 'node_modules', ...parts); }
function logExtractionFailure(stage, error) {
  // Server diagnostics only. Never include document content or request URLs.
  console.error('[broker-dealer-pdf]', {
    stage, name: error?.name || 'Error', code: error?.code || null,
    ...(stage === 'initialize' ? { message: String(error?.message || '').replace(/[\r\n]/g, ' ').slice(0, 300) } : {}),
  });
}
export const BROKER_DEALER_PDF_LIMITS = Object.freeze({
  bytes: 24 * 1024 * 1024, pages: 80, ocrPages: 20, milliseconds: 150_000,
  pixels: 5_000_000, pageCharacters: 30_000, totalCharacters: 600_000,
  pageItems: 12_000, ocrPageConfidence: 75, ocrNumberConfidence: 80,
});
let activeExtractions = 0;

export class BrokerDealerPdfError extends Error {
  constructor(message, code = 'BROKER_PDF_UNAVAILABLE', status = 503) {
    super(message); this.name = 'BrokerDealerPdfError'; this.code = code;
    this.safeMessage = message; this.status = status;
  }
}
function interrupted(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('PDF extraction was stopped.', 'AbortError');
}
function checkSignal(signal) { if (signal.aborted) throw interrupted(signal); }
function bounded(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(interrupted(signal)); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(interrupted(signal));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function round(n) { return Math.round(n * 100) / 100; }
function usableText(text) {
  if (typeof text !== 'string' || text.trim().length < 35) return false;
  // Broken embedded character maps can produce thousands of characters which
  // are not readable words. Character count alone must never skip OCR.
  const bad = (text.match(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f\ufffd\u00ff]/g) || []).length;
  if (bad / text.length > 0.008) return false;
  const words = text.match(/\b[A-Za-z]{2,}\b/g) || [];
  const ordinary = words.filter(w => /^(the|and|of|to|in|for|as|at|is|on|by|with|assets|liabilities|financial|securities|statement|capital|company|cash|income|report|notes|equity|condition|total|independent|accountant|annual)$/i.test(w));
  return words.length >= 5 && ordinary.length >= 2;
}
function nativeLines(content) {
  const items = content.items.filter(item => typeof item.str === 'string' && item.str.trim()
    && Array.isArray(item.transform) && Number.isFinite(item.transform[4]) && Number.isFinite(item.transform[5]))
    .slice(0, BROKER_DEALER_PDF_LIMITS.pageItems)
    .map(item => ({ text: item.str, x: round(item.transform[4]), y: round(item.transform[5]), width: round(item.width || 0) }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const item of items) {
    const last = rows.at(-1);
    if (last && Math.abs(last.y - item.y) <= 2.5) last.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  return rows.map(row => {
    row.items.sort((a, b) => a.x - b.x);
    return { text: row.items.map(item => item.text).join(' ').trim(), items: row.items, usableForNumbers: true };
  });
}
function ocrLines(data, viewport) {
  const lines = [];
  for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) {
    const items = (line.words || []).filter(word => typeof word.text === 'string' && word.text.trim() && word.bbox)
      .map(word => {
        const [x, y] = viewport.convertToPdfPoint(word.bbox.x0, word.bbox.y1);
        return { text: word.text, x: round(x), y: round(y), confidence: Number.isFinite(word.confidence) ? word.confidence : 0 };
      });
    const numeric = items.filter(item => /\d/.test(item.text));
    const numericConfidence = numeric.length ? Math.min(...numeric.map(item => item.confidence)) : null;
    const confidence = Number.isFinite(line.confidence) ? line.confidence : 0;
    lines.push({ text: items.map(item => item.text).join(' '), items, confidence, numericConfidence,
      usableForNumbers: confidence >= BROKER_DEALER_PDF_LIMITS.ocrPageConfidence
        && (numericConfidence === null || numericConfidence >= BROKER_DEALER_PDF_LIMITS.ocrNumberConfidence) });
  }
  return lines;
}

/** The pinned Tesseract 7 Node worker protocol lets us own the thread from its
 * creation. The public createWorker promise does not expose its thread until
 * language initialization completes, so it cannot enforce startup cancellation. */
async function createLocalOcr(signal) {
  const langPath = dependencyPath('@tesseract.js-data', 'eng', '4.0.0');
  await access(join(langPath, 'eng.traineddata.gz'));
  checkSignal(signal);
  const worker = new Worker(dependencyPath('tesseract.js', 'src', 'worker-script', 'node', 'index.js'), {
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 },
    // --input-type and test-runner flags belong to the caller, not a file worker.
    execArgv: [],
  });
  let sequence = 0, stopped = false;
  const pending = new Map();
  function rejectJobs(error) { for (const job of pending.values()) job.reject(error); pending.clear(); }
  async function terminate() {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener('abort', onAbort);
    rejectJobs(new BrokerDealerPdfError('The OCR worker was stopped.', 'BROKER_PDF_OCR_STOPPED'));
    await worker.terminate();
  }
  function onAbort() { void terminate(); }
  signal.addEventListener('abort', onAbort, { once: true });
  worker.on('message', event => {
    if (!['resolve', 'reject'].includes(event.status)) return;
    const job = pending.get(event.jobId); if (!job) return;
    pending.delete(event.jobId);
    if (event.status === 'resolve') job.resolve(event.data);
    else job.reject(new BrokerDealerPdfError('This page could not be recognized reliably.', 'BROKER_PDF_OCR_FAILED'));
  });
  worker.on('error', () => rejectJobs(new BrokerDealerPdfError('The OCR worker could not complete.', 'BROKER_PDF_OCR_FAILED')));
  worker.on('exit', () => rejectJobs(new BrokerDealerPdfError('The OCR worker stopped before completion.', 'BROKER_PDF_OCR_STOPPED')));
  function job(action, payload) {
    checkSignal(signal);
    if (stopped) throw new BrokerDealerPdfError('The OCR worker is unavailable.', 'BROKER_PDF_OCR_STOPPED');
    return bounded(new Promise((resolve, reject) => {
      const jobId = String(++sequence); pending.set(jobId, { resolve, reject });
      worker.postMessage({ workerId: 'broker-report', jobId, action, payload });
    }), signal);
  }
  try {
    await job('load', { options: { lstmOnly: true, logging: false } });
    await job('loadLanguage', { langs: 'eng', options: { langPath, gzip: true, cacheMethod: 'none', lstmOnly: true } });
    await job('initialize', { langs: 'eng', oem: 1, config: {} });
    await job('setParameters', { params: { preserve_interword_spaces: '1' } });
    return { terminate, recognize: image => job('recognize', { image, options: {}, output: { text: true, blocks: true } }) };
  } catch (error) { await terminate(); throw error; }
}

export async function extractBrokerDealerPdf(input, { signal } = {}) {
  if (!(input instanceof Uint8Array) || input.byteLength > BROKER_DEALER_PDF_LIMITS.bytes) {
    throw new BrokerDealerPdfError('This PDF exceeds the supported 24 MB limit.', 'BROKER_PDF_SIZE_LIMIT', 413);
  }
  if (!new TextDecoder('latin1').decode(input.subarray(0, 1024)).includes('%PDF-')) {
    throw new BrokerDealerPdfError('The selected document is not a supported PDF.', 'BROKER_PDF_INVALID', 415);
  }
  if (signal?.aborted) throw interrupted(signal);
  // Bound simultaneous native canvases and WASM heaps in a reused Fluid instance.
  if (activeExtractions >= 2) throw new BrokerDealerPdfError('Report reading is busy. Please try again shortly.', 'BROKER_PDF_BUSY', 503);
  activeExtractions++;
  const deadline = new AbortController();
  const stop = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new BrokerDealerPdfError('The report reached its extraction time limit.', 'BROKER_PDF_TIMEOUT')), BROKER_DEALER_PDF_LIMITS.milliseconds);
  let loading, document, ocr, activeRender, canvas, pageCount = 0, ocrAttempts = 0, textCharacters = 0, retryable = false;
  let stage = 'initialize';
  const pages = [], limitations = new Set();
  const abortWork = () => { activeRender?.cancel(); void ocr?.terminate(); void loading?.destroy().catch(() => {}); };
  stop.addEventListener('abort', abortWork, { once: true });
  try {
    const pdfjs = await bounded(import('pdfjs-dist/legacy/build/pdf.mjs'), stop);
    const pdfRoot = dependencyPath('pdfjs-dist');
    loading = pdfjs.getDocument({ data: new Uint8Array(input), isEvalSupported: false, disableFontFace: true,
      useSystemFonts: false, useWorkerFetch: false, disableAutoFetch: true, disableStream: true,
      disableRange: true, verbosity: 0, maxImageSize: 16_000_000, canvasMaxAreaInBytes: 32_000_000,
      cMapUrl: join(pdfRoot, 'cmaps') + '/', cMapPacked: true,
      standardFontDataUrl: join(pdfRoot, 'standard_fonts') + '/', wasmUrl: join(pdfRoot, 'wasm') + '/' });
    stage = 'load-document';
    document = await bounded(loading.promise, stop);
    pageCount = document.numPages;
    if (pageCount > BROKER_DEALER_PDF_LIMITS.pages) limitations.add('Only the first 80 PDF pages were read.');
    for (let pageNumber = 1; pageNumber <= Math.min(pageCount, BROKER_DEALER_PDF_LIMITS.pages); pageNumber++) {
      checkSignal(stop);
      let page;
      const result = { pageNumber, text: '', lines: [], method: 'unavailable', ocrConfidence: null };
      try {
        page = await bounded(document.getPage(pageNumber), stop);
        const content = await bounded(page.getTextContent(), stop);
        const lines = nativeLines(content);
        const text = lines.map(line => line.text).join('\n');
        if (usableText(text)) {
          result.lines = lines; result.text = text; result.method = 'native';
          if (content.items.length > BROKER_DEALER_PDF_LIMITS.pageItems) limitations.add(`Page ${pageNumber} exceeded the text-item limit.`);
        } else if (ocrAttempts < BROKER_DEALER_PDF_LIMITS.ocrPages) {
          ocrAttempts++;
          if (!ocr) ocr = await bounded(createLocalOcr(stop), stop);
          if (!canvas) canvas = await bounded(import('@napi-rs/canvas'), stop);
          const original = page.getViewport({ scale: 1 });
          if (!(original.width > 0 && original.height > 0 && Number.isFinite(original.width * original.height))) throw new Error('Invalid page dimensions');
          const scale = Math.min(3, 2800 / Math.max(original.width, original.height), Math.sqrt(BROKER_DEALER_PDF_LIMITS.pixels / (original.width * original.height)));
          const viewport = page.getViewport({ scale });
          const surface = canvas.createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
          try {
            const context = surface.getContext('2d');
            activeRender = page.render({ canvasContext: context, viewport, background: '#ffffff' });
            await bounded(activeRender.promise, stop); activeRender = null;
            const image = await bounded(surface.encode('png'), stop);
            const data = await bounded(ocr.recognize(image), stop);
            const recognizedLines = ocrLines(data, viewport);
            const recognized = recognizedLines.map(line => line.text).join('\n');
            result.ocrConfidence = Number.isFinite(data.confidence) ? data.confidence : 0;
            if (result.ocrConfidence >= BROKER_DEALER_PDF_LIMITS.ocrPageConfidence && usableText(recognized)) {
              result.lines = recognizedLines; result.text = recognized; result.method = 'ocr';
              if (recognizedLines.some(line => !line.usableForNumbers && /\d/.test(line.text))) limitations.add(`Page ${pageNumber} contains OCR values that require checking against the original PDF.`);
            } else limitations.add(`Page ${pageNumber} did not yield sufficiently reliable text; check the original PDF.`);
          } finally { activeRender = null; surface.width = 1; surface.height = 1; }
        } else limitations.add('The 20-page OCR limit was reached; some scanned or unreadable pages remain unextracted.');
        const allowed = Math.min(BROKER_DEALER_PDF_LIMITS.pageCharacters, BROKER_DEALER_PDF_LIMITS.totalCharacters - textCharacters);
        if (result.text.length > allowed) {
          let count = 0;
          result.lines = result.lines.filter(line => { count += line.text.length + 1; return count <= allowed; });
          result.text = result.lines.map(line => line.text).join('\n');
          limitations.add('A text-length limit was reached; some source text was omitted.');
        }
        textCharacters += result.text.length;
      } catch (error) {
        if (stop.aborted) throw error;
        logExtractionFailure('extract-page', error);
        retryable = true;
        limitations.add(`Page ${pageNumber} could not be extracted; check the original PDF.`);
      } finally { page?.cleanup(); }
      pages.push(result);
      if (textCharacters >= BROKER_DEALER_PDF_LIMITS.totalCharacters - 100) break;
    }
  } catch (error) {
    if (signal?.aborted) throw interrupted(signal);
    if (deadline.signal.aborted && pages.length) {
      retryable = true;
      limitations.add('The extraction time limit was reached; remaining pages were not read.');
    }
    else if (error?.name === 'PasswordException') throw new BrokerDealerPdfError('This PDF requires a password and cannot be analyzed.', 'BROKER_PDF_PASSWORD', 422);
    else if (error instanceof BrokerDealerPdfError) throw error;
    else {
      logExtractionFailure(stage, error);
      throw new BrokerDealerPdfError('This PDF could not be read safely. Open the original SEC document.', 'BROKER_PDF_INVALID', 422);
    }
  } finally {
    clearTimeout(timer); stop.removeEventListener('abort', abortWork);
    activeRender?.cancel(); await ocr?.terminate().catch(() => {});
    await loading?.destroy().catch(() => {});
    activeExtractions--;
  }
  const pagesWithText = pages.filter(page => page.text.trim()).length;
  const ocrPages = pages.filter(page => page.method === 'ocr').length;
  const unresolved = pagesWithText < pages.length || pages.length < pageCount;
  const status = !pagesWithText ? 'no-text' : unresolved || limitations.size ? 'partial' : 'complete';
  return { pages, extraction: { status, pageCount, pagesRead: pages.length, pagesWithText, ocrPages, retryable,
    ocrPagesAttempted: ocrAttempts,
    message: status === 'complete' ? 'Text was read from every PDF page. Statement coverage still depends on what the public report contains.'
      : status === 'no-text' ? 'Reliable financial text could not be read. Review the original SEC PDF.'
        : 'Some PDF content remains unextracted or needs verification. Missing text or figures are not zero.',
    limitations: [...limitations],
    ...(ocrPages ? { ocrNote: 'OCR transcribes scanned or unreadable pages. Check digits, units and labels against the linked PDF before relying on them.' } : {}) } };
}
