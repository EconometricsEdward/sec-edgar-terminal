import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { ExactSvmScheme as ExactSvmFacilitator } from '@x402/svm/exact/facilitator';
import { createKeyPairSignerFromBytes, generateKeyPairSigner, getBase58Decoder } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { buildX402BuyerExample } from '../src/utils/x402BuyerExample.js';
import { createPaidHandler, getX402Config, X402_SOLANA_NETWORK, X402_SOLANA_USDC } from '../src/utils/x402Payments.js';

// Ephemeral local-only signers and RPC; no production wallet, funds or broadcast.
const buyer = await generateKeyPairSigner(true);
const recipient = await generateKeyPairSigner();
const feePayer = await generateKeyPairSigner();
const keyBytes = [
  ...new Uint8Array(await crypto.subtle.exportKey('pkcs8', buyer.keyPair.privateKey)).slice(-32),
  ...new Uint8Array(await crypto.subtle.exportKey('raw', buyer.keyPair.publicKey)),
];
const config = getX402Config({ NODE_ENV: 'test', X402_PAY_TO: recipient.address });
const mockTransaction = getBase58Decoder().decode(new Uint8Array(64).fill(172));
const resourceUrl = 'https://secedgarterminal.com/api/x402/v1/factor-universe?basis=ttm&limit=100&offset=0';
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
      result = { context: { slot: 1000 }, value: { data: [data.toString('base64'), 'base64'], executable: false, lamports: 1000000, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 } };
    } else if (input.method === 'getLatestBlockhash') {
      result = { context: { slot: 1000 }, value: { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(10)), lastValidBlockHeight: 2000 } };
    } else throw new Error(`Unexpected offline RPC method ${input.method}`);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
});
after(async () => { rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve)); });

function fixture() {
  const state = { requests: 0, verifies: 0, settles: 0, claims: [], finishes: [] };
  const facilitator = new ExactSvmFacilitator({ getAddresses: () => [feePayer.address], simulateTransaction: async () => {} });
  const paid = createPaidHandler(() => Response.json({ rows: [{ ticker: 'MOCK' }], schemaVersion: 'offline-example' }), {
    config,
    facilitatorClient: {
      async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: X402_SOLANA_NETWORK, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} }; },
      async verify(payload, requirements) { state.verifies++; return facilitator.verify(payload, requirements); },
      async settle(payload, requirements) {
        state.settles++;
        assert.equal(requirements.amount, '10000');
        assert.equal(requirements.payTo, recipient.address);
        assert.equal(state.claims.length, 1);
        return { success: true, transaction: mockTransaction, network: requirements.network, payer: buyer.address, amount: '10000' };
      },
    },
    ledger: {
      ready: () => true,
      async claim(payment) { state.claims.push(payment); return { claimed: true, token: { owner: payment.requestId } }; },
      async finish(receipt) { state.finishes.push(receipt); },
      async stageDelivery(delivery) {
        assert.match(delivery.recoveryHash, /^[a-f0-9]{64}$/);
        assert.ok(Buffer.isBuffer(delivery.bytes));
        return { expiresAt: new Date(Date.now() + 86400000).toISOString() };
      },
    },
  });
  return { state, fetch: async request => { state.requests++; assert.equal(request.url, resourceUrl); return paid(request); } };
}

