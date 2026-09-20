import Link from "next/link";
import { buildPageMetadata } from "../../utils/siteMetadata";
import LegalShell from "../terms/LegalShell";

export const dynamic = "force-dynamic";
export const metadata = buildPageMetadata({ title: "Privacy Notice", description: "How EDGAR Terminal handles research requests, AI conversations, account information and payment records.", path: "/privacy" });

export default function PrivacyPage() {
  return <LegalShell title="Privacy notice" intro="This notice explains what reaches the service, what stays in your browser and what records an optional Hosted AI purchase creates.">
    <section><h2>Research without an account</h2>
      <p>The public research pages do not require an account. Search terms, selected public companies or funds, and research requests reach EDGAR Terminal so it can retrieve and organize public data. Hosting and security services process ordinary connection and request information, such as an IP address and browser information, to deliver the site and protect against abuse.</p>
      <p>Saved portfolios, page preferences and supported local work use your browser’s storage. They do not automatically sync across devices. Some research tools send the selections or inputs needed for that tool to the service. Chat receives a portfolio or scenario snapshot only when you explicitly attach it; the chat attachment contains bounded research inputs, not the underlying uploaded file.</p>
    </section>
    <section><h2>Chat and AI processing</h2>
      <ul>
        <li><strong>Data answers:</strong> your question, bounded recent conversation and selected or explicitly attached context reach EDGAR Terminal for public-data retrieval. This mode does not call a hosted language model.</li>
        <li><strong>Browser AI:</strong> the same data-retrieval request reaches EDGAR Terminal, and answer generation runs on your compatible device. Enabling it downloads model assets from external hosts, including Hugging Face and the model-runtime delivery hosts. Those hosts receive normal download connection information. Model files may remain in browser cache until you remove them. Questions are not included in model-asset download URLs.</li>
        <li><strong>Hosted AI:</strong> your question, bounded recent conversation, selected or attached context and retrieved research are processed through Vercel AI Gateway and Mistral to generate a response. Do not enter confidential or sensitive information.</li>
      </ul>
      <p>The application does not create a persistent chat transcript or deliberately log prompts and answers. Conversation history and drafts live in the open tab’s memory and clear on reload or New chat. Limited history is transmitted for each request; closing the panel alone does not clear the conversation.</p>
      <p>Hosted requests ask the gateway for zero data retention and no model training. Those are provider requirements for the configured request, not a promise that no service processes connection, security or usage metadata. Provider processing remains subject to the applicable service terms and configuration. Raw model reasoning is not displayed or stored as conversation history.</p>
    </section>
    <section><h2>Accounts, payments and answer credits</h2>
      <p>If you choose Hosted AI, we process your email address, account identifier, verification status and authentication information to sign you in and associate purchases with your account. Session tokens help maintain and verify your sign-in. They are stored in this browser’s local storage, refreshed as needed and cleared when you sign out; do not sign in on a browser profile shared with people you do not trust. Supabase supplies account and database services; Vercel hosts the application.</p>
      <p>Stripe handles checkout and payment-card information on its payment page. EDGAR Terminal does not collect or store full payment-card numbers or card security codes. We retain payment references, purchase amounts, currency, tax information returned by the processor, payment/refund/dispute status, purchased and remaining credits, and your accepted terms version.</p>
      <p>Usage records identify a hosted request, its status, credit reservation or restoration, and relevant timestamps so balances can be reconciled and errors investigated. These billing records do not contain your question or generated answer. Support messages may contain information you choose to send; include a purchase or request reference instead of sensitive data.</p>
    </section>
    <section><h2>Service providers and analytics</h2>
      <p>We use service providers to host and secure the site, authenticate accounts, process payments, retrieve data and provide requested AI functionality. These include Vercel, Supabase, Stripe and the configured AI provider. Public-data requests also use source services such as SEC and CFTC endpoints. Providers may process information in the United States or other locations where they operate.</p>
      <p>Vercel Analytics and Speed Insights measure page usage and application performance. The site does not use these features to sell personal information or run cross-site advertising profiles. Browser “Do Not Track” signals do not change the site’s necessary account, security or billing processing. External websites and downloads operate under their own notices.</p>
      <p>We may disclose necessary records to address fraud, a payment dispute, enforce service terms or comply with a valid legal obligation. We do not sell chat content or payment records.</p>
    </section>
    <section><h2>Retention and your choices</h2>
      <p>Chat content is processed transiently as described above. Account and operational information is retained as needed to provide the service, resolve requests, protect against abuse and meet legal obligations. Purchase, refund and related accounting records are generally retained for seven years, or longer when applicable law or an unresolved matter requires it.</p>
      <p>These are retention purposes and review periods, not a promise that an automatic deletion job removes every record on a fixed date. Deleting an account may not delete records needed for tax, accounting, fraud prevention or an unresolved payment issue. Clearing your browser removes local information but does not erase purchase records.</p>
      <p>Use the contact below to request access to, correction of or deletion of personal information, or to ask about processing. We may verify your identity and retain information where a legal exception applies. For a refund, follow the <Link href="/refunds" prefetch={false}>refund policy</Link>. You can clear locally saved research in your browser and remove Browser AI model files with its model-removal control.</p>
    </section>
    <section><h2>Children and notice changes</h2>
      <p>Paid Hosted AI is offered to adults aged 18 or older. EDGAR Terminal is not directed to children under 13 and does not knowingly seek their personal information. Contact the operator if you believe a child has supplied personal information.</p>
      <p>Updates to this notice appear with a new effective date. Material changes will be communicated through the site or, where relevant, the account email before being applied to existing account information.</p>
    </section>
  </LegalShell>;
}
