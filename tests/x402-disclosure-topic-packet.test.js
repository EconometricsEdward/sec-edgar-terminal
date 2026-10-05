import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import Ajv from 'ajv';
import { createPaidDisclosureTopicPacketReader, paidDisclosureTopicPacketSelection } from '../src/utils/x402DisclosureTopicPacket.js';
import { X402_DISCLOSURE_TOPIC_PACKET_SCHEMA, X402_DISCLOSURE_TOPIC_PACKET_DESCRIPTOR, X402_DISCLOSURE_PACKET_TOPICS } from '../src/utils/x402DisclosureTopicPacketSchema.js';
import { parseDisclosureQuery } from '../src/utils/disclosureQuery.js';
import { createPaidHandler, getX402Config, X402_SOLANA_NETWORK, X402_SOLANA_USDC } from '../src/utils/x402Payments.js';

const NOW = Date.parse('2026-10-04T20:00:00Z'), CIK = '0000019617';
const select = (parameters = {}, clock = NOW) => paidDisclosureTopicPacketSelection({ url: `https://example.invalid/api/x402/v1/disclosure-topic-packet?${new URLSearchParams({ cik: CIK, ...parameters })}` }, { now: clock });
const coverage = { documents: 79, passages: 11501, retentionDays: 730, oldestFilingDate: '2025-01-08', newestFilingDate: '2026-10-02', lastIndexedAt: '2026-10-03T04:01:46.269814+00:00' };
function candidate(text = 'Liquidity remains sufficient; no covenant breach or additional collateral requirement was identified.', index = 0, overrides = {}) {
  return { cik: CIK, ticker: 'JPM', companyName: 'JPMORGAN CHASE & CO', accession: '0001628280-26-008131', primaryDoc: 'jpm-20251231.htm',
    form: '10-K', filingDate: '2026-02-13', parserVersion: 1, sourceRetrievedAt: '2026-09-15T07:34:48.025Z', indexedAt: '2026-09-15T07:34:49.68044+00:00',
    textHash: 'a'.repeat(64), indexedPassages: 180, totalPassages: 26658, complete: false, privateField: 'do-not-deliver', sourceUrl: 'https://private.invalid/secret',
    passage: { index, sectionId: 'notes', section: 'Financial statement notes', text }, ...overrides };
}
const searchResult = (rows, extra = {}) => ({ coverage, results: rows, hasMore: false, ...extra });
const reader = (rows = [candidate()], options = {}) => createPaidDisclosureTopicPacketReader({ now: () => NOW, search: async () => searchResult(rows), ...options });
const validate = new Ajv({ allErrors: true }).compile(X402_DISCLOSURE_TOPIC_PACKET_SCHEMA);

test('strict selectors use one exact issuer and canonical bounded literal topics', async () => {
  assert.deepEqual(select(), { cik: CIK, topics: ['liquidity', 'covenants', 'collateral'], start: '2024-10-04', end: '2026-10-04', format: 'json' });
  assert.deepEqual(select({ topics: 'collateral,liquidity' }).topics, ['liquidity', 'collateral']);
  for (const params of [{ cik: 'JPM' }, { cik: '19617' }, { cik: '0000000000' }, { cik: `${CIK},0000320193` }, { topics: '' },
    { topics: 'liquidity,liquidity' }, { topics: 'Liquidity' }, { topics: 'liquidity,covenants,collateral,customer-concentration' },
    { topics: 'bank-funding' }, { start: '2024-10-03' }, { end: '2026-10-05' }, { start: '2026-02-30' }, { format: 'xml' }, { offset: '1' }, { query: 'debt' }]) assert.equal(select(params), null, JSON.stringify(params));
  assert.equal(paidDisclosureTopicPacketSelection({ url: `https://example.invalid/?cik=${CIK}&topics=liquidity&topics=collateral` }), null);
  let reads = 0;
  const read = reader([], { search: async () => { reads++; return searchResult([]); } });
  assert.equal((await read({ ...select(), source: 'SEC' })).status, 400); assert.equal(reads, 0);
  for (const topic of X402_DISCLOSURE_PACKET_TOPICS) assert.ok(parseDisclosureQuery(topic.query).positive.length <= 16);
  assert.equal(new Ajv().compile(X402_DISCLOSURE_TOPIC_PACKET_DESCRIPTOR.inputSchema)(X402_DISCLOSURE_TOPIC_PACKET_DESCRIPTOR.input), true);
  assert.ok(X402_DISCLOSURE_TOPIC_PACKET_DESCRIPTOR.tags.length <= 5);
});

