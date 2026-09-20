import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./legal.module.css";

export const LEGAL_VERSION = "2026-09-20";

function SupportContact() {
  return (
    <aside className={styles.contact} aria-label="Project support">
      <p><strong>Questions or support:</strong> <a href="https://github.com/EconometricsEdward/sec-edgar-terminal/issues" target="_blank" rel="noopener noreferrer">Contact the project through its issue tracker</a>.</p>
      <p>The issue tracker is public. Do not post sensitive information or private research there.</p>
    </aside>
  );
}

export default function LegalShell({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <article className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>EDGAR Terminal · Research and privacy</p>
        <h1>{title}</h1>
        <p className={styles.intro}>{intro}</p>
        <p className={styles.updated}>Effective <time dateTime={LEGAL_VERSION}>September 20, 2026</time></p>
        <nav className={styles.nav} aria-label="Service policies">
          <Link href="/terms" prefetch={false}>Terms</Link>
          <Link href="/privacy" prefetch={false}>Privacy</Link>
        </nav>
      </header>
      <div className={styles.body}>{children}</div>
      <SupportContact />
    </article>
  );
}
