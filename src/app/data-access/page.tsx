import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Braces, Database, FileDown, Layers3, ListFilter, ShieldCheck } from 'lucide-react';
import { buildPageMetadata } from '../../utils/siteMetadata';
import { getX402PublicConfiguration } from '../../utils/x402Payments.js';
import { getX402LivePublicConfiguration } from '../../utils/x402SolanaRecipient.js';
import { X402_RESOURCES, getX402StarterSelection } from '../../utils/x402Catalog.js';
import { buildX402BuyerExample } from '../../utils/x402BuyerExample.js';
import styles from './data-access.module.css';

export const dynamic = 'force-dynamic';

export const metadata = buildPageMetadata({
  title: 'Research Data API — Disclosures, Bank Risk & Financials',
  description: 'Company disclosure packets, bank capital and funding batches, financial change evidence and institutional holdings for agents. Source-linked JSON and CSV through x402.',
  path: '/data-access',
});

type Resource = {
  id: string;
  name: string;
  description: string;
  path: string;
  example: string;
  limitations: string;
  parameters: Array<{ name: string; values: string[]; default: string }>;
  useCase?: string;
  includes?: string[];
  formats?: string[];
  limits?: string;
};

const PRODUCT_DETAILS: Record<string, { useCase: string; includes: string[]; formats: string[]; limits: string }> = {
  'financial-batch': {
    useCase: 'Build a watchlist model with one request for several companies.',
    includes: ['Up to 10 prepared company financial histories', 'Annual, quarterly, YTD or TTM selections', 'JSON bundle or tabular CSV export'],
    formats: ['json', 'csv'],
    limits: 'Up to 10 tickers per request. Prepared coverage only.',
  },
  'fundamental-screen': {
    useCase: 'Select and rank companies for an accounting-based research screen.',
    includes: ['Filter a sector and metric, including current values or changes', 'Selected metric values and sector peer percentiles', 'Sorted JSON or CSV pages pinned to one snapshot'],
    formats: ['json', 'csv'],
    limits: 'Up to 100 issuer rows per request. TTM or annual basis.',
  },
  'credit-screen': {
    useCase: 'Select a company list for debt, liquidity and refinancing research.',
    includes: ['Filter prepared debt, liquidity, maturity and coverage measures', 'Cash shortfall against the first reported maturity bucket', 'Sorted JSON or CSV pages with filing evidence'],
    formats: ['json', 'csv'],
    limits: 'Up to 100 company rows per request. Available snapshot coverage only.',
  },
  financials: {
    useCase: 'Inspect one company’s prepared financial model and evidence.',
    includes: ['Available statement history and reporting periods', 'Metric definitions, units and calculation context', 'Prepared SEC source evidence'],
    formats: ['json'],
    limits: 'One company per request. Annual, quarterly, YTD or TTM basis.',
  },
  'factor-universe': {
    useCase: 'Bring the prepared issuer universe into your own research pipeline.',
    includes: ['Filing-based company and sector fundamentals', 'Explicit coverage and equal-issuer-weight breadth', 'Snapshot-consistent pagination'],
    formats: ['json'],
    limits: 'Up to 100 issuer rows per request. Each settled page is billed.',
  },
  refinancing: {
    useCase: 'Retrieve the prepared company debt-maturity dataset for your own analysis.',
    includes: ['Company debt-maturity and liquidity context', 'Filing evidence and explicit coverage', 'Snapshot-consistent pagination'],
    formats: ['json'],
    limits: 'Up to 100 company rows per request. Each settled page is billed.',
  },
};

const PRODUCT_ORDER = ['disclosure-topic-packet', 'bank-risk-batch', 'disclosure-evidence', 'credit-screen', 'financial-changes', 'institutional-overlap', 'financial-batch', 'fundamental-screen', 'financials', 'factor-universe', 'refinancing'];
const PRODUCT_ICONS = { 'financial-batch': Layers3, 'fundamental-screen': ListFilter, 'credit-screen': ShieldCheck, financials: Braces, 'factor-universe': Database, refinancing: FileDown };
const requestExample = "curl -i 'https://secedgarterminal.com/api/x402/v1/financial-batch?tickers=AAPL%2CMSFT&basis=annual'";

