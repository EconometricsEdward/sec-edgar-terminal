import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFilingPair, compareDisclosureText, extractResearchSections } from '../src/utils/filingChanges.js';
import { parseWorkspace, writeWorkspace, snapshotChanges, exportResearchBrief } from '../src/utils/researchWorkspace.js';
import { FINANCIAL_DATA_VERSION } from '../src/utils/xbrlPeriods.js';

const report = (accession, date, form = '10-Q') => ({ accession, reportDate: date, filingDate: date, form, primaryDoc: 'report.htm' });
const a = 'Our deposit funding depends on customer confidence and market conditions. We monitor these conditions and maintain resources to support our operations and financial obligations.';
const b = 'Our deposit funding depends on customer confidence and market conditions. Deposit outflows increased significantly and we accessed additional secured funding to support our operations and financial obligations.';
const stable = 'We maintain internal controls and regularly evaluate our business operations, financial performance, and strategic priorities. These established procedures continue to support our organization.';
const doc = (p) => `Item 1A. Risk Factors\n\n${p}\n\n${stable}\n\nItem 2. Management’s Discussion and Analysis\n\n${stable}\n\nItem 3. Other information`;

test('default filing comparison matches the same reporting season rather than the nearest quarter', () => {
  const pair = selectFilingPair([report('now', '2026-06-30'), report('q1', '2026-03-31'), report('year', '2025-06-30')]);
  assert.equal(pair.prior.accession, 'year');
});
test('saved review uses its actual accession and never silently chooses a different baseline', () => {
  const rows = [report('now', '2026-06-30'), report('q1', '2026-03-31')];
  assert.equal(selectFilingPair(rows, { baseline: 'q1' }).prior.accession, 'q1');
  assert.equal(selectFilingPair(rows, { baseline: 'missing' }).prior, null);
  assert.equal(selectFilingPair(rows, { baseline: 'now' }).unchanged, true);
});
test('unmatched annual and quarterly reports are not treated as comparable', () => {
  assert.equal(selectFilingPair([report('now', '2026-06-30'), report('annual', '2025-12-31', '10-K')]).prior, null);
});
test('unchanged boilerplate is suppressed while modified paragraphs retain both texts', () => {
  const result = compareDisclosureText(doc(a), doc(b), '10-Q');
  assert.equal(result.changes.length, 1); assert.equal(result.changes[0].type, 'modified');
  assert.equal(result.changes[0].before, a); assert.equal(result.changes[0].after, b);
});
test('missing sections are explicit coverage gaps, not evidence that risk disappeared', () => {
  const result = compareDisclosureText(doc(a), 'The document could not be divided into sections.', '10-Q');
  assert.equal(result.changes.length, 0); assert.equal(result.coverage[0].currentFound, false);
});
test('table of contents does not replace a substantial filing section', () => {
  const text = `Item 1A. Risk Factors\nItem 2. Management Discussion\nItem 3. Other\n${doc(a)}`;
  assert.ok(extractResearchSections(text, '10-Q')[0].paragraphs.includes(a));
});
test('note updates retain an explicitly saved baseline', () => {
  let stored = null;
  const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  writeWorkspace(storage, (w) => ({ ...w, companies: { JPM: { baseline: { observedAt: 'old' }, notes: 'first' } } }));
  writeWorkspace(storage, (w) => ({ ...w, companies: { ...w.companies, JPM: { ...w.companies.JPM, notes: 'new' } } }));
  assert.equal(parseWorkspace(stored).companies.JPM.baseline.observedAt, 'old');
});
test('corrupt storage and failed writes are surfaced without silently replacing old data', () => {
  assert.throws(() => parseWorkspace('{broken'));
  assert.throws(() => writeWorkspace({ getItem: () => '{broken', setItem: () => assert.fail('must not overwrite') }, (w) => w));
  assert.throws(() => writeWorkspace({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, (w) => w));
});
test('review changes ignore incompatible units, period bases, and older parser versions', () => {
  const metric = { key: 'cash', value: 100, source: { unit: 'USD' }, period: { end: '2026-06-30', kind: 'quarter' } };
  const before = { dataVersion: FINANCIAL_DATA_VERSION, metrics: [metric] };
  assert.equal(snapshotChanges(before, { dataVersion: FINANCIAL_DATA_VERSION, metrics: [{ ...metric, value: 120 }] }).length, 1);
  assert.equal(snapshotChanges(before, { dataVersion: FINANCIAL_DATA_VERSION, metrics: [{ ...metric, value: 120, source: { unit: 'EUR' } }] }).length, 0);
  assert.equal(snapshotChanges(before, { dataVersion: 'old', metrics: [{ ...metric, value: 120 }] }).length, 0);
});
test('research export retains notes, selected excerpts, reporting period, and SEC accessions', () => {
  const text = exportResearchBrief({ ticker: 'JPM', name: 'Example', cik: '19617', notes: 'Review deposit funding.', evidence: [{ label: 'Funding passage', text: b, url: 'https://www.sec.gov/example' }], snapshot: { observedAt: '2026-09-05', period: { fp: 'Q2', fy: 2026 }, metrics: [{ label: 'Deposits', value: 100, format: 'currency', source: { tag: 'Deposits', accession: '0000019617-26-000002', end: '2026-06-30', unit: 'USD', filed: '2026-08-01' } }] } });
  assert.match(text, /Review deposit funding/); assert.match(text, /Funding passage/); assert.match(text, /000001961726000002/); assert.match(text, /Q2 26/);
  assert.match(text, /\| Metric \| Value \| Basis \| Source evidence \|\n\| --- \| ---: \| --- \| --- \|\n\| Deposits \|/);
});

test('calculated ratio evidence retains reported inputs without relabeling their values', async () => {
  const { evidenceSources, evidenceCalculations } = await import('../src/utils/researchEvidence.js');
  const inputs = [{ tag: 'CashFlow', value: 200, start: '2026-01-01', end: '2026-06-30', unit: 'USD' }, { tag: 'CashFlow', value: 90, start: '2026-01-01', end: '2026-03-31', unit: 'USD' }];
  const point = { sources: [{ value: 110, start: '2026-04-01', end: '2026-06-30', formula: 'Current cumulative − prior cumulative', inputSources: inputs }] };
  assert.deepEqual(evidenceSources(point).map((s) => s.value), [200, 90]);
  assert.equal(evidenceCalculations(point)[0].value, 110);
});

test('MD&A contents-only headings are not counted as narrative coverage', () => {
  const text = `Item 2. Management's Discussion and Analysis\n\nExecutive Overview\n\n1\n\n${'Results\n\n2\n\n'.repeat(20)}Item 3. Quantitative and Qualitative Disclosures`;
  assert.equal(extractResearchSections(text, '10-Q').find((s) => s.id === 'mda').found, false);
});

test('bank MD&A narrative introduction is bounded before the financial statements', () => {
  const paragraph = 'The following is Management’s discussion and analysis of the financial condition and results of operations for the second quarter.';
  const body = 'The company explains its funding position and changes in the business during the quarter. '.repeat(10);
  const text = `${paragraph}\n\n${body}\n\nConsolidated statements of income (unaudited)\n\nThis financial statement must not be included in the narrative comparison. ${body}`;
  const mda = extractResearchSections(text, '10-Q').find((s) => s.id === 'mda');
  assert.equal(mda.found, true);
  assert.equal(mda.paragraphs.length, 2);
  assert.ok(!mda.paragraphs.some((p) => p.includes('must not be included')));
});

test('similar financial wording does not pair different business subjects', () => {
  const oldText = "Item 2. Management's Discussion and Analysis\n\nServices gross margin percentage increased during the third quarter and first nine months due primarily to a different mix of services, partially offset by higher costs.";
  const newText = "Item 2. Management's Discussion and Analysis\n\nProducts gross margin and gross margin percentage increased during the third quarter and first nine months primarily due to a different mix of products and tariff refunds, partially offset by higher costs.";
  const result = compareDisclosureText(oldText, newText, '10-Q');
  assert.ok(!result.changes.some((c) => c.type === 'modified'));
  assert.deepEqual(new Set(result.changes.map((c) => c.type)), new Set(['added', 'removed']));
});
