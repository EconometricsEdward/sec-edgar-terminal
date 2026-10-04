import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { generateKeyPairSigner, getBase58Decoder, getTransactionDecoder, getBase64EncodedWireTransaction } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { x402Client } from '@x402/core/client';
import { ExactSvmScheme as ExactSvmClient } from '@x402/svm/exact/client';
import { ExactSvmScheme as ExactSvmFacilitator } from '@x402/svm/exact/facilitator';
import { FacilitatorResponseError, FacilitatorTimeoutError } from '@x402/core/server';
import { SettleError } from '@x402/core/types';
import {
  createPaidHandler, createX402FacilitatorClient, createX402AttemptGate, getX402Config, getX402PublicConfiguration,
  X402_AMOUNT, X402_SOLANA_NETWORK, X402_SOLANA_USDC,
} from '../src/utils/x402Payments.js';

// Offline fixtures: ephemeral signers, mock settlement and local-only mint/blockhash RPC.
const buyer = await generateKeyPairSigner();
const feePayer = await generateKeyPairSigner();
const receivingAddress = '5qe4MpMXzT6TeaUNZz7ApAzoQzTGpVWbz1VBGbGhrdiR';
const resourceUrl = 'https://secedgarterminal.com/api/x402/v1/financials/AAPL?basis=annual';
const config = getX402Config({ NODE_ENV: 'production', X402_PAY_TO: receivingAddress });
const mockReceipt = getBase58Decoder().decode(new Uint8Array(64).fill(171));
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
      result = { context: { slot: 1000 }, value: { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(9)), lastValidBlockHeight: 2000 } };
    } else throw new Error(`Unexpected offline RPC method ${input.method}`);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
});
after(async () => { rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve)); });

function invalidateSignature(payload) {
  const transaction = getTransactionDecoder().decode(Buffer.from(payload.payload.transaction, 'base64'));
  payload.payload.transaction = getBase64EncodedWireTransaction({ ...transaction, signatures: { ...transaction.signatures, [buyer.address]: new Uint8Array(64) } });
}

