#!/usr/bin/env node
// Default: read-only offer/catalog audit. --register sends verify-only requests
// from a fresh in-memory, unfunded signer; never settles or retries a seller.
import { pathToFileURL } from 'node:url';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { extractDiscoveryInfo, validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { generateKeyPairSigner } from '@solana/kit';
import { X402_DEPLOYMENT_PAY_TO, X402_DEPLOYMENT_NETWORK } from '../src/utils/x402Deployment.js';

const ORIGIN = 'https://secedgarterminal.com';
const FACILITATOR = 'https://facilitator.payai.network';
const RPC_URL = 'https://api.mainnet-beta.solana.com';
const ASSET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DISCOVERY_REQUESTS = Object.freeze([
  `${ORIGIN}/api/x402/v1/financials/AAPL?basis=annual`,
  `${ORIGIN}/api/x402/v1/factor-universe?basis=ttm&limit=100&offset=0`,
  `${ORIGIN}/api/x402/v1/refinancing?limit=100&offset=0`,
]);
const TERMS = Object.freeze({ scheme: 'exact', network: X402_DEPLOYMENT_NETWORK, asset: ASSET, amount: '10000', payTo: X402_DEPLOYMENT_PAY_TO });

export function validateOffer(offer, requestUrl) {
  if (!DISCOVERY_REQUESTS.includes(requestUrl) || offer?.x402Version !== 2 || offer.resource?.url !== requestUrl) throw new Error('Unexpected payment resource');
  if (offer.accepts?.length !== 1 || !Object.entries(TERMS).every(([key, value]) => offer.accepts[0][key] === value)) throw new Error('Unexpected payment terms');
  if (offer.resource.serviceName !== 'SEC EDGAR Terminal' || !offer.resource.tags?.length || offer.resource.mimeType !== 'application/json') throw new Error('Missing service discovery metadata');
  const extension = offer.extensions?.bazaar;
  const verdict = extension && validateDiscoveryExtension(extension);
  if (!verdict?.valid || extension.info?.input?.method !== 'GET') throw new Error(`Invalid Bazaar declaration: ${verdict?.errors?.join(', ') || 'missing GET declaration'}`);
  const discovery = extractDiscoveryInfo({ x402Version: 2, resource: offer.resource, extensions: offer.extensions }, offer.accepts[0]);
  if (!discovery?.resourceUrl) throw new Error('Discovery resource was not extracted');
  return discovery.resourceUrl;
}

/** Restrict the audit transport, including its optional registration mutation. */
export function guardedDiscoveryFetch(fetchImpl, { register = false } = {}) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (headers.has('PAYMENT-SIGNATURE') || headers.has('X-PAYMENT') || headers.has('Authorization')) throw new Error('Audit transport cannot submit a seller payment or credentials');
    const seller = DISCOVERY_REQUESTS.includes(url.href);
    const catalog = url.origin === FACILITATOR && ['/discovery/resources', '/discovery/listing-status'].includes(url.pathname);
    const verification = register && url.href === `${FACILITATOR}/verify` && method === 'POST';
    if (!((method === 'GET' && (seller || catalog) && init.body === undefined) || verification)) throw new Error('Forbidden discovery transport target or method');
    if (verification) {
      const body = JSON.parse(init.body);
      const payload = body.paymentPayload;
      validateOffer({ x402Version: payload?.x402Version, resource: payload?.resource, accepts: [body.paymentRequirements], extensions: payload?.extensions }, payload?.resource?.url);
      if (body.x402Version !== 2 || JSON.stringify(payload.accepted) !== JSON.stringify(body.paymentRequirements) || typeof payload.payload?.transaction !== 'string') throw new Error('Invalid verify-only request');
    }
    return fetchImpl(url.href, { ...init, method, redirect: 'error', signal: init.signal || AbortSignal.timeout(20_000) });
  };
}

// No key files, private-key environment variables, broadcasts or signed retries.
export async function createEphemeralPayloadBuilder({ rpcUrl = RPC_URL } = {}) {
  const signer = await generateKeyPairSigner();
  const client = new x402Client();
  client.setSpendControls({ maxAmountPerPayment: '$0.01' });
  client.register(X402_DEPLOYMENT_NETWORK, new ExactSvmScheme(signer, { rpcUrl }));
  return offer => client.createPaymentPayload(offer);
}

function decodeExtensionResponse(header) {
  if (!header) return { status: 'missing' };
  try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')).bazaar || { status: 'missing' }; }
  catch { return { status: 'invalid-response-header' }; }
}

export async function checkDiscovery({ register = false, fetchImpl = fetch, createPayload } = {}) {
  const request = guardedDiscoveryFetch(fetchImpl, { register });
  const offers = [];
  // Validate every live offer before generating a signer or sending /verify.
  for (const requestUrl of DISCOVERY_REQUESTS) {
    const response = await request(requestUrl);
    if (response.status !== 402) throw new Error(`Expected HTTP 402 at ${requestUrl}; received ${response.status}`);
    const header = response.headers.get('PAYMENT-REQUIRED');
    if (!header) throw new Error('Missing PAYMENT-REQUIRED header');
    const offer = decodePaymentRequiredHeader(header);
    const resource = validateOffer(offer, requestUrl);
    offers.push({ requestUrl, resource, offer });
  }
  const buildPayload = register ? (createPayload || await createEphemeralPayloadBuilder()) : null;
  const resources = [];
  for (const { requestUrl, resource, offer } of offers) {
    let registration;
    if (register) {
      const paymentPayload = await buildPayload(offer);
      const response = await request(`${FACILITATOR}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: paymentPayload.accepted }),
      });
      const verification = await response.json();
      registration = { httpStatus: response.status, isValid: verification.isValid, invalidReason: verification.invalidReason, extension: decodeExtensionResponse(response.headers.get('EXTENSION-RESPONSES')) };
    }
    const statusResponse = await request(`${FACILITATOR}/discovery/listing-status?resource=${encodeURIComponent(resource)}`);
    const status = await statusResponse.json();
    resources.push({ requestUrl, resource, offer: 'valid', ...(registration ? { registration } : {}), listing: { httpStatus: statusResponse.status, listed: status.listed === true, hidden: status.hidden, hiddenReason: status.hiddenReason, lastWrite: status.lastWrite, lastProbe: status.lastProbe } });
  }
  const catalogResponse = await request(`${FACILITATOR}/discovery/resources?payTo=${encodeURIComponent(X402_DEPLOYMENT_PAY_TO)}&network=${encodeURIComponent(X402_DEPLOYMENT_NETWORK)}&extensions=bazaar&limit=100`);
  if (!catalogResponse.ok) throw new Error(`Catalog request failed: HTTP ${catalogResponse.status}`);
  const catalog = await catalogResponse.json();
  const expected = new Set(resources.map(item => item.resource));
  const listings = (catalog.items || []).filter(item => expected.has(item.resource)).map(item => ({
    resource: item.resource, method: item.method, serviceName: item.serviceName, tags: item.tags, lastUpdated: item.lastUpdated,
    termsMatch: item.accepts?.some(accept => Object.entries(TERMS).every(([key, value]) => accept[key] === value)) === true,
    declarationValid: validateDiscoveryExtension(item.extensions?.bazaar || {}).valid,
  }));
  return { mode: register ? 'verify-only registration' : 'read-only', fundsMoved: false, resources, catalog: { httpStatus: catalogResponse.status, totalForWallet: catalog.pagination?.total, matching: listings } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--register') || args.length > 1) {
    console.error('Usage: node scripts/check-x402-discovery.mjs [--register]');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await checkDiscovery({ register: args.includes('--register') }), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
