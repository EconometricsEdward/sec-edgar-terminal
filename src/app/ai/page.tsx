import Link from "next/link";
import { ArrowRight, Check, Cpu, Database, MessageSquare, ShieldCheck } from "lucide-react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import AiAccount from "../../components/billing/AiAccount";
import styles from "./ai.module.css";

export const metadata = buildPageMetadata({
  title: "Hosted AI Pricing & Account — EDGAR Terminal",
  description: "Buy 100 hosted AI research responses for $10 USD. One-time purchase, no subscription. Public research, data answers and browser AI remain free.",
  path: "/ai",
});

export default function AiPage() {
  return <div className={styles.page}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>EDGAR TERMINAL / RESEARCH ASSISTANT</p><h1>A little more context.<br /><span>A clearer answer.</span></h1><p>Use hosted AI to explain the research, compare companies and connect the evidence. Pay only when you choose to add responses.</p></div>
      <span className={styles.headerIcon}><MessageSquare size={32} aria-hidden="true" /></span>
    </header>
    <div className={styles.workspace}>
      <section className={styles.plan} aria-labelledby="plan-title">
        <div className={styles.planTop}><span className={styles.eyebrow}>HOSTED AI</span><span className={styles.badge}>One-time purchase</span></div>
        <h2 id="plan-title">Your next 100 questions.</h2>
        <div className={styles.price}><strong>$10</strong><span>USD / 100 responses<br /><small>10¢ per completed answer</small></span></div>
        <p className={styles.tax}>Applicable tax is calculated at checkout. Review the final total before you pay.</p>
        <ul className={styles.features}>
          <li><Check size={16} aria-hidden="true" />Fast and Reasoning modes included</li>
          <li><Check size={16} aria-hidden="true" />One credit per completed answer</li>
          <li><Check size={16} aria-hidden="true" />No automatic renewal or refill</li>
          <li><Check size={16} aria-hidden="true" />No expiry and no overage charges</li>
          <li><Check size={16} aria-hidden="true" />Failed or empty generations restore the credit</li>
        </ul>
        <div className={styles.planFoot}><ShieldCheck size={18} aria-hidden="true" /><p>Checkout is handled by Stripe. EDGAR Terminal does not collect your card number.</p></div>
      </section>
      <AiAccount />
    </div>
    <section className={styles.freeSection} aria-labelledby="free-heading"><div><p className={styles.eyebrow}>FREE RESEARCH STAYS FREE</p><h2 id="free-heading">Choose the help you need.</h2></div><div className={styles.freeChoices}>
      <article><Database size={20} aria-hidden="true" /><div><h3>Data answers</h3><p>Structured facts and page guidance. No account, model download or AI credit needed.</p></div></article>
      <article><Cpu size={20} aria-hidden="true" /><div><h3>Browser AI · Pilot</h3><p>An optional model runs on your compatible device. You approve the download; no hosted AI charge.</p></div></article>
    </div><Link href="/analysis" prefetch={false}>Continue researching <ArrowRight size={15} aria-hidden="true" /></Link></section>
    <section className={styles.questions} aria-label="Hosted AI questions">
      <details><summary>What counts as one response?</summary><p>Each completed hosted AI answer uses one credit, in either Fast or Reasoning mode. Follow-up questions count as new answers. If a generation fails or produces an empty answer, its reserved credit is restored. Your account shows your remaining balance.</p></details>
      <details><summary>What happens when my balance reaches zero?</summary><p>Hosted AI pauses until you buy another pack. There is no automatic refill and no additional usage bill. You can continue using the free research pages, data answers and supported browser AI.</p></details>
      <details><summary>Can I get a refund?</summary><p>See the <Link href="/refunds" prefetch={false}>refund policy</Link> for eligibility, requests and your statutory rights. Your account provides purchase history and the available support contact.</p></details>
      <details><summary>What should I know before using AI?</summary><p>Hosted AI sends your question, recent conversation, page selections and attached research context to our AI providers. Avoid confidential or sensitive information. AI may make mistakes; verify dates, figures and claims against original sources. Answers are for research and education and are not personalized investment advice.</p></details>
    </section>
    <nav className={styles.legal} aria-label="AI policies"><Link href="/terms" prefetch={false}>Terms of service</Link><Link href="/privacy" prefetch={false}>Privacy policy</Link><Link href="/refunds" prefetch={false}>Refund policy</Link></nav>
  </div>;
}