function decode(header) { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
function signedRequest(payload, url = resourceUrl) {
  return new Request(url, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64') } });
}
function assertPrivate(response) {
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.match(response.headers.get('access-control-expose-headers'), /PAYMENT-RESPONSE/);
}

function fixture({ handler = () => Response.json({ cik: '320193', value: 42 }), settlement, ledgerFailure, validate, attemptGate, recipientCheck, configuration = config } = {}) {
  const state = { reads: 0, verifies: 0, settles: 0, claims: 0, supported: 0, finishes: [], reservations: new Map() };
  const svmFacilitator = new ExactSvmFacilitator({
    getAddresses: () => [feePayer.address],
    simulateTransaction: async () => {},
  });
  const facilitatorClient = {
    async getSupported() { state.supported++; return { kinds: [{ x402Version: 2, scheme: 'exact', network: X402_SOLANA_NETWORK, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} }; },
    async verify(payload, requirements) {
      state.verifies++;
      return svmFacilitator.verify(payload, requirements);
    },
    async settle(payload, requirements) {
      state.settles++;
      assert.equal(requirements.amount, X402_AMOUNT);
      assert.equal(requirements.asset, X402_SOLANA_USDC);
      assert.equal(requirements.network, X402_SOLANA_NETWORK);
      assert.equal(state.claims, 1, 'durable reservation precedes settlement');
      assert.equal(state.reads, 1, 'successful data preparation precedes settlement');
      if (typeof settlement === 'function') return settlement(state.settles);
      if (settlement instanceof Error) throw settlement;
      return settlement || { success: true, transaction: mockReceipt, network: requirements.network, payer: buyer.address, amount: requirements.amount };
    },
  };
  const ledger = {
    ready: () => true,
    async claim(input) {
      if (ledgerFailure) throw new Error('Database unavailable');
      assert.equal(input.amount, X402_AMOUNT);
      assert.match(input.paymentHash, /^[0-9a-f]{64}$/);
      assert.equal(input.nonce, input.paymentHash);
      assert.equal(input.payer, buyer.address);
      assert.match(input.requestId, /^[0-9a-f-]{36}$/);
      const nonceKey = `${input.network}:${input.asset}:${input.payer}:${input.nonce}`;
      if (state.reservations.has(nonceKey)) return { claimed: false, status: 'pending' };
      state.reservations.set(nonceKey, input);
      state.claims++;
      return { claimed: true, token: { owner: input.requestId } };
    },
    async finish(input) {
      if (input.errorCode !== undefined) assert.match(input.errorCode, /^[a-z0-9_]{1,80}$/, 'receipt errors match the durable ledger contract');
      state.finishes.push(input);
    },
  };
  const paid = createPaidHandler(async (...args) => { state.reads++; return handler(...args); }, {
    description: 'Offline test company package', config: configuration, facilitatorClient, ledger, validate, attemptGate, recipientCheck,
  });
  return { paid, state };
}

async function paymentPayload(paid, url = resourceUrl) {
  const offer = await paid(new Request(url));
  assert.equal(offer.status, 402);
  const required = decode(offer.headers.get('PAYMENT-REQUIRED'));
  const client = new x402Client().register(X402_SOLANA_NETWORK, new ExactSvmClient(buyer, { rpcUrl }));
  return client.createPaymentPayload(required);
}

test('configuration requires a real nonzero recipient and refuses production testnet', () => {
  assert.equal(getX402Config({ NODE_ENV: 'production' }).ready, false);
  assert.equal(getX402Config({ X402_PAY_TO: '11111111111111111111111111111111' }).ready, false);
  assert.equal(getX402Config({ NODE_ENV: 'production', X402_PAY_TO: receivingAddress, X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }).ready, false);
  assert.equal(getX402Config({ NODE_ENV: 'test', X402_PAY_TO: receivingAddress, X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }).ready, true);
  assert.equal(getX402Config({ VERCEL_ENV: 'production', NODE_ENV: 'production' }).payTo, receivingAddress);
  assert.equal(getX402Config({ VERCEL_ENV: 'production', NODE_ENV: 'production' }).requireRecipientReady, true);
  assert.equal(getX402Config({ NODE_ENV: 'development' }).ready, false);
  assert.equal(getX402PublicConfiguration({ VERCEL_ENV: 'preview', X402_PAY_TO: receivingAddress }).status, 'configuration-required');
  assert.equal(getX402Config({ X402_PAY_TO: receivingAddress, X402_FACILITATOR_URL: 'bad', PAYAI_API_KEY_ID: 'key', PAYAI_API_KEY_SECRET: 'secret' }).ready, false);
  const publicConfiguration = getX402PublicConfiguration({ X402_PAY_TO: receivingAddress });
  assert.equal(publicConfiguration.price, '0.01');
  assert.equal(publicConfiguration.payTo, receivingAddress);
  assert.equal(publicConfiguration.protocol, 'x402');
  assert.equal('authKeySecret' in publicConfiguration, false);
});

test('unsigned GET returns v2 402 for exactly 0.01 native USDC without data work', async () => {
  const { paid, state } = fixture();
  const response = await paid(new Request(resourceUrl));
  assert.equal(response.status, 402);
  assertPrivate(response);
  const required = decode(response.headers.get('PAYMENT-REQUIRED'));
  assert.equal(required.x402Version, 2);
  assert.equal(required.resource.url, resourceUrl);
  assert.equal(required.accepts.length, 1);
  assert.equal(required.accepts[0].amount, '10000');
  assert.equal(required.accepts[0].asset, X402_SOLANA_USDC);
  assert.equal(required.accepts[0].network, X402_SOLANA_NETWORK);
  assert.equal(required.accepts[0].payTo, receivingAddress);
  assert.equal(required.accepts[0].extra.paymentFlow, 'authorization');
  assert.equal(state.reads + state.verifies + state.settles + state.claims, 0);
});

test('genuine SDK client signs, mock facilitator cryptographically verifies, and success settles before delivery', async () => {
  const { paid, state } = fixture();
  const payload = await paymentPayload(paid);
  const response = await paid(signedRequest(payload));
  assert.equal(response.status, 200);
  assertPrivate(response);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { cik: '320193', value: 42 });
  assert.equal(response.headers.get('x-content-sha256'), createHash('sha256').update(body).digest('hex'));
  const receipt = decode(response.headers.get('PAYMENT-RESPONSE'));
  assert.equal(receipt.success, true);
  assert.equal(receipt.amount, '10000');
  assert.equal(state.verifies, 1);
  assert.equal(state.settles, 1);
  assert.equal(state.finishes.at(-1).status, 'settled');
});

test('successful paid CORS exposes the price, freshness, discovery and payment headers', async () => {
  const { paid } = fixture({ handler: () => Response.json({ value: 42 }, { headers: {
    'X-X402-Price': '0.01 USDC', 'X-Data-Stale': '1', Link: '</data-access>; rel="help"',
    'Access-Control-Expose-Headers': 'X-X402-Price, X-Data-Stale, Link',
  } }) });
  const response = await paid(signedRequest(await paymentPayload(paid)));
  assert.equal(response.status, 200);
  const exposed = response.headers.get('access-control-expose-headers').toLowerCase().split(/,\s*/);
  for (const name of ['payment-required', 'payment-response', 'x-content-sha256', 'x-x402-price', 'x-data-stale', 'link', 'retry-after']) {
    assert.ok(exposed.includes(name), `${name} is readable by browser buyers`);
  }
  assert.equal(response.headers.get('x-x402-price'), '0.01 USDC');
  assert.equal(response.headers.get('x-data-stale'), '1');
  assert.equal(response.headers.get('link'), '</data-access>; rel="help"');
});

test('paid handler forwards validated route context to the resource reader', async () => {
  const { paid } = fixture({ handler: (_request, context) => Response.json({ ticker: context.selection.ticker }) });
  const response = await paid(signedRequest(await paymentPayload(paid)), { selection: { ticker: 'AAPL' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ticker: 'AAPL' });
});

test('facilitator capabilities use one bounded request and never retry a429', async () => {
  let calls = 0;
  const facilitator = await createX402FacilitatorClient(config, async (_url, options) => {
    calls++;
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response('', { status: 429, headers: { 'Retry-After': '3600' } });
  });
  await assert.rejects(facilitator.getSupported(), /capabilities unavailable/);
  assert.equal(calls, 1);
});

test('facilitator capabilities reject invalid and unbounded input before initialization', async () => {
  for (const body of [{ kinds: 'invalid' }, { kinds: [], oversized: 'x'.repeat(129 * 1024) }]) {
    const facilitator = await createX402FacilitatorClient(config, async () => Response.json(body));
    await assert.rejects(facilitator.getSupported());
  }
});

test('invalid signature never reserves, prepares, settles, or exposes the resource', async () => {
  const { paid, state } = fixture();
  const payload = await paymentPayload(paid);
  invalidateSignature(payload);
  const response = await paid(signedRequest(payload));
  assert.equal(response.status, 402);
  assertPrivate(response);
  assert.equal(state.reads + state.claims + state.settles, 0);
  assert.equal(response.headers.get('PAYMENT-RESPONSE'), null);
});

test('changed payment amount and payment network are rejected', async () => {
  for (const mutate of [p => { p.accepted.amount = '1'; }, p => { p.accepted.network = 'eip155:84532'; }]) {
    const { paid, state } = fixture();
    const payload = await paymentPayload(paid);
    mutate(payload);
    assert.equal((await paid(signedRequest(payload))).status, 402);
    assert.equal(state.reads + state.claims + state.settles, 0);
  }
});

test('valid signature for a smaller transfer cannot purchase 0.01 USDC resource by editing HTTP amount', async () => {
  const { paid, state } = fixture();
  const offer = await paid(new Request(resourceUrl));
  const required = decode(offer.headers.get('PAYMENT-REQUIRED'));
  const original = required.accepts[0];
  required.accepts = [{ ...original, amount: '1' }];
  const client = new x402Client().register(X402_SOLANA_NETWORK, new ExactSvmClient(buyer, { rpcUrl }));
  const payload = await client.createPaymentPayload(required);
  payload.accepted = original;
  assert.equal((await paid(signedRequest(payload))).status, 402);
  assert.equal(state.reads + state.settles + state.claims, 0);
});

test('production recipient setup or uncertain readiness blocks offers before facilitator and data work', async () => {
  for (const status of ['recipient-setup-required', 'recipient-check-unavailable']) {
    const { paid, state } = fixture({
      configuration: getX402Config({ VERCEL_ENV: 'production', NODE_ENV: 'production' }),
      recipientCheck: async () => ({ ready: false, status }),
    });
    const response = await paid(new Request(resourceUrl));
    assert.equal(response.status, 503);
    assertPrivate(response);
    assert.equal(response.headers.get('PAYMENT-REQUIRED'), null);
    assert.equal(state.reads + state.verifies + state.settles + state.claims + state.supported, 0);
    assert.equal((await response.json()).error, status === 'recipient-setup-required' ? 'receiving_account_not_ready' : 'receiving_account_check_unavailable');
  }
});

test('missing wallet or missing ledger fails closed with no invented payment offer', async () => {
  const missingWallet = createPaidHandler(() => Response.json({ secret: 1 }), { config: getX402Config({}) });
  const missingLedger = createPaidHandler(() => Response.json({ secret: 1 }), { config });
  for (const paid of [missingWallet, missingLedger]) {
    const response = await paid(new Request(resourceUrl));
    assert.equal(response.status, 503);
    assertPrivate(response);
    assert.equal(response.headers.get('PAYMENT-REQUIRED'), null);
  }
});

test('unavailable durable ledger refuses verified payment before data work or settlement', async () => {
  const { paid, state } = fixture({ ledgerFailure: true });
  const response = await paid(signedRequest(await paymentPayload(paid)));
  assert.equal(response.status, 503);
  assertPrivate(response);
  assert.equal(state.reads + state.settles, 0);
});

test('HEAD and OPTIONS never prepare data, verify, settle, or generate a paid offer', async () => {
  const { paid, state } = fixture();
  for (const [method, status] of [['HEAD', 405], ['OPTIONS', 204]]) {
    const response = await paid(new Request(resourceUrl, { method }));
    assert.equal(response.status, status);
    assertPrivate(response);
    assert.equal(response.headers.get('PAYMENT-REQUIRED'), null);
  }
  assert.equal(state.reads + state.verifies + state.settles, 0);
});

test('route input validation happens before an offer, data preparation, or settlement', async () => {
  const { paid, state } = fixture({ validate: () => Response.json({ error: 'unsupported_query' }, { status: 400 }) });
  const response = await paid(new Request(resourceUrl));
  assert.equal(response.status, 400);
  assertPrivate(response);
  assert.equal(response.headers.get('PAYMENT-REQUIRED'), null);
  assert.equal(state.reads + state.verifies + state.settles, 0);
});

test('handler error, redirect, invalid JSON and oversize response never settle', async () => {
  const cases = [
    { handler: () => Response.json({ error: 'not_found' }, { status: 404 }), status: 404 },
    { handler: () => Response.redirect('https://example.test'), status: 502 },
    { handler: () => { throw new Error('Source down'); }, status: 502 },
    { handler: () => new Response('not json', { headers: { 'Content-Type': 'application/json' } }), status: 502 },
    { handler: () => Response.json({ oversized: 'x'.repeat(4 * 1024 * 1024) }), status: 502 },
  ];
  for (const entry of cases) {
    const { paid, state } = fixture(entry);
    const response = await paid(signedRequest(await paymentPayload(paid)));
    assert.equal(response.status, entry.status);
    assertPrivate(response);
    assert.equal(state.settles, 0);
    assert.equal(state.finishes.at(-1).status, 'handler_failed');
  }
});

test('settlement failure and malformed settlement receipts withhold prepared content', async () => {
  const cases = [
    { success: false, errorReason: 'insufficient_funds', transaction: '', network: X402_SOLANA_NETWORK },
    { success: false, errorReason: 'settlement_pending', transaction: mockReceipt, network: X402_SOLANA_NETWORK },
    { success: true, transaction: 'invalid', network: X402_SOLANA_NETWORK, payer: buyer.address },
    { success: true, transaction: mockReceipt, network: 'eip155:84532', payer: buyer.address },
  ];
  for (const settlement of cases) {
    const { paid, state } = fixture({ settlement });
    const response = await paid(signedRequest(await paymentPayload(paid)));
    assert.ok(response.status >= 400);
    assertPrivate(response);
    assert.equal((await response.text()).includes('"value":42'), false);
    assert.notEqual(state.finishes.at(-1).status, 'settled');
    if (settlement.transaction === mockReceipt) {
      assert.equal(state.finishes.at(-1).transaction, settlement.transaction);
      assert.equal(state.finishes.at(-1).network, X402_SOLANA_NETWORK);
      assert.equal(state.finishes.at(-1).payer, buyer.address);
    }
  }
});

test('SDK settlement transport failures preserve pending status and request reconciliation without another authorization', async () => {
  for (const settlement of [new TypeError('fetch failed'), new FacilitatorTimeoutError('settle', 20000),
    new FacilitatorResponseError('Invalid JSON after settlement'),
    new SettleError(502, { success: false, errorReason: 'unexpected_settle_error', transaction: '', network: X402_SOLANA_NETWORK }),
    () => null,
    () => ({ success: 'true', transaction: '', network: X402_SOLANA_NETWORK, payer: buyer.address }),
  ]) {
    const { paid, state } = fixture({ settlement });
    const payload = await paymentPayload(paid);
    const response = await paid(signedRequest(payload));
    assert.equal(response.status, 503);
    assertPrivate(response);
    const body = await response.json();
    assert.equal(body.error, 'settlement_indeterminate');
    assert.match(body.paymentHash, /^[a-f0-9]{64}$/);
    assert.match(body.retry, /Do not create another payment authorization/);
    assert.equal(body.transaction, undefined);
    assert.equal(state.finishes.at(-1).status, 'pending');
    assert.equal(state.finishes.at(-1).errorCode, 'settlement_indeterminate');
    assert.equal((await paid(signedRequest(payload))).status, 409);
    assert.equal(state.settles, 1, 'uncertain settlement never releases the replay reservation');
  }
});

test('first uncertain response retains a known transaction even when its outcome is malformed or a server error', async () => {
  for (const settlement of [
    new SettleError(500, { success: false, errorReason: 'internal_server_error', transaction: mockReceipt, network: X402_SOLANA_NETWORK }),
    () => ({ success: false, transaction: mockReceipt, network: X402_SOLANA_NETWORK }),
    () => ({ success: 'true', transaction: mockReceipt, network: X402_SOLANA_NETWORK }),
  ]) {
    const { paid, state } = fixture({ settlement });
    const payload = await paymentPayload(paid);
    const response = await paid(signedRequest(payload));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).transaction, mockReceipt);
    assert.equal(state.finishes.at(-1).status, 'pending');
    assert.equal(state.finishes.at(-1).transaction, mockReceipt);
    assert.equal(state.finishes.at(-1).payer, buyer.address);
    assert.equal((await paid(signedRequest(payload))).status, 409);
    assert.equal(state.settles, 1);
  }
});

test('generic facilitator failure without a known settlement verdict remains pending', async () => {
  for (const reason of ['Settlement failed', 'unknown reason']) {
    const { paid, state } = fixture({ settlement: { success: false, errorReason: reason,
      transaction: '', network: X402_SOLANA_NETWORK } });
    const payload = await paymentPayload(paid);
    const response = await paid(signedRequest(payload));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'settlement_indeterminate');
    assert.equal(state.finishes.at(-1).status, 'pending');
    assert.equal((await paid(signedRequest(payload))).status, 409);
    assert.equal(state.settles, 1);
  }
});

