import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { createPaidBankRiskBatchReader, paidBankRiskBatchSelection } from '../src/utils/x402BankRiskBatch.js';
import { X402_BANK_RISK_BATCH_SCHEMA, X402_BANK_RISK_BATCH_DESCRIPTOR } from '../src/utils/x402BankRiskBatchSchema.js';
import { parseCallXbrl } from '../src/utils/bank/parser.js';
import { normalizeBankReport, validateBankReport, bankMetricDefinitions } from '../src/utils/bank/normalization.js';
import { isBankReadResult } from '../src/utils/bank/readResult.js';

const NOW = Date.parse('2026-10-05T04:00:00Z'), PERIOD = '2026-06-30', PRIOR = '2026-03-31';
const JPM = 852218, BOA = 480228, ALLIANCE = 493741;
const publicKeys = ['key', 'form', 'item', 'rssd', 'unit', 'basis', 'codes', 'group', 'label', 'value', 'period', 'reason', 'status', 'formula', 'schedule', 'startDate', 'reportDate', 'mappingVersion', 'capitalFramework'];
function report(rssd = JPM, form = '031') {
  const xml = readFileSync(new URL(`./fixtures/bank-${rssd}-${PERIOD}.xml`, import.meta.url), 'utf8');
  const parsed = parseCallXbrl(xml, { rssd, reportDate: PERIOD }), normalized = normalizeBankReport(parsed, { form, ingestedAt: '2026-10-03T12:00:00Z' });
  assert.equal(normalized.validation.passed, true);
  return { id_rssd: rssd, report_date: PERIOD, form_type: form, source_sha256: parsed.sha256, retrieved_at: '2026-10-03T12:00:00Z',
    submission_date_raw: '08/14/2026 8:00 PM', validation: normalized.validation,
    metrics: normalized.metrics.map(metric => Object.fromEntries(publicKeys.map(key => [key, metric[key] ?? null]))),
    source_metadata: { credentials: 'do-not-expose', privateKey: 'do-not-expose' } };
}
function historical(current) {
  const previous = structuredClone(current); previous.report_date = PRIOR; previous.source_sha256 = 'a'.repeat(64);
  previous.metrics.forEach(metric => {
    metric.reportDate = PRIOR;
    if (metric.unit === 'USD' && metric.value !== null) metric.value *= .8;
  });
  previous.validation = validateBankReport(previous.metrics, previous.validation.capitalFramework === 'CBLR');
  assert.equal(previous.validation.passed, true); return previous;
}
function fixture(records = [report(JPM), report(BOA)]) {
  return { banks: records.map(row => ({ id_rssd: row.id_rssd, legal_name: `Bank ${row.id_rssd}`, city: 'Example', state: 'IN', form_type: '041',
    available_periods: ['2026-09-30', PERIOD, PRIOR, '2025-12-31'] })), reports: [...records, ...records.map(historical)],
    periods: ['2026-09-30', PERIOD, PRIOR, '2025-12-31'], jobs: [], directoryAt: '2026-10-03T12:00:00Z',
    publicReadCache: { checkedAt: new Date(NOW - 1000).toISOString(), stale: false } };
}
const selected = (extra = '', ids = `${JPM},${BOA}`) => paidBankRiskBatchSelection({ url: `https://example.invalid/?rssds=${ids}&period=${PERIOD}${extra}` }, NOW);
const reader = data => createPaidBankRiskBatchReader({ bankRead: async () => data, now: () => NOW });
function parseCsv(csv) {
  const rows = [], row = []; let value = '', quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') { if (quoted && csv[index + 1] === '"') { value += '"'; index++; } else quoted = !quoted; }
    else if (!quoted && (char === ',' || char === '\r' && csv[index + 1] === '\n')) {
      row.push(value); value = '';
      if (char === '\r') { rows.push([...row]); row.length = 0; index++; }
    } else value += char;
  }
  assert.equal(quoted, false);
  return rows.slice(1).map(values => Object.fromEntries(rows[0].map((key, index) => [key, values[index]])));
}

test('strict selection requires one common reporting quarter and bounded unique legal-bank identifiers', async () => {
  for (const url of ['?rssds=852218', '?rssds=0&period=2026-06-30', '?rssds=0852218&period=2026-06-30', '?rssds=852218,852218&period=2026-06-30',
    '?rssds=1,2,3,4,5&period=2026-06-30', '?rssds=852218&period=2026-06-31', '?rssds=852218&period=2027-03-31']) {
    assert.equal(paidBankRiskBatchSelection({ url: `https://example.invalid/${url}` }, NOW), null);
  }
  for (const extra of ['&format=xml', '&comparison=year', '&period=2026-03-31', '&refresh=1', '&snapshot=a', '&format=']) assert.equal(selected(extra), null);
  let reads = 0;
  const read = createPaidBankRiskBatchReader({ bankRead: async () => { reads++; }, now: () => NOW });
  assert.equal((await read({ rssds: [JPM], period: '2026-06-31' })).status, 400); assert.equal(reads, 0);
  assert.deepEqual(selected().rssds, [BOA, JPM]); assert.equal(selected().comparison, 'previous');
  assert.equal(X402_BANK_RISK_BATCH_DESCRIPTOR.tags.length <= 5, true);
});

