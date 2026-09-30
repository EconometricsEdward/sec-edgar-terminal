import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTimelineDisclosures, compareTimelineDisclosures, timelineExcerpt, RISK_TIMELINE_LIMITS } from '../src/utils/riskTimelineDisclosures.js';

const filing = year => ({ accession: `0000320193-${String(year).slice(-2)}-000001`, form: '10-K', reportDate: `${year}-06-30`, filed: `${year}-08-01`, url: `https://www.sec.gov/Archives/edgar/data/320193/0000320193${String(year).slice(-2)}000001/report.htm` });
const opening = 'Our credit agreement includes financial covenants. We are not required to post collateral unless the contractual conditions described in the original agreement are satisfied. ';
const filler = 'Management monitors the consolidated borrowing agreement and its contractual restrictions throughout the reporting period. '.repeat(9);
const analysis = text => extractTimelineDisclosures(`Item 1A. Risk Factors\n\n${text}\n\nItem 2. Properties\n\nWe own and lease operating facilities.`, '10-K');

test('a revision past the opening preview appears in both bounded evidence excerpts', () => {
  const result = compareTimelineDisclosures(analysis(`${opening}${filler}The liquidity covenant requires $8 million of cash.`), analysis(`${opening}${filler}The liquidity covenant requires $5 million of cash.`), filing(2025), filing(2024));
  const event = result.events.find(row => row.category === 'covenants');
  assert.ok(event);
  assert.match(event.before.evidence[0].text, /\$5 million/);
  assert.match(event.after.evidence[0].text, /\$8 million/);
  assert.notEqual(event.before.evidence[0].text, event.after.evidence[0].text);
  for (const evidence of [event.before.evidence[0], event.after.evidence[0]]) {
    assert.ok(evidence.text.length <= RISK_TIMELINE_LIMITS.excerptCharacters);
    assert.ok(evidence.text.startsWith('Our credit agreement'));
    assert.match(evidence.text, /not required/);
    assert.equal(evidence.truncated, true);
  }
});

test('a reporting-date roll does not hide a later changed covenant or its negation', () => {
  const old = `As of June 30, 2024, ${opening}${filler}We remain in compliance with the liquidity covenant.`;
  const next = `As of June 30, 2025, ${opening}${filler}We do not remain in compliance with the liquidity covenant.`;
  const event = compareTimelineDisclosures(analysis(next), analysis(old), filing(2025), filing(2024)).events.find(row => row.category === 'covenants');
  assert.match(event.before.evidence[0].text, /We remain in compliance/);
  assert.match(event.after.evidence[0].text, /We do not remain in compliance/);
});

test('the changed part of a long sentence remains visible and bounded', () => {
  const old = `${opening}${'the borrower monitors its contractual restrictions and available liquidity, '.repeat(15)}the financial covenant minimum is $3.0 million and remains applicable to the consolidated borrower.`;
  const next = old.replace('$3.0 million', '$4.0 million');
  const event = compareTimelineDisclosures(analysis(next), analysis(old), filing(2025), filing(2024)).events.find(row => row.category === 'covenants');
  assert.match(event.before.evidence[0].text, /\$3.0 million/);
  assert.match(event.after.evidence[0].text, /\$4.0 million/);
  assert.ok(event.after.evidence[0].text.length <= RISK_TIMELINE_LIMITS.excerptCharacters);
});

test('multiple deep revisions do not focus past the changed amount in the first changed sentence', () => {
  const neutralOpening = 'Our credit agreement includes financial covenants. Management evaluates the borrowing agreement and its contractual conditions. ';
  const firstChangedSentence = `The liquidity covenant requires $5 million ${'for ordinary operations and seasonal working capital requirements, '.repeat(12)}subject to the agreement.`;
  const old = `${neutralOpening}${filler}${firstChangedSentence} The leverage covenant requires a maximum ratio of 3.0 to 1.0.`;
  const next = old.replace('$5 million', '$8 million').replace('3.0 to 1.0', '4.0 to 1.0');
  const event = compareTimelineDisclosures(analysis(next), analysis(old), filing(2025), filing(2024)).events.find(row => row.category === 'covenants');
  assert.ok(event);
  assert.match(event.before.evidence[0].text, /\$5 million/);
  assert.match(event.after.evidence[0].text, /\$8 million/);
  assert.notEqual(event.before.evidence[0].text, event.after.evidence[0].text);
  for (const evidence of [event.before.evidence[0], event.after.evidence[0]]) {
    assert.ok(evidence.text.length <= RISK_TIMELINE_LIMITS.excerptCharacters);
    assert.equal(evidence.truncated, true);
  }
});

test('a deep long sentence retains its own negation alongside the changed amount', () => {
  const neutralOpening = 'Our credit agreement includes financial covenants. Management evaluates the borrowing agreement and its contractual conditions. ';
  const sentence = `We are not required, ${'after applying the definitions and qualifications established under the borrowing agreement, '.repeat(15)}to maintain liquidity of $5 million under the financial covenant.`;
  const old = `${neutralOpening}${filler}${sentence}`;
  const next = old.replace('$5 million', '$8 million');
  const event = compareTimelineDisclosures(analysis(next), analysis(old), filing(2025), filing(2024)).events.find(row => row.category === 'covenants');
  assert.ok(event);
  assert.match(event.before.evidence[0].text, /\$5 million/);
  assert.match(event.after.evidence[0].text, /\$8 million/);
  for (const evidence of [event.before.evidence[0], event.after.evidence[0]]) {
    assert.match(evidence.text, /We are not required/);
    assert.ok(evidence.text.length <= RISK_TIMELINE_LIMITS.excerptCharacters);
    assert.equal(evidence.truncated, true);
  }
});

test('short evidence and unpaired excerpts preserve original text', () => {
  const text = 'We are not required to post collateral under the current credit agreement.';
  assert.equal(timelineExcerpt({ text }, filing(2025).url).text, text);
  const excerpt = timelineExcerpt({ text: opening + filler }, filing(2025).url);
  assert.ok(excerpt.text.startsWith(opening));
  assert.ok(excerpt.text.length <= RISK_TIMELINE_LIMITS.excerptCharacters);
});
