import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOwnershipRequest, ownershipCompanyTarget, projectCompanyOwnership } from '../src/utils/companyOwnership.js';
import { createCompanyOwnershipReader } from '../src/utils/companyOwnershipServer.js';

const NOW = Date.parse('2026-09-18T05:00:00Z'), checkedAt = '2026-09-18T04:30:00Z';
const target = { name: 'Apple Inc.', cik: '0000320193', aliases: ['AAPL'], nameMatchAllowed: true };
const stock = { id: 1, name: 'Apple Inc', title: 'APPLE INC', cusip: '037833100', tickerSymbol: null,
  assetCat: 'EC', payoffProfile: 'Long', balance: 20, units: 'NS', value: 200, pctOfNav: 20 };
function fund(overrides = {}) {
  return { id: 'VOO', name: 'Vanguard', data: { ticker: 'VOO', status: 'ready', name: 'Vanguard 500 Index Fund', cik: '0000036405',
    seriesId: 'S000002839', accession: '0000036405-26-000473', asOf: '2026-06-30', filingDate: '2026-08-28',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/36405/000003640526000473/primary_doc.xml',
    fundInfo: { netAssets: 1000 }, retrievedAt: checkedAt, cache: { checkedAt }, holdings: [stock], ...overrides } };
}
function manager(overrides = {}) {
  return { id: '0001067983', name: 'Berkshire', saved: { checkedAt, data: { status: 'ready',
    manager: { cik: '0001067983', name: 'BERKSHIRE HATHAWAY INC' }, coverage: { selectedPeriodComplete: true },
    portfolio: { complete: true, period: '2026-06-30', totalValueUsd: 10000, reportType: '13F HOLDINGS REPORT', confidentialOmitted: false,
      filings: [{ filingDate: '2026-08-14', form: '13F-HR', indexUrl: 'https://www.sec.gov/Archives/edgar/data/1067983/000095012326000123/0000950123-26-000123-index.html' }],
      holdings: [
        { cusip: '037833100', issuer: 'APPLE INC', classTitle: 'COM', quantity: 100, valueUsd: 1000, quantityType: 'SH', putCall: null },
        { cusip: '037833100', issuer: 'APPLE INC', classTitle: 'COM', quantity: 20, valueUsd: 200, quantityType: 'SH', putCall: 'PUT' },
        { cusip: '037833100', issuer: 'APPLE INC', classTitle: 'COM', quantity: 5, valueUsd: 50, quantityType: 'PRN', putCall: null },
      ], ...overrides } } } };
}
const project = (funds = [fund()], managers = [manager()], extra = {}) => projectCompanyOwnership({ ticker: 'AAPL', target, funds, managers, now: NOW, ...extra });

test('prepared ownership retains original dollar units, shares and complete separate denominators', () => {
  const data = project();
  assert.equal(data.funds[0].valueUsd, 200); assert.equal(data.funds[0].shares, 20); assert.equal(data.funds[0].weightPct, 20);
  assert.equal(data.managers[0].valueUsd, 1000); assert.equal(data.managers[0].shares, 100); assert.equal(data.managers[0].weightPct, 10);
  assert.equal(data.managers[0].denominatorUsd, 10000);
  assert.deepEqual(data.identity.cusips, ['037833100']);
  assert.equal(data.funds[0].denominatorLabel, 'fund net assets');
  assert.equal(data.managers[0].denominatorLabel, 'reported 13F holdings');
  assert.equal(data.totalValueUsd, undefined); assert.equal(data.managers[0].companyOwnershipPct, undefined);
});

test('common-equity ownership excludes options, principal, short, preferred and conflicting ticker records', () => {
  const data = project([fund({ holdings: [stock,
    { ...stock, id: 2, assetCat: 'DE', value: 500 },
    { ...stock, id: 3, payoffProfile: 'Short', value: -50 },
    { ...stock, id: 4, assetCat: 'EP', value: 400 },
    { ...stock, id: 5, tickerSymbol: 'WRONG', value: 300 },
  ] })]);
  assert.equal(data.funds[0].positions.length, 1); assert.equal(data.managers[0].positions.length, 1);
  assert.equal(data.managers[0].valueUsd, 1000);
});

test('missing input stays unavailable and N-PORT number-of-shares units are required', () => {
  const data = project([fund({ holdings: [stock, { ...stock, id: 2, value: null, pctOfNav: null, balance: 50, units: 'PA' }] })]);
  assert.equal(data.funds[0].valueUsd, null); assert.equal(data.funds[0].shares, null); assert.equal(data.funds[0].weightPct, null);
  const zero = project([fund({ holdings: [{ ...stock, value: 0, pctOfNav: 0, balance: 0 }] })]);
  assert.equal(zero.funds[0].valueUsd, 0); assert.equal(zero.funds[0].weightPct, 0);
});

