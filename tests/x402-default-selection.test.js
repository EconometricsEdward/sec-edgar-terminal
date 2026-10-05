import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSigner, getBase58Decoder } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { x402Client } from '@x402/core/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createPaidProductRoute, resolvePaidProductSelection } from '../src/utils/x402ProductRoute.js';
import { X402_RESOURCES } from '../src/utils/x402Catalog.js';
import { paidProductSelection } from '../src/utils/x402Products.js';
import { paidFinancialChangesSelection } from '../src/utils/x402FinancialChanges.js';
import { paidDisclosureEvidenceSelection } from '../src/utils/x402DisclosureEvidence.js';
import { paidInstitutionalOverlapSelection } from '../src/utils/x402InstitutionalOverlap.js';
import { paidDisclosureTopicPacketSelection } from '../src/utils/x402DisclosureTopicPacket.js';
import { paidBankRiskBatchSelection } from '../src/utils/x402BankRiskBatch.js';
import { createPaidHandler, getX402Config, X402_SOLANA_NETWORK, X402_SOLANA_USDC } from '../src/utils/x402Payments.js';

const origin = 'https://secedgarterminal.com';
const now = Date.parse('2026-10-05T15:00:00Z');
const recipient = '5qe4MpMXzT6TeaUNZz7ApAzoQzTGpVWbz1VBGbGhrdiR';
const selectors = {
  'financial-batch': request => paidProductSelection(request, 'financial-batch'),
  'financial-changes': paidFinancialChangesSelection,
  'disclosure-evidence': request => paidDisclosureEvidenceSelection(request, { now: () => now }),
  'institutional-overlap': request => paidInstitutionalOverlapSelection(request, now),
  'disclosure-topic-packet': request => paidDisclosureTopicPacketSelection(request, { now: () => now }),
  'bank-risk-batch': request => paidBankRiskBatchSelection(request, now),
};
const resources = Object.keys(selectors).map(id => X402_RESOURCES.find(resource => resource.id === id));

// These ephemeral signatures are created and checked only against a localhost
// RPC fixture and mock facilitator. Nothing is submitted to Solana or PayAI.
const buyer = await generateKeyPairSigner();
let rpc;
let rpcUrl;
before(async () => {
  rpc = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    let result;
    if (input.method === 'getAccountInfo') {
      assert.equal(input.params[0], X402_SOLANA_USDC);
      const data = Buffer.alloc(82); data[44] = 6; data[45] = 1;
      result = { context: { slot: 1000 }, value: { data: [data.toString('base64'), 'base64'], executable: false,
        lamports: 1000000, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 } };
    } else if (input.method === 'getLatestBlockhash') {
      result = { context: { slot: 1000 }, value: { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(9)), lastValidBlockHeight: 2000 } };
    } else throw new Error(`Unexpected offline RPC method ${input.method}`);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
});
after(async () => { rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve)); });

test('six empty-query products resolve exactly their public catalog example through the existing real selector', () => {
  for (const resource of resources) {
    const select = selectors[resource.id];
    const request = new Request(`${origin}${resource.path}`);
    assert.equal(select(request), null, `${resource.id} selector itself remains strict`);
    const expected = select(new Request(new URL(resource.example, origin)));
    assert.ok(expected, `${resource.id} example must be a usable documented selection`);
    assert.deepEqual(resolvePaidProductSelection(request, resource.id, select), expected);
    assert.equal(request.url, `${origin}${resource.path}`);
    assert.equal(new URL(request.url).searchParams.size, 0);
    assert.equal(expected.format, 'json');
  }
});

test('the starter resolution changes only selector input and preserves the buyer request, origin, method and headers', () => {
  for (const method of ['GET', 'HEAD']) {
    const resource = resources[0];
    const url = `https://preview.example${resource.path}`;
    const request = new Request(url, { method, headers: { 'PAYMENT-SIGNATURE': 'opaque-buyer-proof', 'X-X402-Recovery-Token': 'opaque-capability' } });
    let calls = 0;
    const selection = resolvePaidProductSelection(request, resource.id, candidate => {
      calls++;
      assert.notEqual(candidate, request);
      assert.equal(candidate.url, new URL(resource.example, 'https://preview.example').href);
      assert.equal(candidate.method, method);
      assert.equal(candidate.headers.get('PAYMENT-SIGNATURE'), 'opaque-buyer-proof');
      return selectors[resource.id](candidate);
    });
    assert.equal(calls, 1);
    assert.deepEqual(selection.tickers, ['AAPL', 'MSFT']);
    assert.equal(request.url, url);
    assert.equal(request.headers.get('X-X402-Recovery-Token'), 'opaque-capability');
  }
});