export default async function DataAccessPage() {
  const configuration = await getX402LivePublicConfiguration(getX402PublicConfiguration());
  const clientExample = buildX402BuyerExample(configuration);
  const resources = [...(X402_RESOURCES as Resource[])].sort((a, b) => PRODUCT_ORDER.indexOf(a.id) - PRODUCT_ORDER.indexOf(b.id));
  const directoryQuery = new URLSearchParams({ limit: '100', ...(configuration.payTo ? { payTo: configuration.payTo } : {}) });
  const searchQuery = new URLSearchParams({ query: 'SEC EDGAR Terminal', ...(configuration.payTo ? { payTo: configuration.payTo } : {}) });
  const dataCatalog = {
    '@context': 'https://schema.org',
    '@type': 'DataCatalog',
    name: 'SEC EDGAR Terminal machine data products',
    url: 'https://secedgarterminal.com/data-access',
    description: 'Company disclosure topic packets, legal-bank capital and funding batches, financial-change evidence, institutional holdings and research screens. Starter pricing is 0.01 USDC on Solana per successfully settled bounded GET.',
    dataset: resources.map(resource => ({
      '@type': 'Dataset',
      name: resource.name,
      description: `${resource.description} ${resource.limitations}`,
      url: `https://secedgarterminal.com/data-access#${resource.id}`,
      isAccessibleForFree: false,
      distribution: (resource.formats || PRODUCT_DETAILS[resource.id]?.formats || ['json']).map(format => ({ '@type': 'DataDownload', encodingFormat: format === 'csv' ? 'text/csv' : 'application/json', contentUrl: `https://secedgarterminal.com${resource.example}${format === 'csv' ? '&format=csv' : ''}` })),
    })),
  };
  const active = configuration.status === 'active';
  const paymentStatus = active ? 'Payments active'
    : configuration.status === 'recipient-setup-required' ? 'USDC receiving account setup required'
    : configuration.status === 'recipient-check-unavailable' ? 'Payment readiness is temporarily unavailable'
    : 'Payments are not active yet';
  const paymentNote = active ? 'No subscription or API key. Connect an x402-compatible client with a funded wallet.'
    : configuration.status === 'recipient-setup-required' ? "The recipient’s USDC receiving account needs setup. No payment is collected while unavailable."
    : configuration.status === 'recipient-check-unavailable' ? 'The receiving account could not be checked. Try again later; no payment is collected while readiness is unavailable.'
    : 'Paid resources accept payments once the payout wallet and settlement service are ready. No payment is collected while unavailable.';

  return (
    <article className={styles.page}>
      <script type='application/ld+json' dangerouslySetInnerHTML={{ __html: JSON.stringify(dataCatalog).replace(/</g, '\\u003c') }} />
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Filing & regulatory data for agents</p>
          <h1>From filing data<br /><span>to your workflow.</span></h1>
          <p className={styles.intro}>Research company liquidity and covenant disclosures. Compare bank capital, credit quality and funding. Bring source-linked evidence into your agent’s workflow with prepared research packets, batches and exports.</p>
          <div className={styles.heroActions}>
            <a className={styles.primary} href='#products'>Choose a data product <ArrowRight size={17} aria-hidden='true' /></a>
            <a href='/api/x402'>Machine catalog <ArrowUpRight size={15} aria-hidden='true' /></a>
          </div>
          <div className={styles.trust}><span>Source context included</span><span>JSON & CSV products</span><span>Optional 24-hour delivery recovery</span></div>
        </div>
        <aside className={styles.price} aria-label='Paid request pricing'>
          <p className={styles.eyebrow}>Starter pricing · Per bounded GET</p>
          <p className={styles.amount}>$0.01</p>
          <p>0.01 USDC · Solana mainnet</p>
          <p className={styles.priceNote}>One successfully settled response. A batch of up to 10 companies is one request. Each page of a screen or dataset is one request.</p>
          <p className={styles.status} data-active={active}>{paymentStatus}</p>
          <p className={styles.priceNote}>{paymentNote}</p>
        </aside>
      </header>

      <section className={styles.section} id='products' aria-labelledby='products-title'>
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>The product catalog</p><h2 id='products-title'>Choose the work you want to save.</h2><p>Use an evidence packet for a specific research question, a batch or screen for a data workflow, or retrieve prepared models for your own pipeline. Check coverage free before purchasing an evidence product.</p></div>
        <div className={styles.resources}>
          {resources.map(resource => {
            const starterSelection = getX402StarterSelection(resource);
            const fallback = PRODUCT_DETAILS[resource.id];
            const Icon = PRODUCT_ICONS[resource.id as keyof typeof PRODUCT_ICONS] || Database;
            const formats = resource.formats || fallback?.formats || ['json'];
            return <article key={resource.id} id={resource.id} className={styles.product}>
              <div className={styles.productTop}><Icon size={22} strokeWidth={1.6} aria-hidden='true' /><span>{formats.map(format => format.toUpperCase()).join(' / ')}</span><span className={styles.productPrice}>0.01 USDC</span></div>
              <h3>{resource.name}</h3>
              <p className={styles.useCase}>{resource.useCase || fallback?.useCase || resource.description}</p>
              <ul className={styles.includes}>{(resource.includes || fallback?.includes || [resource.description]).map(item => <li key={item}>{item}</li>)}</ul>
              <p className={styles.bounds}>{resource.limits || fallback?.limits || resource.limitations}</p>
              <details className={styles.contract}><summary>Request details & limitations</summary><code>GET {resource.path}</code>{starterSelection ? <p>With no query parameters, this buys the starter selection: <code>{JSON.stringify(starterSelection)}</code>. To choose another selection, include all required fields. A partial or invalid query is rejected.</p> : null}<p>{resource.parameters.map(parameter => `${parameter.name}: ${parameter.values.join(' | ')} (default ${parameter.default === 'required' && starterSelection ? 'required when any query is supplied' : parameter.default})`).join('; ')}</p><p>{resource.limitations}</p></details>
              <a className={styles.inspect} href={resource.example}>Inspect the payment offer <ArrowUpRight size={15} aria-hidden='true' /></a>
              {['disclosure-topic-packet', 'bank-risk-batch', 'financial-changes', 'disclosure-evidence', 'institutional-overlap'].includes(resource.id) ? <a className={styles.inspect} href={`/api/x402/availability?product=${resource.id}&${resource.example.split('?')[1]}`}>Check prepared coverage free <ArrowUpRight size={15} aria-hidden='true' /></a> : null}
            </article>;
          })}
        </div>
        <p className={styles.note}>Inspecting an unsigned request does not authorize a payment. An active endpoint returns HTTP 402 with the price and payment requirements. Source readiness is checked before settlement.</p>
      </section>

      <section className={styles.section} aria-labelledby='value-title'>
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>What you are paying for</p><h2 id='value-title'>Less request coordination. More usable output.</h2><p>Public records and research remain accessible. The paid products package that research into bounded machine workflows, including selection, sorting, batch delivery and exports.</p></div>
        <div className={styles.comparison} role='region' aria-label='Public research and paid machine products comparison' tabIndex={0}>
          <table><thead><tr><th scope='col'>Research task</th><th scope='col'>Free public research</th><th scope='col'>Paid machine products</th></tr></thead><tbody>
            <tr><th scope='row'>Understand a company</th><td>Browse statements, charts and SEC evidence.</td><td>Retrieve a prepared model or several company histories together.</td></tr>
            <tr><th scope='row'>Explain a financial change</th><td>Inspect history and reported source inputs.</td><td>Receive compatible latest-versus-baseline observations, changes and compact evidence.</td></tr>
            <tr><th scope='row'>Ground a disclosure answer</th><td>Search and read filings in the public tools.</td><td>Retrieve complete retained paragraphs with exact query verification and source context.</td></tr>
            <tr><th scope='row'>Research several disclosure topics</th><td>Search each topic and organize the filing evidence.</td><td>Receive one company packet with grouped topic evidence, matching rules and extraction coverage.</td></tr>
            <tr><th scope='row'>Compare legal banks</th><td>Inspect individual Call Reports and regulatory histories.</td><td>Receive a same-quarter bank batch with native units, ratio inputs and compatible prior-quarter changes.</td></tr>
            <tr><th scope='row'>Compare institutional positions</th><td>Explore historical 13F manager portfolios.</td><td>Receive reconciled same-quarter overlap with per-manager exposure and amendment evidence.</td></tr>
            <tr><th scope='row'>Build a selected universe</th><td>Explore company and sector data through public tools and APIs.</td><td>Request filtered, sorted fundamental or credit results.</td></tr>
            <tr><th scope='row'>Move data into your tools</th><td>Use public summaries and research exports.</td><td>Receive JSON or CSV from the batch and screen endpoints.</td></tr>
            <tr><th scope='row'>Complete a paginated pull</th><td>Use the public data contracts available for each surface.</td><td>Pin the returned snapshot across paid pages.</td></tr>
            <tr><th scope='row'>Recover a lost response</th><td>Retry a free request for the currently available research.</td><td>Opt in before purchase to recover the exact purchased output within 24 hours.</td></tr>
          </tbody></table>
        </div>
        <p className={styles.note}>The fee pays for this delivery and processing service. It does not grant exclusive ownership of SEC records. Some underlying research is also available free. These products use prepared coverage, preserve unavailable inputs, and do not promise real-time data or a fixed update schedule.</p>
      </section>

      <section className={styles.section} aria-labelledby='start-title'>
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>Integrate once</p><h2 id='start-title'>Check coverage. Connect your client.</h2><p>Start with the free catalog and evidence-product readiness checks. Review the exact resource, amount, recipient and network before your client authorizes payment. Add <code>format=csv</code> to an evidence, batch or screen request for a tabular export; JSON is the default.</p></div>
        <div className={styles.links}><a href='/openapi.json'>OpenAPI document <ArrowUpRight size={15} aria-hidden='true' /></a><a href='/llms.txt'>Agent guide <ArrowUpRight size={15} aria-hidden='true' /></a><a href='/api/x402'>Current resource catalog <ArrowUpRight size={15} aria-hidden='true' /></a></div>
        <pre className={styles.code}><code>{requestExample}</code></pre>
        <ol className={styles.steps}>
          <li><span>01</span><h3>Read the offer</h3><p>An unsigned active request returns HTTP 402 and a <code>PAYMENT-REQUIRED</code> header. Inactive payments return HTTP 503.</p></li>
          <li><span>02</span><h3>Authorize one request</h3><p>An x402-compatible client signs the exact 0.01 USDC offer and retries with <code>PAYMENT-SIGNATURE</code>.</p></li>
          <li><span>03</span><h3>Receive data & a receipt</h3><p>After verification and successful settlement, the response delivers data and a <code>PAYMENT-RESPONSE</code> receipt. Invalid selections and unavailable resources are not settled.</p></li>
        </ol>
        <details className={styles.example}>
          <summary>Node.js starter client using the official x402 SDK</summary>
          <p>Install the tested packages with <code>npm install @x402/core@2.28.0 @x402/fetch@2.28.0 @x402/svm@2.28.0 @solana/kit@6.9.0</code>. Save this example as a local <code>.mjs</code> file. It retrieves a fundamental-universe page using a funded development wallet and a private keypair file on your own computer. Confirm the public recipient in the catalog before running it. The example checks the exact amount, mint, recipient and network before signing, and prints the receipt with the data. Production agents should use a constrained signer with a total spending limit.</p>
          <p>Set <code>PAYER_KEYPAIR_FILE</code> to your local 64-byte Solana keypair JSON file. Set <code>RECOVERY_FILE</code> to a new private file in an existing local directory, using a different filename for each purchase. The example saves recovery details before requesting payment and refuses to overwrite an existing file. Keep both files private. To recover the same purchase, use its saved recovery file; creating another purchase file is not a retry.</p>
          <p>For optional delivery recovery, create and retain a random 32-byte token before a purchase and send its 64-character lowercase hexadecimal value as <code>X-X402-Recovery-Token</code>. A lost settled response can be recovered within 24 hours from <code>GET /api/x402/v1/delivery</code> with the same token header. Send no payment header or new authorization. A pending or unknown settlement needs reconciliation before another payment; recovery does not automatically resolve settlement. HTTP 409 may indicate an already-used payment. Keep the token, receipt and transaction information private.</p>
          <pre className={styles.code}><code>{clientExample}</code></pre>
          <a href='https://docs.x402.org/getting-started/quickstart-for-buyers' target='_blank' rel='noopener noreferrer'>Official buyer guide <ArrowUpRight size={14} aria-hidden='true' /></a>
          <a href='https://solana.com/docs/payments/agentic-payments/x402' target='_blank' rel='noopener noreferrer'>Solana x402 guide <ArrowUpRight size={14} aria-hidden='true' /></a>
        </details>
      </section>

      <section className={styles.section} aria-labelledby='discovery-title'>
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>Agent discovery</p><h2 id='discovery-title'>Find the contracts. Check the directory.</h2><p>All {resources.length} paid resources publish Bazaar input and output contracts alongside their payment offers. The local catalog and OpenAPI document describe the available products. External listing is a separate admission step handled by participating facilitators.</p></div>
        <div className={styles.links}>
          <a href={`https://facilitator.payai.network/discovery/resources?${directoryQuery}`} target='_blank' rel='noopener noreferrer'>Browse PayAI catalog <ArrowUpRight size={15} aria-hidden='true' /></a>
          <a href={`https://facilitator.payai.network/discovery/search?${searchQuery}`} target='_blank' rel='noopener noreferrer'>Search PayAI <ArrowUpRight size={15} aria-hidden='true' /></a>
          <a href='https://docs.x402.org/extensions/bazaar' target='_blank' rel='noopener noreferrer'>Bazaar guide <ArrowUpRight size={15} aria-hidden='true' /></a>
        </div>
        <p className={styles.note}>These links let you inspect the external directory. Publishing a payment offer or receiving a queued admission response does not confirm a visible listing or buyer demand. Ordinary crawlers must support x402 and authorize spending to purchase data.</p>
      </section>

      <section className={styles.details} aria-label='Billing and data details'>
        {configuration.payTo ? <details><summary>Current payment recipient</summary><p>Network: Solana mainnet (<code>solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp</code>). Asset: native USDC, mint <code>EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</code>. Confirm this payout wallet before authorizing a payment: <code>{configuration.payTo}</code>. The signed challenge supplies the offer for your exact request.</p></details> : null}
        <details><summary>How do I retrieve multiple pages?</summary><p>Refinancing, fundamental-universe and screen responses include snapshot metadata and pagination. Use <code>nextOffset</code> for the next request and pass the returned <code>snapshot</code> token on every later page, keeping the same filters and sorting. A changed snapshot returns HTTP 409 without settlement; restart from the first page to keep one consistent dataset. Each successfully settled page costs 0.01 USDC. CSV screen exports carry pagination, snapshot and selection context in their columns. A screen token pins both the source and the screening criteria; changing format or page size is allowed.</p></details>
        <details><summary>What counts as a paid request?</summary><p>One successfully settled bounded GET costs 0.01 USDC at current starter pricing. A financial batch of up to 10 tickers counts as one request. Each screen or dataset page counts as one request. A new retrieval needs a new payment authorization. Public pages, discovery documents and public API previews are free. Invalid requests and unavailable datasets are not settled.</p></details>
        <details><summary>Dates, coverage and data limitations</summary><p>These products deliver prepared research and do not start bulk source collection. Preserve reporting periods, retrieval times, units, nulls, stale status and source links. A financial history is not guaranteed to reconstruct information known at an earlier filing cutoff. Fundamental current and prior values are percentage levels; changes are percentage-point differences, so numeric bounds use the selected field’s units. Credit selectors named <code>next12m</code> use the first maturity bucket: the next fiscal year or a rolling twelve-month interval, as identified by its basis and dates. Fundamental screens describe accounting data rather than stock returns; credit screens are research filters rather than credit ratings or default probabilities. Source coverage and preparation dates vary.</p></details>
        <details><summary>Delivery recovery, receipts and payment support</summary><p>Opt in before a signed purchase by creating and retaining a random 32-byte token and sending it as <code>X-X402-Recovery-Token</code> in 64-character lowercase hexadecimal form. The recovery endpoint <code>GET /api/x402/v1/delivery</code> accepts the same token header, no query parameters and no payment headers. Within the 24-hour recovery window, a settled purchase returns its exact original JSON or CSV output and receipt without another payment. A pending purchase returns HTTP 202 with status information; a failed one returns 409; an expired or unknown token returns 404. Keep the token private: possession grants access to that delivery. Recovery is optional and does not guarantee settlement reconciliation.</p><p>Keep the response receipt and transaction identifier. Wallet addresses and settled transfers can be visible on the public blockchain. For unresolved delivery issues, contact <a href='https://github.com/EconometricsEdward/sec-edgar-terminal/issues' target='_blank' rel='noopener noreferrer'>project support</a> with the transaction identifier and requested resource. Do not post recovery tokens, private keys or signed payment headers. See the <Link href='/terms' prefetch={false}>terms</Link> and <Link href='/privacy' prefetch={false}>privacy notice</Link>.</p></details>
      </section>
      <footer className={styles.closing}><p>Public data. Traceable research.</p><Link href='/analysis' prefetch={false}>Explore free research <ArrowRight size={16} aria-hidden='true' /></Link></footer>
    </article>
  );
}