test('packet groups exact evidence by topic, filing and section and deduplicates shared full paragraphs', async () => {
  const text = `There is no covenant breach. ${'The qualification remains attached to this disclosure. '.repeat(35)} Liquidity remains adequate and collateral is unchanged.`;
  const calls = [], read = reader([candidate(text, 6587)], { search: async (settings, options) => {
    calls.push(settings); assert.ok(options.signal instanceof AbortSignal); return searchResult([candidate(text, 6587)]);
  } });
  const response = await read(select()), payload = await response.json();
  assert.equal(response.status, 200); assert.equal(payload.status, 'ready');
  assert.equal(validate(payload), true, JSON.stringify(validate.errors));
  assert.equal(payload.sourceCatalog.length, 1); assert.equal(payload.evidenceCatalog.length, 1);
  assert.equal(payload.evidenceCatalog[0].quote, text); assert.equal(payload.evidenceCatalog[0].index, 6587);
  assert.equal(payload.evidenceCatalog[0].fingerprint, createHash('sha256').update(text).digest('hex'));
  assert.equal(payload.topics.length, 3);
  for (const topic of payload.topics) {
    assert.equal(topic.status, 'matched'); assert.equal(topic.coverage.documents, 79);
    assert.deepEqual(topic.filings[0].sections[0].evidenceRefs, [payload.evidenceCatalog[0].id]);
    assert.equal(topic.filings[0].sourceRef, payload.sourceCatalog[0].id);
  }
  assert.equal(payload.sourceCatalog[0].documentComplete, false);
  assert.equal(payload.sourceCatalog[0].sourceUrl, 'https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm');
  assert.doesNotMatch(JSON.stringify(payload), /do-not-deliver|private\.invalid|privateField|"score"|"rank"/);
  assert.ok(calls.every(settings => settings.limit === 120 && settings.offset === 0 && settings.section === 'all' && JSON.stringify(settings.ciks) === JSON.stringify([CIK])));
});

test('at most five paragraphs per topic remain explicit bounded evidence', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => candidate('Liquidity is sufficient.', i));
  const response = await reader(rows)(select({ topics: 'liquidity' })), payload = await response.json();
  assert.equal(response.status, 200); assert.equal(payload.evidenceCatalog.length, 5);
  const checked = payload.topics[0].candidateCoverage;
  assert.equal(checked.rawCandidatesReturned, 120); assert.equal(checked.rawCandidatesScanned, 5);
  assert.equal(checked.verifiedReturned, 5); assert.equal(checked.hasMore, true); assert.equal(checked.nextOffset, 5);
  assert.equal(validate(payload), true, JSON.stringify(validate.errors));
});

test('unmatched topics retain coverage without absence conclusions and an all-empty packet is 404', async () => {
  const response = await reader([candidate('Liquidity remains adequate.')])(select()), payload = await response.json();
  assert.equal(response.status, 200); assert.equal(payload.status, 'partial');
  assert.deepEqual(payload.topics.map(topic => topic.status), ['matched', 'no-retained-match', 'no-retained-match']);
  assert.equal(payload.topics[1].coverage.indexedPassages, 11501);
  assert.equal(payload.topics[1].candidateCoverage.verifiedReturned, 0); assert.deepEqual(payload.topics[1].filings, []);
  assert.equal(validate(payload), true, JSON.stringify(validate.errors));
  const noMatch = await reader([candidate('Revenue increased.')])(select());
  assert.equal(noMatch.status, 404); const missing = await noMatch.json();
  assert.equal(missing.code, 'NO_MATCHING_EVIDENCE'); assert.equal(missing.topics.length, 3);
  assert.ok(missing.topics.every(topic => topic.status === 'no-retained-match'));
  assert.equal((await reader([])(select())).status, 404);
});

