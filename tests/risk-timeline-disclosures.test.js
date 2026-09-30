import test from 'node:test';
import assert from 'node:assert/strict';
import { comparableTimelineText, isTimelineNarrative, extractTimelineDisclosures, compareTimelineDisclosures,
  timelineExcerpt, isCustomerConcentrationDisclosure, RISK_TIMELINE_LIMITS } from '../src/utils/riskTimelineDisclosures.js';
import { matchesRiskTimelineResponse, RISK_TIMELINE_RESPONSE_VERSION } from '../src/utils/riskTimelineResponse.js';

const cik = '0000320193';
const filing = (year, form = '10-K') => ({ accession: `0000320193-${String(year).slice(-2)}-000001`, form,
  reportDate: `${year}-06-30`, filed: `${year}-08-01`, url: `https://www.sec.gov/Archives/edgar/data/320193/0000320193${String(year).slice(-2)}000001/report.htm` });
const narrative = amount => `Our credit agreement requires us to maintain financial covenants, including a minimum available liquidity balance of $${amount} million. We remain in compliance with these covenants and have not requested a waiver of the agreement. These restrictions apply to the consolidated borrower and do not establish available borrowing capacity.`;
const report = text => `Item 1A. Risk Factors\n\n${text}\n\nItem 2. Properties\n\nOur principal facilities are owned or leased in several countries.`;
const analysis = text => extractTimelineDisclosures(report(text), '10-K');

test('topic extraction includes plurals and preserves leading negation and qualifications', () => {
  const text = 'We do not have any single customer that accounts for a material portion of our revenue. Our major customers are independent distributors, and their purchases may change between periods. The reported customer concentration does not establish a named counterparty exposure or a guarantee of future sales.';
  const extracted = analysis(text);
  assert.equal(extracted.topics['customer-concentration'].matchingParagraphs, 1);
  assert.equal(extracted.topics['customer-concentration'].matches[0].text, text);
  assert.equal(timelineExcerpt(extracted.topics['customer-concentration'].matches[0], filing(2025).url).text, text);
  assert.equal(extracted.topics.covenants.matchingParagraphs, 0);
});

test('contents, labels, numeric table blocks and unrelated waivers do not become covenant evidence', () => {
  assert.equal(isTimelineNarrative('Financial covenants ........................................ 54'), false);
  assert.equal(isTimelineNarrative('Collateral pledged 2025 2024 10,500 9,800 8,900 12,600 18,950.'), false);
  const unrelated = 'Our employees may request a waiver of this policy when their work responsibilities require an exception. These requests are reviewed by management under the employee code of conduct and do not relate to financing agreements or external creditors.';
  assert.equal(analysis(unrelated).topics.covenants.matchingParagraphs, 0);
  assert.equal(analysis(narrative(5)).topics.covenants.matchingParagraphs, 1);
});

test('standard negated customer shares and dependence are retained, marketing customer references are excluded', () => {
  // Verbatim FY2025 Adobe Financial Notes disclosure, independently inspected
  // in the retained original ADBE annual HTML (period ended 2025-11-28).
  const actual = 'For all periods presented, there were no customers that represented at least 10% of net revenue or that were responsible for over 10% of our trade receivables.';
  const marketing = 'We have a global professional services team dedicated to designing and implementing solutions for our largest customers. Our professional services team uses a comprehensive, customer-focused methodology that has been refined over years of capturing and analyzing best practices from numerous customer engagements across a diverse mix of solutions, industries and customer segments.';
  const disclosures = [actual, 'No customers accounted for more than 10% of net revenue.',
    'No single customer represented more than 10% of revenues.',
    'Our revenue depends on a small number of major customers.',
    'We rely on a single customer for a substantial portion of our business.'];
  for (const text of disclosures) {
    assert.equal(isCustomerConcentrationDisclosure(text), true);
    const result = analysis(text);
    assert.equal(result.topics['customer-concentration'].matchingParagraphs, 1);
    assert.equal(result.topics['customer-concentration'].matches[0].text, text);
    assert.equal(timelineExcerpt(result.topics['customer-concentration'].matches[0], filing(2025).url).text, text);
  }
  assert.equal(isCustomerConcentrationDisclosure(marketing), false);
  assert.equal(analysis(marketing).topics['customer-concentration'].matchingParagraphs, 0);
  assert.equal(isCustomerConcentrationDisclosure('Our contracts with customers may include promises to transfer multiple products and services. Determining whether these services are accounted for separately requires judgment about when revenue is recognized. Subscription services represent 90% of our revenue.'), false);
  assert.equal(isCustomerConcentrationDisclosure('Our customers increasingly require responsible and secure solutions for their business. We develop products that support their revenue growth and market share.'), false);
});

test('short complete compliance and collateral statements remain narrative evidence', () => {
  assert.equal(analysis('We are in compliance with all of our debt covenants.').topics.covenants.matchingParagraphs, 1);
  assert.equal(analysis('No collateral is required under the credit agreement.').topics.collateral.matchingParagraphs, 1);
});

