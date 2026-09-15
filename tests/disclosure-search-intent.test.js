import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretDisclosureSearch, disclosureSearchSuggestions } from '../src/utils/disclosureSearchIntent.js';
import { parseDisclosureQuery, matchesQuery } from '../src/utils/disclosureQuery.js';
import { disclosureSettings } from '../src/utils/disclosureResearchServer.js';

const companies = {
  MSFT: { cik: '789019', name: 'MICROSOFT CORP' },
  AAPL: { cik: '320193', name: 'Apple Inc.' },
  APLE: { cik: '1418121', name: 'Apple Hospitality REIT, Inc.' },
  LQDT: { cik: '1235468', name: 'Liquidity Services Inc.' },
  CVLG: { cik: '928658', name: 'Covenant Logistics Group, Inc.' },
  NET: { cik: '1477333', name: 'Cloudflare, Inc.' },
  NVDA: { cik: '1045810', name: 'NVIDIA CORP' },
  CPHI: { cik: '1106644', name: 'China Pharma Holdings, Inc.' },
  GOOG: { cik: '1652044', name: 'Alphabet Inc.' },
  GOOGL: { cik: '1652044', name: 'Alphabet Inc.' },
  JPM: { cik: '19617', name: 'JPMorgan Chase & Co.' },
  GS: { cik: '886982', name: 'Goldman Sachs Group Inc.' },
  AMZN: { cik: '1018724', name: 'Amazon.com Inc.' },
  V: { cik: '1403161', name: 'Visa Inc.' },
  AI: { cik: '1577526', name: 'C3.ai, Inc.' },
  ALL: { cik: '899051', name: 'ALLSTATE CORP' },
  NARA: { cik: '100', name: 'North American Alpha Inc.' },
  NARB: { cik: '101', name: 'North American Beta Inc.' },
  GALA: { cik: '102', name: 'Galaxy Alpha Inc.' },
  GALB: { cik: '103', name: 'Galaxy Beta Inc.' },
};
const interpret = (raw, options = {}) => interpretDisclosureSearch(raw, { companies, now: '2026-09-15T12:00:00Z', ...options });
const matches = (text, result) => matchesQuery(text, parseDisclosureQuery(result.query));

test('natural issuer/topic questions produce a focused index search and transparent expansions', () => {
  const result = interpret('Microsoft cybersecurity risks');
  assert.equal(result.settings.tickers, '0000789019');
  assert.equal(result.settings.mode, 'index');
  assert.equal(result.settings.comparison, 'none');
  assert.equal(result.settings.forms, '10-K,10-Q,8-K');
  assert.equal(result.settings.query, result.query);
  assert.equal(matches('Our cybersecurity program is reviewed annually.', result), true);
  assert.equal(matches('Information security oversight continues.', result), true);
  assert.equal(matches('Our normal operations continue.', result), false);
  assert.deepEqual(result.expansions[0].alternatives, ['cybersecurity', 'cyber security', 'information security']);
  assert.equal(result.chips.find(chip => chip.key === 'tickers').value, result.settings.tickers);
});

test('broad discovery strips conversational framing and preserves breach meaning', () => {
  const result = interpret('Could you find companies mentioning debt covenant breaches?');
  assert.equal(result.settings.tickers, '');
  assert.equal(matches('We breached the covenants under our credit agreement.', result), true);
  assert.equal(matches('Our debt covenants were in compliance.', result), false);
  assert.equal(matches('There was no covenant breach.', result), true);
  assert.ok(!result.query.includes('companies'));
  assert.equal(result.chips[0].label, 'All SEC filers');
});

test('explicit filing dates are separate from financial periods', () => {
  const result = interpret('Apple supply chain risks in filings from 2025');
  assert.equal(result.settings.tickers, '0000320193');
  assert.equal(result.settings.start, '2025-01-01');
  assert.equal(result.settings.end, '2025-12-31');
  assert.equal(matches('Disruptions in our supply chain may affect production.', result), true);
  const fiscal = interpret('Apple fiscal 2025 revenue');
  assert.equal(fiscal.settings.start, '2021-01-01');
  assert.ok(fiscal.query.includes('2025'));
  assert.match(fiscal.warnings.join(' '), /fiscal periods remain search terms/);
});

