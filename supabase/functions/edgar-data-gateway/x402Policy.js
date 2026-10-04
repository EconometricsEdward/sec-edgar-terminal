/** Payment receipts are admitted only from the existing production workload. */
export const X402_RPC_PARAMETERS = Object.freeze({
  edgar_x402_claim: ['p_payment', 'p_owner'],
  edgar_x402_finish: ['p_claim', 'p_receipt'],
  edgar_x402_stage_delivery: ['p_claim', 'p_delivery'],
  edgar_x402_recover_delivery: ['p_recovery_hash'],
});
export const X402_LIMITS = Object.freeze({ rpcBytes: 8192, deliveryRpcBytes: 6 * 1024 * 1024,
  deliveryBytes: 4 * 1024 * 1024, amount: '10000', maxAuthorizationSeconds: 600 });
export function x402RpcBytes(name) {
  return ['edgar_x402_stage_delivery', 'edgar_x402_recover_delivery'].includes(name) ? X402_LIMITS.deliveryRpcBytes : X402_LIMITS.rpcBytes;
}
export const X402_SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const X402_SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const HASH = /^[a-f0-9]{64}$/;
const ADDRESS = /^0x[a-f0-9]{40}$/;
const TRANSACTION = /^0x[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LEGACY_NETWORKS = new Set(['eip155:8453', 'eip155:84532']);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Validate decoded size as well as alphabet; never lowercase Solana values. */
export function validBase58Bytes(value, expectedBytes) {
  if (typeof value !== 'string' || ![32, 64].includes(expectedBytes)
    || value.length < expectedBytes || value.length > Math.ceil(expectedBytes * 8 / Math.log2(58))) return false;
  let number = 0n, leadingZeros = 0;
  for (let index = 0; index < value.length; index += 1) {
    const digit = BASE58.indexOf(value[index]);
    if (digit < 0) return false;
    if (index === leadingZeros && digit === 0) leadingZeros += 1;
    number = number * 58n + BigInt(digit);
  }
  let nonzeroBytes = 0;
  while (number > 0n) { nonzeroBytes += 1; number >>= 8n; }
  return leadingZeros + nonzeroBytes === expectedBytes;
}
export function validX402Address(value, network) {
  return network === X402_SOLANA_NETWORK ? validBase58Bytes(value, 32) : LEGACY_NETWORKS.has(network) && ADDRESS.test(value || '');
}
export function validX402Transaction(value, network) {
  return network === X402_SOLANA_NETWORK ? validBase58Bytes(value, 64) : LEGACY_NETWORKS.has(network) && TRANSACTION.test(value || '');
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
export function validX402Delivery(delivery) {
  if (!keys(delivery, ['recoveryHash', 'gzipBase64', 'gzipHash', 'contentHash', 'rawBytes', 'status', 'headers'])
    || !HASH.test(delivery.recoveryHash || '') || !HASH.test(delivery.gzipHash || '') || !HASH.test(delivery.contentHash || '')
    || !Number.isSafeInteger(delivery.rawBytes) || delivery.rawBytes < 1 || delivery.rawBytes > X402_LIMITS.deliveryBytes
    || !Number.isSafeInteger(delivery.status) || delivery.status < 200 || delivery.status > 299 || delivery.status === 204
    || typeof delivery.gzipBase64 !== 'string' || delivery.gzipBase64.length > Math.ceil((X402_LIMITS.deliveryBytes + 65536) / 3) * 4
    || !/^H4sI[A-Za-z0-9+/]*={0,2}$/.test(delivery.gzipBase64) || delivery.gzipBase64.length % 4 !== 0
    || !keys(delivery.headers, ['content-type', 'content-disposition', 'x-data-stale', 'x-schema-version', 'link'])
    || !['application/json', 'text/csv'].includes(delivery.headers['content-type']?.split(';', 1)[0].trim())
    || Object.values(delivery.headers).some(value => typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value))) return false;
  return true;
}
export function validX402Resource(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://secedgarterminal.com' && url.pathname.startsWith('/api/x402/v1/')
      && url.pathname.length > '/api/x402/v1/'.length && !url.username && !url.password && !url.hash
      && !/[\u0000-\u001f\u007f]/.test(value);
  } catch { return false; }
}
export function validX402Payment(payment, now = Date.now()) {
  if (!keys(payment, ['paymentHash', 'resourceUrl', 'resourceHash', 'payer', 'network', 'asset', 'amount', 'payTo', 'nonceHash', 'validBefore'])
    || !HASH.test(payment.paymentHash || '') || !HASH.test(payment.resourceHash || '')
    || !HASH.test(payment.nonceHash || '') || !validBase58Bytes(payment.payer, 32) || !validBase58Bytes(payment.payTo, 32)
    || payment.network !== X402_SOLANA_NETWORK || payment.asset !== X402_SOLANA_USDC || payment.amount !== X402_LIMITS.amount
    || !validX402Resource(payment.resourceUrl) || !/^[1-9]\d{0,10}$/.test(payment.validBefore || '')) return false;
  const expiry = Number(payment.validBefore);
  return Number.isSafeInteger(expiry) && expiry > Math.floor(now / 1000)
    && expiry <= Math.floor(now / 1000) + X402_LIMITS.maxAuthorizationSeconds;
}
export function validX402Rpc(name, params, now = Date.now()) {
  if (!Object.hasOwn(X402_RPC_PARAMETERS, name)
    || !keys(params, ['p_namespace', ...X402_RPC_PARAMETERS[name]])
    || params.p_namespace !== undefined && params.p_namespace !== 'production') return false;
  if (name === 'edgar_x402_claim') return UUID.test(params.p_owner || '') && validX402Payment(params.p_payment, now);
  if (name === 'edgar_x402_recover_delivery') return HASH.test(params.p_recovery_hash || '');
  if (name === 'edgar_x402_stage_delivery') return keys(params.p_claim, ['paymentHash', 'owner'])
    && HASH.test(params.p_claim.paymentHash || '') && UUID.test(params.p_claim.owner || '') && validX402Delivery(params.p_delivery);
  const claim = params.p_claim, receipt = params.p_receipt;
  if (!keys(claim, ['paymentHash', 'owner']) || !HASH.test(claim.paymentHash || '') || !UUID.test(claim.owner || '')
    || !keys(receipt, ['status', 'transaction', 'payer', 'network', 'errorCode'])
    || !['settled', 'failed', 'pending', 'handler_failed'].includes(receipt.status)
    || receipt.errorCode !== undefined && (typeof receipt.errorCode !== 'string' || !/^[a-z0-9_]{1,80}$/.test(receipt.errorCode))) return false;
  if (receipt.status === 'settled' || receipt.status === 'pending' && receipt.transaction !== undefined)
    return validX402Transaction(receipt.transaction, receipt.network) && validX402Address(receipt.payer, receipt.network);
  return receipt.transaction === undefined && receipt.payer === undefined && receipt.network === undefined;
}
