#!/usr/bin/env node
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual, verify } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRIVATE_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CHECK_MESSAGE = Buffer.from('SEC EDGAR Terminal local keypair format check v1');

export class BuyerKeypairError extends Error {
  constructor(code, message) { super(message); this.name = 'BuyerKeypairError'; this.code = code; }
}

/** Base58 encodes exactly the public 32 bytes, preserving leading zero bytes. */
export function encodeBuyerAddress(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new BuyerKeypairError('invalid_public_key', 'Expected a 32-byte public key.');
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) { encoded = BASE58[Number(value % 58n)] + encoded; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; encoded = `1${encoded}`; }
  return encoded;
}

export function defaultBuyerKeypairPath() { return join(homedir(), '.edgar-x402', 'buyer-keypair.json'); }

export function validateBuyerKeypairPath(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)
    || /[\\/]$/.test(value) || /^\\\\|^\/\//.test(value)
    || /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)
    || !isAbsolute(value) || !basename(value))
    throw new BuyerKeypairError('invalid_keypair_path', 'Choose an absolute local keypair file path, without a URL or network share.');
  return resolve(value);
}

export function parseBuyerArgs(args, { defaultPath = defaultBuyerKeypairPath() } = {}) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length === 0) return { keypairPath: validateBuyerKeypairPath(defaultPath) };
  if (args.length === 2 && args[0] === '--keypair') return { keypairPath: validateBuyerKeypairPath(args[1]) };
  throw new BuyerKeypairError('invalid_arguments', 'Usage: node scripts/create-x402-buyer.mjs [--keypair <absolute-local-path>]');
}

/** Native Node crypto only. Returns public metadata, never the seed or key bytes. */
export function createBuyerWallet({ keypairPath = defaultBuyerKeypairPath(),
  generateKeyPairImpl = () => generateKeyPairSync('ed25519'), existsImpl = existsSync,
  mkdirImpl = mkdirSync, writeFileImpl = writeFileSync } = {}) {
  const file = validateBuyerKeypairPath(keypairPath);
  let privateDer, publicDer, keyBytes;
  try {
    if (existsImpl(file)) throw new BuyerKeypairError('keypair_exists', 'Key file already exists. Keep it; this helper will not overwrite it.');
    const { privateKey, publicKey } = generateKeyPairImpl();
    if (privateKey?.asymmetricKeyType !== 'ed25519' || publicKey?.asymmetricKeyType !== 'ed25519')
      throw new BuyerKeypairError('invalid_generated_key', 'Native crypto did not produce a valid Ed25519 keypair.');
    privateDer = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }));
    publicDer = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
    if (privateDer.length !== PRIVATE_PREFIX.length + 32 || publicDer.length !== PUBLIC_PREFIX.length + 32
      || !privateDer.subarray(0, PRIVATE_PREFIX.length).equals(PRIVATE_PREFIX)
      || !publicDer.subarray(0, PUBLIC_PREFIX.length).equals(PUBLIC_PREFIX))
      throw new BuyerKeypairError('invalid_key_format', 'Native Ed25519 key format failed validation.');
    // Reconstruct from the exact bytes to be saved, then prove seed/public match.
    const signingKey = createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
    const verifyingKey = createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
    const derivedPublic = createPublicKey(signingKey).export({ format: 'der', type: 'spki' });
    if (!timingSafeEqual(derivedPublic, publicDer) || !verify(null, CHECK_MESSAGE, verifyingKey, sign(null, CHECK_MESSAGE, signingKey)))
      throw new BuyerKeypairError('keypair_mismatch', 'Generated Ed25519 private and public keys do not match.');
    const publicBytes = publicDer.subarray(PUBLIC_PREFIX.length);
    const address = encodeBuyerAddress(publicBytes);
    keyBytes = Buffer.concat([privateDer.subarray(PRIVATE_PREFIX.length), publicBytes]);
    mkdirImpl(dirname(file), { recursive: true, mode: 0o700 });
    writeFileImpl(file, `${JSON.stringify(Array.from(keyBytes))}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return Object.freeze({ address, keypairPath: file });
  } catch (error) {
    if (error instanceof BuyerKeypairError) throw error;
    if (error?.code === 'EEXIST') throw new BuyerKeypairError('keypair_exists', 'Key file already exists. Keep it; this helper will not overwrite it.');
    throw new BuyerKeypairError('creation_failed', 'Unable to create the buyer keypair safely. Check the selected path and permissions.');
  } finally {
    privateDer?.fill(0);
    keyBytes?.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseBuyerArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/create-x402-buyer.mjs [--keypair <absolute-local-path>]');
    else {
      const wallet = createBuyerWallet(options);
      console.log(`Buyer wallet address: ${wallet.address}`);
      console.log(`Key file: ${wallet.keypairPath}`);
    }
  } catch (error) {
    console.error(error instanceof BuyerKeypairError ? error.message : 'Unable to create the buyer keypair safely.');
    process.exitCode = 1;
  }
}
