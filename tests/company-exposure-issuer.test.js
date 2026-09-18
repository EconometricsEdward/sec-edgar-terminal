import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCompanyExposureMap } from '../src/utils/companyExposure.js';

const filing = { url: 'https://www.sec.gov/Archives/edgar/data/753308/000075330826000060/nee-20260630.htm', accession: '0000753308-26-000060', form: '10-Q', filed: '2026-07-24', reportDate: '2026-06-30' };
const definition = 'DEFINITIONS\n\nAcronyms and defined terms used in the text include the following:\n\nTerm\n\nMeaning\n\nNEE\n\nNextEra Energy, Inc.\n\nNEECH\n\nNextEra Energy Capital Holdings, Inc.\n\nFPL\n\nFlorida Power & Light Company\n\nTABLE OF CONTENTS\n\n';
const extract = text => extractCompanyExposureMap([{ text, filing, role: 'quarterly' }], { companyName: 'NEXTERA ENERGY INC', ticker: 'NEE' });

test('an explicit issuer definition admits the issuer acronym without promoting tickers or subsidiaries', () => {
  const actual = 'NEE uses interest rate contracts and foreign currency contracts to mitigate and adjust interest rate and foreign currency exchange exposure related primarily to certain outstanding and expected future debt issuances and borrowings.';
  const result = extract(definition + actual);
  assert.ok(result.rows.some(row => row.id === 'borrowing:interest-rates'));
  assert.ok(result.rows.some(row => row.id === 'currencies:foreign-currencies'));
  assert.ok(result.rows.every(row => row.benchmark === null));
  assert.ok(result.rows.every(row => row.evidence.every(item => item.text === actual && item.accession === filing.accession)));
  assert.deepEqual(extract(actual).rows, [], 'Ticker alone is not issuer proof');
  assert.deepEqual(extract(definition + actual.replaceAll('NEE ', 'NEECH ')).rows, [], 'Subsidiary definition is not issuer proof');
  assert.deepEqual(extract(definition + 'FPL purchases natural gas to operate its generating facilities.').rows, []);
});

test('issuer definitions remain local to their source filing and exact legal entity', () => {
  const statement = 'NEE purchases natural gas for use at its generating facilities.';
  assert.deepEqual(extract(definition.replace('NextEra Energy, Inc.', 'NextEra Energy Capital Holdings, Inc.') + statement).rows, []);
  const result = extractCompanyExposureMap([
    { text: definition, filing: { ...filing, accession: 'annual', form: '10-K' }, role: 'annual' },
    { text: statement, filing, role: 'quarterly' },
  ], { companyName: 'NEXTERA ENERGY INC', ticker: 'NEE' });
  assert.deepEqual(result.rows, [], 'An annual definition is not silently applied to another filing');
});

test('issuer acronyms retain the same third-party and speculative-economy exclusions', () => {
  for (const statement of [
    "NEE's customers purchase natural gas to support their production operations.",
    'NEE expects global demand for natural gas production to increase significantly.',
  ]) assert.deepEqual(extract(definition + statement).rows, [], statement);
});

test('a portfolio of biogas projects is not a commodity holding or futures benchmark', () => {
  const statement = 'NextEra Energy Resources owns, or has a partial ownership interest in, a portfolio of 29 biogas projects, eight of which are operating renewable natural gas facilities and the others are primarily operating landfill gas-to-electric facilities.';
  assert.deepEqual(extract(statement).rows, []);
  const physical = extract('Our natural gas inventory is held alongside a portfolio of processing facilities for our operating activities.');
  assert.ok(physical.rows.some(row => row.id === 'investments:natural-gas'));
});

test('separate gas production and electricity purchases retain their distinct channels', () => {
  const statement = "NEE and FPL use derivative instruments to manage the physical and financial risks inherent in the purchase and sale of fuel and electricity, as well as interest rate risk associated with borrowings, and to optimize the value of NEER's power generation and natural gas production assets.";
  const insurance = 'Due to the high cost and limited coverage available from third-party insurers, NEE does not have property insurance coverage for a substantial portion of its natural gas pipeline assets.';
  const result = extract(definition + statement + '\n\n' + insurance);
  assert.ok(result.rows.some(row => row.id === 'revenue:natural-gas'));
  assert.ok(result.rows.some(row => row.id === 'revenue:electricity'));
  assert.ok(result.rows.some(row => row.id === 'input-costs:electricity'));
  assert.ok(!result.rows.some(row => row.id === 'input-costs:natural-gas'));
  assert.ok(result.rows.every(row => row.evidence.every(item => item.text !== insurance)));
});

test('construction procurement guarantees do not imply purchases of a pipeline commodity', () => {
  const statement = 'NEE subsidiaries issue guarantees related to equity contribution agreements and engineering, procurement and construction agreements, associated with the development, construction and financing of certain power generation facilities and a natural gas pipeline project, as well as a natural gas transportation agreement.';
  assert.deepEqual(extract(definition + statement).rows, []);
});
