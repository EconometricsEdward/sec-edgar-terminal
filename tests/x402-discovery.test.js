import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { bazaarResourceServerExtension, validateDiscoveryExtension, validateDiscoveryExtensionSpec, sanitizeResourceServiceMetadata, extractDiscoveryInfo } from '@x402/extensions/bazaar';
import { x402DiscoveryOptions, X402_OUTPUT_SCHEMAS } from '../src/utils/x402Discovery.js';
import { buildX402Catalog, X402_RESOURCES } from '../src/utils/x402Catalog.js';
import { buildAnalysisCompany, packAnalysisCompany } from '../src/utils/analysisResearch.js';
import { createPaidResearchReaders } from '../src/utils/x402Research.js';
import { X402_SOLANA_NETWORK } from '../src/utils/x402Payments.js';

const validators = Object.fromEntries(Object.entries(X402_OUTPUT_SCHEMAS).map(([id, schema]) => [id, new Ajv({ allErrors: true }).compile(schema)]));

test('all discovery declarations validate through the genuine SDK after transport enrichment', () => {
  for (const resource of X402_RESOURCES) {
    const options = x402DiscoveryOptions(resource.id);
    const path = new URL(resource.example, 'https://secedgarterminal.com').pathname;
    let extension = bazaarResourceServerExtension.enrichDeclaration(options.extensions.bazaar, {
      method: 'GET', routePattern: options.routePattern, adapter: { getPath: () => path },
    });
    if (options.omitDiscoveryRouteTemplate) {
      const { routeTemplate: _routeTemplate, ...concrete } = extension;
      extension = concrete;
    }
    assert.deepEqual(validateDiscoveryExtensionSpec(extension), { valid: true });
    assert.deepEqual(validateDiscoveryExtension(extension), { valid: true });
    assert.equal(extension.info.input.method, 'GET');
    assert.equal(extension.info.output.type, 'json');
    assert.equal(extension.info.output.example, undefined, 'No fabricated financial record is advertised as a live result.');
    assert.deepEqual(extension.schema.properties.output.properties.example, X402_OUTPUT_SCHEMAS[resource.id]);
    assert.deepEqual(sanitizeResourceServiceMetadata(options), {
      serviceName: 'SEC EDGAR Terminal', tags: options.tags, iconUrl: 'https://secedgarterminal.com/favicon.svg',
    });
    if (resource.id === 'financials') {
      assert.equal(options.routePattern, '/api/x402/v1/financials/:ticker');
      assert.equal(options.omitDiscoveryRouteTemplate, true);
      assert.equal(extension.routeTemplate, undefined);
      assert.deepEqual(extension.info.input.pathParams, { ticker: 'AAPL' });
      const extracted = extractDiscoveryInfo({
        x402Version: 2, resource: { url: `https://secedgarterminal.com${resource.example}`, ...options }, extensions: { bazaar: extension },
      }, {}, true);
      assert.equal(extracted.resourceUrl, 'https://secedgarterminal.com/api/x402/v1/financials/AAPL');
      assert.equal(extracted.serviceName, 'SEC EDGAR Terminal');
    }
  }
});

test('discovery output contracts validate actual prepared-reader responses and reject corrupt required fields', async () => {
  const at = Date.parse('2026-10-04T15:00:00Z');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/analysis-gs-sec-facts.json', import.meta.url), 'utf8'));
  const payload = packAnalysisCompany(buildAnalysisCompany({ ...fixture, cik: String(fixture.cik).padStart(10, '0') }, { basis: 'quarter' }));
  const readers = createPaidResearchReaders({
    now: () => at,
    financialRead: async () => ({ payload, metadata: { fetchedAt: new Date(at - 60000).toISOString(), expiresAt: new Date(at + 60000).toISOString() } }),
    universeRead: async () => ({ generated_at: '2026-10-04T14:00:00Z', rows: [{ ticker: 'GS', partial: true }] }),
    refinancingRead: async () => ({ generatedAt: '2026-10-04T14:00:00Z', companies: [{ ticker: 'GS', coverage: 'partial' }] }),
  });
  const financials = await (await readers.financials({ ticker: 'GS', basis: 'quarter' })).json();
  assert.equal(validators.financials(financials), true, JSON.stringify(validators.financials.errors));
  assert.equal(validators.financials({ ...financials, model: { ...financials.model, packed: false } }), false);
  for (const id of ['refinancing', 'factor-universe']) {
    const data = await (await readers.page(id, { ...(id === 'factor-universe' ? { basis: 'ttm' } : {}), limit: 100, offset: 0, snapshot: '' })).json();
    assert.equal(validators[id](data), true, JSON.stringify(validators[id].errors));
    assert.equal(validators[id]({ ...data, pagination: { ...data.pagination, snapshot: 'invalid-token' } }), false);
  }
});