test('SDK pending settlement retry retains its known transaction when the retry times out', async () => {
  const { paid, state } = fixture({ settlement: attempt => {
    if (attempt === 1) return { success: false, errorReason: 'settlement_pending', transaction: mockReceipt,
      network: X402_SOLANA_NETWORK, payer: buyer.address };
    throw new FacilitatorTimeoutError('settle', 20000);
  } });
  const payload = await paymentPayload(paid);
  const response = await paid(signedRequest(payload));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.transaction, mockReceipt);
  assert.equal(state.finishes.at(-1).status, 'pending');
  assert.equal(state.finishes.at(-1).transaction, mockReceipt);
  assert.equal(state.finishes.at(-1).network, X402_SOLANA_NETWORK);
  assert.equal(state.finishes.at(-1).payer, buyer.address);
  assert.equal(state.settles, 2, 'installed SDK performs its single pending retry');
  assert.equal((await paid(signedRequest(payload))).status, 409);
  assert.equal(state.settles, 2);
});

test('SDK retry cannot replace an earlier broadcast transaction with a final rejection', async () => {
  const { paid, state } = fixture({ settlement: attempt => attempt === 1
    ? { success: false, errorReason: 'settlement_pending', transaction: mockReceipt, network: X402_SOLANA_NETWORK }
    : { success: false, errorReason: 'insufficient_funds', transaction: '', network: X402_SOLANA_NETWORK } });
  const payload = await paymentPayload(paid);
  const response = await paid(signedRequest(payload));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).transaction, mockReceipt);
  assert.equal(state.finishes.at(-1).status, 'pending');
  assert.equal(state.finishes.at(-1).transaction, mockReceipt);
  assert.equal((await paid(signedRequest(payload))).status, 409);
  assert.equal(state.settles, 2);
});

