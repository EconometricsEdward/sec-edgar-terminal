import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { createX402Ledger } from '../src/utils/x402Ledger.js';
import { createX402DeliveryHandler } from '../src/utils/x402Delivery.js';
import { x402RecoveryToken } from '../src/utils/x402RecoveryToken.js';
import { createGateway, TRUST } from '../supabase/functions/edgar-data-gateway/handler.js';
import { validX402Rpc, X402_SOLANA_NETWORK, X402_SOLANA_USDC } from '../supabase/functions/edgar-data-gateway/x402Policy.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const capability = '42'.repeat(32), recoveryHash = sha(capability);
const payer = '5qe4MpMXzT6TeaUNZz7ApAzoQzTGpVWbz1VBGbGhrdiR';
const transaction = '3'.repeat(87); // 64-byte base58 fixture, never broadcast.
const request = (token = capability) => new Request('https://secedgarterminal.com/api/x402/v1/delivery', { headers: { 'X-X402-Recovery-Token': token } });

async function fixture() {
  const db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public to service_role;');
  for (const name of ['20261004152305_edgar_x402_payment_receipts.sql', '20261004160213_edgar_x402_solana_receipts.sql', '20261004225742_edgar_x402_delivery_recovery.sql'])
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  await db.exec('set role service_role');
  const calls = [];
  const fetchImpl = async (url, options) => {
    const name = url.split('/').at(-1), params = JSON.parse(options.body);
    calls.push({ name, params });
    assert.equal(options.headers.Authorization, 'Bearer workload.token.signed');
    let query, values;
    if (name === 'edgar_x402_claim') {
      query = 'select public.edgar_x402_claim($1,$2::jsonb,$3::uuid) as result'; values = [params.p_namespace, JSON.stringify(params.p_payment), params.p_owner];
    } else if (name === 'edgar_x402_finish') {
      query = 'select public.edgar_x402_finish($1,$2::jsonb,$3::jsonb) as result'; values = [params.p_namespace, JSON.stringify(params.p_claim), JSON.stringify(params.p_receipt)];
    } else if (name === 'edgar_x402_stage_delivery') {
      query = 'select public.edgar_x402_stage_delivery($1,$2::jsonb,$3::jsonb) as result'; values = [params.p_namespace, JSON.stringify(params.p_claim), JSON.stringify(params.p_delivery)];
    } else if (name === 'edgar_x402_recover_delivery') {
      query = 'select public.edgar_x402_recover_delivery($1,$2) as result'; values = [params.p_namespace, params.p_recovery_hash];
    } else throw new Error('Unexpected RPC');
    try { return Response.json((await db.query(query, values)).rows[0].result); }
    catch (error) { return Response.json({ code: error.code }, { status: 409 }); }
  };
  const ledger = createX402Ledger({ env: { VERCEL_ENV: 'production' }, fetchImpl, identityTokenImpl: async () => 'workload.token.signed' });
  async function claim(label = randomUUID()) {
    const proof = sha(label);
    return ledger.claim({ paymentHash: proof, resourceUrl: 'https://secedgarterminal.com/api/x402/v1/factor-export?basis=ttm&format=csv',
      payer, payTo: payer, asset: X402_SOLANA_USDC, network: X402_SOLANA_NETWORK, amount: '10000', nonce: proof,
      validBefore: String(Math.floor(Date.now() / 1000) + 300), requestId: randomUUID() });
  }
  return { db, ledger, calls, claim };
}

test('exact bytes survive storage and response loss; recovery has no second payment or handler invocation', async () => {
  const { db, ledger, calls, claim } = await fixture();
  try {
    const token = (await claim()).token;
    const bytes = Buffer.from('ticker,company,value\r\nAAPL,"Example, Inc.",42\r\n');
    const staged = await ledger.stageDelivery({ token, recoveryHash, bytes, status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="factors.csv"',
        'x-schema-version': 'edgar.paid-fundamental-screen.v1',
        'set-cookie': 'never-store-cookie', 'payment-signature': 'never-store-proof' } });
    assert.ok(Date.parse(staged.expiresAt) > Date.now() + 23 * 3600000);
    const pending = await ledger.recoverDelivery(recoveryHash);
    assert.equal(pending.status, 'pending'); assert.equal(pending.delivery, undefined);
    await ledger.finish({ token, status: 'settled', transaction, payer, network: X402_SOLANA_NETWORK });
    const get = createX402DeliveryHandler({ ledger });
    for (let count = 0; count < 2; count++) {
      const response = await get(request());
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.equal(response.headers.get('X-Content-SHA256'), sha(bytes));
      assert.equal(response.headers.get('X-X402-Recovered'), '1');
      assert.equal(response.headers.get('content-disposition'), 'attachment; filename="factors.csv"');
      assert.equal(response.headers.get('x-schema-version'), 'edgar.paid-fundamental-screen.v1');
      assert.equal(response.headers.get('set-cookie'), null);
      const receipt = JSON.parse(Buffer.from(response.headers.get('PAYMENT-RESPONSE'), 'base64').toString('utf8'));
      assert.equal(receipt.success, true); assert.equal(receipt.transaction, transaction);
    }
    assert.equal(calls.filter(call => call.name === 'edgar_x402_claim').length, 1);
    assert.equal(calls.filter(call => call.name === 'edgar_x402_finish').length, 1);
    assert.ok(!JSON.stringify(calls).includes(capability));
    assert.ok(!JSON.stringify(calls).includes('never-store'));
    const schema = (await db.query("select relrowsecurity from pg_class where relname='x402_deliveries'")).rows[0];
    assert.equal(schema.relrowsecurity, true);
  } finally { await db.close(); }
});