test('same SEC series is counted once and newer available report wins', () => {
  const alias = fund({ ticker: 'VFIAX', asOf: '2026-03-31', holdings: [{ ...stock, value: 100 }] }); alias.id = 'VFIAX';
  const data = project([alias, fund()]);
  assert.equal(data.funds.length, 1); assert.equal(data.funds[0].valueUsd, 200); assert.equal(data.coverage.fundsAvailable, 1);
});

test('cutoff excludes later filings including an amendment chain, and incomplete reports cannot support weights', () => {
  const cutoff = project(undefined, undefined, { asOf: '2026-07-31' });
  assert.equal(cutoff.funds.length, 0); assert.equal(cutoff.managers.length, 0); assert.equal(cutoff.coverage.excludedAfterCutoff, 2);
  const amended = manager(); amended.saved.data.portfolio.filings.push({ ...amended.saved.data.portfolio.filings[0], filingDate: '2026-09-10' });
  assert.equal(project(undefined, [amended], { asOf: '2026-09-01' }).managers.length, 0);
  assert.equal(project(undefined, [manager({ complete: false })]).managers.length, 0);
});

test('company-wide classes remain distinct and names never substitute for a 13F CUSIP', () => {
  const alphabet = { name: 'Alphabet Inc.', cik: '0001652044', aliases: ['GOOG', 'GOOGL'], nameMatchAllowed: true };
  const classes = [ { ...stock, name: 'Alphabet Inc', title: 'Class A', cusip: '02079K305', tickerSymbol: 'GOOGL' },
    { ...stock, id: 2, name: 'Alphabet Inc', title: 'Class C', cusip: '02079K107', tickerSymbol: 'GOOG' } ];
  const data = project([fund({ holdings: classes })], [manager({ holdings: [{ cusip: '111111118', issuer: 'ALPHABET INC', putCall: null, quantityType: 'SH', quantity: 100, valueUsd: 1000 }] })], { target: alphabet, ticker: 'GOOG' });
  assert.equal(data.funds[0].positions.length, 2); assert.equal(data.managers.length, 0);
});

test('SEC jurisdiction suffix and legal endings normalize without fuzzy issuer matching', () => {
  const data = project([fund({ holdings: [{ ...stock, name: 'Bank of America Corp', cusip: '060505104' }] })], [],
    { ticker: 'BAC', target: { name: 'BANK OF AMERICA CORP /DE/', aliases: ['BAC'], nameMatchAllowed: true } });
  assert.equal(data.funds.length, 1); assert.deepEqual(data.identity.cusips, ['060505104']);
  const unrelated = project([fund({ holdings: [{ ...stock, name: 'Apple Hospitality REIT' }] })]);
  assert.equal(unrelated.funds.length, 0); assert.equal(unrelated.managers.length, 0);
});

test('distinct legal forms cannot cross-match OWL/OBDC or TTC/TORO and seed unrelated 13F positions', () => {
  const directory = {
    OWL: { name: 'Blue Owl Capital Inc.', cik: '0001823945' },
    OBDC: { name: 'Blue Owl Capital Corp', cik: '0001655888' },
    TTC: { name: 'TORO CO', cik: '0000737758' },
    TORO: { name: 'Toro Corp.', cik: '0001941131' },
  };
  for (const [symbol, wrongName] of [['OWL', 'Blue Owl Capital Corporation'], ['TTC', 'Toro Corp']]) {
    const result = project([fund({ holdings: [{ ...stock, name: wrongName }] })], [manager()],
      { ticker: symbol, target: ownershipCompanyTarget(symbol, directory) });
    assert.equal(result.funds.length, 0); assert.equal(result.managers.length, 0);
    assert.deepEqual(result.identity.cusips, []);
  }
  const correct = project([fund({ holdings: [{ ...stock, name: 'Blue Owl Capital Incorporated' }] })], [],
    { ticker: 'OWL', target: ownershipCompanyTarget('OWL', directory) });
  assert.equal(correct.funds.length, 1);
});