test('any nonempty malformed, partial, empty or duplicate query stays invalid instead of receiving starter defaults', () => {
  for (const resource of resources) {
    const required = Object.keys(Object.fromEntries(new URL(resource.example, origin).searchParams))[0];
    const queries = ['?format=json', '?format=csv', '?unknown=1', `?${required}=`, '?format=json&format=csv'];
    for (const query of queries) {
      const request = new Request(`${origin}${resource.path}${query}`);
      assert.equal(resolvePaidProductSelection(request, resource.id, selectors[resource.id]), null, `${resource.id}${query}`);
    }
  }
});

test('explicit valid JSON and CSV queries keep their own selection and are passed unchanged to the selector', () => {
  for (const resource of resources) {
    for (const format of ['json', 'csv']) {
      const url = new URL(resource.example, origin);
      url.searchParams.set('format', format);
      const request = new Request(url);
      let seen;
      const selection = resolvePaidProductSelection(request, resource.id, candidate => { seen = candidate; return selectors[resource.id](candidate); });
      assert.equal(seen, request);
      assert.deepEqual(selection, selectors[resource.id](request));
      assert.equal(selection.format, format);
    }
  }
});

test('other products retain their existing empty-query behavior without receiving a starter example', () => {
  for (const kind of ['fundamental-screen', 'credit-screen']) {
    const request = new Request(`${origin}/api/x402/v1/${kind}`);
    assert.deepEqual(resolvePaidProductSelection(request, kind), paidProductSelection(request, kind));
  }
  const request = new Request(`${origin}/api/x402/v1/unrecognized`);
  let seen;
  assert.equal(resolvePaidProductSelection(request, 'unrecognized', candidate => { seen = candidate; return null; }), null);
  assert.equal(seen, request);
});

function routeFixture(resource, { validBuyer = false } = {}) {
  const state = { reads: 0, supported: 0, verifies: 0, settles: 0, claims: 0, requests: [], descriptions: [], readSelections: [], reservations: [], finishes: [] };
  const config = getX402Config({ NODE_ENV: 'production', X402_PAY_TO: recipient });
  const route = createPaidProductRoute(resource.id, null, 'Prepared selected research.', {
    select: selectors[resource.id],
    read: selection => { state.reads++; state.readSelections.push(selection); return Response.json({ error: 'DATA_NOT_PREPARED' }, { status: 503 }); },
    createHandler: (reader, options) => {
      state.descriptions.push(options.description);
      const paid = createPaidHandler(reader, {
        ...options, config,
        ledger: {
          ready: () => true,
          claim: input => { state.claims++; state.reservations.push(input); return { claimed: true, token: { paymentHash: input.paymentHash, owner: input.requestId } }; },
          finish: input => { state.finishes.push(input); },
        },
        facilitatorClient: {
          async getSupported() {
            state.supported++;
            return { kinds: [{ x402Version: 2, scheme: 'exact', network: X402_SOLANA_NETWORK, extra: { feePayer: recipient } }], extensions: ['bazaar'], signers: {} };
          },
          verify: async () => { state.verifies++; return validBuyer ? { isValid: true, payer: buyer.address }
            : { isValid: false, invalidReason: 'synthetic-invalid-proof' }; },
          settle: async () => { state.settles++; throw new Error('Must never settle test discovery'); },
        },
      });
      return (request, context) => { state.requests.push({ request, selection: context.selection }); return paid(request, context); };
    },
  });
  return { route, state };
}

test('bare GET offers are real SDK challenges bound to the original URL and truthfully describe the starter selection', async () => {
  for (const resource of resources) {
    const { route, state } = routeFixture(resource);
    const request = new Request(`${origin}${resource.path}`);
    const response = await route(request);
    assert.equal(response.status, 402);
    const offer = decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED'));
    assert.equal(offer.resource.url, request.url);
    assert.equal(offer.resource.mimeType, 'application/json');
    assert.ok(offer.resource.description.includes(resource.example));
    assert.match(offer.resource.description, /without query parameters.*starter selection/);
    assert.equal(offer.extensions.bazaar.info.input.method, 'GET');
    assert.equal(state.requests[0].request, request);
    assert.deepEqual(state.requests[0].selection, selectors[resource.id](new Request(new URL(resource.example, origin))));
    assert.equal(state.supported, 1);
    assert.equal(state.reads + state.verifies + state.settles + state.claims, 0);
  }
});

