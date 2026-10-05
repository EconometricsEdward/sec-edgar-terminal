import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDiscoveryExtension, validateDiscoveryExtensionSpec } from '@x402/extensions/bazaar';
import { buildX402Documentation, createX402DocumentationHandlers } from '../src/utils/x402Documentation.js';
import { buildX402Catalog, X402_RESOURCES } from '../src/utils/x402Catalog.js';
import { buildX402BuyerExample } from '../src/utils/x402BuyerExample.js';
import { getX402PublicConfiguration } from '../src/utils/x402Payments.js';
import { HEAD, OPTIONS } from '../src/app/data-access/route.js';

const configuration = getX402PublicConfiguration({ NODE_ENV: 'production', VERCEL_ENV: 'production' });

test('machine documentation preserves all catalog contracts, strict Bazaar metadata and the tested effective buyer source', () => {
  const documentation = buildX402Documentation(configuration);
  assert.equal(documentation.schemaVersion, 'edgar.x402-documentation.v1');
  assert.deepEqual(documentation.catalog, buildX402Catalog(configuration));
  assert.equal(documentation.catalog.resources.length, 11);
  assert.deepEqual(documentation.catalog.resources.map(resource => resource.id), X402_RESOURCES.map(resource => resource.id));
  for (const resource of documentation.catalog.resources) {
    assert.deepEqual(validateDiscoveryExtensionSpec(resource.discovery.extensions.bazaar), { valid: true });
    assert.deepEqual(validateDiscoveryExtension(resource.discovery.extensions.bazaar), { valid: true });
    assert.equal(resource.amount, '10000');
    assert.equal(resource.price, '0.01');
  }
  assert.equal(documentation.integration.clientStarter.source, buildX402BuyerExample(configuration));
  assert.ok(documentation.integration.clientStarter.source.includes(configuration.payTo));
  assert.equal(documentation.preflight.products.length, 5);
  for (const preflight of documentation.preflight.products) {
    const resource = X402_RESOURCES.find(resource => resource.id === preflight.id);
    const url = new URL(preflight.example);
    assert.equal(url.pathname, '/api/x402/availability');
    assert.equal(url.searchParams.get('product'), resource.id);
    url.searchParams.delete('product');
    assert.equal(url.searchParams.toString(), new URL(resource.example, documentation.url).searchParams.toString());
  }
});

function assertDocumentHeaders(response) {
  assert.match(response.headers.get('Content-Type'), /^application\/json/);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
  assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'Link');
  assert.equal(response.headers.get('Allow'), 'GET, HEAD, OPTIONS');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, follow');
  assert.match(response.headers.get('Link'), /api\/x402.*application\/json/);
  assert.match(response.headers.get('Link'), /openapi\.json.*service-desc/);
  assert.equal(response.headers.get('PAYMENT-REQUIRED'), null);
  assert.equal(response.headers.get('PAYMENT-RESPONSE'), null);
}

test('free machine GET is JSON with live public configuration and the same instructions for browsers and crawlers', async () => {
  let reads = 0;
  const handlers = createX402DocumentationHandlers(async () => { reads++; return configuration; });
  const bodies = [];
  for (const userAgent of ['Mozilla/5.0', 'AgentCrawler/1.0']) {
    const response = await handlers.GET(new Request('https://secedgarterminal.com/data-access', { headers: { 'User-Agent': userAgent } }));
    assert.equal(response.status, 200);
    assertDocumentHeaders(response);
    const body = await response.json();
    assert.equal(body.catalog.payTo, configuration.payTo);
    assert.equal(body.access.discoveryFree, true);
    assert.equal(body.catalog.status, configuration.status);
    bodies.push(body);
  }
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(reads, 2);
});

test('machine document HEAD and OPTIONS are bodyless and never perform configuration or recipient readiness reads', async () => {
  const handlers = createX402DocumentationHandlers(() => { throw new Error('A probe must not read dependencies'); });
  for (const [method, expectedStatus] of [['HEAD', 200], ['OPTIONS', 204]]) {
    const response = handlers[method]();
    assert.equal(response.status, expectedStatus);
    assertDocumentHeaders(response);
    assert.equal(response.body, null);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('Content-Length'), null);
  }
  for (const handler of [HEAD, OPTIONS]) {
    const response = await handler();
    assertDocumentHeaders(response);
    assert.equal(response.body, null);
  }
});

test('machine documentation accurately preserves unavailable payment states without inventing an active recipient', async () => {
  for (const status of ['configuration-required', 'recipient-setup-required', 'recipient-check-unavailable']) {
    const publicConfiguration = { ...configuration, status };
    if (status === 'configuration-required') delete publicConfiguration.payTo;
    const handlers = createX402DocumentationHandlers(async () => publicConfiguration);
    const response = await handlers.GET();
    const documentation = await response.json();
    assert.equal(response.status, 200);
    assert.equal(documentation.catalog.status, status);
    assert.equal(documentation.billing.status, status);
    assert.equal(documentation.catalog.payTo, publicConfiguration.payTo);
    assert.equal(documentation.integration.clientStarter.source, buildX402BuyerExample(publicConfiguration));
    assert.ok(documentation.billing.readiness[status]);
    assert.equal(documentation.deliveryRecovery.tokenHeader, 'X-X402-Recovery-Token');
    assert.equal(documentation.deliveryRecovery.method, 'GET');
  }
});
