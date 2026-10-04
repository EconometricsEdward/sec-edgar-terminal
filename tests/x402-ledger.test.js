import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createX402Ledger } from '../src/utils/x402Ledger.js';
import { createGateway, TRUST } from '../supabase/functions/edgar-data-gateway/handler.js';
import { validBase58Bytes, X402_SOLANA_NETWORK, X402_SOLANA_USDC, validX402Payment } from '../supabase/functions/edgar-data-gateway/x402Policy.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`), result = '';
  while (value > 0n) { result = BASE58[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = `1${result}`; }
  return result;
}
const payer = encodeBase58(Buffer.alloc(32, 1));
const payTo = 'H6VfqLdNwYfFmA54TQeL28sx2LyWE1E5FLX6XGEN3pmb';
const nonce = sha('decoded signed message');
const asset = X402_SOLANA_USDC;
const network = X402_SOLANA_NETWORK, transaction = encodeBase58(Buffer.alloc(64, 4));
const resourceUrl = 'https://secedgarterminal.com/api/x402/v1/company/0000320193?snapshot=abc';
function payment(overrides = {}) {
  return { paymentHash: sha('authorization'), resourceUrl, resourceHash: sha(resourceUrl), payer, payTo, asset, network,
    amount: '10000', nonceHash: nonce, validBefore: String(Math.floor(Date.now() / 1000) + 300), ...overrides };
}
async function database({ beforeSolana } = {}) {
  const db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public to service_role;');
  await db.exec(await readFile(new URL('../supabase/migrations/20261004152305_edgar_x402_payment_receipts.sql', import.meta.url), 'utf8'));
  if (beforeSolana) await beforeSolana(db);
  await db.exec(await readFile(new URL('../supabase/migrations/20261004160213_edgar_x402_solana_receipts.sql', import.meta.url), 'utf8'));
  await db.exec('set role service_role');
  return db;
}