test('exact and explicit Boolean or quoted expressions remain unexpanded and unstripped', () => {
  for (const raw of ['"material weakness" AND remediation', '(Microsoft OR Apple) AND cybersecurity', 'covenant AND NOT breach', 'liquidity -hypothetical', '"Microsoft cybersecurity risks"']) {
    const result = interpret(raw);
    assert.equal(result.query, raw);
    assert.equal(result.settings.tickers, '');
    assert.deepEqual(result.expansions, []);
    assert.equal(result.style, 'exact');
  }
  const exact = interpret('Microsoft cybersecurity risks', { style: 'exact' });
  assert.equal(exact.query, 'Microsoft cybersecurity risks');
  assert.equal(exact.settings.tickers, '');
});

test('curly quotes are visibly normalized to exact phrases', () => {
  const result = interpret('“material weakness”');
  assert.equal(result.query, '"material weakness"');
  assert.equal(result.style, 'exact');
  assert.match(result.warnings[0], /Curly quotation/);
  assert.equal(matches('A material accounting weakness.', result), false);
});

test('malformed Boolean and unsupported special syntax are not broadened', () => {
  for (const raw of ['liquidity AND', 'liquidity OR NOT covenant', '"unclosed', '(covenant OR breach', 'cyber*', 'cyber~', 'pattern[abc]']) assert.throws(() => interpret(raw), undefined, raw);
});

test('explicit symbols, lowercase leading tickers, CIKs and names retain identity', () => {
  for (const [raw, expected] of [
    ['$MSFT cybersecurity', 'MSFT'],
    ['show me msft cybersecurity', 'MSFT'],
    ['ticker: AAPL material weakness', 'AAPL'],
    ['CIK 320193 liquidity', '0000320193'],
    ['0000320193 liquidity', '0000320193'],
    ['Alphabet artificial intelligence', '0001652044'],
    ['JPMorgan Chase liquidity', '0000019617'],
    ['Amazon.com supply chain', '0001018724'],
    ["Apple’s supply chain", '0000320193'],
  ]) assert.equal(interpret(raw).settings.tickers, expected, raw);
});

test('common words and financial acronyms do not become ticker filters', () => {
  for (const raw of ['ALL companies mentioning liquidity', 'AI risks', 'capital requirements', 'North American revenue', 'liquidity', 'covenant breaches', 'net income']) assert.equal(interpret(raw).settings.tickers, '', raw);
  assert.equal(interpret('$AI artificial intelligence').settings.tickers, 'AI');
});

test('exact company names outrank inferred prefixes from similarly named issuers', () => {
  assert.equal(interpret('Apple supply chain').settings.tickers, '0000320193');
  assert.equal(interpret('Apple Hospitality REIT liquidity').settings.tickers, '0001418121');
  assert.equal(interpret('Liquidity Services material weakness').settings.tickers, '0001235468');
  assert.equal(interpret('Covenant Logistics liquidity').settings.tickers, '0000928658');
});

test('ambiguous company prefixes stay literal and offer verified company choices', () => {
  const result = interpret('Galaxy liquidity');
  assert.equal(result.settings.tickers, '');
  assert.match(result.query, /Galaxy/);
  assert.match(result.warnings.join(' '), /more than one SEC issuer/);
  assert.deepEqual(result.suggestions.filter(value => value.kind === 'company').map(value => value.cik), ['0000000102', '0000000103']);
});

test('multiple issuers are deduplicated by CIK and never silently truncated', () => {
  const result = interpret('Microsoft and Apple cybersecurity');
  assert.equal(result.settings.tickers, '0000789019,0000320193');
  assert.equal(interpret('GOOG GOOGL artificial intelligence').settings.tickers, 'GOOG');
  assert.throws(() => interpret('MSFT AAPL GOOG JPM GS AMZN liquidity'), /up to 5/);
});

test('raw issuer intent replaces an existing issuer filter while other filters persist', () => {
  const result = interpret('Microsoft liquidity', { settings: { tickers: 'AAPL', forms: '10-Q', scope: 'document', comparison: 'previous-report', depth: 4, amendments: true } });
  assert.equal(result.settings.tickers, '0000789019');
  assert.equal(result.settings.forms, '10-Q');
  assert.equal(result.settings.scope, 'document');
  assert.equal(result.settings.comparison, 'previous-report');
  assert.equal(result.settings.amendments, true);
  assert.equal(interpret('liquidity', { settings: { tickers: 'AAPL' } }).settings.tickers, 'AAPL');
});

