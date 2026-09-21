import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { extractBrokerDealerPdf, BROKER_DEALER_PDF_LIMITS } from '../src/utils/brokerDealerPdf.js';

async function nativePdf(count = 1) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const page = document.addPage([612, 792]);
    page.drawText('TEST SECURITIES LLC', { x: 40, y: 740, size: 14, font });
    page.drawText('Statement of Financial Condition', { x: 40, y: 710, size: 12, font });
    page.drawText('December 31, 2025', { x: 40, y: 680, size: 12, font });
    // Deliberately write values before labels. Reading order must use positions.
    page.drawText('150,000', { x: 450, y: 620, size: 12, font });
    page.drawText('Total assets', { x: 40, y: 620, size: 12, font });
    page.drawText('Total liabilities', { x: 40, y: 590, size: 12, font });
    page.drawText('90,000', { x: 450, y: 590, size: 12, font });
    page.drawText("Members' equity", { x: 40, y: 560, size: 12, font });
    page.drawText('60,000', { x: 450, y: 560, size: 12, font });
  }
  return document.save();
}
async function scannedPdf() {
  const canvas = createCanvas(1530, 1980), context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000'; context.font = 'bold 42px sans-serif';
  context.fillText('TEST SECURITIES LLC', 120, 150);
  context.font = '36px sans-serif';
  const rows = [
    ['Statement of Financial Condition', ''], ['December 31, 2025', ''],
    ['Amounts in US dollars', ''], ['ASSETS', ''], ['Cash', '150,000'], ['Total assets', '150,000'],
    ['LIABILITIES AND EQUITY', ''], ['Total liabilities', '90,000'], ["Members equity", '60,000'],
    ['Total liabilities and equity', '150,000'],
  ];
  rows.forEach(([label, amount], index) => {
    const y = 240 + index * 100;
    context.fillText(label, 120, y); if (amount) context.fillText(amount, 1160, y);
  });
  const document = await PDFDocument.create(), page = document.addPage([612, 792]);
  const image = await document.embedPng(await canvas.encode('png'));
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  return document.save();
}

test('native PDF reading preserves page provenance and financial row order without OCR', async () => {
  const result = await extractBrokerDealerPdf(await nativePdf());
  assert.equal(result.extraction.status, 'complete');
  assert.equal(result.extraction.ocrPages, 0);
  assert.equal(result.pages[0].method, 'native');
  const assets = result.pages[0].lines.find(line => line.text.startsWith('Total assets'));
  assert.equal(assets.text, 'Total assets 150,000');
  assert.ok(assets.items[0].x < assets.items[1].x);
  assert.equal(assets.usableForNumbers, true);
});

test('a real image-only PDF is rendered and recognized with bundled offline English OCR', { timeout: 30_000 }, async () => {
  const result = await extractBrokerDealerPdf(await scannedPdf());
  assert.equal(result.extraction.pageCount, 1);
  assert.equal(result.extraction.ocrPages, 1);
  const page = result.pages[0];
  assert.equal(page.method, 'ocr');
  assert.ok(page.ocrConfidence >= BROKER_DEALER_PDF_LIMITS.ocrPageConfidence);
  const assets = page.lines.find(line => /^Total assets/i.test(line.text));
  assert.ok(assets, page.text);
  assert.match(assets.text, /150,000/);
  assert.equal(assets.usableForNumbers, true);
  assert.ok(assets.numericConfidence >= BROKER_DEALER_PDF_LIMITS.ocrNumberConfidence);
  assert.ok(assets.items.every(item => Number.isFinite(item.x) && Number.isFinite(item.y)));
});

test('page cap is explicit and does not present a truncated document as fully read', async () => {
  const result = await extractBrokerDealerPdf(await nativePdf(81));
  assert.equal(result.extraction.pageCount, 81);
  assert.equal(result.extraction.pagesRead, 80);
  assert.equal(result.extraction.status, 'partial');
  assert.ok(result.extraction.limitations.some(text => text.includes('80')));
});

test('oversize, non-PDF, and already-aborted inputs fail before decoder work', async () => {
  await assert.rejects(extractBrokerDealerPdf(new Uint8Array(BROKER_DEALER_PDF_LIMITS.bytes + 1)), { code: 'BROKER_PDF_SIZE_LIMIT' });
  await assert.rejects(extractBrokerDealerPdf(new TextEncoder().encode('<html>error</html>')), { code: 'BROKER_PDF_INVALID' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractBrokerDealerPdf(await nativePdf(), { signal: controller.signal }), { name: 'AbortError' });
});

test('cancellation during OCR stops the worker and leaves capacity for another extraction', { timeout: 20_000 }, async () => {
  const controller = new AbortController();
  const data = await scannedPdf();
  const timer = setTimeout(() => controller.abort(), 150);
  try { await assert.rejects(extractBrokerDealerPdf(data, { signal: controller.signal }), { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  const result = await extractBrokerDealerPdf(await nativePdf());
  assert.equal(result.extraction.status, 'complete');
});
