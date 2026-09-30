import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTimelineDisclosures, compareTimelineDisclosures, RISK_TIMELINE_LIMITS } from '../src/utils/riskTimelineDisclosures.js';

const filing = year => ({ accession: `0000000001-${String(year).slice(-2)}-000001`, form: '10-K',
  reportDate: `${year}-12-31`, filed: `${year + 1}-02-01`,
  url: `https://www.sec.gov/Archives/edgar/data/1/0000000001${String(year).slice(-2)}000001/report.htm` });
const report = (text, section = 'mda') => section === 'mda'
  ? `Item 7. Management's Discussion and Analysis\n\n${text}\n\nItem 8. Financial Statements`
  : `Item 1A. Risk Factors\n\n${text}\n\nItem 2. Properties`;
const analyze = (text, section) => extractTimelineDisclosures(report(text, section), '10-K');
const funding = 'Our credit facility provides committed liquidity for ordinary operations and seasonal working capital. Borrowings remain available subject to the agreed terms throughout the facility term.';
const collateral = 'Our credit facility provides committed liquidity for ordinary operations and seasonal working capital. Borrowings now require additional collateral subject to the agreed terms throughout the facility term.';
const compare = (before, after) => compareTimelineDisclosures(after, before, filing(2025), filing(2024));

test('a new collateral clause pairs with the same prior funding paragraph without inventing a prior mention', () => {
  const before = analyze(funding), after = analyze(collateral);
  assert.equal(before.topics.collateral.matchingParagraphs, 0);
  assert.equal(before.topics.collateral.matches.length, 0);
  assert.equal(before.topics.collateral.paragraphs.length, 1);
  const result = compare(before, after);
  const event = result.events.find(item => item.category === 'collateral');
  assert.ok(event);
  assert.equal(event.before.evidence[0].text, funding);
  assert.equal(event.after.evidence[0].text, collateral);
  assert.equal(event.before.evidence[0].url, filing(2024).url);
  assert.equal(event.after.evidence[0].url, filing(2025).url);
  assert.equal(result.coverage.collateral.matches, 1);
  assert.equal(result.coverage.collateral.status, 'differed');
  assert.equal(event.direction, 'review');
  assert.doesNotMatch(event.title, /new|introduced|increased|required|resolved/i);
  assert.equal('value' in event, false);
});

test('a prior covenant paragraph remains a candidate when its collateral clause is first disclosed', () => {
  const old = 'The borrower must maintain financial covenants requiring a leverage ratio below 3.0 to 1.0. These conditions apply to borrowings used for operating requirements throughout the agreement term.';
  const next = 'The borrower must maintain financial covenants requiring a leverage ratio below 3.0 to 1.0. These conditions apply to borrowings used for operating requirements and now require pledged collateral throughout the agreement term.';
  const result = compare(analyze(old), analyze(next));
  assert.equal(result.events.some(event => event.category === 'covenants'), false);
  const event = result.events.find(item => item.category === 'collateral');
  assert.ok(event);
  assert.equal(event.before.evidence[0].text, old);
  assert.equal(event.after.evidence[0].text, next);
});

test('funding candidates alone do not count as collateral coverage or manufacture change events', () => {
  const before = analyze(funding), after = analyze(funding.replace('seasonal', 'ongoing'));
  const result = compare(before, after);
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.collateral.matches, 0);
  assert.equal(result.coverage.collateral.status, 'missing');
  assert.equal(before.topics.collateral.matches.length, 0);
  assert.equal(after.topics.collateral.matches.length, 0);
});

test('unmatched new language and unclassified or different-section funding text remain unpaired', () => {
  const unrelated = 'The company expects to expand manufacturing operations in several locations as customer demand grows. Management reviews those operational plans with its board of directors.';
  assert.equal(compare(analyze(unrelated), analyze(collateral)).events.length, 0);
  const unclassified = extractTimelineDisclosures(funding, '10-K');
  assert.equal(unclassified.topics.collateral.paragraphs.length, 0);
  assert.equal(compare(unclassified, analyze(collateral)).events.length, 0);
  const differentSection = compare(analyze(funding, 'risk'), analyze(collateral, 'mda'));
  assert.equal(differentSection.events.length, 0);
  assert.equal(differentSection.coverage.collateral.status, 'uncompared');
});

test('candidate retention stays within the paragraph limit and shared unique-text budget', () => {
  const longer = Array.from({ length: 80 }, (_, index) => `Our credit facility ${index + 1} provides borrowing capacity under the consolidated agreement. ${'The borrower uses its committed facility to support ordinary operations and seasonal working capital needs. '.repeat(70)}`);
  const mentions = Array.from({ length: 25 }, (_, index) => `Our credit facility ${index + 1} includes financial covenants and pledged collateral requirements. ${'The borrower reviews the agreement with the lending counterparty and reports the applicable conditions. '.repeat(70)}`);
  const extracted = analyze([...mentions, ...longer].join('\n\n'));
  const unique = new Set(Object.values(extracted.topics).flatMap(topic => topic.paragraphs.map(p => p.text)));
  assert.ok([...unique].reduce((size, text) => size + text.length, 0) <= RISK_TIMELINE_LIMITS.analysisCharactersPerFiling);
  for (const topic of Object.values(extracted.topics)) {
    assert.ok(topic.paragraphs.length <= RISK_TIMELINE_LIMITS.passagesPerTopic);
    assert.ok(topic.matches.length <= RISK_TIMELINE_LIMITS.passagesPerTopic);
  }
  assert.equal(extracted.topics.collateral.matchingParagraphs, 25);
  assert.equal(extracted.topics.collateral.matches.length, 25);
});