test('same legal names across distinct CIKs need a compatible explicit ticker and cannot seed from name alone', () => {
  const directory = {
    FBP: { name: 'FIRST BANCORP /PR/', cik: '0001057706' },
    FBNC: { name: 'FIRST BANCORP /NC/', cik: '0000811589' },
    FNLC: { name: 'FIRST BANCORP /ME/', cik: '0000765207' },
  };
  const selected = ownershipCompanyTarget('FBP', directory);
  assert.equal(selected.nameMatchAllowed, false);
  const ambiguous = project([fund({ holdings: [{ ...stock, name: 'First Bancorp' }] })], [manager()], { target: selected, ticker: 'FBP' });
  assert.equal(ambiguous.funds.length, 0); assert.deepEqual(ambiguous.identity.cusips, []); assert.equal(ambiguous.managers.length, 0);
  const explicit = project([fund({ holdings: [{ ...stock, name: 'First Bancorp', tickerSymbol: 'FBP' }] })], [], { target: selected, ticker: 'FBP' });
  assert.equal(explicit.funds.length, 1);
  const conflict = project([fund({ holdings: [{ ...stock, name: 'Apple Inc', tickerSymbol: 'FBP' }] })], [], { target: selected, ticker: 'FBP' });
  assert.equal(conflict.funds.length, 0);
});

test('multiple ticker classes of one CIK are one unambiguous issuer', () => {
  const directory = { GOOG: { name: 'Alphabet Inc.', cik: '0001652044' }, GOOGL: { name: 'Alphabet Inc.', cik: '0001652044' } };
  const selected = ownershipCompanyTarget('GOOG', directory);
  assert.equal(selected.nameMatchAllowed, true); assert.deepEqual(selected.aliases, ['GOOG', 'GOOGL']);
  const result = project([fund({ holdings: [
    { ...stock, name: 'Alphabet Inc.', cusip: '02079K107' },
    { ...stock, id: 2, name: 'Alphabet Inc.', cusip: '02079K305', tickerSymbol: 'GOOGL' },
  ] })], [], { target: selected, ticker: 'GOOG' });
  assert.equal(result.funds[0].positions.length, 2); assert.deepEqual(result.identity.cusips, ['02079K107', '02079K305']);
});

test('invalidated and stale snapshots retain original checked date', () => {
  const data = manager(); data.saved.invalidatedAt = '2026-09-18T04:45:00Z';
  const result = project([fund({ cache: { checkedAt: '2026-09-17T00:00:00Z' } })], [data]);
  assert.equal(result.funds[0].stale, true); assert.equal(result.managers[0].stale, true);
  assert.equal(result.checkedAt, '2026-09-17T00:00:00Z');
});

test('selectors reject future and invalid dates and arbitrary symbols', () => {
  assert.deepEqual(normalizeOwnershipRequest(' aapl ', '2026-09-17', NOW), { ticker: 'AAPL', asOf: '2026-09-17' });
  for (const value of ['2026-02-31', '2026-09-19', 'junk']) assert.throws(() => normalizeOwnershipRequest('AAPL', value, NOW));
  assert.throws(() => normalizeOwnershipRequest('../evil', '', NOW));
});

test('default ownership reads only prepared portfolios, coalesces results, and preserves unmatched vs unavailable coverage', async () => {
  let readCount = 0, preparations = 0;
  const reader = createCompanyOwnershipReader({ now: () => NOW, directory: async () => ({ AAPL: target }), funds: [{ id: 'VOO', name: 'Vanguard' }, { id: 'NOPE', name: 'Unavailable' }], managers: [{ id: '0001067983', name: 'Berkshire' }],
    readFund: async id => { readCount++; return id === 'VOO' ? fund().data : null; },
    readManager: async () => { readCount++; return manager().saved; },
    prepareFund: async () => { preparations++; }, prepareManager: async () => { preparations++; },
  });
  const [one, two] = await Promise.all([reader.read('AAPL'), reader.read('AAPL')]);
  assert.equal(one, two); assert.equal(readCount, 3); assert.equal(preparations, 0);
  assert.equal(one.funds.length, 1); assert.equal(one.managers.length, 1);
  assert.deepEqual(one.coverage.notPrepared.map(row => row.id), ['NOPE']);
  await reader.read('AAPL'); assert.equal(readCount, 3);
});

test('explicit preparation touches one allowed portfolio and refreshes projection without fanout', async () => {
  const prepared = [];
  const reader = createCompanyOwnershipReader({ now: () => NOW, directory: async () => ({ AAPL: target }), funds: [{ id: 'VOO', name: 'Vanguard' }], managers: [],
    readFund: async () => prepared.length ? fund().data : null,
    prepareFund: async id => { prepared.push(id); return fund().data; },
    prepareManager: async () => { throw new Error('unexpected manager acquisition'); },
  });
  assert.equal((await reader.read('AAPL')).funds.length, 0);
  const result = await reader.prepare('AAPL', { kind: 'fund', id: 'VOO' });
  assert.deepEqual(prepared, ['VOO']); assert.equal(result.funds.length, 1);
  await assert.rejects(reader.prepare('AAPL', { kind: 'fund', id: 'NOTALLOWED' }), RangeError);
  assert.deepEqual(prepared, ['VOO']);
});