test('real FFIEC fixture values retain full USD, percentage levels, scopes and explicit ratio denominators', async () => {
  const data = fixture(); assert.equal(isBankReadResult(data, [BOA, JPM]), true);
  const calls = [], read = createPaidBankRiskBatchReader({ bankRead: async request => { calls.push(request); return data; }, now: () => NOW });
  const response = await read(selected()), payload = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(calls, [{ rssds: [BOA, JPM] }]);
  assert.equal(payload.bankCount, 2); assert.equal(payload.banks[0].metrics.length, 15);
  const bank = payload.banks.find(row => row.rssd === JPM), metrics = new Map(bank.metrics.map(metric => [metric.key, metric]));
  assert.equal(metrics.get('assets').current.value, 4091315000000); assert.equal(metrics.get('assets').current.unit, 'USD');
  assert.equal(metrics.get('assets').change.growthPercent, 25); assert.equal(metrics.get('assets').change.deltaUnit, 'USD');
  const raw = new Map(data.reports.find(row => row.id_rssd === JPM && row.report_date === PERIOD).metrics.map(metric => [metric.key, metric]));
  const credit = metrics.get('noncurrentLoansRatio');
  assert.equal(credit.current.value, (raw.get('past_due_90').value + raw.get('nonaccrual').value) / raw.get('loans').value * 100);
  assert.deepEqual(credit.current.sourceIds.map(id => bank.sourceCatalog[id].key), ['past_due_90', 'nonaccrual', 'loans']);
  const funding = metrics.get('brokeredDomesticDepositRatio');
  assert.equal(funding.current.value, raw.get('brokered_deposits').value / raw.get('domestic_deposits').value * 100);
  assert.ok(funding.current.sourceIds.every(id => bank.sourceCatalog[id].codes.every(code => code.startsWith('RCON'))));
  assert.equal(metrics.get('cet1Ratio').current.value, raw.get('cet1_ratio').value);
  assert.equal(metrics.get('cet1Ratio').change.deltaUnit, 'percentage-points'); assert.equal(metrics.get('cet1Ratio').change.growthPercent, null);
  const validate = new Ajv({ allErrors: true }).compile(X402_BANK_RISK_BATCH_SCHEMA);
  assert.equal(validate(payload), true, JSON.stringify(validate.errors));
  assert.equal(JSON.stringify(payload).includes('do-not-expose'), false);
});

test('source hashes pin report and metric-lineage links while directory form never overrides actual report form', async () => {
  const data = fixture([report(ALLIANCE, '051')]);
  const payload = await (await reader(data)(selected('', String(ALLIANCE)))).json(), bank = payload.banks[0];
  assert.equal(bank.currentReport.form, '051'); assert.match(bank.currentReport.formSource, /ffiec051$/);
  for (const source of bank.sourceCatalog) {
    assert.equal(new URL(source.sourceUrl).searchParams.get('hash'), source.sourceHash);
    assert.equal(new URL(source.sourceUrl).searchParams.get('metric'), source.key);
    assert.equal(new URL(source.sourceUrl).searchParams.get('rssd'), String(ALLIANCE));
    assert.equal(source.form, '051'); assert.match(source.formSource, /ffiec051$/);
  }
  const cet1 = bank.metrics.find(metric => metric.key === 'cet1Ratio');
  assert.equal(cet1.current.value, null); assert.equal(cet1.current.status, 'not_applicable'); assert.match(cet1.current.reason, /not_required_under_cblr/);
  assert.equal(bank.currentReport.validation.capitalFramework, 'CBLR');
});

