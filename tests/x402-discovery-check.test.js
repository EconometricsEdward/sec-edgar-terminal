import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSigner, getBase58Decoder } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { x402DiscoveryOptions } from '../src/utils/x402Discovery.js';
import { X402_DEPLOYMENT_PAY_TO, X402_DEPLOYMENT_NETWORK } from '../src/utils/x402Deployment.js';
import { checkDiscovery, createEphemeralPayloadBuilder, DISCOVERY_REQUESTS, guardedDiscoveryFetch, loadLocalKeypairSigner, parseDiscoveryArgs, validateOffer } from '../scripts/check-x402-discovery.mjs';

const FACILITATOR = 'https://facilitator.payai.network';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const feePayer = await generateKeyPairSigner();
const offers = DISCOVERY_REQUESTS.map((url, i) => {
  const { extensions, ...metadata } = x402DiscoveryOptions(['financials', 'factor-universe', 'refinancing', 'financial-batch', 'fundamental-screen', 'credit-screen', 'financial-changes', 'disclosure-evidence', 'institutional-overlap'][i]);
  delete metadata.routePattern;
  extensions.bazaar.info.input.method = 'GET';
  return { x402Version: 2, resource: { url, description: 'Prepared SEC research', mimeType: 'application/json', ...metadata }, extensions,
    accepts: [{ scheme: 'exact', network: X402_DEPLOYMENT_NETWORK, asset: MINT, amount: '10000', payTo: X402_DEPLOYMENT_PAY_TO, maxTimeoutSeconds: 60, extra: { feePayer: feePayer.address } }],
  };
});

function transport({ register = false, altered = false } = {}) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    calls.push({ url, method: init.method });
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).has('PAYMENT-SIGNATURE'), false);
    if (DISCOVERY_REQUESTS.includes(url)) {
      const offer = structuredClone(offers[DISCOVERY_REQUESTS.indexOf(url)]);
      if (altered) offer.accepts[0].amount = '20000';
      return new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(offer) } });
    }
    if (url === `${FACILITATOR}/verify`) {
      assert.equal(register, true);
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.paymentPayload.accepted, body.paymentRequirements);
      assert.deepEqual(body.paymentPayload.resource, offers.find(offer => offer.resource.url === body.paymentPayload.resource.url).resource);
      assert.deepEqual(body.paymentPayload.extensions, offers.find(offer => offer.resource.url === body.paymentPayload.resource.url).extensions);
      assert.ok(body.paymentPayload.payload.transaction.length > 100);
      return Response.json({ isValid: false, invalidReason: 'unfunded-test-payer' }, { headers: { 'EXTENSION-RESPONSES': Buffer.from(JSON.stringify({ bazaar: { status: 'processing' } })).toString('base64') } });
    }
    assert.equal(init.method, 'GET');
    if (new URL(url).pathname === '/discovery/listing-status') return Response.json({ listed: false, lastWrite: { status: 'pending' } });
    assert.equal(new URL(url).pathname, '/discovery/resources');
    return Response.json({ items: [], pagination: { total: 0 } });
  } };
}

test('discovery audit is read-only by default and distinguishes valid offers from unlisted resources', async () => {
  const mock = transport();
  const result = await checkDiscovery({ fetchImpl: mock.fetch, createPayload: () => { throw new Error('Read-only mode must not generate payment payloads'); } });
  assert.equal(mock.calls.length, DISCOVERY_REQUESTS.length * 2 + 1);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
  assert.equal(result.resources.length, DISCOVERY_REQUESTS.length);
  assert.equal(result.resources[0].resource, 'https://secedgarterminal.com/api/x402/v1/financials/AAPL');
  assert.equal(result.resources[1].resource, 'https://secedgarterminal.com/api/x402/v1/factor-universe');
  assert.ok(result.resources.every(resource => !resource.listing.listed));
  assert.equal(result.catalog.totalForWallet, 0);
});

test('batch discovery uses the canonical encoded URL while retaining comma-separated ticker semantics', () => {
  const canonical = 'https://secedgarterminal.com/api/x402/v1/financial-batch?tickers=AAPL%2CMSFT&basis=annual';
  assert.equal(DISCOVERY_REQUESTS[3], canonical);
  assert.equal(new URL(canonical).searchParams.get('tickers'), 'AAPL,MSFT');
  assert.doesNotThrow(() => validateOffer(offers[3], canonical));
  assert.throws(() => validateOffer(offers[3], canonical.replace('%2C', ',')), /Unexpected payment resource/);
});

test('local keypair mode requires an explicit registration flag and does not accept wallet environment values', async () => {
  assert.deepEqual(parseDiscoveryArgs([]), { register: false, keypairPath: undefined });
  assert.deepEqual(parseDiscoveryArgs(['--register', '--keypair', '/local/buyer.json']), { register: true, keypairPath: '/local/buyer.json' });
  for (const args of [['--keypair', '/local/buyer.json'], ['--register', '--keypair'], ['--register', '--register'], ['--origin', 'https://example.com']]) assert.throws(() => parseDiscoveryArgs(args));
  await assert.rejects(checkDiscovery({ keypairPath: '/local/buyer.json', fetchImpl: () => { throw new Error('Must not fetch or read keys'); } }), /requires explicit --register/);
});

