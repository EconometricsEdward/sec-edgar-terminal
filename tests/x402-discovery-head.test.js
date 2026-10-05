import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { extractDiscoveryInfo, validateDiscoveryExtension, validateDiscoveryExtensionSpec } from '@x402/extensions/bazaar';
import { createX402DiscoveryHead, getX402Config, X402_AMOUNT, X402_SOLANA_NETWORK, X402_SOLANA_USDC } from '../src/utils/x402Payments.js';
import { X402_RESOURCES } from '../src/utils/x402Catalog.js';
import { x402DiscoveryOptions, X402_DISCOVERY_DESCRIPTORS } from '../src/utils/x402Discovery.js';

const recipient = '5qe4MpMXzT6TeaUNZz7ApAzoQzTGpVWbz1VBGbGhrdiR';
const config = getX402Config({ NODE_ENV: 'production', X402_PAY_TO: recipient });
const origin = 'https://secedgarterminal.com';
const headRequest = (url, headers) => new Request(url, { method: 'HEAD', headers });
const decode = response => decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED'));

function fixture(options = {}) {
  const state = { supported: 0, verifies: 0, settles: 0, ledger: 0, recipient: 0, validates: 0 };
  const forbiddenLedgerCall = () => { state.ledger++; throw new Error('Discovery never uses the payment ledger'); };
  const head = createX402DiscoveryHead({
    description: 'Prepared research with documented GET selectors; a probe does not check data availability.',
    config,
    ...x402DiscoveryOptions('bank-risk-batch'),
    facilitatorClient: {
      async getSupported() {
        state.supported++;
        return { kinds: [{ x402Version: 2, scheme: 'exact', network: X402_SOLANA_NETWORK, extra: { feePayer: recipient } }], extensions: ['bazaar'], signers: {} };
      },
      verify() { state.verifies++; throw new Error('Discovery never verifies buyer payment'); },
      settle() { state.settles++; throw new Error('Discovery never settles buyer payment'); },
    },
    ledger: { ready: forbiddenLedgerCall, claim: forbiddenLedgerCall, finish: forbiddenLedgerCall, stageDelivery: forbiddenLedgerCall },
    recipientCheck: async () => { state.recipient++; return { ready: true }; },
    ...options,
  });
  return { head, state };
}

async function assertBodyless(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.body, null);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('Content-Length'), null);
  assert.match(response.headers.get('Cache-Control'), /private.*no-store/);
  assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
  assert.match(response.headers.get('Access-Control-Expose-Headers'), /PAYMENT-REQUIRED/);
  assert.match(response.headers.get('Link'), /openapi\.json.*service-desc/);
  if (status !== 402) assert.equal(response.headers.get('PAYMENT-REQUIRED'), null);
}

test('all eleven query-free catalog URLs expose valid bodyless GET discovery challenges without buyer or ledger work', async () => {
  for (const resource of X402_RESOURCES) {
    const options = x402DiscoveryOptions(resource.id);
    const url = new URL(resource.example, origin);
    url.search = '';
    const { head, state } = fixture(options);
    const response = await head(headRequest(url.href));
    await assertBodyless(response, 402);
    const offer = decode(response);
    assert.equal(offer.x402Version, 2);
    assert.equal(offer.resource.url, url.href);
    assert.equal(offer.resource.mimeType, 'application/json');
    assert.equal(offer.resource.serviceName, 'SEC EDGAR Terminal');
    assert.equal(offer.accepts.length, 1);
    assert.equal(offer.accepts[0].network, X402_SOLANA_NETWORK);
    assert.equal(offer.accepts[0].asset, X402_SOLANA_USDC);
    assert.equal(offer.accepts[0].payTo, recipient);
    assert.equal(offer.accepts[0].amount, X402_AMOUNT);
    assert.equal(offer.accepts[0].extra.feePayer, recipient);
    const declaration = offer.extensions.bazaar;
    assert.deepEqual(validateDiscoveryExtensionSpec(declaration), { valid: true });
    assert.deepEqual(validateDiscoveryExtension(declaration), { valid: true });
    assert.equal(declaration.info.input.method, 'GET');
    assert.equal(declaration.info.output.type, 'json');
    assert.equal(declaration.info.output.example, undefined);
    assert.deepEqual(declaration.schema.properties.input.properties.queryParams, X402_DISCOVERY_DESCRIPTORS[resource.id].inputSchema);
    const discovery = extractDiscoveryInfo(offer, {}, true);
    assert.equal(discovery.resourceUrl, url.href);
    if (resource.id === 'financials') {
      assert.deepEqual(declaration.info.input.pathParams, { ticker: 'AAPL' });
      assert.equal(declaration.routeTemplate, undefined);
    }
    await assertBodyless(await head(headRequest(url.href)), 402);
    assert.equal(state.supported, 1, 'Repeated HEAD shares one capability initialization');
    assert.equal(state.verifies, 0);
    assert.equal(state.settles, 0);
    assert.equal(state.ledger, 0);
  }
});