test('a missing or invalid current bank aborts the full batch; known validation flags must reconcile with the metrics', async () => {
  const mutations = [
    data => { data.reports = data.reports.filter(row => !(row.id_rssd === BOA && row.report_date === PERIOD)); },
    data => { data.reports[1].id_rssd = 42; },
    data => { data.reports[1].metrics[0].rssd = JPM; },
    data => { data.reports[1].source_sha256 = 'invalid'; },
    data => { data.reports[1].validation.passed = false; },
    data => { data.reports[1].metrics.find(metric => metric.key === 'assets').value += 10000; },
    data => { data.reports[1].metrics.find(metric => metric.key === 'assets').unit = 'USD thousands'; },
    data => { data.reports[1].metrics.find(metric => metric.key === 'assets').codes = ['RCON2170']; },
    data => { data.reports[1].metrics.find(metric => metric.key === 'assets').mappingVersion = 'stale-version'; },
    data => { data.reports[1].validation.checks[0].inputs.privateNote = 1; },
    data => { data.reports[1].retrieved_at = '2030-01-01T00:00:00Z'; },
  ];
  for (const mutate of mutations) {
    const data = fixture(); mutate(data); const response = await reader(data)(selected());
    assert.equal(response.status, 503); const body = await response.json(); assert.equal(body.code, 'DATA_NOT_PREPARED'); assert.equal('banks' in body, false);
  }
  const data = fixture();
  const unavailable = paidBankRiskBatchSelection({ url: 'https://example.invalid/?rssds=852218,480228&period=2026-09-30' }, NOW);
  assert.equal((await reader(data)(unavailable)).status, 503, 'Directory latest-quarter placeholders are not complete prepared data');
});

test('zero and missing ratio components stay unavailable while reported zero observations remain zero', async () => {
  const data = fixture([report(JPM)]), current = data.reports[0];
  current.metrics.find(metric => metric.key === 'deposits').value = 0;
  const brokered = current.metrics.find(metric => metric.key === 'brokered_deposits');
  Object.assign(brokered, { value: null, status: 'unavailable', reason: 'reported_nil' });
  current.validation = validateBankReport(current.metrics, false);
  const payload = await (await reader(data)(selected('', String(JPM)))).json(), metrics = payload.banks[0].metrics;
  assert.equal(metrics.find(metric => metric.key === 'deposits').current.value, 0);
  assert.equal(metrics.find(metric => metric.key === 'loansDepositsRatio').current.value, null);
  assert.equal(metrics.find(metric => metric.key === 'loansDepositsRatio').current.reason, 'nonpositive_denominator');
  assert.equal(metrics.find(metric => metric.key === 'brokeredDomesticDepositRatio').current.value, null);
  assert.match(metrics.find(metric => metric.key === 'brokeredDomesticDepositRatio').current.reason, /reported_nil/);
});

test('only the consecutive same-bank prior quarter is used; missing history never becomes a zero baseline', async () => {
  const data = fixture(); data.reports = data.reports.filter(row => !(row.id_rssd === JPM && row.report_date === PRIOR));
  const response = await reader(data)(selected()), payload = await response.json(); assert.equal(response.status, 200);
  const missing = payload.banks.find(bank => bank.rssd === JPM); assert.equal(missing.priorReport, null);
  assert.equal(missing.metrics[0].prior, null); assert.equal(missing.metrics[0].change.comparable, false); assert.equal(missing.metrics[0].change.absoluteDelta, null);
  assert.equal(payload.banks.find(bank => bank.rssd === BOA).priorReport.reportDate, PRIOR);
  const currentOnly = await (await reader(fixture())(selected('&comparison=none'))).json();
  assert.ok(currentOnly.banks.every(bank => bank.priorUnavailableReason === 'comparison_not_requested' && bank.sourceCatalog.length === 15));
});

test('reported scope changes withhold quarter changes without suppressing valid current evidence', async () => {
  const data = fixture([report(JPM)]), before = data.reports[1];
  // A domestic-only prior form can be valid while its consolidated input scope
  // differs from the current form 031. Definition-owned text itself cannot vary.
  before.form_type = '041';
  for (const definition of bankMetricDefinitions('041')) {
    const metric = before.metrics.find(value => value.key === definition.key);
    for (const key of ['label', 'basis', 'schedule', 'item', 'codes']) metric[key] = structuredClone(definition[key]);
    metric.form = '041'; metric.formula = definition.operation === 'sum' ? definition.codes.join(' + ') : null;
    if (definition.notApplicable) Object.assign(metric, { value: null, status: 'not_applicable', reason: definition.notApplicable });
    else if (metric.value !== null) metric.status = definition.operation === 'sum' ? 'calculated' : 'reported';
  }
  before.validation = validateBankReport(before.metrics, false);
  assert.equal(before.validation.passed, true);
  const response = await reader(data)(selected('', String(JPM))), bank = (await response.json()).banks[0];
  assert.equal(response.status, 200); const metric = bank.metrics.find(metric => metric.key === 'loansDepositsRatio');
  assert.equal(metric.change.comparable, false); assert.match(metric.change.reason, /scope/); assert.ok(metric.current.value > 0);
  assert.equal(bank.metrics.find(metric => metric.key === 'brokeredDomesticDepositRatio').change.comparable, true);
});

