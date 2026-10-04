import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { buildPageMetadata } from '../../utils/siteMetadata';
import { getX402PublicConfiguration } from '../../utils/x402Payments.js';
import { X402_RESOURCES } from '../../utils/x402Catalog.js';
import styles from './data-access.module.css';

export const dynamic = 'force-dynamic';

export const metadata = buildPageMetadata({
  title: 'Data Access — $0.01 x402 Requests',
  description: 'Machine-readable financial research for crawlers and agents. Pay 0.01 USDC per successful paid request using x402 on Base.',
  path: '/data-access',
});

const requestExample = "curl -i 'https://secedgarterminal.com/api/x402/v1/factor-universe?basis=ttm&limit=100&offset=0'";
const clientExample = `import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

// Keep the funded wallet's key in your own secure environment.
const signer = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY);
// Confirm this public recipient against the data-access catalog first.
const expectedRecipient = process.env.EXPECTED_PAY_TO;
if (!expectedRecipient) throw new Error('Confirm the payout address first');
const url = 'https://secedgarterminal.com/api/x402/v1/factor-universe?basis=ttm&limit=100&offset=0';
const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const client = new x402Client({
  spendControls: { maxAmountPerPayment: '$0.01' },
});
client.register('eip155:8453', new ExactEvmScheme(signer));
client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements: offer }) => {
  if (offer.network !== 'eip155:8453'
    || offer.asset.toLowerCase() !== usdc.toLowerCase()
    || BigInt(offer.amount) > 10000n
    || offer.payTo.toLowerCase() !== expectedRecipient.toLowerCase()
    || paymentRequired.resource.url !== url) {
    return { abort: true, reason: 'Unexpected payment offer' };
  }
});
const paidFetch = wrapFetchWithPayment(fetch, client);

const response = await paidFetch(url);
if (!response.ok) throw new Error(\`Request failed: \${response.status}\`);
const data = await response.json();`;