test('malformed explicit queries reject before buyer verification, source reads, ledger claims or settlement', async () => {
  for (const resource of resources) {
    const { route, state } = routeFixture(resource);
    for (const query of ['?format=json', '?unknown=1', '?format=json&format=csv']) {
      const response = await route(new Request(`${origin}${resource.path}${query}`, { headers: { 'PAYMENT-SIGNATURE': 'synthetic-proof' } }));
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('PAYMENT-REQUIRED'), null);
      assert.equal((await response.json()).code, 'INVALID_SELECTION');
    }
    assert.equal(state.descriptions.length, 0);
    assert.equal(state.requests.length, 0);
    assert.equal(state.supported + state.reads + state.verifies + state.settles + state.claims, 0);
  }
});

test('explicit and starter offer descriptions cannot contaminate one another through handler reuse', async () => {
  const resource = resources[0];
  const { route, state } = routeFixture(resource);
  for (const url of [resource.path, resource.example, resource.path, resource.example]) {
    const response = await route(new Request(new URL(url, origin)));
    assert.equal(response.status, 402);
    const offer = decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED'));
    if (url === resource.path) assert.match(offer.resource.description, /starter selection/);
    else assert.equal(offer.resource.description, 'Prepared selected research.');
  }
  assert.equal(state.descriptions.length, 2);
  assert.equal(state.supported, 2);
  assert.equal(state.reads + state.verifies + state.settles + state.claims, 0);
});

test('invalid buyer proof on the bare URL never accesses prepared data or settles the starter packet', async () => {
  const resource = resources[0];
  const { route, state } = routeFixture(resource);
  const url = `${origin}${resource.path}`;
  const offerResponse = await route(new Request(url));
  const offer = decodePaymentRequiredHeader(offerResponse.headers.get('PAYMENT-REQUIRED'));
  const payload = { x402Version: 2, resource: offer.resource, accepted: offer.accepts[0], extensions: offer.extensions, payload: { transaction: 'synthetic-unsigned-transaction' } };
  const response = await route(new Request(url, { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) } }));
  assert.equal(response.status, 402);
  assert.equal(state.verifies, 1);
  assert.equal(state.reads + state.claims + state.settles, 0);
  assert.equal(state.requests.at(-1).request.url, url);
});

test('valid offline buyer proof reads each exact starter and leaves unavailable data uncharged without switching datasets', async () => {
  const client = new x402Client().register(X402_SOLANA_NETWORK, new ExactSvmScheme(buyer, { rpcUrl }));
  for (const resource of resources) {
    const { route, state } = routeFixture(resource, { validBuyer: true });
    const url = `${origin}${resource.path}`;
    const offerResponse = await route(new Request(url));
    const offer = decodePaymentRequiredHeader(offerResponse.headers.get('PAYMENT-REQUIRED'));
    const payment = await client.createPaymentPayload(offer);
    const request = new Request(url, { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payment) } });
    const response = await route(request);
    assert.equal(response.status, 503, resource.id);
    assert.deepEqual(await response.json(), { error: 'DATA_NOT_PREPARED' });
    const expected = selectors[resource.id](new Request(new URL(resource.example, origin)));
    assert.deepEqual(state.readSelections, [expected], 'Only the exact documented starter reaches the prepared reader');
    assert.equal(state.verifies, 1);
    assert.equal(state.reads, 1);
    assert.equal(state.claims, 1, 'Existing middleware reserves a verified proof before calling the reader');
    assert.equal(state.reservations[0].resourceUrl, url, 'The reservation binds to the bare buyer URL, not the selector-only request');
    assert.equal(state.reservations[0].payer, buyer.address);
    assert.equal(state.requests.at(-1).request, request);
    assert.equal(state.finishes.length, 1);
    assert.equal(state.finishes[0].status, 'handler_failed');
    assert.equal(state.finishes[0].errorCode, 'resource_status_503');
    assert.equal(state.settles, 0, 'Unavailable starter data never reaches settlement');
    assert.equal(response.headers.get('PAYMENT-RESPONSE'), null);
  }
});
