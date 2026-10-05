#!/usr/bin/env node
// Default: read-only offer/catalog audit. --register sends verify-only requests
// from a fresh in-memory signer, or an explicitly selected local keypair.
// Never settles, broadcasts or retries a seller with a signed payment.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { bazaarResourceServerExtension, extractDiscoveryInfo, validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { createKeyPairSignerFromBytes, generateKeyPairSigner } from '@solana/kit';
import { X402_DEPLOYMENT_PAY_TO, X402_DEPLOYMENT_NETWORK } from '../src/utils/x402Deployment.js';
import { x402DiscoveryOptions } from '../src/utils/x402Discovery.js';

const ORIGIN = 'https://secedgarterminal.com';
const FACILITATOR = 'https://facilitator.payai.network';
const RPC_URL = 'https://api.mainnet-beta.solana.com';
const ASSET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DISCOVERY_REQUESTS = Object.freeze([
  `${ORIGIN}/api/x402/v1/financials/AAPL?basis=annual`,
  `${ORIGIN}/api/x402/v1/factor-universe?basis=ttm&limit=100&offset=0`,
  `${ORIGIN}/api/x402/v1/refinancing?limit=100&offset=0`,
  `${ORIGIN}/api/x402/v1/financial-batch?tickers=AAPL%2CMSFT&basis=annual`,
  `${ORIGIN}/api/x402/v1/fundamental-screen?basis=ttm&limit=100&offset=0`,
  `${ORIGIN}/api/x402/v1/credit-screen?limit=100&offset=0`,
  `${ORIGIN}/api/x402/v1/financial-changes?tickers=AAPL%2CMSFT&basis=annual&comparison=year`,
  `${ORIGIN}/api/x402/v1/disclosure-evidence?query=liquidity&limit=10`,
  `${ORIGIN}/api/x402/v1/institutional-overlap?ciks=0001067983%2C0001350694&period=2026-06-30&limit=100&offset=0`,
  `${ORIGIN}/api/x402/v1/disclosure-topic-packet?cik=0000019617&topics=liquidity%2Ccovenants%2Ccollateral`,
  `${ORIGIN}/api/x402/v1/bank-risk-batch?rssds=852218%2C480228&period=2026-06-30`,
]);
export const DISCOVERY_RESOURCES = Object.freeze(DISCOVERY_REQUESTS.map(requestUrl => {
  const url = new URL(requestUrl);
  return `${url.origin}${url.pathname}`;
}));
const RESOURCE_IDS = ['financials', 'factor-universe', 'refinancing', 'financial-batch', 'fundamental-screen', 'credit-screen', 'financial-changes', 'disclosure-evidence', 'institutional-overlap', 'disclosure-topic-packet', 'bank-risk-batch'];
const TERMS = Object.freeze({ scheme: 'exact', network: X402_DEPLOYMENT_NETWORK, asset: ASSET, amount: '10000', payTo: X402_DEPLOYMENT_PAY_TO });

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function expectedDeclaration(index) {
  const options = x402DiscoveryOptions(RESOURCE_IDS[index]);
  const extension = bazaarResourceServerExtension.enrichDeclaration(options.extensions.bazaar, {
    method: 'GET', routePattern: options.routePattern,
    adapter: { getPath: () => new URL(DISCOVERY_RESOURCES[index]).pathname },
  });
  if (options.omitDiscoveryRouteTemplate) delete extension.routeTemplate;
  return { options, extension };
}

function validateDiscoveryOffer(offer, requestUrl, index) {
  if (index < 0 || offer?.x402Version !== 2 || offer.resource?.url !== requestUrl) throw new Error('Unexpected payment resource');
  if (['payload', 'paymentPayload', 'signature', 'transaction'].some(key => Object.hasOwn(offer, key))) throw new Error('Discovery offer cannot contain a signed payment payload');
  if (offer.accepts?.length !== 1 || !Object.entries(TERMS).every(([key, value]) => offer.accepts[0][key] === value)) throw new Error('Unexpected payment terms');
  const expected = expectedDeclaration(index);
  if (offer.resource.serviceName !== expected.options.serviceName || offer.resource.iconUrl !== expected.options.iconUrl
    || stableJson(offer.resource.tags) !== stableJson(expected.options.tags) || offer.resource.mimeType !== 'application/json') throw new Error('Unexpected service discovery metadata');
  const extension = offer.extensions?.bazaar;
  const verdict = extension && validateDiscoveryExtension(extension);
  if (!verdict?.valid || extension.info?.input?.method !== 'GET') throw new Error(`Invalid Bazaar declaration: ${verdict?.errors?.join(', ') || 'missing GET declaration'}`);
  if (stableJson(extension) !== stableJson(expected.extension)) throw new Error('Unexpected Bazaar GET discovery contract');
  const discovery = extractDiscoveryInfo({ x402Version: 2, resource: offer.resource, extensions: offer.extensions }, offer.accepts[0]);
  if (discovery?.resourceUrl !== DISCOVERY_RESOURCES[index]) throw new Error('Unexpected extracted discovery resource');
  return discovery.resourceUrl;
}

