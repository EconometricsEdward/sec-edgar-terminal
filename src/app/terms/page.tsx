import Link from "next/link";
import { buildPageMetadata } from "../../utils/siteMetadata";
import LegalShell from "./LegalShell";

export const dynamic = "force-dynamic";
export const metadata = buildPageMetadata({ title: "Service Terms", description: "Free research access, optional prepaid Hosted AI, answer credits and research limitations at EDGAR Terminal.", path: "/terms" });

export default function TermsPage() {
  return <LegalShell title="Service terms" intro="Public-data research remains free. Hosted AI is an optional paid service with a stated allowance and no recurring charge.">
    <section><h2>Free research and optional Hosted AI</h2>
      <p>You can use the public research pages and Data answers without purchasing Hosted AI or creating an account. Optional Browser AI runs generation on a compatible device after you choose to download its model; data retrieval still uses EDGAR Terminal and an internet connection.</p>
      <p>Hosted AI uses an external AI service. Paid purchases are initially available to adults aged 18 or older using a verified email account and a United States billing address. Keep your account secure and use a payment method you are authorized to use. These terms apply when you use the service; the paid purchase terms are presented for acceptance before checkout.</p>
    </section>
    <section><h2>The hosted answer pack</h2>
      <p><strong>$10 USD buys 100 Hosted AI responses</strong>, plus applicable sales tax shown before payment. There is no subscription, automatic renewal, automatic refill or automatic overage charge. You decide whether to buy another pack.</p>
      <p>One successfully completed Hosted AI response uses one credit in either Fast or Reasoning mode. A completed model-generated general explanation or clarifying question also counts. If the service cannot retrieve the evidence needed for a research answer and instead displays its source-unavailable notice, the credit is restored. A credit pays for a delivered response, not a guaranteed research finding or investment outcome.</p>
      <p>Failed, empty or stopped generations do not use a credit. A credit reserved while a response is running is restored when that request is recorded as unsuccessful; interrupted connections may take a short time to reconcile. Stopping a request after it has already completed does not reverse a completed response.</p>
      <p>Credits are attached to your account, do not expire, have no inactivity fee and cannot be transferred or resold. They are an allowance for this service, not money held on deposit. Refunds are available under the <Link href="/refunds" prefetch={false}>refund policy</Link> and where applicable law requires.</p>
      <p>The initial paid service accepts United States billing addresses only. If a payment is completed with an unsupported billing country, it is refunded without issuing credits. Credits are added after payment is confirmed. Returning from checkout alone does not establish successful payment. Your <Link href="/ai#account" prefetch={false}>billing page</Link> shows your balance and purchase history; contact support if a confirmed purchase is missing.</p>
    </section>
    <section><h2>Service limits and availability</h2>
      <p>Responses have bounded length, research coverage and processing time. Fast is intended for concise answers; Reasoning allows additional checking but does not guarantee better accuracy or a particular length. Complex questions may need to be narrowed or split into separately charged responses.</p>
      <p>Fair-use rate limits, concurrent-request limits, provider availability and service spending controls can temporarily prevent a request. Repeated failed or stopped generations can also trigger an account or service spending pause, even when unused credits remain. A pause preserves your purchased balance; contact support about restoring access or refund options if it remains unavailable. A blocked request does not spend a credit. Browser AI and Data answers do not spend Hosted AI credits and are never silently switched to paid generation.</p>
      <p>Access may be restricted to address payment disputes, fraud, attempts to bypass controls or interference with the service. Refund requests and statutory rights remain available. If we permanently discontinue Hosted AI, we will offer refunds for unused purchased credits.</p>
    </section>
    <section><h2>Research assistance and source verification</h2>
      <p>AI-generated responses can contain errors, omit information or use historical data. Check dates, units, coverage and important claims against the linked source filings. Public filings, calculations, scenarios and AI interpretations are different kinds of information.</p>
      <p>EDGAR Terminal provides research and educational tools, not personalized investment, legal or tax advice. It does not assess an investment’s suitability for you, manage your money or execute trades. No investment return or financial outcome is guaranteed.</p>
      <p>EDGAR Terminal is independent of the SEC, CFTC and other government agencies. Use of their public records does not imply approval, endorsement or affiliation.</p>
    </section>
    <section><h2>Your inputs and privacy</h2>
      <p>Submit only material you are authorized to share. Do not enter passwords, payment-card details, confidential workplace information, personal financial account details or other sensitive information into chat. Hosted requests transmit your question, bounded recent history and selected research context to the AI service.</p>
      <p>The <Link href="/privacy" prefetch={false}>privacy notice</Link> explains account, payment and chat handling. Conversation content is not an account archive; save any research you need before clearing or reloading the chat.</p>
    </section>
    <section><h2>Changes and questions</h2>
      <p>The price and allowance shown at purchase govern that pack. Later pricing changes apply to later purchases; we will not automatically charge an existing payment method or reduce an already purchased allowance through a price change. Material policy changes will be posted with a new effective date and communicated through the site or the account email where relevant.</p>
      <p>Nothing in these terms removes consumer rights that cannot be waived under applicable law. Contact the seller below about billing, service delivery or these terms.</p>
    </section>
  </LegalShell>;
}