test('natural form and explicit section filters align with the server contract', () => {
  const result = interpret('Apple 10-K material weaknesses in risk factors');
  assert.equal(result.settings.forms, '10-K');
  assert.equal(result.settings.section, 'risk');
  const settings = disclosureSettings(new URLSearchParams(result.settings));
  assert.equal(settings.section, 'risk');
  assert.equal(interpret('Microsoft annual reports cybersecurity').settings.forms, '10-K,20-F,40-F');
  assert.equal(interpret('8-K cybersecurity in item 1.05').settings.section, '8k:1.05');
  assert.equal(interpret('liquidity in MD&A').settings.section, 'mda');
  assert.equal(interpret('debt in the notes to financial statements').settings.section, 'notes');
  assert.throws(() => interpret('10-K/A liquidity'), /amended/);
  assert.throws(() => interpret('liquidity in risk factors and in MD&A'), /one filing section/);
});

test('date ranges support calendar years, exact dates and since syntax', () => {
  for (const [raw, start, end] of [
    ['liquidity filed between 2024-01-01 and 2025-06-30', '2024-01-01', '2025-06-30'],
    ['liquidity filings from 2024 through 2025', '2024-01-01', '2025-12-31'],
    ['liquidity filed since 2025-06-30', '2025-06-30', '2026-09-15'],
    ['liquidity filings from this year', '2026-01-01', '2026-09-15'],
    ['What have companies said about liquidity in filings from last year?', '2025-01-01', '2025-12-31'],
    ['liquidity filings in the last 30 days', '2026-08-16', '2026-09-15'],
    ['liquidity filings from 2026', '2026-01-01', '2026-09-15'],
  ]) {
    const result = interpret(raw);
    assert.equal(result.settings.start, start, raw);
    assert.equal(result.settings.end, end, raw);
    assert.equal(matches('We have sufficient liquidity.', result), true, raw);
  }
});

test('month and leap-year windows stay on valid dates without rollover', () => {
  assert.equal(interpret('liquidity filings last 1 month', { now: '2026-03-31' }).settings.start, '2026-02-28');
  assert.equal(interpret('liquidity filings last 1 year', { now: '2024-02-29' }).settings.start, '2023-02-28');
});

test('future, invalid, conflicting and inverted filing windows are rejected', () => {
  for (const raw of ['liquidity filed in 2027', 'liquidity filed in 2025-02-30', 'liquidity filings from 2025 to 2024', 'liquidity filed in 2000', 'liquidity filed in 2024 and filed in 2025', 'liquidity filings past 0 days']) assert.throws(() => interpret(raw), undefined, raw);
});

test('typo suggestions require user selection and do not alter the search', () => {
  const result = interpret('Apple cybesecurity risks');
  assert.match(result.query, /cybesecurity/);
  assert.equal(result.suggestions.find(value => value.kind === 'spelling').query, 'Apple cybersecurity risks');
  assert.ok(!result.expansions.some(value => value.label === 'Cybersecurity'));
  assert.equal(disclosureSearchSuggestions('cyber')[0].label, 'Cybersecurity');
  assert.equal(disclosureSearchSuggestions('Micro', { companies }).find(value => value.kind === 'company').ticker, 'MSFT');
});

test('natural or means alternatives and conjunctions require both topics', () => {
  const alternative = interpret('Microsoft cybersecurity or material weakness');
  assert.equal(matches('Our cybersecurity oversight has improved.', alternative), true);
  assert.equal(matches('We remediated a material weakness.', alternative), true);
  const both = interpret('cybersecurity and material weakness');
  assert.equal(matches('Our cybersecurity oversight has improved.', both), false);
  assert.equal(matches('Our cybersecurity control had a material weakness.', both), true);
});

test('natural negation remains text evidence rather than a sentiment claim', () => {
  const result = interpret('companies with no covenant breach');
  assert.equal(matches('There was no covenant breach.', result), true);
  assert.equal(matches('There was a covenant breach.', result), false);
});