test('pending and failed receipts never disclose the prepared response', async () => {
  const { db, ledger, claim } = await fixture();
  try {
    const token = (await claim()).token;
    await ledger.stageDelivery({ token, recoveryHash, bytes: Buffer.from('{"private":"paid"}'), status: 200, headers: { 'content-type': 'application/json' } });
    const get = createX402DeliveryHandler({ ledger });
    const pending = await get(request());
    assert.equal(pending.status, 202); assert.doesNotMatch(await pending.text(), /private|gzipBase64|paid/);
    await ledger.finish({ token, status: 'failed', errorCode: 'payment_rejected' });
    const failed = await get(request());
    assert.equal(failed.status, 409); assert.doesNotMatch(await failed.text(), /private|gzipBase64|paid/);
  } finally { await db.close(); }
});

test('capabilities cannot cross purchases or namespaces, alter content, or retrieve expired content', async () => {
  const { db, ledger, claim } = await fixture();
  try {
    const token = (await claim()).token;
    const args = { token, recoveryHash, bytes: Buffer.from('{"stable":1}'), status: 200, headers: { 'content-type': 'application/json' } };
    await ledger.stageDelivery(args);
    await ledger.stageDelivery(args); // Idempotent and immutable.
    await assert.rejects(ledger.stageDelivery({ ...args, bytes: Buffer.from('{"stable":2}') }));
    const other = (await claim()).token;
    await assert.rejects(ledger.stageDelivery({ ...args, token: other }));
    assert.equal((await ledger.recoverDelivery(sha('another capability'))).found, false);
    assert.deepEqual((await db.query('select public.edgar_x402_recover_delivery($1,$2) as result', ['another', recoveryHash])).rows[0].result, { found: false });
    await ledger.finish({ token, status: 'settled', transaction, payer, network: X402_SOLANA_NETWORK });
    await db.exec("reset role; update edgar_private.x402_deliveries set expires_at=clock_timestamp()-interval '1 second'; set role service_role");
    const response = await createX402DeliveryHandler({ ledger })(request());
    assert.equal(response.status, 404); assert.equal((await ledger.recoverDelivery(recoveryHash)).found, false);
  } finally { await db.close(); }
});

test('private response table and both invoker RPCs deny anonymous/authenticated access', async () => {
  const { db } = await fixture();
  try {
    const functions = (await db.query("select prosecdef from pg_proc where proname in ('edgar_x402_stage_delivery','edgar_x402_recover_delivery')")).rows;
    assert.equal(functions.length, 2); assert.ok(functions.every(value => !value.prosecdef));
    await assert.rejects(db.query("update edgar_private.x402_deliveries set response_headers='{}'::jsonb"), { code: '42501' });
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}`);
      await assert.rejects(db.query('select * from edgar_private.x402_deliveries'), { code: '42501' });
      await assert.rejects(db.query('select public.edgar_x402_recover_delivery($1,$2)', ['production', recoveryHash]), { code: '42501' });
      await assert.rejects(db.query('select public.edgar_x402_stage_delivery($1,$2::jsonb,$3::jsonb)', ['production', '{}', '{}']), { code: '42501' });
    }
  } finally { await db.close(); }
});

test('delivery API rejects missing, duplicate, malformed capabilities and query secrets before lookup', async () => {
  let reads = 0;
  const get = createX402DeliveryHandler({ ledger: { recoverDelivery: async () => { reads++; return { found: false }; } } });
  for (const token of ['', '42'.repeat(31), 'AA'.repeat(32), `${capability},${capability}`, '../key']) {
    assert.equal((await get(request(token))).status, 400);
    assert.throws(() => x402RecoveryToken(request(token), { required: true }));
  }
  assert.equal((await get(new Request('https://secedgarterminal.com/api/x402/v1/delivery'))).status, 400);
  assert.equal((await get(new Request(`https://secedgarterminal.com/api/x402/v1/delivery?token=${capability}`, { headers: request().headers }))).status, 400);
  const payment = request(); payment.headers.set('PAYMENT-SIGNATURE', 'not-resubmitted');
  assert.equal((await get(payment)).status, 400);
  assert.equal(reads, 0);
  assert.equal((await get(request())).status, 404); assert.equal(reads, 1);
});

