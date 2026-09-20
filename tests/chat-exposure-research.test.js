import test from 'node:test';
import assert from 'node:assert/strict';
import { createExposureChatTools } from '../src/utils/chatExposureResearch.js';
import { extractCompanyExposureMap } from '../src/utils/companyExposure.js';

const identity = { id: 'TEST', ticker: 'TEST', cik: '0000000001', name: 'Example Company' };
const annual = { url: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm', accession: '0000000001-26-000001', form: '10-K', filed: '2026-02-01', reportDate: '2025-12-31' };
const quarterly = { url: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000002/report.htm', accession: '0000000001-26-000002', form: '10-Q', filed: '2026-08-01', reportDate: '2026-06-30' };
const positive = 'Our copper production revenue is exposed to changes in copper prices and customer demand.';
const negative = 'We no longer have any copper production revenue or exposure to changes in copper prices.';
function fixture({ text = positive, newer = null, asOf = null } = {}) {
  const inputs = [{ text, filing: annual, role: 'annual' }, ...(newer ? [{ text: newer, filing: quarterly, role: 'quarterly' }] : [])];
  const extracted = extractCompanyExposureMap(inputs, { companyName: identity.name, ticker: identity.ticker });
  return { ticker: 'TEST', cik: identity.cik, asOf, status: extracted.rows.length ? 'ready' : 'no_matches', checkedAt: '2026-09-20T00:00:00Z',
    rows: extracted.rows, sources: inputs.map(input => ({ ...input.filing, role: input.role, status: 'ready' })),
    coverage: { ...extracted.coverage, filingsScanned: inputs.length, filingsFailed: 0, annualAvailable: true, quarterlyAvailable: Boolean(newer), searchComplete: true } };
}
function harness(result = fixture(), options = {}) {
  const sources = [], calls = [];
  const tools = createExposureChatTools({ context: options.context || {}, preview: options.preview || false,
    stringSchema: description => ({ type: 'string', description }), enumeration: values => ({ type: 'string', enum: values }),
    tool: (_description, _properties, _status, execute) => ({ execute }),
    read: (key, work) => work(options.signal || new AbortController().signal),
    resolve: async () => ({ identity: options.identity || identity }), rememberCompany: value => value,
    addSource: (title, url, asOf) => { const existing = sources.find(source => source.url === url); if (existing) return existing.id;
      const id = `S${sources.length + 1}`; sources.push({ id, title, url, asOf }); return id; },
    fail: (message, code) => Object.assign(new Error(message), { researchCode: code }),
    unavailable: (reason, code) => ({ status: 'unavailable', reason, code }), txt: (value, max = 600) => typeof value === 'string' ? value.slice(0, max) : '',
    dependencies: { cftcEnabled: () => options.enabled !== false, companyExposures: async (selection, signal) => {
      calls.push({ selection, signal }); if (options.load) return options.load(selection, signal); return result;
    } },
  });
  return { run: (overrides = {}) => tools.company_exposures.execute({ identifier: 'TEST', asOf: '', category: 'all', ...overrides }), calls, sources };
}

test('company exposure tool uses existing reader selection and cancellation signal while preserving dated SEC passages', async () => {
  const signal = new AbortController().signal;
  const h = harness(fixture(), { signal });
  const result = await h.run();
  assert.equal(result.status, 'ready');
  assert.deepEqual(h.calls[0].selection, { ticker: 'TEST', cik: identity.cik, asOf: '' });
  assert.equal(h.calls[0].signal, signal);
  assert.equal(result.rows[0].evidence[0].text, positive);
  assert.equal(result.rows[0].evidence[0].filed, '2026-02-01');
  assert.equal(result.rows[0].evidence[0].reportDate, '2025-12-31');
  assert.ok(result.rows[0].evidence[0].sourceIds.length);
  assert.ok(h.sources.some(source => source.url === annual.url));
  assert.match(result.limitations.join(' '), /does not identify this company’s futures positions/);
});

test('newer negative and annual positive evidence remain together with separately dated benchmark suggestions', async () => {
  const result = await harness(fixture({ newer: negative })).run();
  const evidence = result.rows[0].evidence;
  assert.equal(evidence[0].text, negative);
  assert.equal(evidence[0].disclosureDirection, 'qualifying-or-negative');
  assert.equal(evidence[0].suggestedBenchmark, null);
  assert.equal(evidence[1].text, positive);
  assert.equal(evidence[1].suggestedBenchmark.contract, '085692');
  assert.equal(evidence[1].suggestedBenchmark.fit, 'proxy');
});

test('unsupported benchmarks stay unsupported and amount excerpts keep their economic meaning', async () => {
  const result = await harness(fixture({ text: 'Our crude oil production is sold under prices linked to Brent. Our SOFR swaps had a notional amount of $1.2 billion and hedge interest rate risk on debt.' })).run();
  const brent = result.rows.find(row => row.market === 'Brent crude oil');
  assert.equal(brent.evidence[0].suggestedBenchmark, null);
  assert.match(brent.benchmarkUnavailableReason, /Brent is not WTI/);
  const rates = result.rows.find(row => row.market === 'SOFR');
  assert.deepEqual(rates.evidence[0].amounts, [{ text: '$1.2 billion', kind: 'notional' }]);
  assert.equal(rates.evidence[0].suggestedBenchmark.contract, '134741');
  assert.match(result.limitations.join(' '), /not standardized or additive/);
});

test('matching company page cutoff is inherited and a different company page is not', async () => {
  const h = harness(fixture({ asOf: '2026-03-01' }), { context: { company: 'TEST', asOf: '2026-03-01' } });
  assert.equal((await h.run()).filingCutoff, '2026-03-01');
  assert.equal(h.calls[0].selection.asOf, '2026-03-01');
  const other = harness(fixture(), { context: { company: 'OTHER', asOf: '2026-03-01' } });
  assert.equal((await other.run()).filingCutoff, null);
});

test('wrong company or cutoff is rejected instead of returning the latest available map', async () => {
  for (const patch of [{ cik: '0000000002' }, { ticker: 'OTHER' }, { asOf: '2026-02-01' }]) {
    await assert.rejects(harness({ ...fixture(), ...patch }).run(), error => error.researchCode === 'SOURCE_IDENTITY_MISMATCH');
  }
  const h = harness();
  await assert.rejects(h.run({ asOf: '2026-02-30' }));
  assert.equal(h.calls.length, 0);
});

test('future or invalid source evidence does not leave an older positive exposure unqualified', async () => {
  for (const corrupt of ['future', 'url', 'binding']) {
    const value = fixture({ newer: negative, asOf: '2026-09-01' });
    if (corrupt === 'future') { value.sources[1].filed = '2026-10-01'; value.rows[0].evidence[0].filed = '2026-10-01'; }
    if (corrupt === 'url') { value.sources[1].url = 'https://example.com/filing.htm'; value.rows[0].evidence[0].url = 'https://example.com/filing.htm'; }
    if (corrupt === 'binding') value.rows[0].evidence[0].reportDate = '2025-12-31';
    const result = await harness(value).run({ asOf: '2026-09-01' });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.rows, []);
    assert.equal(result.coverage.omittedInvalidRows, 1);
  }
});

test('no match and partial coverage never establish absence of an exposure', async () => {
  const empty = await harness(fixture({ text: 'Our consolidated financial statements are prepared under the applicable accounting standards.' })).run();
  assert.equal(empty.sourceStatus, 'no_matches');
  assert.equal(empty.status, 'ready');
  assert.deepEqual(empty.rows, []);
  assert.match(empty.limitations.join(' '), /does not mean the company has no exposure/);
  const partial = fixture(); partial.status = 'partial'; partial.coverage.searchComplete = false; partial.coverage.filingsFailed = 1;
  const result = await harness(partial).run();
  assert.equal(result.sourceStatus, 'partial');
  assert.equal(result.coverage.searchComplete, false);
  assert.equal(result.coverage.filingsFailed, 1);
});

test('feature gate prevents all company exposure loading', async () => {
  const h = harness(undefined, { enabled: false });
  assert.equal((await h.run()).code, 'CFTC_DISABLED');
  assert.equal(h.calls.length, 0);
  assert.equal(h.sources.length, 0);
});

test('large maps omit complete rows, keep original passages unchanged and remain within chat payload bounds', async () => {
  const value = fixture({ newer: negative });
  value.rows = Array.from({ length: 50 }, (_, index) => ({ ...value.rows[0], id: `row-${index}`, marketLabel: `Copper ${index}` }));
  const result = await harness(value).run();
  assert.ok(result.rows.length > 0 && result.rows.length < 50);
  assert.equal(result.coverage.omittedBudgetRows, 50 - result.rows.length);
  for (const row of result.rows) assert.deepEqual(row.evidence.map(item => item.text), [negative, positive]);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 12000);
});
