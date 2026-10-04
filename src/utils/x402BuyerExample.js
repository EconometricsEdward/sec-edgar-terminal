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

const response = await paidFetch(url);
const receipt = response.headers.get('PAYMENT-RESPONSE');
const data = await response.json();
if (!response.ok) {
  // Preserve these details and reconcile before authorizing another payment.
  throw new Error(JSON.stringify({ status: response.status, receipt, error: data }));
}
console.log(JSON.stringify({ receipt, data }));`;
}
