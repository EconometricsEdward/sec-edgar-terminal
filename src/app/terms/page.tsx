import Link from "next/link";
import { buildPageMetadata } from "../../utils/siteMetadata";
import LegalShell from "./LegalShell";

export const metadata = buildPageMetadata({ title: "Service Terms", description: "Public financial research, paid x402 data access, source verification and service limitations at EDGAR Terminal.", path: "/terms" });

export default function TermsPage() {
  return <LegalShell title="Service terms" intro="Public research is free without an account. Dedicated paid data endpoints have separate per-request pricing.">
    <section><h2>Public financial research</h2>
      <p>EDGAR Terminal organizes public filings, financial data and market reports, with calculations, comparisons and hypothetical scenarios to support research. These terms apply when you use the service.</p>
      <p>The site is for research and education. It does not provide personalized investment, legal or tax advice, assess an investment’s suitability for you, manage money or execute trades. No investment return or financial outcome is guaranteed.</p>
      <p>EDGAR Terminal is independent of the SEC, CFTC and other government agencies. Use of their public records does not imply approval, endorsement or affiliation.</p>
    </section>
    <section><h2>Paid machine access</h2>
      <p>The <Link href="/data-access" prefetch={false}>data-access catalog</Link> lists paid endpoints for compatible crawlers and agents. Each successfully settled GET costs 0.01 USDC on Base mainnet, advertised as $0.01. USDC is a digital asset intended to track the U.S. dollar; its market value and availability can vary. Each page of a paginated dataset is a separate paid retrieval. Public pages, discovery documents and existing public API previews remain free.</p>
      <p>Your client authorizes payment through x402. Check the requested resource, amount, recipient and network before signing. You control your wallet, funds and spending limits. EDGAR Terminal does not request your private key or hold your funds. Any external wallet, network or settlement-provider charges are governed by that provider.</p>
      <p>Invalid requests and unavailable datasets are not settled. A paid response may contain explicitly labeled stale or incomplete coverage. The access fee pays for prepared data delivery and does not grant ownership of government records or promise exclusive data, future updates, historical as-filed coverage or a financial outcome.</p>
      <p>Keep payment receipts and transaction identifiers. Blockchain settlement can be irreversible, and a lost network response may not establish whether settlement completed. Do not assume an automatic refund or sign a replacement payment without checking the receipt or transaction. For a settled request that failed to deliver, contact project support with the transaction identifier and resource. Do not publish private keys or signed payment headers. Support requests are reviewed individually; rights required by applicable law remain in force.</p>
    </section>
    <section><h2>Source verification and limitations</h2>
      <p>Check important figures and claims against the original sources. Reporting dates, filing dates, units, coverage and calculation assumptions matter. Data can be delayed, incomplete, restated or mapped incorrectly, and a missing value does not mean zero.</p>
      <p>Reported records, application calculations and user-entered scenarios represent different kinds of information. Hypothetical scenarios are not forecasts. A search result or supported data field does not represent an exhaustive review of all public records.</p>
    </section>
    <section><h2>Availability and responsible use</h2>
      <p>Access depends on source availability, supported data coverage and service capacity. Rate limits and other safeguards may restrict requests. Features and coverage may change, and uninterrupted access is not guaranteed.</p>
      <p>Use the service lawfully. Do not bypass access controls or rate limits, interfere with other users or attempt to disrupt the application or its data sources. Access may be restricted to protect the service and address abuse.</p>
    </section>
    <section><h2>Your research and privacy</h2>
      <p>Submit only information you are authorized to use. Saved portfolios, preferences and supported local research use browser storage and do not automatically sync across devices. Export work you need to keep before clearing site data.</p>
      <p>Some tools send the identifiers and inputs needed to retrieve public data. The <Link href="/privacy" prefetch={false}>privacy notice</Link> describes research requests, browser storage and service providers.</p>
    </section>
    <section><h2>Changes and questions</h2>
      <p>Updates to these terms appear with a revised effective date. Nothing in these terms removes rights that cannot be waived under applicable law. Use the project support link below for questions about the service.</p>
    </section>
  </LegalShell>;
}