test('repeated wording and reporting-date roll-forwards do not generate changed-language events', () => {
  const old = analysis(`As of June 30, 2024, ${narrative(5)}`);
  const current = analysis(`As of June 30, 2025, ${narrative(5)}`);
  const result = compareTimelineDisclosures(current, old, filing(2025), filing(2024));
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.covenants.status, 'unchanged');
  assert.notEqual(comparableTimelineText('The facility matures in 2027.'), comparableTimelineText('The facility matures in 2028.'));
});

test('future covenant and collateral obligation dates are retained while report dates roll forward', () => {
  const covenant = year => `As of June 30, ${year === 2027 ? 2024 : 2025}, ${narrative(5)} At December 31, ${year}, the borrower must satisfy the financial covenant under the credit agreement.`;
  const result = compareTimelineDisclosures(analysis(covenant(2028)), analysis(covenant(2027)), filing(2025), filing(2024));
  assert.equal(result.events.length, 1);
  assert.match(result.events[0].before.evidence[0].text, /December 31, 2027/);
  assert.match(result.events[0].after.evidence[0].text, /December 31, 2028/);
  const collateral = year => `We exchange collateral with our lending counterparties under the security agreement. At December 31, ${year}, the pledged collateral must be returned to the borrower subject to the continuing restrictions and agreed conditions in the contract.`;
  const pledged = compareTimelineDisclosures(analysis(collateral(2028)), analysis(collateral(2027)), filing(2025), filing(2024));
  assert.equal(pledged.events.length, 1);
  assert.equal(pledged.events[0].category, 'collateral');
});

test('reported amounts, percentages, signs, decimals and currency remain significant', () => {
  const customer = percent => `No customers accounted for more than ${percent}% of net revenue. The company reviews customer concentration and receivable exposure using the reported revenue benchmark in each reporting period.`;
  const concentration = compareTimelineDisclosures(analysis(customer(15)), analysis(customer(10)), filing(2025), filing(2024));
  assert.equal(concentration.events.length, 1);
  assert.equal(concentration.events[0].category, 'customer-concentration');
  const collateral = amount => `We posted ${amount} million of collateral with the lending counterparty under our security agreement. The reported collateral amount relates to the contract and does not establish total encumbrance of the company's assets.`;
  const posted = compareTimelineDisclosures(analysis(collateral('$5.5')), analysis(collateral('$5.0')), filing(2025), filing(2024));
  assert.equal(posted.events.length, 1);
  for (const [before, after] of [['$5', '-$5'], ['$5', '€5'], ['10%', '10'], ['≤10%', '≥10%']])
    assert.notEqual(comparableTimelineText(before), comparableTimelineText(after));
  assert.equal(comparableTimelineText('$1,000'), comparableTimelineText('$1000'));
});

test('changed full text generates paired source evidence with exact periods and no inferred metric', () => {
  const result = compareTimelineDisclosures(analysis(narrative(7)), analysis(narrative(5)), filing(2025), filing(2024));
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.title, 'Covenants language changed');
  assert.equal(event.date, '2025-06-30');
  assert.equal(event.dateBasis, 'period-end');
  assert.equal(event.direction, 'review');
  assert.equal(event.before.evidence[0].url, filing(2024).url);
  assert.equal(event.after.evidence[0].url, filing(2025).url);
  assert.ok(event.before.evidence[0].text.includes('$5 million'));
  assert.ok(event.after.evidence[0].text.includes('$7 million'));
  assert.equal('value' in event, false);
  assert.equal(result.coverage.covenants.comparedTo.gapDays, 365);
});

test('changes beyond the 600-character excerpt are compared using complete paragraphs', () => {
  const leading = `${narrative(5)} ${'The borrower remains subject to the consolidated agreement and its contractual restrictions. '.repeat(7)}`;
  const old = analysis(`${leading} The liquidity covenant requires $5 million of cash at the end of each reporting period.`);
  const current = analysis(`${leading} The liquidity covenant requires $8 million of cash at the end of each reporting period.`);
  const result = compareTimelineDisclosures(current, old, filing(2025), filing(2024));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].before.evidence[0].truncated, true);
  assert.equal(result.events[0].after.evidence[0].truncated, true);
  assert.ok(result.events[0].after.evidence[0].text.length <= RISK_TIMELINE_LIMITS.excerptCharacters);
  assert.ok(result.events[0].after.evidence[0].text.startsWith('Our credit agreement'));
});

test('a changed negation remains significant and is retained in the evidence', () => {
  const old = analysis(narrative(5));
  const current = analysis(narrative(5).replace('We remain in compliance', 'We do not remain in compliance'));
  const result = compareTimelineDisclosures(current, old, filing(2025), filing(2024));
  assert.equal(result.events.length, 1);
  assert.match(result.events[0].after.evidence[0].text, /do not remain in compliance/);
  assert.doesNotMatch(result.events[0].title, /breach|increased|default|resolved/i);
});