test('local loader accepts only an explicitly selected synthetic standard keypair and sanitizes key errors', async () => {
  const buyer = await generateKeyPairSigner(true);
  const bytes = [
    ...new Uint8Array(await crypto.subtle.exportKey('pkcs8', buyer.keyPair.privateKey)).slice(-32),
    ...new Uint8Array(await crypto.subtle.exportKey('raw', buyer.keyPair.publicKey)),
  ];
  let reads = 0;
  const loaded = await loadLocalKeypairSigner('/synthetic/buyer.json', { readFile: (path, encoding) => {
    reads++; assert.equal(path, '/synthetic/buyer.json'); assert.equal(encoding, 'utf8'); return JSON.stringify(bytes);
  } });
  assert.equal(loaded.address, buyer.address);
  assert.equal(reads, 1);
  for (const source of ['secret-key-material', JSON.stringify(bytes.slice(1)), JSON.stringify([...bytes.slice(0, -1), 256])]) {
    await assert.rejects(loadLocalKeypairSigner('/synthetic/buyer.json', { readFile: () => source }), error => {
      assert.match(error.message, /exactly 64 integer bytes/);
      assert.doesNotMatch(error.message, /secret-key-material|synthetic|256/);
      return true;
    });
  }
});

test('an invalid unfunded verification without an extension response reports not queued and a concrete next step', async () => {
  const mock = transport({ register: true });
  const fetchImpl = async (url, init) => {
    const response = await mock.fetch(url, init);
    if (url === `${FACILITATOR}/verify`) response.headers.delete('EXTENSION-RESPONSES');
    return response;
  };
  const createPayload = async offer => ({ x402Version: 2, resource: offer.resource, extensions: offer.extensions, accepted: offer.accepts[0], payload: { transaction: 'offline-only-verification-placeholder'.repeat(4) } });
  const result = await checkDiscovery({ register: true, fetchImpl, createPayload });
  assert.equal(result.mode, 'verify-only unfunded probe');
  assert.ok(result.resources.every(resource => resource.registration.queued === false && resource.registration.outcome === 'not acknowledged as queued'));
  assert.match(result.resources[0].registration.note, /--register --keypair/);
});

test('discovery transport rejects settlement, signed seller retries, credentials, redirects and arbitrary origins', async () => {
  let forwarded = 0;
  const safe = guardedDiscoveryFetch(async () => { forwarded++; return new Response(); }, { register: true });
  for (const [url, init] of [
    [`${FACILITATOR}/settle`, { method: 'POST', body: '{}' }],
    [DISCOVERY_REQUESTS[0], { headers: { 'PAYMENT-SIGNATURE': 'signed' } }],
    [DISCOVERY_REQUESTS[0], { headers: { Authorization: 'secret' } }],
    [DISCOVERY_REQUESTS[0], { method: 'POST', body: '{}' }],
    ['https://example.com/verify', { method: 'POST', body: '{}' }],
    [`${FACILITATOR}/verify`, { method: 'POST', body: '{}' }],
  ]) await assert.rejects(safe(url, init));
  assert.equal(forwarded, 0);
  await assert.rejects(guardedDiscoveryFetch(() => { forwarded++; })(`${FACILITATOR}/verify`, { method: 'POST', body: '{}' }));
  assert.equal(forwarded, 0);
});

test('registration refuses changed payment terms before generating a signer or contacting verify', async () => {
  const mock = transport({ altered: true });
  await assert.rejects(checkDiscovery({ register: true, fetchImpl: mock.fetch, createPayload: () => { throw new Error('Must not build a payload'); } }), /Unexpected payment terms/);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, 'GET');
});

test('genuine SDK registration echoes declarations and sends only verify; results never expose signed transactions', async () => {
  const methods = [];
  const rpc = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); methods.push(input.method);
    let result;
    if (input.method === 'getAccountInfo') {
      assert.equal(input.params[0], MINT);
      const data = Buffer.alloc(82); data[44] = 6; data[45] = 1;
      result = { context: { slot: 1000 }, value: { data: [data.toString('base64'), 'base64'], executable: false, lamports: 1000000, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 } };
    } else if (input.method === 'getLatestBlockhash') {
      result = { context: { slot: 1000 }, value: { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(10)), lastValidBlockHeight: 2000 } };
    } else { response.writeHead(400); response.end('Unexpected RPC'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  try {
    const createPayload = await createEphemeralPayloadBuilder({ rpcUrl: `http://127.0.0.1:${rpc.address().port}` });
    const mock = transport({ register: true });
    const result = await checkDiscovery({ register: true, fetchImpl: mock.fetch, createPayload });
    assert.equal(mock.calls.filter(call => call.method === 'POST').length, DISCOVERY_REQUESTS.length);
    assert.ok(mock.calls.filter(call => call.method === 'POST').every(call => call.url === `${FACILITATOR}/verify`));
    assert.ok(methods.every(method => ['getAccountInfo', 'getLatestBlockhash'].includes(method)));
    assert.ok(result.resources.every(resource => resource.registration.extension.status === 'processing' && resource.registration.isValid === false));
    assert.equal(result.fundsMoved, false);
    assert.doesNotMatch(JSON.stringify(result), /transaction|signature|keyPair/);
  } finally { rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve)); }
});