test('corrupt or missing topic data fails the entire packet without leaking other paid evidence', async () => {
  for (const bad of [null, searchResult([candidate('Collateral remains sufficient.', 1, { parserVersion: 2 })]),
    searchResult([candidate('Collateral remains sufficient.', 1, { cik: '0000320193' })]),
    searchResult([candidate('Collateral remains sufficient.', 1, { sourceRetrievedAt: '2026-10-05T00:00:00Z' })])]) {
    const read = reader([], { search: async settings => settings.terms.includes('liquidity') ? searchResult([candidate('Liquidity has paid evidence.')]) : bad });
    const response = await read(select({ topics: 'liquidity,collateral' }));
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /Liquidity has paid evidence/);
  }
  const read = reader([], { search: async () => { throw new Error('private-credentials'); } });
  const response = await read(select()); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-credentials/);
});

test('different generations or paragraphs for one retained source cannot be combined across topics', async () => {
  for (const altered of [candidate(undefined, 0, { textHash: 'b'.repeat(64) }), candidate('Different liquidity, covenant and collateral paragraph.', 0)]) {
    const read = reader([], { search: async settings => searchResult([settings.terms.includes('liquidity') ? candidate() : altered]) });
    assert.equal((await read(select({ topics: 'liquidity,collateral' }))).status, 503);
  }
});

test('data version ignores request clock and export format but changes with selection or source evidence', async () => {
  let clock = NOW, rows = [candidate()];
  const read = reader([], { now: () => clock, search: async () => searchResult(rows) });
  const first = await (await read(select())).json();
  clock += 1000;
  const second = await (await read(select())).json();
  assert.notEqual(first.generatedAt, second.generatedAt); assert.equal(first.snapshot, second.snapshot); assert.match(first.snapshot, /^[a-f0-9]{64}$/);
  const reordered = await (await read(select({ topics: 'collateral,covenants,liquidity' }))).json();
  assert.equal(first.snapshot, reordered.snapshot);
  const csv = await (await read(select({ format: 'csv' }))).text(); assert.ok(csv.includes(first.snapshot));
  const one = await (await read(select({ topics: 'liquidity' }))).json(); assert.notEqual(one.snapshot, first.snapshot);
  rows = [candidate('Liquidity is adequate, covenants have not been breached, and collateral is sufficient.')];
  const changed = await (await read(select())).json(); assert.notEqual(changed.snapshot, first.snapshot);
});

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\r' && text[i + 1] === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += char;
  }
  return rows;
}
test('CSV carries exact qualifications, references, source coverage and unmatched topic rows safely', async () => {
  const quote = '=Liquidity("adequate")\nThere is no covenant breach.';
  const read = reader([candidate(quote, 4, { companyName: '@Issuer' })]);
  const json = await (await read(select())).json(), response = await read(select({ format: 'csv' }));
  assert.equal(response.status, 200); assert.match(response.headers.get('Content-Type'), /text\/csv/);
  const [columns, ...values] = parseCsv(await response.text());
  const rows = values.map(row => Object.fromEntries(columns.map((key, index) => [key, row[index]])));
  assert.equal(rows.length, 3); assert.equal(rows[0].quote, `'${quote}`); assert.equal(rows[0].companyName, "'@Issuer");
  assert.equal(rows[0].fingerprint, json.evidenceCatalog[0].fingerprint); assert.equal(rows[0].snapshot, json.snapshot);
  assert.equal(rows[0].sourceRef, json.sourceCatalog[0].id); assert.equal(rows[0].evidenceRef, json.evidenceCatalog[0].id);
  assert.deepEqual(JSON.parse(rows[0].topicCoverage), json.topics[0].coverage);
  assert.equal(rows[2].topicStatus, 'no-retained-match'); assert.equal(rows[2].quote, '');
  assert.doesNotMatch(JSON.stringify(rows), /private\.invalid|do-not-deliver/);
});