// Execute the exact displayed body, with genuine pinned SDKs. Only the file,
// resource transport and RPC URL are replaced by local fixtures.
async function runExample(configuration, fetch, { writes = [], logs = [], writeError, recoveryFile = 'ephemeral-recovery.json' } = {}) {
  const source = buildX402BuyerExample(configuration).replace(/^import .*;\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  class LocalExactSvmScheme extends ExactSvmScheme {
    constructor(signer) { super(signer, { rpcUrl }); }
  }
  const execute = new AsyncFunction('x402Client', 'wrapFetchWithPayment', 'ExactSvmScheme', 'createKeyPairSignerFromBytes', 'readFileSync', 'writeFileSync', 'process', 'fetch', 'console', `${source}\nreturn { data, receipt };`);
  return execute(x402Client, wrapFetchWithPayment, LocalExactSvmScheme, createKeyPairSignerFromBytes,
    (file, encoding) => { assert.equal(file, 'ephemeral-keypair.json'); assert.equal(encoding, 'utf8'); return JSON.stringify(keyBytes); },
    (file, content, options) => {
      assert.equal(file, 'ephemeral-recovery.json');
      assert.deepEqual(options, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (writeError) throw writeError;
      const saved = JSON.parse(content);
      assert.match(saved.token, /^[a-f0-9]{64}$/);
      assert.equal(saved.url, 'https://secedgarterminal.com/api/x402/v1/delivery');
      assert.equal(saved.resourceUrl, resourceUrl);
      writes.push(saved);
    },
    { env: { PAYER_KEYPAIR_FILE: 'ephemeral-keypair.json', RECOVERY_FILE: recoveryFile } },
    async (...args) => { assert.equal(writes.length, 1, 'recovery capability is saved before any request'); return fetch(...args); },
    { log: value => logs.push(value) });
}

test('displayed buyer example settles exactly one offline purchase with the genuine pinned fetch SDK', async () => {
  const { state, fetch } = fixture();
  const writes = [], logs = [];
  const result = await runExample({ payTo: recipient.address, network: X402_SOLANA_NETWORK }, fetch, { writes, logs });
  assert.equal(state.requests, 2);
  assert.equal(state.verifies, 1);
  assert.equal(state.settles, 1);
  assert.equal(state.claims[0].payer, buyer.address);
  assert.equal(state.finishes[0].status, 'settled');
  assert.deepEqual(result.data.rows, [{ ticker: 'MOCK' }]);
  assert.equal(JSON.parse(Buffer.from(result.receipt, 'base64').toString()).transaction, mockTransaction);
  assert.equal(writes.length, 1);
  assert.ok(logs.every(value => !value.includes(writes[0].token)));
  assert.match(logs[0], /ephemeral-recovery.json/);
});

test('displayed buyer example refuses changed recipient and excessive prices before payment authorization', async () => {
  const { state, fetch } = fixture();
  await assert.rejects(runExample({ payTo: feePayer.address, network: X402_SOLANA_NETWORK }, fetch), /Unexpected payment offer/);
  assert.equal(state.requests, 1);
  assert.equal(state.verifies, 0);
  assert.equal(state.settles, 0);
  const alteredPrice = async request => {
    const response = await fetch(request);
    const offer = JSON.parse(Buffer.from(response.headers.get('PAYMENT-REQUIRED'), 'base64').toString());
    offer.accepts[0].amount = '20000';
    response.headers.set('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(offer)).toString('base64'));
    return response;
  };
  await assert.rejects(runExample({ payTo: recipient.address, network: X402_SOLANA_NETWORK }, alteredPrice), /spendControls.maxAmountPerPayment/);
  assert.equal(state.verifies, 0);
  assert.equal(state.settles, 0);
});

test('displayed buyer example preserves indeterminate errors and never retries with a replacement payment', async () => {
  let requests = 0;
  const fetch = async request => {
    requests++;
    const { fetch: challenge } = fixture();
    if (!request.headers.has('PAYMENT-SIGNATURE')) return challenge(request);
    return Response.json({ error: 'settlement_indeterminate', paymentHash: 'mock-payment-hash', retry: 'Reconcile this payment.' }, { status: 503 });
  };
  await assert.rejects(runExample({ payTo: recipient.address, network: X402_SOLANA_NETWORK }, fetch), /settlement_indeterminate.*mock-payment-hash/);
  assert.equal(requests, 2);
});

test('displayed buyer example preserves a private saved capability when a settled response body is interrupted', async () => {
  const { state, fetch } = fixture();
  const writes = [], logs = [];
  const interrupted = async request => {
    assert.equal(request.headers.get('X-X402-Recovery-Token'), writes[0].token);
    const response = await fetch(request);
    if (!response.ok) return response;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('Response body interrupted')); } }),
      { status: response.status, headers: response.headers });
  };
  await assert.rejects(runExample({ payTo: recipient.address, network: X402_SOLANA_NETWORK }, interrupted, { writes, logs }), error => {
    assert.match(error.message, /Response body interrupted/);
    assert.match(error.message, /ephemeral-recovery.json/);
    assert.match(error.message, /Do not authorize a replacement payment/);
    assert.ok(!error.message.includes(writes[0].token));
    assert.equal(JSON.parse(error.message).status, 200);
    return true;
  });
  assert.equal(writes.length, 1);
  assert.equal(state.requests, 2);
  assert.equal(state.settles, 1);
  assert.equal(state.finishes[0].status, 'settled');
  assert.equal(logs.length, 0);
});

test('displayed buyer example never requests or authorizes payment if recovery persistence is missing or cannot create a new file', async () => {
  let requests = 0;
  const fetch = async () => { requests++; throw new Error('Must not request payment'); };
  await assert.rejects(runExample({ payTo: recipient.address, network: X402_SOLANA_NETWORK }, fetch, { recoveryFile: '' }), /RECOVERY_FILE/);
  await assert.rejects(runExample({ payTo: recipient.address, network: X402_SOLANA_NETWORK }, fetch, { writeError: new Error('EEXIST recovery file already exists') }), /EEXIST/);
  assert.equal(requests, 0);
});