test('SDK retry success for the same broadcast transaction records settlement and delivers the data', async () => {
  const { paid, state } = fixture({ settlement: attempt => attempt === 1
    ? { success: false, errorReason: 'settlement_pending', transaction: mockReceipt, network: X402_SOLANA_NETWORK }
    : { success: true, transaction: mockReceipt, network: X402_SOLANA_NETWORK, payer: buyer.address, amount: X402_AMOUNT } });
  const payload = await paymentPayload(paid);
  const response = await paid(signedRequest(payload));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cik: '320193', value: 42 });
  assert.equal(state.finishes.at(-1).status, 'settled');
  assert.equal(state.finishes.at(-1).transaction, mockReceipt);
  assert.equal(decode(response.headers.get('PAYMENT-RESPONSE')).transaction, mockReceipt);
  assert.equal((await paid(signedRequest(payload))).status, 409);
  assert.equal(state.settles, 2);
});

test('definitive facilitator rejection remains a failed payment and receipt errors fit the ledger contract', async () => {
  const reason = 'Rejected: invalid spending policy / supplied proof! '.repeat(4);
  for (const settlement of [
    { success: false, errorReason: 'insufficient_funds', transaction: '', network: X402_SOLANA_NETWORK },
    new SettleError(400, { success: false, errorReason: reason, transaction: '', network: X402_SOLANA_NETWORK }),
  ]) {
    const { paid, state } = fixture({ settlement });
    const response = await paid(signedRequest(await paymentPayload(paid)));
    assert.equal(response.status, 402);
    assert.equal(state.finishes.at(-1).status, 'failed');
    assert.match(state.finishes.at(-1).errorCode, /^[a-z0-9_]{1,80}$/);
    assert.equal(state.finishes.at(-1).transaction, undefined);
    assert.equal(state.settles, 1);
  }
});