export default function DataAccessPage() {
  const configuration = getX402PublicConfiguration();
  const active = configuration.status === 'active';
  return (
    <article className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Data access for crawlers & agents</p>
          <h1>Financial research.<br /><span>One request at a time.</span></h1>
          <p className={styles.intro}>Retrieve prepared financial data with source evidence through paid x402 endpoints. Public research pages and existing public summaries stay free.</p>
          <div className={styles.links}>
            <a href='/api/x402'>Resource catalog <ArrowRight size={16} aria-hidden='true' /></a>
            <a href='/openapi.json'>OpenAPI document <ArrowUpRight size={15} aria-hidden='true' /></a>
          </div>
        </div>
        <aside className={styles.price} aria-label='Paid request pricing'>
          <p className={styles.eyebrow}>Per successful paid request</p>
          <p className={styles.amount}>$0.01</p>
          <p>0.01 USDC · Base mainnet</p>
          <p className={styles.status} data-active={active}>{active ? 'Payments active' : 'Payments are not active yet'}</p>
          <p className={styles.priceNote}>{active ? 'No subscription or API key. Use an x402-compatible client and a funded wallet.' : 'Paid resources will accept payments once a payout wallet and settlement service are connected. No payment is collected while unavailable.'}</p>
        </aside>
      </header>

      <section className={styles.section} aria-labelledby='resources-title'>
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>Resource catalog</p><h2 id='resources-title'>Choose a prepared dataset.</h2><p>The same price applies to each listed paid GET, including each page of a dataset. Coverage and source dates travel with the data.</p></div>
        <div className={styles.resources}>
          {X402_RESOURCES.map(resource => <article key={resource.id}>
            <div><h3>{resource.name}</h3><p>{resource.description}</p><p className={styles.limitation}>{resource.limitations}</p></div>
            <div className={styles.route}><code>GET {resource.path}</code><p>{resource.parameters.map(parameter => `${parameter.name}: ${parameter.values.join(' | ')} (default ${parameter.default})`).join('; ')}</p></div>
          </article>)}
        </div>
      </section>

      <section className={styles.section} aria-labelledby='payments-title'>
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>x402 · Protocol version 2</p><h2 id='payments-title'>Request, authorize, receive.</h2></div>
        <ol className={styles.steps}>
          <li><span>01</span><h3>Read the price</h3><p>A request without valid payment receives HTTP 402 and a <code>PAYMENT-REQUIRED</code> header describing the payment requirements.</p></li>
          <li><span>02</span><h3>Authorize 0.01 USDC</h3><p>Your compatible client signs payment authorization and retries with <code>PAYMENT-SIGNATURE</code>. Review the amount, recipient and network before spending.</p></li>
          <li><span>03</span><h3>Receive the dataset</h3><p>After verification and successful settlement, the response delivers the data and a <code>PAYMENT-RESPONSE</code> receipt.</p></li>
        </ol>
        <p className={styles.note}>Payment is required on these endpoints regardless of browser or crawler identity. Existing crawlers must support x402 and authorize spending to participate.</p>
      </section>

      <section className={styles.section} aria-labelledby='start-title'>
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>Start here</p><h2 id='start-title'>Inspect first. Then connect your client.</h2><p>This curl request inspects the response and does not authorize payment. Inactive payments return HTTP 503. When active, inspect the HTTP 402 requirements before signing. Unavailable resources are not settled.</p></div>
        <pre className={styles.code}><code>{requestExample}</code></pre>
        <details className={styles.example}>
          <summary>Node.js client example using the official x402 SDK</summary>
          <p>Install <code>@x402/fetch</code>, <code>@x402/evm</code> and <code>viem</code>. This client can authorize payment; use a funded Base wallet, confirm the payout address in the resource catalog and enforce your total spending limit. The example caps each payment at 0.01 USDC and checks the offer before signing.</p>
          <p>A pending or unknown settlement needs reconciliation before another authorization. HTTP 409 may indicate an already-used payment. Keep the payment receipt and transaction information; do not automatically sign a replacement payment after an error.</p>
          <pre className={styles.code}><code>{clientExample}</code></pre>
          <a href='https://docs.x402.org/getting-started/quickstart-for-buyers' target='_blank' rel='noopener noreferrer'>Official buyer guide <ArrowUpRight size={14} aria-hidden='true' /></a>
        </details>
      </section>

      <section className={styles.details} aria-label='Billing and data details'>
        {active && configuration.payTo && <details><summary>Current payment recipient</summary><p>Network: Base mainnet (<code>eip155:8453</code>). Asset: USDC. Confirm this payout wallet before authorizing a payment: <code>{configuration.payTo}</code>. The signed challenge is the source of the offer for your exact request.</p></details>}
        <details><summary>How do I retrieve multiple pages?</summary><p>Refinancing and factor-universe responses include snapshot metadata, the requested company rows and <code>pagination</code> with <code>offset</code>, <code>limit</code>, <code>total</code>, <code>nextOffset</code> and <code>snapshot</code>. Use <code>nextOffset</code> for the next request and pass the returned <code>snapshot</code> token on every later page. A changed snapshot returns HTTP 409 without settlement; restart from the first page to keep one consistent dataset. Each successfully settled page costs 0.01 USDC.</p></details>
        <details><summary>What counts as a paid crawl?</summary><p>One successfully settled GET to a listed paid endpoint costs 0.01 USDC. A new retrieval requires a new payment authorization. Public pages, discovery documents and public API previews are free. Invalid requests and unavailable datasets are not settled. Payment alone does not guarantee complete source coverage.</p></details>
        <details><summary>Dates, coverage and shared public data</summary><p>These endpoints deliver prepared research and do not start bulk source collection. Some research also appears on public pages or public APIs. The fee is for this paid machine-access service, not ownership of government records. Preserve reporting periods, retrieval times, nulls, stale status and source links when using the data.</p></details>
        <details><summary>Receipts and payment support</summary><p>Keep the response receipt and transaction identifier. Wallet addresses and settled transfers can be visible on the public blockchain. If a settled request fails to deliver, contact <a href='https://github.com/EconometricsEdward/sec-edgar-terminal/issues' target='_blank' rel='noopener noreferrer'>project support</a> with the transaction identifier and requested resource. Do not post private keys or signed payment headers. See the <Link href='/terms' prefetch={false}>terms</Link> and <Link href='/privacy' prefetch={false}>privacy notice</Link>.</p></details>
      </section>
      <footer className={styles.closing}><p>Public data. Traceable research.</p><Link href='/analysis' prefetch={false}>Explore free research <ArrowRight size={16} aria-hidden='true' /></Link></footer>
    </article>
  );
}
