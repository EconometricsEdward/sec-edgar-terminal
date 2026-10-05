import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { address, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { AccountState, getTokenEncoder, parseTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  buildCashoutMessage, cashoutTokenAddresses, COLLECTION_WALLET,
  createCashoutRpc, KRAKEN_DEPOSIT_WALLET, MAINNET_GENESIS, MAINNET_RPC,
  NATIVE_USDC_MINT, parseEarningsTransferArgs, parseUsdcAmount, transferEarnings,
} from '../scripts/transfer-x402-earnings.mjs';
import { X402_DEPLOYMENT_NETWORK } from '../src/utils/x402Deployment.js';

const ADDRESSES = await cashoutTokenAddresses();
const OPTIONS = { amount: '1.000001', krakenMinimum: '1' };
const SEND = { ...OPTIONS, send: true, confirmDestination: KRAKEN_DEPOSIT_WALLET, keypairPath: '/local-only/collection.json' };
const BLOCKHASH = '11111111111111111111111111111111';

function tokenAccount(owner, amount, overrides = {}) {
  const token = { mint: address(NATIVE_USDC_MINT), owner: address(owner), amount, delegate: null, state: AccountState.Initialized, isNative: null, delegatedAmount: 0n, closeAuthority: null, ...overrides };
  return { owner: TOKEN_PROGRAM_ADDRESS, executable: false, data: [Buffer.from(getTokenEncoder().encode(token)).toString('base64'), 'base64'] };
}

// Independent RPC fixture: do not derive this from the implementation's CAIP ID.
const RPC_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

function mockRpc({ usdc = 5_000_000n, sol = 1_000_000, fee = 5000, genesis = RPC_MAINNET_GENESIS, source, destination, sendError = false, confirmationStatus = 'finalized', transactionError = null } = {}) {
  const calls = [];
  let expectedId;
  return {
    calls,
    setId(value) { expectedId = value; },
    rpc: async (method, params = []) => {
      calls.push({ method, params });
      if (method === 'getGenesisHash') return genesis;
      if (method === 'getAccountInfo') {
        assert.ok([ADDRESSES.source, ADDRESSES.destination].includes(params[0]));
        assert.deepEqual(params[1], { encoding: 'base64', commitment: 'confirmed' });
        return { value: params[0] === ADDRESSES.source ? (source === undefined ? tokenAccount(COLLECTION_WALLET, usdc) : source) : (destination === undefined ? tokenAccount(KRAKEN_DEPOSIT_WALLET, 0n) : destination) };
      }
      if (method === 'getBalance') { assert.equal(params[0], COLLECTION_WALLET); return { value: sol }; }
      if (method === 'getLatestBlockhash') return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 12345 } };
      if (method === 'getFeeForMessage') {
        assert.equal(params.length, 2);
        const compiled = getCompiledTransactionMessageDecoder().decode(Buffer.from(params[0], 'base64'));
        assert.equal(compiled.header.numSignerAccounts, 1);
        assert.equal(compiled.staticAccounts[0], COLLECTION_WALLET);
        assert.equal(compiled.instructions.length, 1);
        assert.equal(compiled.staticAccounts[compiled.instructions[0].programAddressIndex], TOKEN_PROGRAM_ADDRESS);
        return { value: fee };
      }
      if (method === 'sendTransaction') {
        assert.deepEqual(params[1], { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
        assert.ok(expectedId);
        if (sendError) throw new Error('RPC echo of secret signed wire must not escape');
        return expectedId;
      }
      if (method === 'getSignatureStatuses') {
        assert.deepEqual(params, [[expectedId], { searchTransactionHistory: true }]);
        return { value: confirmationStatus === null ? [null] : [{ confirmationStatus, err: transactionError }] };
      }
      throw new Error(`Unexpected offline RPC method ${method}`);
    },
  };
}

function forbiddenSigner() { throw new Error('Test forbids reading a keypair or signing'); }

test('cashout decimals use exact native-USDC base units and reject ambiguous, rounded or out-of-range values', () => {
  assert.equal(parseUsdcAmount('1.000001'), 1_000_001n);
  assert.equal(parseUsdcAmount('0.000001'), 1n);
  assert.equal(parseUsdcAmount('18446744073709.551615'), (1n << 64n) - 1n);
  for (const input of ['0', '0.000000', '-1', '+1', '1e3', '01', ' 1', '1 ', '.1', '1.', '1,000', '0.0000001', '18446744073709.551616', 1, undefined]) assert.throws(() => parseUsdcAmount(input));
});

test('mainnet RPC full genesis hash is distinct from the truncated CAIP-2 network identifier', async () => {
  assert.equal(MAINNET_GENESIS, RPC_MAINNET_GENESIS);
  assert.equal(X402_DEPLOYMENT_NETWORK, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.notEqual(MAINNET_GENESIS, X402_DEPLOYMENT_NETWORK.slice('solana:'.length));
  const truncated = mockRpc({ genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' });
  await assert.rejects(transferEarnings(SEND, { rpc: truncated.rpc, loadSigner: forbiddenSigner, signMessage: forbiddenSigner }), /not Solana mainnet/);
  assert.deepEqual(truncated.calls.map(call => call.method), ['getGenesisHash']);
});

test('CLI requires amount and current account minimum, and rejects send credentials in preview', () => {
  assert.deepEqual(parseEarningsTransferArgs(['--amount', '1', '--kraken-minimum', '0.5']), { send: false, amount: '1', krakenMinimum: '0.5' });
  assert.deepEqual(parseEarningsTransferArgs(['--amount', SEND.amount, '--kraken-minimum', SEND.krakenMinimum, '--send', '--confirm-destination', SEND.confirmDestination, '--keypair', SEND.keypairPath]), SEND);
  for (const args of [[], ['--amount', '1'], ['--kraken-minimum', '1'], ['--amount', '1', '--kraken-minimum', '1', '--keypair', '/local/key.json'], ['--amount', '1', '--kraken-minimum', '1', '--confirm-destination', KRAKEN_DEPOSIT_WALLET], ['--amount', '1', '--kraken-minimum', '1', '--send'], ['--amount', '1', '--kraken-minimum', '1', '--amount', '2'], ['--amount', '1', '--kraken-minimum', '1', '--rpc', 'http://localhost']]) assert.throws(() => parseEarningsTransferArgs(args));
});

test('invalid flags or wrong destination fail before public RPC, private-key read, signing or send', async () => {
  let calls = 0;
  const dependencies = { rpc: () => { calls++; throw new Error('Forbidden'); }, loadSigner: forbiddenSigner, signMessage: forbiddenSigner };
  for (const options of [{ ...SEND, confirmDestination: COLLECTION_WALLET }, { ...SEND, keypairPath: 'relative.json' }, { ...SEND, keypairPath: fileURLToPath(new URL('../work/private.json', import.meta.url)) }, { ...SEND, keypairPath: fileURLToPath(new URL('../..keys/collection.json', import.meta.url)) }, { ...OPTIONS, keypairPath: SEND.keypairPath }, { ...OPTIONS, amount: '1e6' }, { ...OPTIONS, krakenMinimum: undefined }, { ...OPTIONS, destination: COLLECTION_WALLET }]) await assert.rejects(transferEarnings(options, dependencies));
  assert.equal(calls, 0);
});

test('send-only key loading rejects an outside junction that resolves into the real repository before reading contents', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'edgar-cashout-alias-'));
  try {
    const repository = fileURLToPath(new URL('../', import.meta.url));
    const alias = join(temporary, 'repository-alias');
    symlinkSync(repository, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const mock = mockRpc();
    // package.json is merely a public existing path. The loader must reject its
    // canonical location before attempting to read it as keypair contents.
    await assert.rejects(transferEarnings({ ...SEND, keypairPath: join(alias, 'package.json') }, { rpc: mock.rpc, signMessage: forbiddenSigner }), /outside the repository/);
    assert.equal(mock.calls.at(-1).method, 'getFeeForMessage');
    assert.ok(mock.calls.every(call => call.method !== 'sendTransaction'));
  } finally {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('default preview reads only public chain state and prints a review without private paths, signatures or wire bytes', async () => {
  const mock = mockRpc();
  const result = await transferEarnings(OPTIONS, { rpc: mock.rpc, loadSigner: forbiddenSigner, signMessage: forbiddenSigner });
  assert.equal(result.mode, 'preview only');
  assert.equal(result.network, 'Solana mainnet');
  assert.equal(result.asset, 'native USDC');
  assert.equal(result.from, COLLECTION_WALLET);
  assert.equal(result.to, KRAKEN_DEPOSIT_WALLET);
  assert.equal(result.amountUsdc, '1.000001');
  assert.equal(result.collectionBalanceUsdc, '5');
  assert.equal(result.collectionBalanceSol, '0.001');
  assert.equal(result.estimatedFeeSol, '0.000005');
  assert.equal(result.estimatedFeeLamports, '5000');
  assert.equal(result.readyToSend, true);
  assert.equal(result.broadcast, false);
  assert.deepEqual(mock.calls.map(call => call.method), ['getGenesisHash', 'getAccountInfo', 'getAccountInfo', 'getBalance', 'getLatestBlockhash', 'getFeeForMessage']);
  assert.doesNotMatch(JSON.stringify(result), /keypairPath|wireTransaction|transactionId|local-only|signature/i);
});

test('preview shows inadequate USDC, SOL or account minimum; explicit send is blocked before loading a key', async () => {
  for (const [options, state, expected] of [[OPTIONS, { sol: 0 }, /needs SOL/], [OPTIONS, { usdc: 1n }, /insufficient native USDC/], [{ ...OPTIONS, krakenMinimum: '2' }, {}, /below the Kraken minimum/]]) {
    const previewMock = mockRpc(state);
    const preview = await transferEarnings(options, { rpc: previewMock.rpc, loadSigner: forbiddenSigner, signMessage: forbiddenSigner });
    assert.equal(preview.readyToSend, false);
    assert.match(preview.blocking.join(' '), expected);
    const sendMock = mockRpc(state);
    await assert.rejects(transferEarnings({ ...SEND, ...options }, { rpc: sendMock.rpc, loadSigner: forbiddenSigner, signMessage: forbiddenSigner }), expected);
    assert.ok(sendMock.calls.every(call => call.method !== 'sendTransaction'));
  }
});

test('amount equal to collection balance and typed Kraken minimum is accepted without rounding', async () => {
  const mock = mockRpc({ usdc: 1_000_001n, sol: 5000 });
  const result = await transferEarnings({ amount: '1.000001', krakenMinimum: '1.000001' }, { rpc: mock.rpc, loadSigner: forbiddenSigner });
  assert.equal(result.readyToSend, true);
});

test('wrong network, missing accounts and invalid SPL-token identities fail before private-key reads', async () => {
  const initialized = tokenAccount(COLLECTION_WALLET, 5_000_000n);
  for (const state of [
    { genesis: 'devnet' }, { source: null }, { destination: null },
    { source: { ...initialized, owner: 'TokenzQdBNbLqP5VEhdkAS6EPFzGptXXPAbTQRt5dHqJq' } },
    { source: tokenAccount(KRAKEN_DEPOSIT_WALLET, 5_000_000n) },
    { destination: tokenAccount(COLLECTION_WALLET, 0n) },
    { source: tokenAccount(COLLECTION_WALLET, 5_000_000n, { mint: address(COLLECTION_WALLET) }) },
    { source: tokenAccount(COLLECTION_WALLET, 5_000_000n, { state: AccountState.Frozen }) },
    { source: tokenAccount(COLLECTION_WALLET, 5_000_000n, { state: AccountState.Uninitialized }) },
    { source: { ...initialized, data: ['truncated', 'base64'] } },
    { source: { ...initialized, executable: true } },
    { fee: null }, { fee: -1 }, { sol: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const mock = mockRpc(state);
    await assert.rejects(transferEarnings(SEND, { rpc: mock.rpc, loadSigner: forbiddenSigner, signMessage: forbiddenSigner }));
    assert.ok(mock.calls.every(call => call.method !== 'sendTransaction'));
  }
});

test('canonical ATAs and compiled instruction pin the original SPL native-USDC mint, exact amount and Kraken destination', () => {
  assert.deepEqual(ADDRESSES, { source: 'C7tW2q2uyHwdDS3uwNgGCoydHuaYAjb8733ovbsye4AR', destination: '2mXS4P3775UedqUkf6idRyUe7hgHSbiU8H2U11JvXuYK' });
  const message = buildCashoutMessage({ ...ADDRESSES, amountUnits: 1_000_001n, lifetime: { blockhash: BLOCKHASH, lastValidBlockHeight: 12345n } });
  assert.equal(message.feePayer.address, COLLECTION_WALLET);
  assert.equal(message.instructions.length, 1);
  const parsed = parseTransferCheckedInstruction(message.instructions[0]);
  assert.equal(parsed.programAddress, TOKEN_PROGRAM_ADDRESS);
  assert.equal(parsed.accounts.source.address, ADDRESSES.source);
  assert.equal(parsed.accounts.mint.address, NATIVE_USDC_MINT);
  assert.equal(parsed.accounts.destination.address, ADDRESSES.destination);
  assert.equal(parsed.accounts.authority.address, COLLECTION_WALLET);
  assert.deepEqual(parsed.data, { discriminator: 12, amount: 1_000_001n, decimals: 6 });
});

test('selected keypair must match the collection public address before signing', async () => {
  const mock = mockRpc();
  let reads = 0;
  await assert.rejects(transferEarnings(SEND, { rpc: mock.rpc, loadSigner: async path => { reads++; assert.equal(path, SEND.keypairPath); return { address: KRAKEN_DEPOSIT_WALLET }; }, signMessage: forbiddenSigner }), /does not control/);
  assert.equal(reads, 1);
  assert.ok(mock.calls.every(call => call.method !== 'sendTransaction'));
});

// Synthetic signing implementation supplies placeholder signatures offline. It
// validates the installed SDK flow without creating or reading a real keypair.
const SYNTHETIC_SIGNER = {
  address: address(COLLECTION_WALLET),
  async signTransactions(transactions) {
    return transactions.map(() => ({ [COLLECTION_WALLET]: new Uint8Array(64).fill(1) }));
  },
};

test('explicit send performs fresh public checks before synthetic signing and submits exactly one reviewed transfer', async () => {
  const mock = mockRpc();
  const wrappedRpc = async (method, params) => {
    if (method === 'sendTransaction') {
      const transaction = getTransactionDecoder().decode(Buffer.from(params[0], 'base64'));
      const { getSignatureFromTransaction } = await import('@solana/kit');
      mock.setId(getSignatureFromTransaction(transaction));
      const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      assert.equal(compiled.staticAccounts[0], COLLECTION_WALLET);
      assert.equal(compiled.instructions.length, 1);
      assert.equal(compiled.staticAccounts[compiled.instructions[0].accountIndices[2]], ADDRESSES.destination);
    }
    return mock.rpc(method, params);
  };
  let reads = 0;
  const result = await transferEarnings(SEND, {
    rpc: wrappedRpc,
    loadSigner: async path => {
      assert.equal(mock.calls.at(-1).method, 'getFeeForMessage');
      assert.equal(path, SEND.keypairPath);
      reads++; return SYNTHETIC_SIGNER;
    },
  });
  assert.equal(reads, 1);
  assert.equal(result.broadcast, true);
  assert.equal(result.status, 'finalized onchain; check Kraken deposit credit');
  assert.match(result.explorer, /^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(mock.calls.filter(call => call.method === 'sendTransaction').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'getSignatureStatuses').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /wireTransaction|keypairPath|local-only|signTransactions/);
});

test('broadcast errors retain the public transaction ID for reconciliation and never retry or claim success', async () => {
  const mock = mockRpc({ sendError: true });
  const publicId = '2'.repeat(88);
  mock.setId(publicId);
  const result = await transferEarnings(SEND, { rpc: mock.rpc, loadSigner: async () => SYNTHETIC_SIGNER, signMessage: async () => ({ transactionId: publicId, wireTransaction: 'private-signed-wire' }) });
  assert.equal(result.broadcast, 'unknown');
  assert.equal(result.transactionId, publicId);
  assert.match(result.status, /broadcast uncertain/);
  assert.match(result.note, /Do not repeat/);
  assert.equal(mock.calls.filter(call => call.method === 'sendTransaction').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'getSignatureStatuses').length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-signed-wire|secret signed wire/);
});

test('RPC acceptance remains pending unless finalization is observed, and a chain failure is not reported as a successful transfer', async () => {
  for (const [state, expected] of [[{ confirmationStatus: null }, /finalization and Kraken credit pending/], [{ confirmationStatus: 'confirmed' }, /finalization and Kraken credit pending/], [{ confirmationStatus: 'finalized', transactionError: { InstructionError: [0, 'InsufficientFunds'] } }, /failed onchain/]]) {
    const mock = mockRpc(state);
    const publicId = '2'.repeat(88);
    mock.setId(publicId);
    const result = await transferEarnings(SEND, { rpc: mock.rpc, loadSigner: async () => SYNTHETIC_SIGNER, signMessage: async () => ({ transactionId: publicId, wireTransaction: 'offline-wire' }) });
    assert.equal(result.broadcast, true);
    assert.match(result.status, expected);
    assert.equal(mock.calls.filter(call => call.method === 'sendTransaction').length, 1);
  }
});

test('preview transport uses the fixed mainnet RPC and denies broadcast, account creation, airdrops and arbitrary methods', async () => {
  const calls = [];
  const rpc = createCashoutRpc({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(url, MAINNET_RPC);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    const request = JSON.parse(init.body);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: MAINNET_GENESIS });
  } });
  assert.equal(await rpc('getGenesisHash'), MAINNET_GENESIS);
  for (const method of ['sendTransaction', 'requestAirdrop', 'simulateTransaction', 'setAccount', 'getTokenAccountsByOwner']) await assert.rejects(rpc(method), /Forbidden/);
  assert.equal(calls.length, 1);
});

test('transport and signing errors do not expose raw RPC errors or signed wire bytes', async () => {
  const rpc = createCashoutRpc({ allowSend: true, fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body);
    return Response.json({ jsonrpc: '2.0', id: request.id, error: { message: `secret key bytes and wire ${request.params[0]}` } });
  } });
  await assert.rejects(rpc('sendTransaction', ['signed-wire-secret']), error => {
    assert.match(error.message, /sendTransaction failed/);
    assert.doesNotMatch(error.message, /secret key|signed-wire-secret/);
    return true;
  });
  const mock = mockRpc();
  await assert.rejects(transferEarnings(SEND, { rpc: mock.rpc, loadSigner: async () => SYNTHETIC_SIGNER, signMessage: () => { throw new Error('private key bytes'); } }), error => {
    assert.match(error.message, /nothing was broadcast/);
    assert.doesNotMatch(error.message, /private key bytes/);
    return true;
  });
  assert.ok(mock.calls.every(call => call.method !== 'sendTransaction'));
});