test('long multi-topic searches retain literal terms when expansions exceed grammar limits', () => {
  const result = interpret('cybersecurity supply chain liquidity litigation material weakness customer concentration refinancing');
  assert.equal(result.expansions.length, 0);
  assert.match(result.warnings.join(' '), /query limit/);
  const parsed = parseDisclosureQuery(result.query);
  assert.ok(parsed.terms.includes('refinancing'));
  assert.ok(parsed.terms.includes('cybersecurity'));
});

test('empty, control-character, issuer-only and invalid filter input fails usefully', () => {
  for (const raw of ['', ' ', '<script>', 'liquidity\n', 'a'.repeat(1001), 'Microsoft', 'CIK 0 liquidity', 'CIK 12345678901 liquidity']) assert.throws(() => interpret(raw), undefined, raw);
  for (const settings of [{ forms: 'unknown' }, { section: 'unknown' }, { scope: 'anything' }, { start: '2025-02-30' }, { end: '2099-01-01' }, { comparison: 'unknown' }, { tickers: 'MSFT,<bad>' }]) assert.throws(() => interpret('liquidity', { settings }));
});

test('resolved issuer questions remove conversational verbs without requiring those verbs in evidence', () => {
  for (const [raw, ticker, evidence] of [
    ['What is NVIDIA saying about AI?', '0001045810', 'Our artificial intelligence products continue to develop.'],
    ['What did Microsoft disclose about cybersecurity?', '0000789019', 'Our information security program is reviewed annually.'],
    ['Tell me about Apple’s supply chain risks', '0000320193', 'Disruptions to our supply chain may affect production.'],
    ['What has Microsoft mentioned regarding liquidity?', '0000789019', 'Our liquidity remains sufficient.'],
    ['How is NVIDIA describing artificial intelligence?', '0001045810', 'We develop machine learning products.'],
  ]) {
    const result = interpret(raw);
    assert.equal(result.settings.tickers, ticker, raw);
    assert.equal(matches(evidence, result), true, `${raw}: ${result.query}`);
    assert.ok(!/"(?:What|did|is|saying|disclose|regarding)"/i.test(result.query), result.query);
  }
});

test('risk connectors retain both risk and geography without resolving a country to a company prefix', () => {
  const result = interpret('NVIDIA risks related to China');
  assert.equal(result.settings.tickers, '0001045810');
  assert.equal(matches('We face risk from export restrictions in China.', result), true);
  assert.equal(matches('China sales increased this quarter.', result), false);
  assert.equal(matches('Our risk management program has expanded.', result), false);
});

test('conversational cleanup preserves substantive disclosure nouns and natural negation', () => {
  for (const [raw, required] of [
    ['Microsoft disclosure controls and procedures', ['disclosure', 'controls', 'procedures']],
    ['Microsoft report quality', ['report', 'quality']],
    ['Microsoft related party transactions', ['related', 'party', 'transactions']],
    ['What did Microsoft not disclose about cybersecurity?', ['not']],
    ['What has Microsoft never reported about liquidity?', ['never']],
  ]) {
    const terms = parseDisclosureQuery(interpret(raw).query).terms.map(term => term.toLowerCase());
    for (const term of required) assert.ok(terms.includes(term), `${raw} must retain ${term}`);
  }
});

test('AI topic shorthand preserves explicit company identities and possessive ticker syntax', () => {
  const topic = interpret('AI');
  assert.equal(topic.settings.tickers, '');
  assert.equal(matches('We develop artificial intelligence software.', topic), true);
  assert.equal(interpret('$AI liquidity').settings.tickers, 'AI');
  assert.equal(interpret('ticker: AI liquidity').settings.tickers, 'AI');
  assert.equal(interpret('MSFT’s cybersecurity').settings.tickers, 'MSFT');
  assert.equal(interpret("$MSFT's cybersecurity").warnings.length, 0);
  for (const raw of ['$AI liquidity', '$AI risks', 'ticker: AI risks', 'C3.ai liquidity']) {
    const unresolved = interpret(raw, { companies: {} });
    assert.ok(!unresolved.expansions.some(value => value.label === 'Artificial intelligence'), raw);
  }
  assert.throws(() => interpret('$AI'), /Add a disclosure topic/);
  assert.throws(() => interpret('NVIDIA'), /Add a disclosure topic/);
  assert.equal(disclosureSearchSuggestions('NVIDIA', { companies }).find(value => value.kind === 'company').ticker, 'NVDA');
});