export function validateOffer(offer, requestUrl) {
  return validateDiscoveryOffer(offer, requestUrl, DISCOVERY_REQUESTS.indexOf(requestUrl));
}

/** A probe describes a GET contract; it can never become a purchase URL. */
export function validateDiscoveryProbe(offer, resourceUrl) {
  return validateDiscoveryOffer(offer, resourceUrl, DISCOVERY_RESOURCES.indexOf(resourceUrl));
}

/** Restrict the audit transport, including its optional registration mutation. */
export function guardedDiscoveryFetch(fetchImpl, { register = false } = {}) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (['PAYMENT-SIGNATURE', 'X-PAYMENT', 'X-X402-Recovery-Token', 'Authorization', 'Proxy-Authorization', 'Cookie'].some(name => headers.has(name))) throw new Error('Audit transport cannot submit a seller payment or credentials');
    const seller = DISCOVERY_REQUESTS.includes(url.href);
    const probe = method === 'HEAD' && DISCOVERY_RESOURCES.includes(url.href);
    const catalog = url.origin === FACILITATOR && ['/discovery/resources', '/discovery/listing-status'].includes(url.pathname);
    const verification = register && url.href === `${FACILITATOR}/verify` && method === 'POST';
    const readonly = ((method === 'GET' && (seller || catalog)) || probe) && init.body === undefined;
    if (!(readonly || verification)) throw new Error('Forbidden discovery transport target or method');
    if (verification) {
      const body = JSON.parse(init.body);
      const payload = body.paymentPayload;
      validateOffer({ x402Version: payload?.x402Version, resource: payload?.resource, accepts: [body.paymentRequirements], extensions: payload?.extensions }, payload?.resource?.url);
      if (body.x402Version !== 2 || JSON.stringify(payload.accepted) !== JSON.stringify(body.paymentRequirements) || typeof payload.payload?.transaction !== 'string') throw new Error('Invalid verify-only request');
    }
    return fetchImpl(url.href, { ...init, method, redirect: 'error', signal: init.signal || AbortSignal.timeout(20_000) });
  };
}

/** Only called after an explicit --register --keypair selection on the buyer's machine. */
export async function loadLocalKeypairSigner(keypairPath, { readFile = readFileSync } = {}) {
  let bytes;
  try {
    if (typeof keypairPath !== 'string' || !keypairPath.trim()) throw new Error();
    const source = readFile(keypairPath, 'utf8');
    if (typeof source !== 'string' || source.length > 4096) throw new Error();
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error();
    bytes = new Uint8Array(parsed);
    return await createKeyPairSignerFromBytes(bytes);
  } catch {
    // Never include parsing errors, file contents or key bytes in output.
    throw new Error('Unable to load local keypair: select a readable Solana JSON keypair containing exactly 64 integer bytes.');
  } finally { bytes?.fill(0); }
}

function payloadBuilder(signer, rpcUrl) {
  const client = new x402Client();
  client.setSpendControls({ maxAmountPerPayment: '$0.01' });
  client.register(X402_DEPLOYMENT_NETWORK, new ExactSvmScheme(signer, { rpcUrl }));
  return offer => client.createPaymentPayload(offer);
}

export async function createEphemeralPayloadBuilder({ rpcUrl = RPC_URL } = {}) {
  return payloadBuilder(await generateKeyPairSigner(), rpcUrl);
}

export async function createLocalPayloadBuilder(keypairPath, { rpcUrl = RPC_URL, readFile } = {}) {
  return payloadBuilder(await loadLocalKeypairSigner(keypairPath, { readFile }), rpcUrl);
}

function decodeExtensionResponse(header) {
  if (!header) return { status: 'missing' };
  try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')).bazaar || { status: 'missing' }; }
  catch { return { status: 'invalid-response-header' }; }
}

