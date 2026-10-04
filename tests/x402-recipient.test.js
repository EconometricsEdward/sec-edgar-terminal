import test from 'node:test';
import assert from 'node:assert/strict';
import { createX402RecipientCheck, getX402LivePublicConfiguration } from '../src/utils/x402SolanaRecipient.js';
const config = { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payTo: 'H6VfqLdNwYfFmA54TQeL28sx2LyWE1E5FLX6XGEN3pmb',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
const account = '9yfMyQsU7G8wh8zfWDwKNyMr51fcv4vg2RZvQqiaiVnv';
const initialized = () => ({ owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', executable: false,
  data: { parsed: { type: 'account', info: { owner: config.payTo, mint: config.asset, state: 'initialized' } } } });
const response = value => Response.json({ jsonrpc: '2.0', result: { value } });

test('recipient preflight derives the canonical USDC account without any transaction', async () => {
  const calls = [];
  const check = createX402RecipientCheck({ fetchImpl: async (url, options) => {
    calls.push({ url, options }); return response(initialized());
  } });
  assert.deepEqual(await check(config), { ready: true, status: 'ready', account });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body).params, [account, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  assert.equal(JSON.parse(calls[0].options.body).method, 'getAccountInfo');
});

test('missing or unusable recipient accounts cannot advertise payable access', async () => {
  const frozen = initialized(); frozen.data.parsed.info.state = 'frozen';
  const wrongMint = initialized(); wrongMint.data.parsed.info.mint = config.payTo;
  const wrongOwner = initialized(); wrongOwner.data.parsed.info.owner = config.payTo.toLowerCase();
  for (const value of [null, frozen, wrongMint, wrongOwner]) {
    const check = createX402RecipientCheck({ deriveAccount: async () => account, fetchImpl: async () => response(value) });
    assert.equal((await check(config)).status, 'recipient-setup-required');
    const publicConfig = await getX402LivePublicConfiguration({ ...config, status: 'active', price: '0.01' }, { check, required: true });
    assert.equal(publicConfig.status, 'recipient-setup-required'); assert.equal(publicConfig.payTo, config.payTo);
  }
});

test('readiness caches concurrent checks, recovers after setup, and distinguishes RPC failures', async () => {
  let time = 0, calls = 0, value = null;
  const check = createX402RecipientCheck({ now: () => time, deriveAccount: async () => account,
    fetchImpl: async () => { calls++; return response(value); } });
  await Promise.all([check(config), check(config)]); assert.equal(calls, 1);
  value = initialized(); time = 15001;
  assert.equal((await check(config)).ready, true); assert.equal(calls, 2);
  await check(config); assert.equal(calls, 2);
  const unavailable = createX402RecipientCheck({ deriveAccount: async () => account, fetchImpl: async () => Response.json({ error: { code: -1 } }) });
  assert.equal((await unavailable(config)).status, 'recipient-check-unavailable');
  const inactive = { status: 'configuration-required' };
  assert.equal(await getX402LivePublicConfiguration(inactive, { check: () => { throw Error('Must not call'); }, required: true }), inactive);
});
