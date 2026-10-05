#!/usr/bin/env node
// LOCAL manual cashout. Preview is the default; never schedule this script.
// Private keys are loaded only after explicit send flags and public checks.
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  address, appendTransactionMessageInstruction, compileTransactionMessage,
  createTransactionMessage, getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  AccountState, findAssociatedTokenPda, getTokenDecoder,
  getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { X402_DEPLOYMENT_NETWORK, X402_DEPLOYMENT_PAY_TO } from '../src/utils/x402Deployment.js';

export const COLLECTION_WALLET = '3gmsqc9fhKhPwCz1guDJ3cvs7U8mAttwZWLett1isiD6';
export const KRAKEN_DEPOSIT_WALLET = '5qe4MpMXzT6TeaUNZz7ApAzoQzTGpVWbz1VBGbGhrdiR';
export const NATIVE_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';
// RPC returns the full genesis hash. CAIP-2 uses its first 32 characters.
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READ_METHODS = new Set(['getGenesisHash', 'getAccountInfo', 'getBalance', 'getLatestBlockhash', 'getFeeForMessage', 'getSignatureStatuses']);
const U64_MAX = (1n << 64n) - 1n;

/** Exact decimal arithmetic: no exponent, sign, whitespace or rounding. */
export function parseUsdcAmount(value, label = 'Amount') {
  if (typeof value !== 'string' || value.length > 24 || !/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new Error(`${label} must be a plain positive decimal with at most six decimal places.`);
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n || amount > U64_MAX) throw new Error(`${label} must be greater than zero and fit the token amount range.`);
  return amount;
}