test('gateway requires authenticated production identity and admits only hashed bounded recovery lookup', async () => {
  let forwarded = 0;
  const claims = { iss: TRUST.issuer, aud: TRUST.audience, sub: TRUST.subject, owner: TRUST.owner,
    owner_id: TRUST.ownerId, project: TRUST.project, project_id: TRUST.projectId, environment: 'production',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 };
  const gateway = createGateway({ verifyToken: async () => claims,
    env: name => ({ SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_fixture_never_exposed' })[name],
    fetchImpl: async (_url, init) => { forwarded++; const params = JSON.parse(init.body); assert.equal(params.p_namespace, 'production'); return Response.json({ found: false }); } });
  const url = 'https://gateway.example/functions/v1/edgar-data-gateway/rest/v1/rpc/edgar_x402_recover_delivery';
  const rpc = body => new Request(url, { method: 'POST', headers: { authorization: 'Bearer synthetic.token.signature', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await gateway(new Request(url))).status, 401);
  for (const body of [{ p_recovery_hash: capability, unexpected: true }, { p_recovery_hash: 'bad' }])
    assert.equal((await gateway(rpc(body))).status, 422);
  assert.equal((await gateway(rpc({ p_namespace: 'preview', p_recovery_hash: recoveryHash }))).status, 403);
  assert.equal(forwarded, 0);
  assert.equal((await gateway(rpc({ p_recovery_hash: recoveryHash }))).status, 200);
  assert.equal(forwarded, 1);
  assert.equal(validX402Rpc('edgar_x402_recover_delivery', { p_recovery_hash: 'bad' }), false);
  const bytes = Buffer.from('{"bounded":true}'), compressed = gzipSync(bytes);
  const delivery = { recoveryHash, gzipBase64: compressed.toString('base64'), gzipHash: sha(compressed), contentHash: sha(bytes),
    rawBytes: bytes.length, status: 200, headers: { 'content-type': 'application/json' } };
  const stage = params => new Request(url.replace('edgar_x402_recover_delivery', 'edgar_x402_stage_delivery'), {
    method: 'POST', headers: { authorization: 'Bearer synthetic.token.signature', 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const token = { paymentHash: sha('claim'), owner: randomUUID() };
  for (const patch of [{ contentHash: sha('wrong') }, { gzipHash: sha('wrong') }, { rawBytes: bytes.length + 1 }])
    assert.equal((await gateway(stage({ p_claim: token, p_delivery: { ...delivery, ...patch } }))).status, 422);
  const large = Buffer.alloc(4 * 1024 * 1024 + 1), oversizedGzip = gzipSync(large);
  assert.equal((await gateway(stage({ p_claim: token, p_delivery: { ...delivery, gzipBase64: oversizedGzip.toString('base64'),
    gzipHash: sha(oversizedGzip), contentHash: sha(large), rawBytes: 1 } }))).status, 413);
  assert.equal(forwarded, 1, 'corrupt bytes never reach the database');
  assert.equal((await gateway(stage({ p_claim: token, p_delivery: delivery }))).status, 200);
  assert.equal(forwarded, 2);
});

test('adapter refuses oversized data before RPC, and damaged recovered bytes never reach a buyer', async () => {
  let calls = 0;
  const bytes = Buffer.from('{"payload":42}'), compressed = gzipSync(bytes);
  const result = { found: true, status: 'settled', expiresAt: '2026-10-05T00:00:00.000Z', paymentHash: sha('proof'), transaction, payer,
    network: X402_SOLANA_NETWORK, delivery: { gzipBase64: compressed.toString('base64'), gzipHash: sha(compressed), contentHash: sha('wrong'),
      rawBytes: bytes.length, status: 200, headers: { 'content-type': 'application/json' } } };
  const ledger = createX402Ledger({ env: { VERCEL_ENV: 'production' }, identityTokenImpl: async () => 'workload.token.signed',
    fetchImpl: async () => { calls++; return Response.json(result); } });
  await assert.rejects(ledger.stageDelivery({ token: { paymentHash: sha('proof'), owner: randomUUID() }, recoveryHash,
    bytes: Buffer.alloc(4 * 1024 * 1024 + 1), status: 200, headers: { 'content-type': 'application/json' } }), { code: 'invalid_delivery' });
  assert.equal(calls, 0);
  await assert.rejects(ledger.recoverDelivery(recoveryHash), { code: 'delivery_integrity_failure' });
  const response = await createX402DeliveryHandler({ ledger })(request());
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /payload/);
  let exposed = false;
  const preview = createX402Ledger({ env: { VERCEL_ENV: 'preview' }, fetchImpl: async () => { exposed = true; } });
  await assert.rejects(preview.recoverDelivery(recoveryHash), { code: 'preview_payment_ledger_denied' });
  assert.equal(exposed, false);
});