test('definition-owned evidence and CBLR absence cannot be replaced by apparently valid metadata', async () => {
  for (const key of ['label', 'basis', 'schedule', 'item', 'formula']) {
    const data = fixture([report(JPM)]);
    data.reports[0].metrics.find(metric => metric.key === 'assets')[key] = 'corrupted source definition';
    assert.equal((await reader(data)(selected('', String(JPM)))).status, 503, key);
  }
  for (const key of ['rwa', 'total_capital', 'cet1_ratio', 'tier1_ratio', 'total_capital_ratio']) {
    const data = fixture([report(ALLIANCE, '051')]);
    Object.assign(data.reports[0].metrics.find(metric => metric.key === key), { value: 1, status: 'reported', reason: null });
    assert.equal((await reader(data)(selected('', String(ALLIANCE)))).status, 503, `CBLR ${key}`);
  }
  const domestic = fixture([report(ALLIANCE, '051')]);
  Object.assign(domestic.reports[0].metrics.find(metric => metric.key === 'foreign_deposits'), { value: 0, status: 'reported', reason: null });
  assert.equal((await reader(domestic)(selected('', String(ALLIANCE)))).status, 503);
});

test('negative balance inputs are withheld even when legacy reconciliation checks pass', async () => {
  for (const key of ['nonaccrual', 'past_due_90', 'domestic_deposits', 'brokered_deposits', 'cash', 'fhlb_advances']) {
    const data = fixture([report(JPM)]), current = data.reports[0];
    current.metrics.find(metric => metric.key === key).value = -1;
    current.validation = validateBankReport(current.metrics, false);
    assert.equal(current.validation.passed, true, 'Corruption can escape the upstream arithmetic-only checks');
    assert.equal((await reader(data)(selected('', String(JPM)))).status, 503, key);
  }
});

test('fingerprints bind amended values and source hashes, but prepared-cache checks alone do not restart a snapshot', async () => {
  const data = fixture([report(JPM)]), read = reader(data), request = selected('', String(JPM));
  const first = await (await read(request)).json();
  data.publicReadCache.checkedAt = new Date(NOW - 500).toISOString();
  const same = await (await read({ ...request, snapshot: first.snapshot })).json(); assert.equal(same.snapshot, first.snapshot);
  data.reports[0].source_sha256 = 'b'.repeat(64);
  assert.equal((await read({ ...request, snapshot: first.snapshot })).status, 409);
  const next = await (await read(request)).json(); assert.notEqual(next.snapshot, first.snapshot);
  data.reports[0].metrics.find(metric => metric.key === 'brokered_deposits').value += 1;
  assert.equal((await read({ ...request, snapshot: next.snapshot })).status, 409, 'A normalization correction with an unchanged raw-source hash is still a different snapshot');
});

test('retained store freshness is separate from original source retrieval and cannot be silently renewed', async () => {
  const data = fixture([report(JPM)]), checkedAt = new Date(NOW - 300001).toISOString(); data.publicReadCache = { checkedAt, stale: true };
  const response = await reader(data)(selected('', String(JPM))), payload = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Data-Stale'), '1'); assert.equal(payload.checkedAt, checkedAt);
  assert.equal(payload.banks[0].currentReport.retrievedAt, '2026-10-03T12:00:00Z');
  data.publicReadCache.checkedAt = new Date(NOW - 6 * 3600000 - 1).toISOString();
  assert.equal((await reader(data)(selected('', String(JPM)))).status, 503);
});

test('CSV preserves denominator evidence, reported source hashes and spreadsheet-safe names', async () => {
  const data = fixture([report(JPM)]); data.banks[0].legal_name = '=HYPERLINK("bad"), bank\nname';
  const response = await reader(data)(selected('&format=csv', String(JPM))), rows = parseCsv(await response.text());
  assert.equal(response.status, 200); assert.equal(rows.length, 15); assert.equal(rows[0].name, '\'=HYPERLINK("bad"), bank\nname');
  const ratio = rows.find(row => row.metric === 'brokeredDomesticDepositRatio');
  const sources = JSON.parse(ratio.currentSourceReferences); assert.deepEqual(sources.map(source => source.key), ['brokered_deposits', 'domestic_deposits']);
  assert.ok(sources.every(source => source.codes.every(code => code.startsWith('RCON'))));
  assert.equal(JSON.parse(ratio.currentReport).sourceHash, data.reports[0].source_sha256);
  assert.equal(rows.find(row => row.metric === 'cet1Ratio').deltaUnit, 'percentage-points');
  assert.match(response.headers.get('Content-Disposition'), /bank-risk-batch\.csv/);
});