function formatUnits(value, decimals) {
  const divisor = 10n ** BigInt(decimals);
  const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / divisor}${fraction ? `.${fraction}` : ''}`;
}

function assertKeypairOutsideRepository(keypairPath, repository = REPOSITORY) {
  const withinRepository = relative(repository, resolve(keypairPath));
  const escapesRepository = withinRepository === '..' || withinRepository.startsWith(`..${sep}`) || isAbsolute(withinRepository);
  if (!escapesRepository) throw new Error('Keep the cashout keypair outside the repository.');
}

export function validateTransferOptions(options) {
  if (!options || Object.keys(options).some(key => !['amount', 'krakenMinimum', 'send', 'confirmDestination', 'keypairPath'].includes(key))) throw new Error('Unknown cashout option.');
  if (options.send !== undefined && typeof options.send !== 'boolean') throw new Error('--send must be an explicit flag.');
  const amount = parseUsdcAmount(options.amount);
  const krakenMinimum = parseUsdcAmount(options.krakenMinimum, 'Kraken minimum');
  if (!options.send && (options.keypairPath !== undefined || options.confirmDestination !== undefined)) throw new Error('--keypair and --confirm-destination require explicit --send; preview never reads keys.');
  if (options.send) {
    if (options.confirmDestination !== KRAKEN_DEPOSIT_WALLET) throw new Error('--send requires --confirm-destination with the complete configured Kraken Solana deposit address.');
    if (typeof options.keypairPath !== 'string' || !(isAbsolute(options.keypairPath) || win32.isAbsolute(options.keypairPath))) throw new Error('--send requires an explicitly chosen absolute local --keypair path.');
    assertKeypairOutsideRepository(options.keypairPath);
  }
  return { ...options, send: options.send === true, amountUnits: amount, krakenMinimumUnits: krakenMinimum };
}

export function parseEarningsTransferArgs(args) {
  const options = { send: false };
  const names = { '--amount': 'amount', '--kraken-minimum': 'krakenMinimum', '--confirm-destination': 'confirmDestination', '--keypair': 'keypairPath' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error('Duplicate cashout option.');
    seen.add(flag);
    if (flag === '--send') { options.send = true; continue; }
    if (!names[flag] || typeof args[i + 1] !== 'string' || args[i + 1].startsWith('--')) throw new Error('Use --amount <USDC> --kraken-minimum <current account minimum>; optional send flags are documented by --help.');
    options[names[flag]] = args[++i];
  }
  validateTransferOptions(options);
  return options;
}

/** Fixed mainnet transport. No redirects, cookies, provider secrets or retries. */
export function createCashoutRpc({ fetchImpl = fetch, allowSend = false } = {}) {
  let id = 0;
  return async (method, params = []) => {
    if (!READ_METHODS.has(method) && !(allowSend && method === 'sendTransaction')) throw new Error('Forbidden cashout RPC method.');
    const requestId = ++id;
    try {
      const response = await fetchImpl(MAINNET_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
      });
      if (!response.ok) throw new Error();
      const envelope = await response.json();
      if (envelope.jsonrpc !== '2.0' || envelope.id !== requestId || envelope.error || !Object.hasOwn(envelope, 'result')) throw new Error();
      return envelope.result;
    } catch {
      // RPC errors may echo signed wire bytes; deliberately omit their contents.
      throw new Error(`Cashout RPC ${method} failed; no automatic retry was attempted.`);
    }
  };
}

function exactUnsignedInteger(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`Invalid public ${label} response.`);
}

function validatedTokenAccount(account, expectedOwner, label) {
  if (!account) throw new Error(`${label} native-USDC associated token account is missing. This helper does not create accounts or spend rent fees.`);
  if (account.owner !== TOKEN_PROGRAM_ADDRESS || account.executable !== false || !Array.isArray(account.data) || account.data[1] !== 'base64') throw new Error(`${label} token account is not an original SPL Token account.`);
  let token;
  try {
    const bytes = Buffer.from(account.data[0], 'base64');
    if (bytes.length !== 165) throw new Error();
    token = getTokenDecoder().decode(bytes);
  } catch { throw new Error(`${label} token account has invalid data.`); }
  if (token.owner !== expectedOwner || token.mint !== NATIVE_USDC_MINT || token.state !== AccountState.Initialized || token.isNative.__option !== 'None') throw new Error(`${label} token account owner, native-USDC mint or initialized state does not match.`);
  return token;
}

export async function cashoutTokenAddresses() {
  const [source] = await findAssociatedTokenPda({ owner: address(COLLECTION_WALLET), mint: address(NATIVE_USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [destination] = await findAssociatedTokenPda({ owner: address(KRAKEN_DEPOSIT_WALLET), mint: address(NATIVE_USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return { source, destination };
}

/** A single transferChecked instruction; no approvals, account creation or SOL transfers. */
export function buildCashoutMessage({ amountUnits, source, destination, lifetime, signer }) {
  const instruction = getTransferCheckedInstruction({
    source, mint: address(NATIVE_USDC_MINT), destination,
    authority: signer || address(COLLECTION_WALLET), amount: amountUnits, decimals: 6,
  });
  let message = setTransactionMessageFeePayer(address(COLLECTION_WALLET), createTransactionMessage({ version: 0 }));
  message = setTransactionMessageLifetimeUsingBlockhash(lifetime, message);
  return appendTransactionMessageInstruction(instruction, message);
}

async function publicPreflight(options, rpc) {
  if (X402_DEPLOYMENT_PAY_TO !== COLLECTION_WALLET || X402_DEPLOYMENT_NETWORK !== NETWORK) throw new Error('The configured production payout wallet or network does not match this local collection helper.');
  if (await rpc('getGenesisHash') !== MAINNET_GENESIS) throw new Error('Cashout RPC is not Solana mainnet.');
  const { source, destination } = await cashoutTokenAddresses();
  const [sourceInfo, destinationInfo, solInfo, blockhashInfo] = await Promise.all([
    rpc('getAccountInfo', [source, { encoding: 'base64', commitment: 'confirmed' }]),
    rpc('getAccountInfo', [destination, { encoding: 'base64', commitment: 'confirmed' }]),
    rpc('getBalance', [COLLECTION_WALLET, { commitment: 'confirmed' }]),
    rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]),
  ]);
  const sourceAccount = validatedTokenAccount(sourceInfo?.value, COLLECTION_WALLET, 'Collection');
  const destinationAccount = validatedTokenAccount(destinationInfo?.value, KRAKEN_DEPOSIT_WALLET, 'Kraken destination');
  const solLamports = exactUnsignedInteger(solInfo?.value, 'SOL balance');
  const blockhash = blockhashInfo?.value?.blockhash;
  try { address(blockhash); } catch { throw new Error('Invalid public blockhash response.'); }
  const lastValidBlockHeight = exactUnsignedInteger(blockhashInfo?.value?.lastValidBlockHeight, 'blockhash lifetime');
  const lifetime = { blockhash, lastValidBlockHeight };
  const message = buildCashoutMessage({ amountUnits: options.amountUnits, source, destination, lifetime });
  const encodedMessage = Buffer.from(getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message))).toString('base64');
  const feeResult = await rpc('getFeeForMessage', [encodedMessage, { commitment: 'confirmed' }]);
  if (feeResult?.value === null) throw new Error('Could not estimate the fee for the fresh blockhash; preview again before sending.');
  const feeLamports = exactUnsignedInteger(feeResult?.value, 'transaction fee');
  if (feeLamports <= 0n) throw new Error('Invalid public transaction fee response.');
  const blocking = [];
  if (options.amountUnits < options.krakenMinimumUnits) blocking.push('Amount is below the Kraken minimum you entered.');
  if (options.amountUnits > sourceAccount.amount) blocking.push('Collection wallet has insufficient native USDC.');
  if (solLamports < feeLamports) blocking.push('Collection wallet needs SOL for the estimated network fee.');
  const report = {
    mode: options.send ? 'manual send' : 'preview only', network: 'Solana mainnet', asset: 'native USDC',
    from: COLLECTION_WALLET, to: KRAKEN_DEPOSIT_WALLET, sourceTokenAccount: source, destinationTokenAccount: destination,
    amountUsdc: formatUnits(options.amountUnits, 6), krakenMinimumEnteredUsdc: formatUnits(options.krakenMinimumUnits, 6),
    collectionBalanceUsdc: formatUnits(sourceAccount.amount, 6), krakenAddressOnchainBalanceUsdc: formatUnits(destinationAccount.amount, 6),
    collectionBalanceSol: formatUnits(solLamports, 9), estimatedFeeLamports: feeLamports.toString(), estimatedFeeSol: formatUnits(feeLamports, 9),
    readyToSend: blocking.length === 0, blocking, broadcast: false, status: 'not sent',
    note: 'Check Kraken Deposit → USDC → Solana for this exact address and the current minimum. Preview never reads a private key or sends a transaction. A later send reruns public checks. Onchain receipt does not by itself confirm Kraken credit.',
  };
  return { report, source, destination, lifetime };
}

async function loadCashoutSigner(keypairPath) {
  // Resolve aliases only in explicit send mode, after every public preflight
  // check. A junction or symlink outside Git must not hide a key inside Git.
  let canonicalKeypairPath;
  let canonicalRepository;
  try {
    canonicalKeypairPath = realpathSync(keypairPath);
    canonicalRepository = realpathSync(REPOSITORY);
  } catch { throw new Error('Unable to locate the explicitly selected local cashout keypair.'); }
  assertKeypairOutsideRepository(canonicalKeypairPath, canonicalRepository);
  const { loadLocalKeypairSigner } = await import('./check-x402-discovery.mjs');
  return loadLocalKeypairSigner(canonicalKeypairPath);
}

async function signCashoutMessage(message, signer) {
  const { getBase64EncodedWireTransaction, getSignatureFromTransaction, setTransactionMessageFeePayerSigner, signTransactionMessageWithSigners } = await import('@solana/kit');
  const signed = await signTransactionMessageWithSigners(setTransactionMessageFeePayerSigner(signer, message));
  return { transactionId: getSignatureFromTransaction(signed), wireTransaction: getBase64EncodedWireTransaction(signed) };
}

export async function transferEarnings(options, { rpc, fetchImpl, loadSigner = loadCashoutSigner, signMessage = signCashoutMessage } = {}) {
  const validated = validateTransferOptions(options);
  const request = rpc || createCashoutRpc({ fetchImpl, allowSend: validated.send });
  const { report, source, destination, lifetime } = await publicPreflight(validated, request);
  if (!validated.send) return report;
  if (!report.readyToSend) throw new Error(`Cashout blocked before reading keys: ${report.blocking.join(' ')}`);
  const signer = await loadSigner(validated.keypairPath);
  if (signer?.address !== COLLECTION_WALLET) throw new Error('Selected local keypair does not control the configured collection wallet; nothing was signed or sent.');
  let signed;
  try {
    signed = await signMessage(buildCashoutMessage({ amountUnits: validated.amountUnits, source, destination, lifetime, signer }), signer);
    if (typeof signed?.transactionId !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signed.transactionId) || typeof signed.wireTransaction !== 'string' || !signed.wireTransaction) throw new Error();
  } catch { throw new Error('Unable to sign the local cashout transaction; nothing was broadcast.'); }
  const result = { ...report, transactionId: signed.transactionId, explorer: `https://solscan.io/tx/${signed.transactionId}`, readyToSend: false };
  try {
    const returnedId = await request('sendTransaction', [signed.wireTransaction, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }]);
    if (returnedId !== signed.transactionId) throw new Error();
    result.broadcast = true;
    result.status = 'submitted; finalization and Kraken credit pending';
  } catch {
    // A lost response can still mean the transaction landed. Never retry it here.
    result.broadcast = 'unknown';
    result.status = 'broadcast uncertain; reconcile this transaction before sending again';
    result.note = 'Inspect the public transaction ID and Kraken deposit history. Do not repeat the send automatically; a missing RPC response does not prove that funds were not transferred.';
    return result;
  }
  try {
    const status = (await request('getSignatureStatuses', [[signed.transactionId], { searchTransactionHistory: true }]))?.value?.[0];
    if (status?.err != null) result.status = 'transaction failed onchain; inspect the public transaction ID before retrying';
    else if (status?.confirmationStatus === 'finalized') result.status = 'finalized onchain; check Kraken deposit credit';
  } catch { /* Submitted remains pending; no automatic resend or indefinite wait. */ }
  return result;
}

const HELP = `Local native-USDC earnings cashout on Solana mainnet.

Preview (no private key, signing or broadcast):
  node scripts/transfer-x402-earnings.mjs --amount <USDC> --kraken-minimum <minimum currently shown in your Kraken account>

Manual send, only after reviewing the preview and Kraken deposit details:
  node scripts/transfer-x402-earnings.mjs --amount <USDC> --kraken-minimum <current minimum> --send --confirm-destination ${KRAKEN_DEPOSIT_WALLET} --keypair <absolute local keypair path outside this repository>

The collection wallet needs native USDC and SOL for network fees. Missing token accounts are rejected; this helper never creates them. Never upload or paste a private key. No automatic retries or scheduled transfers.`;

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') console.log(HELP);
    else {
      const report = await transferEarnings(parseEarningsTransferArgs(process.argv.slice(2)));
      console.log(JSON.stringify(report, null, 2));
      if (report.broadcast === 'unknown' || (report.broadcast === true && report.status.startsWith('transaction failed'))) process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to complete local cashout checks.');
    process.exitCode = 1;
  }
}
