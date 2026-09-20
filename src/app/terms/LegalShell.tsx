import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./legal.module.css";

export const LEGAL_VERSION = "2026-09-20";

export function getSellerDetails() {
  const name = process.env.BILLING_SELLER_NAME?.trim() || "";
  const configuredEmail = process.env.BILLING_SUPPORT_EMAIL?.trim() || "";
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configuredEmail) ? configuredEmail : "";
  return { name, email, identified: Boolean(name && email) };
}

export function SellerContact() {
  const seller = getSellerDetails();
  return (
    <aside className={styles.contact} aria-label="Seller and support">
      {seller.identified ? <>
        <p><strong>Seller:</strong> {seller.name}</p>
        <p><strong>Support and privacy requests:</strong> <a href={`mailto:${seller.email}`}>{seller.email}</a></p>
        <p>For a purchase or refund request, start from your signed-in <Link href="/ai#account" prefetch={false}>billing page</Link> so you can identify the purchase.</p>
      </> : <>
        <p><strong>Paid checkout is unavailable.</strong></p>
        <p>The operator’s seller name and support contact will appear here before paid purchases are enabled. No paid offer can be purchased until those details and payment setup are complete.</p>
      </>}
    </aside>
  );
}

export default function LegalShell({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <article className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>EDGAR Terminal · Your account and choices</p>
        <h1>{title}</h1>
        <p className={styles.intro}>{intro}</p>
        <p className={styles.updated}>Effective <time dateTime={LEGAL_VERSION}>September 20, 2026</time></p>
        <nav className={styles.nav} aria-label="Service policies">
          <Link href="/ai#account" prefetch={false}>Hosted AI & billing</Link>
          <Link href="/terms" prefetch={false}>Terms</Link>
          <Link href="/privacy" prefetch={false}>Privacy</Link>
          <Link href="/refunds" prefetch={false}>Refunds</Link>
        </nav>
      </header>
      <div className={styles.body}>{children}</div>
      <SellerContact />
    </article>
  );
}
