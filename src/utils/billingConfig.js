/** Public product facts; no credentials or entitlement decisions belong here. */
export const BILLING_TERMS_VERSION = '2026-09-20';
export const BILLING_PACK = Object.freeze({
  id: 'hosted-100-v1', name: 'Hosted AI · 100 responses', priceCents: 1000, credits: 100, currency: 'usd',
});
export const BILLING_PRODUCTION_ORIGIN = 'https://secedgarterminal.com';
export const BILLING_PRODUCTION_SUPABASE = 'https://vvkihuduqqnxqahhbphs.supabase.co';
// This publishable key identifies the public Auth project. It never authorizes
// billing-table access; all entitlements are checked by the private server RPC.
const PRODUCTION_PUBLIC_KEY = 'sb_publishable_DJfbDbWH2h9uj9q6HvZzXA_TY9xEmzJ';

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

export function getBillingConfig(env = process.env) {
  const production = env.VERCEL_ENV === 'production';
  const authUrl = safeUrl(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || (production ? BILLING_PRODUCTION_SUPABASE : ''));
  const publicKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY
    || (production ? PRODUCTION_PUBLIC_KEY : '');
  // Never accidentally return a privileged Supabase credential to a browser.
  const validPublicKey = typeof publicKey === 'string' && /^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(publicKey);
  const authReady = env.BILLING_AUTH_READY === 'true' && !!authUrl && validPublicKey;
  const sellerName = typeof env.BILLING_SELLER_NAME === 'string' ? env.BILLING_SELLER_NAME.trim().slice(0,160) : '';
  const supportEmail = typeof env.BILLING_SUPPORT_EMAIL === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.BILLING_SUPPORT_EMAIL)
    ? env.BILLING_SUPPORT_EMAIL : '';
  const origin = safeUrl(env.BILLING_APP_ORIGIN || BILLING_PRODUCTION_ORIGIN);
  const stripeSecret = env.STRIPE_SECRET_KEY || '';
  const stripePrice = env.STRIPE_PRICE_ID || '';
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || '';
  const taxMode = env.BILLING_TAX_MODE || 'automatic';
  // Production billing is exclusively live-mode. A preview cannot use a copied
  // production key to modify purchases, wallets, or the shared cost allowance.
  const paymentsReady = production && origin === BILLING_PRODUCTION_ORIGIN
    && /^sk_live_[A-Za-z0-9]+$/.test(stripeSecret) && /^price_[A-Za-z0-9]+$/.test(stripePrice)
    && /^whsec_[A-Za-z0-9]+$/.test(webhookSecret);
  const configured = paymentsReady && authReady && env.BILLING_ENABLED === 'true'
    && env.BILLING_MERCHANT_READY === 'true' && env.BILLING_TAX_READY === 'true'
    && !!sellerName && !!supportEmail && ['automatic', 'reviewed_exempt'].includes(taxMode);
  return { production, authReady, auth: authReady ? { url: authUrl, publishableKey: publicKey } : null,
    sellerName, supportEmail, origin, stripeSecret, stripePrice, webhookSecret, taxMode,
    configured: !!configured, paymentsReady: !!paymentsReady };
}
