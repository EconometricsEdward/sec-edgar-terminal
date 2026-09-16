import test from 'node:test';
import assert from 'node:assert/strict';
import { cache13FReview, clearCached13FReview, deleteCached13FReview, readCached13FReview, valid13FReviewSnapshot } from '../src/utils/thirteenFReviewClient.js';

const cik = '0002012383';
function publication(period = '2026-06-30', manager = cik) {
  const holding = { key: '037833100|SECURITY|SH', cusip: '037833100', issuer: 'APPLE INC', quantityType: 'SH', putCall: null, valueUsd: 100 };
  return { job: { cik: manager, period, reportHash: 'a'.repeat(64), total: 5696, reviewed: 8 },
    report: { cik: manager, period, totalValueUsd: 5000, complete: true },
    rows: [{ key: holding.key, holding, status: 'linked' }], markets: [], coverage: { total: 5696, linked: 1 },
    page: { offset: 0, limit: 50, total: 5696 }, publicationVersion: 'publication:8', publishedAt: '2026-09-16T12:00:00Z' };
}
test.beforeEach(() => clearCached13FReview());

test('a latest-quarter publication can immediately satisfy a return visit and an explicit-quarter visit', () => {
  const value = publication();
  assert.equal(cache13FReview(value, { cik, now: 1000 }), true);
  assert.equal(readCached13FReview(cik, '', 2000), value);
  assert.equal(readCached13FReview(cik, value.job.period, 2000), value);
  assert.equal(value.report.totalValueUsd, 5000);
  assert.equal(value.job.total, 5696);
  assert.equal(value.rows.length, 1);
});

test('viewing an older explicit quarter cannot replace the latest-quarter shortcut', () => {
  const latest = publication(), older = publication('2026-03-31');
  cache13FReview(latest, { cik, now: 1000 });
  cache13FReview(older, { cik, period: older.job.period, now: 2000 });
  assert.equal(readCached13FReview(cik, '', 3000), latest);
  assert.equal(readCached13FReview(cik, older.job.period, 3000), older);
  assert.equal(readCached13FReview('0001067983', '', 3000), null);
});

test('cache rejects mismatched managers, periods, report identities, and row identities', () => {
  assert.equal(cache13FReview(publication(), { cik: '0001067983' }), false);
  assert.equal(cache13FReview(publication(), { cik, period: '2026-03-31' }), false);
  const wrongReport = publication(); wrongReport.report.cik = '0001067983';
  assert.equal(valid13FReviewSnapshot(wrongReport, cik), false);
  const wrongHolding = publication(); wrongHolding.rows[0].key = '67066G104|SECURITY|SH';
  assert.equal(valid13FReviewSnapshot(wrongHolding, cik), false);
  const wrongRevision = publication(); wrongRevision.job.reportHash = 'unknown';
  assert.equal(valid13FReviewSnapshot(wrongRevision, cik), false);
  const duplicate = publication(); duplicate.rows.push(duplicate.rows[0]);
  assert.equal(valid13FReviewSnapshot(duplicate, cik), false);
  assert.equal(readCached13FReview(cik), null);
});

test('expired return-visit entries are discarded without changing source dates', () => {
  const value = publication(), sourceDate = value.publishedAt;
  cache13FReview(value, { cik, now: 1000 });
  assert.equal(readCached13FReview(cik, '', 1000 + 29 * 60000), value);
  assert.equal(readCached13FReview(cik, '', 1000 + 30 * 60000), null);
  assert.equal(value.publishedAt, sourceDate);
});

test('summary caching never admits a full holdings list or an oversized evidence response', () => {
  const manyRows = publication(); manyRows.rows = Array.from({ length: 51 }, () => manyRows.rows[0]);
  assert.equal(cache13FReview(manyRows, { cik }), false);
  const large = publication(); large.evidence = 'x'.repeat(2 * 1024 * 1024);
  assert.equal(cache13FReview(large, { cik }), false);
  assert.equal(readCached13FReview(cik), null);
});

test('cache entry count is bounded and least recently used entries are removed', () => {
  for (let index = 1; index <= 25; index++) {
    const manager = String(index).padStart(10, '0'), value = publication('2026-06-30', manager);
    assert.equal(cache13FReview(value, { cik: manager, period: value.job.period, now: 1000 + index }), true);
  }
  assert.equal(readCached13FReview('0000000001', '2026-06-30', 2000), null);
  assert.ok(readCached13FReview('0000000025', '2026-06-30', 2000));
});

test('combined cache size is bounded before the entry-count limit is reached', () => {
  for (let index = 1; index <= 6; index++) {
    const manager = String(index).padStart(10, '0'), value = publication('2026-06-30', manager);
    value.initialChart = { padding: 'x'.repeat(1536 * 1024) };
    assert.equal(cache13FReview(value, { cik: manager, period: value.job.period, now: 1000 + index }), true);
  }
  assert.equal(readCached13FReview('0000000001', '2026-06-30', 2000), null);
  assert.ok(readCached13FReview('0000000006', '2026-06-30', 2000));
});

test('confirmed missing publications remove only their matching shortcut', () => {
  const value = publication(); cache13FReview(value, { cik, now: 1000 });
  deleteCached13FReview(cik);
  assert.equal(readCached13FReview(cik, '', 2000), null);
  assert.equal(readCached13FReview(cik, value.job.period, 2000), value);
});