test('CSV discovery advertises the selected representation and validates with the genuine SDK', () => {
  for (const id of ['financial-batch', 'fundamental-screen', 'credit-screen']) {
    const options = x402DiscoveryOptions(id, { format: 'csv' });
    const extension = bazaarResourceServerExtension.enrichDeclaration(options.extensions.bazaar, {
      method: 'GET', routePattern: options.routePattern, adapter: { getPath: () => options.routePattern },
    });
    assert.deepEqual(validateDiscoveryExtensionSpec(extension), { valid: true });
    assert.deepEqual(validateDiscoveryExtension(extension), { valid: true });
    assert.equal(extension.info.input.queryParams.format, 'csv');
    assert.equal(extension.info.output.type, 'text');
    assert.equal(extension.schema.properties.output.properties.example.type, 'string');
    assert.equal(extension.info.output.example, undefined);
  }
  assert.throws(() => x402DiscoveryOptions('financials', { format: 'csv' }), /CSV is unavailable/);
});

test('discovery query schemas reject unsupported fields and preserve endpoint-specific basis restrictions', () => {
  const query = id => new Ajv().compile(x402DiscoveryOptions(id).extensions.bazaar.schema.properties.input.properties.queryParams);
  const financials = query('financials');
  assert.equal(financials({ basis: 'quarter' }), true);
  assert.equal(financials({ basis: 'quarter', limit: 100 }), false);
  const refinancing = query('refinancing');
  assert.equal(refinancing({ limit: 1, offset: 0 }), true);
  assert.equal(refinancing({ basis: 'annual', limit: 1 }), false);
  const factor = query('factor-universe');
  assert.equal(factor({ basis: 'ttm', limit: 100, offset: 0 }), true);
  assert.equal(factor({ basis: 'quarter' }), false);
  assert.equal(factor({ limit: 101 }), false);
  assert.equal(factor({ snapshot: 'abc' }), false);
});

test('free catalog publishes every product discovery contract without claiming external directory listing', () => {
  const catalog = buildX402Catalog({ status: 'active', price: '0.01', currency: 'USDC', network: X402_SOLANA_NETWORK, protocol: 'x402', version: 2 });
  assert.equal(catalog.discovery.extension, 'bazaar');
  assert.equal(catalog.discovery.catalogRegistration, 'facilitator-dependent');
  assert.equal(catalog.discovery.indexing, 'concrete-path');
  assert.equal(catalog.resources.length, X402_RESOURCES.length);
  for (const resource of catalog.resources) {
    assert.equal(resource.price, '0.01');
    assert.equal(resource.amount, '10000');
    assert.ok(resource.discovery.extensions.bazaar.schema);
    const declaration = resource.discovery.extensions.bazaar;
    assert.deepEqual(validateDiscoveryExtension(declaration), { valid: true });
    assert.deepEqual(validateDiscoveryExtensionSpec(declaration), { valid: true });
    assert.equal(declaration.info.input.method, 'GET');
    if (resource.id === 'financials') {
      assert.deepEqual(declaration.info.input.pathParams, { ticker: 'AAPL' });
      const extracted = extractDiscoveryInfo({ x402Version: 2,
        resource: { url: `https://secedgarterminal.com${resource.example}` }, extensions: { bazaar: declaration },
      }, {}, true);
      assert.equal(extracted.resourceUrl, 'https://secedgarterminal.com/api/x402/v1/financials/AAPL');
    }
    assert.equal(resource.discovery.indexing, 'concrete-path');
    assert.equal(resource.discovery.routeTemplate, undefined);
    assert.equal(resource.discovery.listed, undefined);
  }
});
