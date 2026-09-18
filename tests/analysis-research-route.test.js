import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PreparedSecUnavailableError } from '../src/utils/secDocumentStore.js';
import { analysisSourceCachePolicy } from '../src/utils/analysisSourceCoverage.js';

function route({ prepared, failure, payload = { packed: true } } = {}) {
  const calls = [];
  const source = readFileSync(new URL('../src/app/api/analysis-research/route.js', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const testModule = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'next/server') return { NextResponse: Response };
    if (name.endsWith('/researchWorkspace.js')) return { validTicker: value => /^[A-Z]+$/.test(value) };
    if (name.endsWith('/preparedFinancialData.js')) return { readPreparedAnalysis: async () => { if (failure) throw failure; return prepared; } };
    if (name.endsWith('/analysisResearchServer.js')) return { loadInteractiveAnalysis: async (selection, signal) => {
      calls.push({ selection, signal }); return { payload, serializedPayload: JSON.stringify(payload), cacheSource: 'upstream' };
    } };
    if (name.endsWith('/secDocumentStore.js')) return { PreparedSecUnavailableError, preparedDataHeaders: () => ({}), preparedCacheControl: () => 'public, s-maxage=300' };
    if (name.endsWith('/analysisSourceCoverage.js')) return { analysisSourceCachePolicy };
    if (name.endsWith('/rateLimit.js')) return { checkRateLimit: async () => ({ allowed: true }), getClientIp: () => 'fixture' };
    throw new Error(`Unexpected route dependency ${name}`);
  }, testModule, testModule.exports);
  return { GET: testModule.exports.GET, calls };
}

test('missing prepared version uses bounded interactive calculation with the exact selection', async () => {
  const app = route({ failure: new PreparedSecUnavailableError(), payload: { packed: true, sourceCoverage: { continuity: { status: 'partial' } } } });
  const request = new Request('https://example.test/api/analysis-research?ticker=GS&basis=quarter&asOf=2025-08-01');
  const response = await app.GET(request);
  assert.equal(response.status, 200);
  assert.deepEqual(app.calls[0].selection, { ticker: 'GS', basis: 'quarter', asOf: '2025-08-01' });
  assert.equal(app.calls[0].signal, request.signal);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, s-maxage=60, must-revalidate');
});

test('valid prepared result avoids interactive loading; unrelated errors are not swallowed', async () => {
  const prepared = route({ prepared: { payload: { verified: true }, serializedPayload: '{"verified":true}' } });
  const response = await prepared.GET(new Request('https://example.test/api/analysis-research?ticker=GS'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { verified: true });
  assert.equal(prepared.calls.length, 0);
  const failed = route({ failure: new Error('Fixture calculation failure') });
  assert.equal((await failed.GET(new Request('https://example.test/api/analysis-research?ticker=GS'))).status, 502);
  assert.equal(failed.calls.length, 0);
});