test('HEAD rejects every payment or recovery header by presence before validation, recipient or capability reads', async () => {
  const { head, state } = fixture({
    config: { ...config, requireRecipientReady: true },
    validate: () => { state.validates++; },
  });
  for (const name of ['PAYMENT-SIGNATURE', 'X-PAYMENT', 'X-X402-Recovery-Token', 'Authorization']) {
    for (const value of ['', 'buyer-proof', 'proof, duplicate-proof']) {
      await assertBodyless(await head(headRequest(`${origin}/api/x402/v1/bank-risk-batch`, { [name]: value })), 400);
    }
  }
  assert.deepEqual(state, { supported: 0, verifies: 0, settles: 0, ledger: 0, recipient: 0, validates: 0 });
});

test('disabled, incomplete, preview and production devnet configurations never advertise an active challenge', async () => {
  for (const environment of [
    { X402_PAY_TO: recipient, X402_ENABLED: 'off' },
    {},
    { X402_PAY_TO: recipient, VERCEL_ENV: 'preview' },
    { NODE_ENV: 'production', X402_PAY_TO: recipient, X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
  ]) {
    const { head, state } = fixture({ config: getX402Config(environment) });
    await assertBodyless(await head(headRequest(`${origin}/api/x402/v1/bank-risk-batch`)), 503);
    assert.equal(state.supported, 0);
    assert.equal(state.recipient, 0);
  }
});

test('production discovery checks public recipient readiness and suppresses offers when the account or RPC is unavailable', async () => {
  for (const check of [async () => ({ ready: false }), async () => { throw new Error('RPC unavailable'); }]) {
    const { head, state } = fixture({ config: { ...config, requireRecipientReady: true }, recipientCheck: check });
    await assertBodyless(await head(headRequest(`${origin}/api/x402/v1/bank-risk-batch`)), 503);
    assert.equal(state.supported, 0);
    assert.equal(state.verifies, 0);
    assert.equal(state.settles, 0);
  }
  const { head, state } = fixture({ config: { ...config, requireRecipientReady: true } });
  await assertBodyless(await head(headRequest(`${origin}/api/x402/v1/bank-risk-batch`)), 402);
  assert.equal(state.recipient, 1);
  assert.equal(state.supported, 1);
});

test('facilitator failures use the existing cooldown and unsupported capabilities cannot produce misleading offers', async () => {
  for (const supported of [
    async () => { throw new Error('Capabilities unavailable'); },
    async () => ({ kinds: [], extensions: ['bazaar'], signers: {} }),
  ]) {
    let capabilities = 0;
    const { head, state } = fixture({ facilitatorClient: {
      getSupported: () => { capabilities++; return supported(); },
      verify: () => { state.verifies++; },
      settle: () => { state.settles++; },
    } });
    await assertBodyless(await head(headRequest(`${origin}/api/x402/v1/bank-risk-batch`)), 503);
    await assertBodyless(await head(headRequest(`${origin}/api/x402/v1/bank-risk-batch`)), 503);
    assert.equal(capabilities, 1);
    assert.equal(state.verifies, 0);
    assert.equal(state.settles, 0);
  }
});

test('CSV HEAD retains exact selected URL, GET input and CSV output declaration', async () => {
  const url = `${origin}/api/x402/v1/bank-risk-batch?rssds=852218%2C480228&period=2026-06-30&format=csv`;
  const { head } = fixture({ ...x402DiscoveryOptions('bank-risk-batch', { format: 'csv' }), mimeType: 'text/csv', allowCsv: true });
  const response = await head(headRequest(url));
  await assertBodyless(response, 402);
  const offer = decode(response);
  assert.equal(offer.resource.url, url);
  assert.equal(offer.resource.mimeType, 'text/csv');
  assert.equal(offer.extensions.bazaar.info.input.method, 'GET');
  assert.equal(offer.extensions.bazaar.info.input.queryParams.format, 'csv');
  assert.equal(offer.extensions.bazaar.info.output.type, 'text');
  assert.deepEqual(validateDiscoveryExtension(offer.extensions.bazaar), { valid: true });
});

test('selector errors and unsupported MIME types remain bodyless without facilitator work', async () => {
  const context = { ticker: '123' };
  const { head, state } = fixture({ validate: (request, input) => {
    assert.equal(input, context);
    assert.equal(request.method, 'HEAD');
    return Response.json({ error: 'Invalid selector' }, { status: 400, headers: { ETag: 'bad', 'Content-Length': '88' } });
  } });
  const response = await head(headRequest(`${origin}/api/x402/v1/bank-risk-batch?rssds=invalid`), context);
  await assertBodyless(response, 400);
  assert.equal(response.headers.get('ETag'), null);
  assert.equal(state.supported, 0);
  const invalidMime = fixture({ mimeType: 'text/html' });
  await assertBodyless(await invalidMime.head(headRequest(`${origin}/api/x402/v1/bank-risk-batch`)), 400);
  assert.equal(invalidMime.state.supported, 0);
});

test('discovery factory never handles a purchase, oversized resource URL, or mismatched route', async () => {
  const { head, state } = fixture();
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    await assertBodyless(await head(new Request(`${origin}/api/x402/v1/bank-risk-batch`, { method })), 405);
  }
  await assertBodyless(await head(headRequest(`${origin}/api/x402/v1/bank-risk-batch?unknown=${'a'.repeat(2048)}`)), 414);
  assert.equal(state.supported, 0);
  await assertBodyless(await head(headRequest(`${origin}/api/x402/v1/another-resource`)), 503);
  assert.equal(state.verifies, 0);
  assert.equal(state.settles, 0);
  assert.equal(state.ledger, 0);
});
