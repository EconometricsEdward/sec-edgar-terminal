import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createBuyerWallet, encodeBuyerAddress, parseBuyerArgs, validateBuyerKeypairPath } from '../scripts/create-x402-buyer.mjs';

// Public, deterministic RFC 8032 test seed. Never use or fund this test wallet.
const testSeed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
const testPublic = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
function fixtureKeys(seed = testSeed) {
  const privateKey = createPrivateKey({ key: Buffer.concat([prefix, seed]), type: 'pkcs8', format: 'der' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}
function temporaryDirectory() { return mkdtempSync(join(tmpdir(), 'edgar-keypair-fixture-')); }
function removeFixtureDirectory(directory) {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.match(basename(target), /^edgar-keypair-fixture-/);
  rmSync(target, { recursive: true, force: true });
}

test('native helper writes a Solana CLI-compatible fixture that roundtrips through the genuine Solana Kit', async () => {
  const directory = temporaryDirectory();
  try {
    const file = join(directory, 'private', 'buyer.json');
    const result = createBuyerWallet({ keypairPath: file, generateKeyPairImpl: fixtureKeys });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.length, 64);
    assert.ok(saved.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    assert.deepEqual(Buffer.from(saved.slice(0, 32)), testSeed);
    assert.deepEqual(Buffer.from(saved.slice(32)), testPublic);
    const { createKeyPairSignerFromBytes, getBase58Decoder } = await import('@solana/kit');
    const signer = await createKeyPairSignerFromBytes(Uint8Array.from(saved));
    assert.equal(signer.address, result.address);
    assert.equal(getBase58Decoder().decode(testPublic), result.address);
    assert.deepEqual(Object.keys(result).sort(), ['address', 'keypairPath']);
    assert.ok(!JSON.stringify(result).includes(testSeed.toString('hex')));
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { removeFixtureDirectory(directory); }
});

test('helper preserves an existing file and cannot overwrite a file created concurrently', () => {
  const directory = temporaryDirectory();
  try {
    const file = join(directory, 'buyer.json');
    const existing = 'existing-key-material-must-stay-private';
    writeFileSync(file, existing);
    assert.throws(() => createBuyerWallet({ keypairPath: file, generateKeyPairImpl: () => { throw new Error('Must not generate'); } }), { code: 'keypair_exists' });
    assert.equal(readFileSync(file, 'utf8'), existing);
    assert.throws(() => createBuyerWallet({ keypairPath: file, generateKeyPairImpl: fixtureKeys, existsImpl: () => false }), { code: 'keypair_exists' });
    assert.equal(readFileSync(file, 'utf8'), existing);
  } finally { removeFixtureDirectory(directory); }
});

test('native format validation and seed/public matching fail before writing; errors never reveal key data', () => {
  const directory = temporaryDirectory();
  try {
    const file = join(directory, 'buyer.json');
    let writes = 0;
    const noWrite = () => { writes++; };
    const wrongPrefix = () => {
      const keys = fixtureKeys();
      return { ...keys, privateKey: { asymmetricKeyType: 'ed25519', export: () => Buffer.alloc(48, 7) } };
    };
    const wrongPublicPrefix = () => {
      const keys = fixtureKeys();
      return { ...keys, publicKey: { asymmetricKeyType: 'ed25519', export: () => Buffer.alloc(44, 7) } };
    };
    for (const generateKeyPairImpl of [wrongPrefix, wrongPublicPrefix])
      assert.throws(() => createBuyerWallet({ keypairPath: file, generateKeyPairImpl, writeFileImpl: noWrite }), { code: 'invalid_key_format' });
    assert.throws(() => createBuyerWallet({ keypairPath: file,
      generateKeyPairImpl: () => ({ privateKey: fixtureKeys().privateKey, publicKey: fixtureKeys(Buffer.alloc(32, 9)).publicKey }), writeFileImpl: noWrite }), { code: 'keypair_mismatch' });
    assert.equal(writes, 0);
    assert.throws(() => createBuyerWallet({ keypairPath: file, generateKeyPairImpl: fixtureKeys,
      writeFileImpl: (_file, content, options) => {
        assert.deepEqual(options, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        throw new Error(`secret failure ${content}`);
      } }), error => { assert.equal(error.code, 'creation_failed'); assert.ok(!error.message.includes(testSeed.toString('hex'))); assert.ok(!error.message.includes('[')); return true; });
  } finally { removeFixtureDirectory(directory); }
});

test('address encoder handles leading zero public bytes and CLI accepts only explicit local absolute paths', async () => {
  assert.equal(encodeBuyerAddress(new Uint8Array(32)), '1'.repeat(32));
  const directory = temporaryDirectory();
  try {
    const file = join(directory, 'buyer.json');
    assert.deepEqual(parseBuyerArgs([], { defaultPath: file }), { keypairPath: file });
    assert.deepEqual(parseBuyerArgs(['--keypair', file]), { keypairPath: file });
    assert.deepEqual(parseBuyerArgs(['--help']), { help: true });
    for (const value of ['relative.json', 'https://example.com/key.json', 'file:///tmp/key.json', '\\\\server\\private\\key.json', '//server/key.json', `${file}\n`])
      assert.throws(() => validateBuyerKeypairPath(value), { code: 'invalid_keypair_path' });
    for (const args of [['--keypair'], ['--keypair', file, '--keypair', file], ['--seed', testSeed.toString('hex')]])
      assert.throws(() => parseBuyerArgs(args));
    assert.throws(() => encodeBuyerAddress(new Uint8Array(31)), { code: 'invalid_public_key' });
    const { getBase58Decoder } = await import('@solana/kit');
    for (const value of [testPublic, new Uint8Array(32), Uint8Array.from([0, 0, ...Array(30).fill(255)])])
      assert.equal(encodeBuyerAddress(value), getBase58Decoder().decode(value));
  } finally { removeFixtureDirectory(directory); }
});
