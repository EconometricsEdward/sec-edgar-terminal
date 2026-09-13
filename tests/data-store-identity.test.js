import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataStore, getDataStoreMode } from '../src/utils/dataStore.js';
import { isSecMigrationScheduleEnabled } from '../src/utils/dataStoreDeployment.js';

test('production uses request-scoped workload identity without exporting a Supabase key', async () => {
  let issued = 0;
  const calls = [];
  const store = createDataStore({ env: { VERCEL_ENV: 'production', EDGAR_DATASTORE_SEC: 'shadow' },
    identityTokenImpl: async () => `short.lived.${++issued}`,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(null);
    } });
  await store.readDataset('sec', 'sec-documents-v1:CIK0000320193:companyfacts');
  await store.readDataset('sec', 'sec-documents-v1:CIK0000320193:companyfacts');
  assert.equal(issued, 2);
  for (const [i, { url, options }] of calls.entries()) {
    assert.equal(url, 'https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway/rest/v1/rpc/edgar_get_version');
    assert.equal(options.headers.Authorization, `Bearer short.lived.${i + 1}`);
    assert.equal(options.headers.apikey, undefined);
    assert.equal(options.headers['x-region'], 'us-east-1');
    assert.equal(JSON.parse(options.body).p_namespace, 'production');
    assert.equal(options.redirect, 'error');
  }
});

test('identity cannot target another endpoint or namespace and errors never reveal tokens', async () => {
  const make = env => createDataStore({ env: { VERCEL_ENV: 'production', ...env },
    identityTokenImpl: async () => { throw new Error('sensitive.token.value'); },
    fetchImpl: async () => assert.fail('no transport expected') });
  await assert.rejects(make({ SUPABASE_URL: 'https://attacker.example' }).readDataStoreStatus(), { code: 'unapproved_endpoint' });
  await assert.rejects(make({ SUPABASE_URL: 'http://127.0.0.1:54321' }).readDataStoreStatus(), { code: 'unapproved_identity_endpoint' });
  await assert.rejects(make({ EDGAR_DATASTORE_NAMESPACE: 'rehearsal' }).readDataStoreStatus(), { code: 'production_namespace_mismatch' });
  await assert.rejects(make({}).readDataStoreStatus(), error => error.code === 'transport_failure' && !error.message.includes('sensitive'));
});

test('explicit independent switches override reviewed deployment defaults; previews remain off', async () => {
  assert.equal(getDataStoreMode('sec', { VERCEL_ENV: 'preview' }), 'off');
  assert.equal(getDataStoreMode('sec', {}), 'off');
  assert.equal(getDataStoreMode('sec', { VERCEL_ENV: 'production', EDGAR_DATASTORE_SEC: 'off' }), 'off');
  assert.equal(getDataStoreMode('sec', { VERCEL_ENV: 'production', EDGAR_DATASTORE_SEC: 'typo' }), 'off');
  assert.equal(getDataStoreMode('financial', { VERCEL_ENV: 'production', EDGAR_DATASTORE_FINANCIAL: 'shadow' }), 'shadow');
  assert.equal(isSecMigrationScheduleEnabled({ VERCEL_ENV: 'preview' }), false);
  assert.equal(isSecMigrationScheduleEnabled({ VERCEL_ENV: 'production', EDGAR_DATASTORE_SEC_SCHEDULE: '0' }), false);
  const store = createDataStore({ env: { VERCEL_ENV: 'production', EDGAR_DATASTORE_SEC: 'off' },
    identityTokenImpl: async () => assert.fail('off must not acquire credentials') });
  assert.equal(await store.readDataset('sec', 'unused'), null);
});