test('Solana migration preserves old Base ownership and receipts, and denies new Base claims', async () => {
  const legacyPayer = `0x${'1'.repeat(40)}`, legacyPayTo = `0x${'2'.repeat(40)}`;
  const legacyNetwork = 'eip155:8453', legacyTransaction = `0x${'4'.repeat(64)}`;
  const legacy = payment({ payer: legacyPayer, payTo: legacyPayTo, network: legacyNetwork,
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' });
  let oldClaim;
  const db = await database({ beforeSolana: async db => { oldClaim = await claim(db, legacy); } });
  try {
    assert.equal(oldClaim.claimed, true);
    await assert.rejects(claim(db, { ...legacy, paymentHash: sha('new-base-claim'), nonceHash: sha('new-base-nonce') }), { code: '22023' });
    assert.deepEqual(await finish(db, oldClaim.token, { status: 'settled', transaction: legacyTransaction,
      payer: legacyPayer, network: legacyNetwork }), { finished: true, status: 'settled' });
    const { rows: [stored] } = await db.query('select * from edgar_private.x402_receipts');
    assert.equal(stored.payer, legacyPayer); assert.equal(stored.pay_to, legacyPayTo);
    assert.equal(stored.transaction_hash, legacyTransaction); assert.equal(stored.owner, oldClaim.token.owner);
  } finally { await db.close(); }
});

test('case-sensitive Solana Base58 validation checks decoded sizes in JS and SQL', async () => {
  const db = await database();
  try {
    for (const [value, bytes, expected] of [
      [payer, 32, true], [payTo, 32, true], [asset, 32, true], [transaction, 64, true],
      ['1'.repeat(31), 32, false], ['z'.repeat(44), 32, false], ['z'.repeat(88), 64, false],
      ['0'.repeat(32), 32, false], [transaction.slice(1), 64, false],
    ]) {
      assert.equal(validBase58Bytes(value, bytes), expected, value);
      const result = await db.query('select edgar_private.x402_base58_bytes($1::text,$2::integer) as valid', [value, bytes]);
      assert.equal(result.rows[0].valid, expected, value);
    }
    const claimed = await claim(db);
    await finish(db, claimed.token, { status: 'settled', transaction, payer, network });
    const { rows: [row] } = await db.query('select * from edgar_private.x402_receipts');
    assert.equal(row.pay_to, payTo); assert.equal(row.payer, payer); assert.equal(row.asset, asset);
    assert.equal(row.transaction_hash, transaction);
    assert.notEqual(row.pay_to, row.pay_to.toLowerCase());
    assert.notEqual(row.transaction_hash, row.transaction_hash.toLowerCase());
  } finally { await db.close(); }
});
async function claim(db, pay = payment(), owner = randomUUID()) {
  const result = await db.query('select public.edgar_x402_claim($1::text,$2::jsonb,$3::uuid) as value', ['production', pay, owner]);
  return result.rows[0].value;
}
async function finish(db, token, receipt) {
  const result = await db.query('select public.edgar_x402_finish($1::text,$2::jsonb,$3::jsonb) as value', ['production', token, receipt]);
  return result.rows[0].value;
}

test('exact migration atomically rejects concurrent proof and cross-resource nonce replay', async () => {
  const db = await database();
  try {
    const competing = await Promise.all(Array.from({ length: 12 }, () => claim(db)));
    assert.equal(competing.filter(value => value.claimed).length, 1);
    assert.equal(competing.filter(value => !value.claimed && value.status === 'pending').length, 11);
    for (const result of competing.filter(value => !value.claimed)) assert.equal(result.token, undefined);
    const changedResource = payment({ paymentHash: sha('same nonce different signed fields'), resourceUrl: resourceUrl.replace('0000320193', '0000789019') });
    assert.deepEqual(await claim(db, changedResource), { claimed: false, status: 'pending' });
    assert.equal((await db.query('select count(*)::integer as n from edgar_private.x402_receipts')).rows[0].n, 1);
    const winner = competing.find(value => value.claimed);
    await assert.rejects(finish(db, { ...winner.token, owner: randomUUID() }, { status: 'settled', transaction, payer, network }), { code: 'PT409' });
    await assert.rejects(finish(db, winner.token, { status: 'settled', transaction, payer: payTo, network }), { code: '22023' });
    assert.deepEqual(await finish(db, winner.token, { status: 'settled', transaction, payer, network }), { finished: true, status: 'settled' });
    assert.deepEqual(await finish(db, winner.token, { status: 'settled', transaction, payer, network }), { finished: true, status: 'settled' });
    await assert.rejects(finish(db, winner.token, { status: 'failed' }), { code: 'PT409' });
    assert.deepEqual(await claim(db), { claimed: false, status: 'settled', transaction });
  } finally { await db.close(); }
});

test('ambiguous settlement and handler failures permanently consume verified authorization', async () => {
  const db = await database();
  try {
    const pending = await claim(db);
    assert.deepEqual(await finish(db, pending.token, { status: 'pending', errorCode: 'settlement_timeout' }), { finished: true, status: 'pending' });
    assert.deepEqual(await claim(db), { claimed: false, status: 'pending' });
    await finish(db, pending.token, { status: 'pending', transaction, payer, network, errorCode: 'settlement_pending' });
    assert.deepEqual(await claim(db), { claimed: false, status: 'pending', transaction });
    await finish(db, pending.token, { status: 'pending', errorCode: 'receipt_retry' });
    assert.deepEqual(await claim(db), { claimed: false, status: 'pending', transaction });
    await assert.rejects(finish(db, pending.token, { status: 'pending', transaction: encodeBase58(Buffer.alloc(64, 8)), payer, network }), { code: 'PT409' });
    await assert.rejects(finish(db, pending.token, { status: 'failed' }), { code: 'PT409' });
    // A later confirmed settlement may reconcile the same pending owner.
    assert.deepEqual(await finish(db, pending.token, { status: 'settled', transaction, payer, network }), { finished: true, status: 'settled' });
    for (const [index, status] of ['failed', 'handler_failed'].entries()) {
      const pay = payment({ paymentHash: sha(status), nonceHash: sha(`distinct-${index}`) });
      const claimed = await claim(db, pay);
      await finish(db, claimed.token, { status, errorCode: 'verified_request_failed' });
      assert.deepEqual(await claim(db, pay), { claimed: false, status });
    }
  } finally { await db.close(); }
});

test('SQL validates paid price, fixed token, expiration and receipt fields; no secrets persisted', async () => {
  const db = await database();
  try {
    for (const patch of [
      { amount: '9999' }, { amount: 10000 }, { asset: payTo }, { network: 'eip155:1' }, { payer: 'invalid' },
      { payTo: null }, { paymentHash: '' }, { nonceHash: '' }, { validBefore: '0' },
      { validBefore: String(Math.floor(Date.now() / 1000) + 610) }, { validBefore: String(Math.floor(Date.now() / 1000) - 1) },
      { resourceUrl: 'https://attacker.example/api/x402/v1/company' }, { resourceUrl: 'https://secedgarterminal.com/api/free' },
      { resourceUrl: 'https://secedgarterminal.com/api/x402/v1/company#fragment' }, { signature: 'must never persist' },
    ]) await assert.rejects(claim(db, payment(patch)), { code: '22023' }, JSON.stringify(patch));
    assert.equal((await db.query('select count(*)::integer as n from edgar_private.x402_receipts')).rows[0].n, 0);
    const claimed = await claim(db);
    for (const receipt of [{ status: 'settled' }, { status: 'failed', transaction }, { status: 'pending', errorCode: 'bad error' }, { status: 'other' }])
      await assert.rejects(finish(db, claimed.token, receipt), { code: '22023' });
    const { rows: [row] } = await db.query('select * from edgar_private.x402_receipts');
    assert.ok(new Date(row.expires_at) > new Date(row.valid_before));
    assert.equal(row.amount, '10000');
    assert.equal(Object.keys(row).some(key => /signature|private_key|header|authorization/.test(key)), false);
  } finally { await db.close(); }
});

test('private receipt table and invoker RPCs deny anon/authenticated access', async () => {
  const db = await database();
  try {
    const { rows } = await db.query("select prosecdef from pg_proc where proname in ('edgar_x402_claim','edgar_x402_finish')");
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.prosecdef === false));
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}`);
      await assert.rejects(claim(db), { code: '42501' });
      await assert.rejects(db.query('select * from edgar_private.x402_receipts'), { code: '42501' });
    }
  } finally { await db.close(); }
});

test('verified claim performs bounded expiry cleanup without releasing active nonce', async () => {
  const db = await database();
  try {
    await claim(db);
    await db.exec("insert into edgar_private.x402_receipts select namespace,md5(i::text)||md5(('x'||i)::text),gen_random_uuid(),resource_url,resource_hash,network,asset,payer,pay_to,amount,md5(('n'||i)::text)||md5(('m'||i)::text),clock_timestamp()-interval '40 days',status,null,null,created_at,updated_at,clock_timestamp()-interval '1 day' from edgar_private.x402_receipts cross join generate_series(1,250) i");
    await claim(db, payment({ paymentHash: sha('cleanup-proof'), nonceHash: sha('cleanup-nonce') }));
    assert.equal((await db.query("select count(*)::integer as n from edgar_private.x402_receipts where expires_at<clock_timestamp()")).rows[0].n, 50);
    assert.deepEqual(await claim(db), { claimed: false, status: 'pending' });
  } finally { await db.close(); }
});

test('adapter uses production OIDC only, fail-closes missing DB and rejects preview/service-key misuse', async () => {
  const calls = [], requestId = randomUUID();
  const input = { paymentHash: sha('authorization'), resourceUrl, payer, payTo, asset, network, amount: '10000', nonce,
    validBefore: String(Math.floor(Date.now() / 1000) + 300), requestId };
  const ledger = createX402Ledger({ env: { VERCEL_ENV: 'production' }, identityTokenImpl: async () => 'workload.token.signed',
    fetchImpl: async (url, options) => { calls.push([url, options]); return Response.json(url.endsWith('/edgar_x402_finish')
      ? { finished: true, status: 'settled' } : { claimed: true, token: { paymentHash: input.paymentHash, owner: requestId } }); } });
  assert.equal(ledger.ready(), true);
  const claimed = await ledger.claim(input);
  assert.equal(claimed.claimed, true);
  assert.equal(calls[0][0], 'https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway/rest/v1/rpc/edgar_x402_claim');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer workload.token.signed');
  assert.equal(calls[0][1].headers.apikey, undefined);
  assert.equal(calls[0][1].cache, 'no-store'); assert.equal(calls[0][1].redirect, 'error');
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.p_payment.nonceHash, nonce); assert.equal(body.p_payment.nonce, undefined);
  assert.equal(body.p_payment.payer, payer); assert.equal(body.p_payment.payTo, payTo); assert.equal(body.p_payment.asset, asset);
  assert.equal(body.p_payment.signature, undefined); assert.equal(body.p_namespace, 'production');
  await assert.rejects(ledger.claim({ ...input, amount: '20000' }), { code: 'invalid_payment_claim' });
  assert.equal(calls.length, 1);
  await ledger.finish({ token: claimed.token, status: 'settled', transaction, payer, network });
  const receipt = JSON.parse(calls[1][1].body).p_receipt;
  assert.equal(receipt.transaction, transaction); assert.equal(receipt.payer, payer); assert.equal(receipt.network, network);
  const unavailable = createX402Ledger({ env: { VERCEL_ENV: 'production' }, identityTokenImpl: async () => 'workload.token.signed', fetchImpl: async () => Response.json({ code: 'PGRST202' }, { status: 404 }) });
  await assert.rejects(unavailable.claim(input), { code: 'payment_ledger_http_404' });
  let accessed = false;
  for (const env of [{ VERCEL_ENV: 'preview', SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'secret' },
    { SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'secret' }]) {
    const denied = createX402Ledger({ env, fetchImpl: async () => { accessed = true; } });
    assert.equal(denied.ready(), false); await assert.rejects(denied.claim(input));
  }
  assert.equal(accessed, false);
});

test('gateway x402 operations preserve fixed workload identity and price; arbitrary billing functions stay denied', async () => {
  const calls = [], now = Date.now(), secret = 'sb_secret_fixture_never_exposed';
  const claims = { iss: TRUST.issuer, aud: TRUST.audience, sub: TRUST.subject, owner: TRUST.owner, owner_id: TRUST.ownerId,
    project: TRUST.project, project_id: TRUST.projectId, environment: 'production', iat: Math.floor(now / 1000)-10, exp: Math.floor(now / 1000)+7100 };
  const handler = createGateway({ now: () => now, verifyToken: async () => claims,
    env: name => ({ SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co', SUPABASE_SERVICE_ROLE_KEY: secret })[name],
    fetchImpl: async (url, options) => { calls.push([url, options]); return Response.json({ claimed: false, status: 'pending' }); } });
  const invoke = (operation, params) => handler(new Request(`https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway/rest/v1/rpc/${operation}`,
    { method: 'POST', headers: { Authorization: 'Bearer header.payload.signature', 'Content-Type': 'application/json' }, body: JSON.stringify(params) }));
  assert.equal(validX402Payment(payment(), now), true);
  assert.equal((await invoke('edgar_x402_claim', { p_payment: payment(), p_owner: randomUUID() })).status, 200);
  assert.equal(JSON.parse(calls[0][1].body).p_namespace, 'production');
  for (const patch of [{ amount: '1' }, { asset: payTo }, { resourceUrl: 'https://attacker.example/api/x402/v1/company' }])
    assert.equal((await invoke('edgar_x402_claim', { p_payment: payment(patch), p_owner: randomUUID() })).status, 422);
  assert.equal((await invoke('edgar_x402_claim', { p_namespace: 'rehearsal', p_payment: payment(), p_owner: randomUUID() })).status, 403);
  assert.equal((await invoke('edgar_x402_release', {})).status, 403);
  assert.equal(calls.length, 1);
});