test('absence, mixed forms and missing recognized sections never become introduction or resolution events', () => {
  const missing = analysis('Our operations span several markets and we discuss their performance in the financial statements. This paragraph describes ordinary operations and has no relevant borrowing or customer concentration topic. Management continues to assess these operations each reporting period.');
  const known = analysis(narrative(5));
  const absent = compareTimelineDisclosures(missing, known, filing(2025), filing(2024));
  assert.equal(absent.events.length, 0);
  assert.equal(absent.coverage.covenants.status, 'missing');
  const mixed = compareTimelineDisclosures(analysis(narrative(7)), known, filing(2025, '10-Q'), filing(2024));
  assert.equal(mixed.events.length, 0);
  assert.equal(mixed.coverage.covenants.status, 'uncompared');
  const unknownA = extractTimelineDisclosures(narrative(7), '40-F');
  const unknownB = extractTimelineDisclosures(narrative(5), '40-F');
  const unknown = compareTimelineDisclosures(unknownA, unknownB, filing(2025, '40-F'), filing(2024, '40-F'));
  assert.equal(unknown.events.length, 0);
  assert.equal(unknown.coverage.covenants.status, 'uncompared');
  assert.deepEqual(unknown.coverage.covenants.sectionCoverage, []);
});

test('matching whole paragraphs have bounded retention with explicit omitted coverage', () => {
  const many = extractTimelineDisclosures(report(Array.from({ length: 60 }, (_, index) => narrative(index + 1)).join('\n\n')), '10-K');
  assert.equal(many.topics.covenants.matchingParagraphs, 60);
  assert.equal(many.topics.covenants.matches.length, 40);
  assert.equal(many.topics.covenants.limited, true);
  assert.equal(many.topics.covenants.omittedMatches, 20);
});

test('20-F layout changes withhold wording events while retaining topic coverage', () => {
  const paragraphs = Array.from({ length: 16 }, (_, index) => `${narrative(index + 1)} Management evaluates these restrictions with its lenders and board of directors each reporting period.`);
  const lines = paragraphs.flatMap(p => {
    const words = p.split(' '), chunks = [];
    for (let index = 0; index < words.length; index += 12) chunks.push(words.slice(index, index + 12).join(' '));
    return chunks;
  });
  const foreign = body => `Item 3. Key Information\n\nD. Risk Factors\n\n${body}\n\nItem 4. Information on the Company\n\nOur operations span several countries.`;
  const prior = extractTimelineDisclosures(foreign(paragraphs.join('\n\n')), '20-F');
  const current = extractTimelineDisclosures(foreign(lines.join('\n\n')), '20-F');
  const result = compareTimelineDisclosures(current, prior, filing(2025, '20-F'), filing(2024, '20-F'));
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.covenants.status, 'uncompared');
  assert.match(result.coverage.covenants.comparisonError, /different text layouts/);
});

test('client response binds paired evidence to issuer, cutoff, dates and original source document', () => {
  const oldFiling = filing(2024), newFiling = filing(2025);
  const oldAnalysis = analysis(narrative(5)), result = compareTimelineDisclosures(analysis(narrative(7)), oldAnalysis, newFiling, oldFiling);
  const olderTopics = Object.fromEntries(Object.keys(result.coverage).map(key => [key, { status: oldAnalysis.topics[key].matchingParagraphs ? 'uncompared' : 'missing', matches: oldAnalysis.topics[key].matchingParagraphs, sectionCoverage: ['risk'] }]));
  const body = { schemaVersion: RISK_TIMELINE_RESPONSE_VERSION, ticker: 'AAPL', basis: 'annual', asOf: '2025-08-01', cik, companyName: 'Apple Inc.', checkedAt: '2026-09-30T00:00:00.000Z', status: 'ready', events: result.events,
    filings: [{ ...oldFiling, status: 'reviewed', topics: olderTopics }, { ...newFiling, status: 'reviewed', topics: result.coverage }], coverage: {}, limitations: [] };
  assert.equal(matchesRiskTimelineResponse(body, 'AAPL', 'annual', '2025-08-01', cik), true);
  assert.equal(matchesRiskTimelineResponse(body, 'MSFT', 'annual', '2025-08-01', cik), false);
  assert.equal(matchesRiskTimelineResponse(body, 'AAPL', 'annual', '2025-07-31', cik), false);
  assert.equal(matchesRiskTimelineResponse(body, 'AAPL', 'annual', '2025-08-01', '0000789019'), false);
  for (const mutate of [
    changed => { changed.events[0].after.evidence[0].url = 'https://example.com/forged.htm'; },
    changed => { changed.events[0].after.evidence[0].text = 'x'.repeat(601); },
    changed => { changed.events[0].value = 5; },
    changed => { changed.events[0].before.form = '10-Q'; },
    changed => { changed.events[0].before.filed = '2026-08-01'; },
    changed => { changed.filings[1].topics.covenants.comparedTo.gapDays = 1; },
  ]) {
    const changed = structuredClone(body); mutate(changed);
    assert.equal(matchesRiskTimelineResponse(changed, 'AAPL', 'annual', '2025-08-01', cik), false);
  }
});
