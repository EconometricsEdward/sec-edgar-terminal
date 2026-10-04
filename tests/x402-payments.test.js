import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import {
  createPaidHandler, createX402FacilitatorClient, createX402AttemptGate, getX402Config, getX402PublicConfiguration,
  X402_AMOUNT, X402_BASE_NETWORK, X402_BASE_USDC,
} from '../src/utils/x402Payments.js';

// Offline fixtures: ephemeral signing account, mock settlement, no blockchain RPCs.
const buyer = privateKeyToAccount(generatePrivateKey());
const receivingAddress = '0x2222222222222222222222222222222222222222';
const resourceUrl = 'https://secedgarterminal.com/api/crawl/company?cik=320193';
const config = getX402Config({ NODE_ENV: 'production', X402_PAY_TO: receivingAddress });
const authorizationTypes = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };

function decode(header) { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
function signedRequest(payload, url = resourceUrl) {
  return new Request(url, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64') } });
}
function assertPrivate(response) {
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.match(response.headers.get('access-control-expose-headers'), /PAYMENT-RESPONSE/);
}

function fixture({ handler = () => Response.json({ cik: '320193', value: 42 }), settlement, ledgerFailure, validate, attemptGate } = {}) {
  const state = { reads: 0, verifies: 0, settles: 0, claims: 0, finishes: [], reservations: new Map() };
  const facilitatorClient = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: X402_BASE_NETWORK }], extensions: [], signers: {} }; },
    async verify(payload, requirements) {
      state.verifies++;
      try {
        const a = payload.payload.authorization;
        const matches = a.value === requirements.amount && a.to.toLowerCase() === requirements.payTo.toLowerCase();
        const valid = matches && await verifyTypedData({
          address: a.from,
          domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: X402_BASE_USDC },
          types: authorizationTypes, primaryType: 'TransferWithAuthorization',
          message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
          signature: payload.payload.signature,
        });
        return { isValid: valid, payer: a.from, ...(!valid ? { invalidReason: 'invalid_signature' } : {}) };
      } catch { return { isValid: false, invalidReason: 'invalid_signature' }; }
    },
    async settle(payload, requirements) {
      state.settles++;
      assert.equal(requirements.amount, X402_AMOUNT);
      assert.equal(requirements.asset, X402_BASE_USDC);
      assert.equal(requirements.network, X402_BASE_NETWORK);
      assert.equal(state.claims, 1, 'durable reservation precedes settlement');
      assert.equal(state.reads, 1, 'successful data preparation precedes settlement');
      if (settlement instanceof Error) throw settlement;
      return settlement || { success: true, transaction: `0x${'a'.repeat(64)}`, network: requirements.network, payer: payload.payload.authorization.from, amount: requirements.amount };
    },
  };
  const ledger = {
    ready: () => true,
    async claim(input) {
      if (ledgerFailure) throw new Error('Database unavailable');
      assert.equal(input.amount, X402_AMOUNT);
      assert.match(input.paymentHash, /^[0-9a-f]{64}$/);
      assert.match(input.requestId, /^[0-9a-f-]{36}$/);
      const nonceKey = `${input.network}:${input.asset}:${input.payer}:${input.nonce}`.toLowerCase();
      if (state.reservations.has(nonceKey)) return { claimed: false, status: 'pending' };
      state.reservations.set(nonceKey, input);
      state.claims++;
      return { claimed: true, token: { owner: input.requestId } };
    },
    async finish(input) { state.finishes.push(input); },
  };
  const paid = createPaidHandler(async (...args) => { state.reads++; return handler(...args); }, {
    description: 'Offline test company package', config, facilitatorClient, ledger, validate, attemptGate,
  });
  return { paid, state };
}

async function paymentPayload(paid, url = resourceUrl) {
  const offer = await paid(new Request(url));
  assert.equal(offer.status, 402);
  const required = decode(offer.headers.get('PAYMENT-REQUIRED'));
  const client = new x402Client().register(X402_BASE_NETWORK, new ExactEvmScheme(buyer));
  return client.createPaymentPayload(required);
}

test('configuration requires a real nonzero recipient and refuses production testnet', () => {
  assert.equal(getX402Config({ NODE_ENV: 'production' }).ready, false);
  assert.equal(getX402Config({ X402_PAY_TO: `0x${'0'.repeat(40)}` }).ready, false);
  assert.equal(getX402Config({ NODE_ENV: 'production', X402_PAY_TO: receivingAddress, X402_NETWORK: 'eip155:84532' }).ready, false);
  assert.equal(getX402Config({ NODE_ENV: 'test', X402_PAY_TO: receivingAddress, X402_NETWORK: 'eip155:84532' }).ready, true);
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
  assert.equal(required.accepts[0].asset, X402_BASE_USDC);
  assert.equal(required.accepts[0].network, X402_BASE_NETWORK);
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
  payload.payload.signature = `0x${'0'.repeat(130)}`;
  const response = await paid(signedRequest(payload));
  assert.equal(response.status, 402);
  assertPrivate(response);
  assert.equal(state.reads + state.claims + state.settles, 0);
  assert.equal(response.headers.get('PAYMENT-RESPONSE'), null);
});

test('changed authorization amount and payment network are rejected', async () => {
  for (const mutate of [p => { p.payload.authorization.value = '1'; }, p => { p.accepted.network = 'eip155:84532'; }]) {
    const { paid, state } = fixture();
    const payload = await paymentPayload(paid);
    mutate(payload);
    assert.equal((await paid(signedRequest(payload))).status, 402);
    assert.equal(state.reads + state.claims + state.settles, 0);
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
    { success: false, errorReason: 'insufficient_funds', transaction: '', network: X402_BASE_NETWORK },
    { success: false, errorReason: 'settlement_pending', transaction: `0x${'b'.repeat(64)}`, network: X402_BASE_NETWORK },
    { success: true, transaction: 'invalid', network: X402_BASE_NETWORK, payer: buyer.address },
    { success: true, transaction: `0x${'a'.repeat(64)}`, network: 'eip155:84532', payer: buyer.address },
  ];
  for (const settlement of cases) {
    const { paid, state } = fixture({ settlement });
    const response = await paid(signedRequest(await paymentPayload(paid)));
    assert.ok(response.status >= 400);
    assertPrivate(response);
    assert.equal((await response.text()).includes('"value":42'), false);
    assert.notEqual(state.finishes.at(-1).status, 'settled');
    if (/^0x[0-9a-f]{64}$/.test(settlement.transaction || '')) {
      assert.equal(state.finishes.at(-1).transaction, settlement.transaction);
      assert.equal(state.finishes.at(-1).network, X402_BASE_NETWORK);
      assert.equal(state.finishes.at(-1).payer.toLowerCase(), buyer.address.toLowerCase());
    }
  }
});

test('resource URL mismatch is rejected before reservation and work', async () => {
  const { paid, state } = fixture();
  const payload = await paymentPayload(paid);
  const response = await paid(signedRequest(payload, resourceUrl.replace('320193', '789019')));
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
  const anotherUrl = resourceUrl.replace('320193', '789019');
  payload.resource.url = anotherUrl;
  assert.equal((await paid(signedRequest(payload, anotherUrl))).status, 409);
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
  payload.payload.signature = `0x${'0'.repeat(130)}`;
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
