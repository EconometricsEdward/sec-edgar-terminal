import Link from "next/link";
import { Search, Home, FolderOpen } from "lucide-react";
import styles from "./help/help.module.css";

export default function NotFound() {
  return (
    <div className={styles.page}>
      <section className={styles.recovery} aria-labelledby="missing-title">
        <p className={styles.eyebrow}>404 · Page not found</p>
        <h1 id="missing-title">We could not find this page.</h1>
        <p>
          Check the address or use the site search to find a company, fund, or
          research tool. A missing page does not mean a company has no SEC
          filings.
        </p>
        <div className={styles.recoveryActions}>
          <Link href="/filings">
            <Search size={17} aria-hidden="true" />
            Find a company
          </Link>
          <Link href="/workspace">
            <FolderOpen size={17} aria-hidden="true" />
            Open workspace
          </Link>
          <Link href="/">
            <Home size={17} aria-hidden="true" />
            Research home
          </Link>
        </div>
        <p>
          For source coverage and research tips, visit the{" "}
          <Link href="/help" style={{ textDecoration: "underline" }}>
            research guide
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