export async function checkDiscovery({ register = false, keypairPath, fetchImpl = fetch, createPayload } = {}) {
  if (keypairPath && !register) throw new Error('--keypair requires explicit --register; read-only mode never reads a keypair.');
  const request = guardedDiscoveryFetch(fetchImpl, { register });
  const offers = [];
  // Validate every live GET offer and its query-free HEAD probe before reading
  // a private key, generating a signer, signing or sending anything to /verify.
  for (const requestUrl of DISCOVERY_REQUESTS) {
    const response = await request(requestUrl);
    if (response.status !== 402) throw new Error(`Expected HTTP 402 at ${requestUrl}; received ${response.status}`);
    const header = response.headers.get('PAYMENT-REQUIRED');
    if (!header) throw new Error('Missing PAYMENT-REQUIRED header');
    const offer = decodePaymentRequiredHeader(header);
    const resource = validateOffer(offer, requestUrl);
    offers.push({ requestUrl, resource, offer });
  }
  for (const entry of offers) {
    const response = await request(entry.resource, { method: 'HEAD' });
    if (response.status !== 402) throw new Error(`Expected unpaid HEAD HTTP 402 at ${entry.resource}; received ${response.status}`);
    const header = response.headers.get('PAYMENT-REQUIRED');
    if (!header) throw new Error(`Missing HEAD PAYMENT-REQUIRED header at ${entry.resource}`);
    validateDiscoveryProbe(decodePaymentRequiredHeader(header), entry.resource);
    entry.probe = { method: 'HEAD', httpStatus: response.status, offer: 'valid', purchaseMethod: 'GET' };
  }
  const buildPayload = register ? (createPayload || (keypairPath ? await createLocalPayloadBuilder(keypairPath) : await createEphemeralPayloadBuilder())) : null;
  const resources = [];
  for (const { requestUrl, resource, offer, probe } of offers) {
    let registration;
    if (register) {
      const paymentPayload = await buildPayload(offer);
      const response = await request(`${FACILITATOR}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: paymentPayload.accepted }),
      });
      const verification = await response.json();
      const extension = decodeExtensionResponse(response.headers.get('EXTENSION-RESPONSES'));
      const queued = extension.status === 'processing';
      registration = { httpStatus: response.status, isValid: verification.isValid, invalidReason: verification.invalidReason, extension, queued,
        outcome: queued ? 'queued; admission not yet confirmed' : 'not acknowledged as queued',
        ...(!queued ? { note: keypairPath
          ? 'The facilitator did not acknowledge discovery. Check verification and extension results; no listing is confirmed.'
          : 'The unfunded probe did not queue discovery. A buyer wallet with Solana USDC is needed for successful verification. Run locally with --register --keypair <buyer-keypair.json>, or complete a real buyer purchase. This script never settles.' } : {}),
      };
    }
    const statusResponse = await request(`${FACILITATOR}/discovery/listing-status?resource=${encodeURIComponent(resource)}`);
    const status = await statusResponse.json();
    resources.push({ requestUrl, resource, offer: 'valid', probe, ...(registration ? { registration } : {}), listing: { httpStatus: statusResponse.status, listed: status.listed === true, hidden: status.hidden, hiddenReason: status.hiddenReason, lastWrite: status.lastWrite, lastProbe: status.lastProbe } });
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
  return { mode: register ? (keypairPath ? 'verify-only local-keypair attempt' : 'verify-only unfunded probe') : 'read-only', fundsMoved: false, resources, catalog: { httpStatus: catalogResponse.status, totalForWallet: catalog.pagination?.total, matching: listings } };
}

export function parseDiscoveryArgs(args) {
  let register = false;
  let keypairPath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--register' && !register) register = true;
    else if (args[i] === '--keypair' && keypairPath === undefined && args[i + 1] && !args[i + 1].startsWith('--')) keypairPath = args[++i];
    else throw new Error('Invalid discovery arguments');
  }
  if (keypairPath && !register) throw new Error('--keypair requires --register');
  return { register, keypairPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseDiscoveryArgs(process.argv.slice(2));
    console.log(JSON.stringify(await checkDiscovery(options), null, 2));
  } catch (error) {
    console.error(error.message);
    console.error('Usage: node scripts/check-x402-discovery.mjs [--register [--keypair /local/path/buyer-keypair.json]]');
    console.error('Default is read-only. --register alone is an unfunded probe. --keypair is for local buyer verification with Solana USDC; it sends metadata to /verify, never settles or moves funds.');
    process.exitCode = 1;
  }
}
