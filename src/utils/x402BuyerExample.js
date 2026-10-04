import { X402_SOLANA_NETWORK, X402_SOLANA_USDC } from './x402Payments.js';

/** Render the buyer example against the same effective offer as the catalog. */
export function buildX402BuyerExample(configuration) {
  return `import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { readFileSync } from 'node:fs';

// Local development wallet only; never upload its keypair to this site.
const file = process.env.PAYER_KEYPAIR_FILE;
if (!file) throw new Error('Choose your local wallet keypair file');
const bytes = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(bytes) || bytes.length !== 64
  || bytes.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
  throw new Error('Expected a Solana CLI 64-byte keypair JSON file');
}
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(bytes));
const expectedRecipient = ${JSON.stringify(configuration.payTo || 'CONFIRM_RECIPIENT_IN_CATALOG')};
const url = 'https://secedgarterminal.com/api/x402/v1/factor-universe?basis=ttm&limit=100&offset=0';
const usdc = ${JSON.stringify(X402_SOLANA_USDC)};
const network = ${JSON.stringify(configuration.network || X402_SOLANA_NETWORK)};
const client = new x402Client();
client.setSpendControls({ maxAmountPerPayment: '$0.01' });
client.register(network, new ExactSvmScheme(signer));
client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements: offer }) => {
  if (offer.scheme !== 'exact'
    || offer.network !== network
    || offer.asset !== usdc
    || BigInt(offer.amount) !== 10000n
    || offer.payTo !== expectedRecipient
    || paymentRequired.resource?.url !== url) {
    return { abort: true, reason: 'Unexpected payment offer' };
  }
});
const paidFetch = wrapFetchWithPayment(fetch, client);

// Generate a new private capability for each purchase. Persist it privately
// before sending the request; never put it in a URL or a public issue.
const recoveryToken = Array.from(crypto.getRandomValues(new Uint8Array(32)),
  byte => byte.toString(16).padStart(2, '0')).join('');
const recovery = { url: 'https://secedgarterminal.com/api/x402/v1/delivery', token: recoveryToken };
let response;
try {
  response = await paidFetch(url, { headers: { 'X-X402-Recovery-Token': recoveryToken } });
} catch (error) {
  throw new Error(JSON.stringify({ error: error.message, recovery,
    nextStep: 'Use ordinary fetch to the recovery URL with the token header. Do not authorize a replacement payment.' }));
}
const receipt = response.headers.get('PAYMENT-RESPONSE');
const data = await response.json();
if (!response.ok) {
  // Preserve these details and reconcile before authorizing another payment.
  throw new Error(JSON.stringify({ status: response.status, receipt, error: data, recovery }));
}
console.log(JSON.stringify({ receipt, data, recovery,
  recoveryUntil: response.headers.get('X-X402-Recovery-Until') }));

// Recover without another payment if delivery was interrupted:
// const recovered = await fetch(recovery.url, {
//   headers: { 'X-X402-Recovery-Token': recovery.token }
// });
// 200: exact paid response; 202: pending settlement; 404: missing/expired.
// Keep the recovery details private. Recovery access lasts 24 hours.`;
}