test('duplicate settlement without a transaction remains unresolved and cannot release data', async () => {
  const { paid, state } = fixture({ settlement: { success: false, errorReason: 'duplicate_settlement',
    transaction: '', network: X402_SOLANA_NETWORK } });
  const response = await paid(signedRequest(await paymentPayload(paid)));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'settlement_indeterminate');
  assert.equal(state.finishes.at(-1).status, 'pending');
  assert.equal(state.settles, 1);
});

test('resource URL mismatch is rejected before reservation and work', async () => {
  const { paid, state } = fixture();
  const payload = await paymentPayload(paid);
  const response = await paid(signedRequest(payload, resourceUrl.replace('AAPL', 'MSFT')));
  assert.equal(response.status, 402);
  assert.equal(state.reads + state.settles + state.claims, 0);
});

test('simultaneous replay of one proof produces only one prepared and settled resource', async () => {
  const { paid, state } = fixture();
  const payload = await paymentPayload(paid);
  const responses = await Promise.all([paid(signedRequest(payload)), paid(signedRequest(payload))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(state.reads, 1);
  assert.equal(state.claims, 1);
  assert.equal(state.settles, 1);
});

test('same signed nonce with edited resource metadata cannot buy another resource', async () => {
  const { paid, state } = fixture();
  const payload = await paymentPayload(paid);
  assert.equal((await paid(signedRequest(payload))).status, 200);
  const anotherUrl = resourceUrl.replace('AAPL', 'MSFT');
  payload.resource.url = anotherUrl;
  assert.equal((await paid(signedRequest(payload, anotherUrl))).status, 409);
  assert.equal(state.settles, 1);
  assert.equal(state.reads, 1);
});

test('editing unsigned fee-payer signature bytes cannot evade canonical signed-message replay lock', async () => {
  const { paid, state } = fixture();
  const payload = await paymentPayload(paid);
  assert.equal((await paid(signedRequest(payload))).status, 200);
  const transaction = getTransactionDecoder().decode(Buffer.from(payload.payload.transaction, 'base64'));
  payload.payload.transaction = getBase64EncodedWireTransaction({ ...transaction, signatures: { ...transaction.signatures, [feePayer.address]: new Uint8Array(64).fill(99) } });
  assert.equal((await paid(signedRequest(payload))).status, 409);
  assert.equal(state.settles, 1);
  assert.equal(state.reads, 1);
});

test('shared purchase concurrency cap rejects before verification and recovers after finally release', async () => {
  const attemptGate = createX402AttemptGate({ maxConcurrent: 1, maxAttempts: 10 });
  let entered;
  const handlerEntered = new Promise(resolve => { entered = resolve; });
  let release;
  const waitForRelease = new Promise(resolve => { release = resolve; });
  const first = fixture({ attemptGate, handler: async () => {
    entered();
    await waitForRelease;
    return Response.json({ value: 42 });
  } });
  const second = fixture({ attemptGate });
  const firstPayload = await paymentPayload(first.paid);
  const secondPayload = await paymentPayload(second.paid);
  const firstPurchase = first.paid(signedRequest(firstPayload));
  await handlerEntered;
  const blocked = await second.paid(signedRequest(secondPayload));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '1');
  assertPrivate(blocked);
  assert.equal(second.state.verifies + second.state.claims + second.state.settles, 0);
  release();
  assert.equal((await firstPurchase).status, 200);
  assert.equal((await second.paid(signedRequest(secondPayload))).status, 200);
});

test('invalid signature spam is capped per window, unsigned offers stay free, and a new window recovers', async () => {
  let now = 1000;
  const attemptGate = createX402AttemptGate({ maxConcurrent: 1, maxAttempts: 2, windowMs: 10000, now: () => now });
  const { paid, state } = fixture({ attemptGate });
  const payload = await paymentPayload(paid);
  invalidateSignature(payload);
  assert.equal((await paid(signedRequest(payload))).status, 402);
  assert.equal((await paid(signedRequest(payload))).status, 402);
  const capped = await paid(signedRequest(payload));
  assert.equal(capped.status, 429);
  assert.equal(capped.headers.get('retry-after'), '10');
  assertPrivate(capped);
  assert.equal(state.verifies, 2);
  assert.equal(state.claims + state.reads + state.settles, 0);
  assert.equal((await paid(new Request(resourceUrl))).status, 402);
  now += 10000;
  assert.equal((await paid(signedRequest(payload))).status, 402);
  assert.equal(state.verifies, 3);
});

test('failed resource preparation releases the shared concurrency permit', async () => {
  const attemptGate = createX402AttemptGate({ maxConcurrent: 1, maxAttempts: 10 });
  const failed = fixture({ attemptGate, handler: () => Response.json({ error: 'unavailable' }, { status: 503 }) });
  const recovered = fixture({ attemptGate });
  assert.equal((await failed.paid(signedRequest(await paymentPayload(failed.paid)))).status, 503);
  assert.equal(failed.state.settles, 0);
  assert.equal((await recovered.paid(signedRequest(await paymentPayload(recovered.paid)))).status, 200);
});