test('paid handler never settles an empty or atomically failed topic packet', async () => {
  // Fixed public identities and dummy in-memory signatures; local mocked RPC
  // only. No wallet keys are created/read and nothing is submitted to a chain.
  const [{ getBase58Decoder }, { TOKEN_PROGRAM_ADDRESS }, { x402Client }, { ExactSvmScheme }] = await Promise.all([
    import('@solana/kit'), import('@solana-program/token'), import('@x402/core/client'), import('@x402/svm/exact/client'),
  ]);
  const base58 = getBase58Decoder(), buyerAddress = base58.decode(new Uint8Array(32).fill(17)), feePayer = base58.decode(new Uint8Array(32).fill(18));
  const signer = { address: buyerAddress, signTransactions: async transactions => transactions.map(() => ({ [buyerAddress]: new Uint8Array(64).fill(1) })) };
  const rpc = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); let result;
    if (input.method === 'getAccountInfo') {
      assert.equal(input.params[0], X402_SOLANA_USDC); const data = Buffer.alloc(82); data[44] = 6; data[45] = 1;
      result = { context: { slot: 1 }, value: { data: [data.toString('base64'), 'base64'], executable: false, lamports: 1, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 } };
    } else { assert.equal(input.method, 'getLatestBlockhash'); result = { context: { slot: 1 }, value: { blockhash: base58.decode(new Uint8Array(32).fill(9)), lastValidBlockHeight: 100 } }; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  try {
    for (const [read, expectedStatus] of [[reader([]), 404], [reader([], { search: async () => null }), 503]]) {
      let verifies = 0, settles = 0, reads = 0; const finishes = [];
      const paid = createPaidHandler(async () => { reads++; return read(select()); }, {
        config: getX402Config({ NODE_ENV: 'test', X402_PAY_TO: '5qe4MpMXzT6TeaUNZz7ApAzoQzTGpVWbz1VBGbGhrdiR' }),
        facilitatorClient: {
          getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: X402_SOLANA_NETWORK, extra: { feePayer } }], extensions: [], signers: {} }),
          verify: async () => { verifies++; return { isValid: true, payer: buyerAddress }; },
          settle: async () => { settles++; throw new Error('Empty evidence must never settle'); },
        },
        ledger: { ready: () => true, claim: async () => ({ claimed: true, token: {} }), finish: async value => { finishes.push(value); } },
      });
      const url = `https://example.invalid/api/x402/v1/disclosure-topic-packet?cik=${CIK}`;
      const offer = await paid(new Request(url)); assert.equal(offer.status, 402);
      const required = JSON.parse(Buffer.from(offer.headers.get('PAYMENT-REQUIRED'), 'base64').toString('utf8'));
      const client = new x402Client().register(X402_SOLANA_NETWORK, new ExactSvmScheme(signer, { rpcUrl: `http://127.0.0.1:${rpc.address().port}` }));
      const proof = await client.createPaymentPayload(required);
      const response = await paid(new Request(url, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(proof)).toString('base64') } }));
      assert.equal(response.status, expectedStatus); assert.equal(verifies, 1); assert.equal(reads, 1); assert.equal(settles, 0);
      assert.equal(finishes.at(-1).status, 'handler_failed'); assert.equal(finishes.at(-1).errorCode, `resource_status_${expectedStatus}`);
    }
  } finally { rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve)); }
});

test('route uses the paid factory and implementation only reuses retained exact evidence', () => {
  const source = readFileSync(new URL('../src/utils/x402DisclosureTopicPacket.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|tickerMap|indexDisclosureText|loadRiskTimeline/);
  const route = readFileSync(new URL('../src/app/api/x402/v1/disclosure-topic-packet/route.js', import.meta.url), 'utf8');
  assert.match(route, /createPaidProductRoute\('disclosure-topic-packet'/);
  assert.match(route, /select: paidDisclosureTopicPacketSelection, read: paidDisclosureTopicPacketReader/);
});
