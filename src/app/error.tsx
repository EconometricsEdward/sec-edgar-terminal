"use client";

import Link from "next/link";
import { RotateCcw, FolderOpen, CircleHelp } from "lucide-react";
import styles from "./help/help.module.css";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className={styles.page}>
      <section className={styles.recovery} aria-labelledby="recovery-title">
        <p className={styles.eyebrow}>Request interrupted</p>
        <h1 id="recovery-title">This view could not finish loading.</h1>
        <p>
          Retry this page with its current URL and filters. Your saved browser
          research is separate from this request; retrying does not clear it.
        </p>
        <div className={styles.recoveryActions}>
          <button type="button" onClick={reset}>
            <RotateCcw size={17} aria-hidden="true" />
            Retry this view
          </button>
          <Link href="/workspace">
            <FolderOpen size={17} aria-hidden="true" />
            Open workspace
          </Link>
          <Link href="/help#recovery">
            <CircleHelp size={17} aria-hidden="true" />
            Get help
          </Link>
        </div>
        <p>
          If the problem continues, use the service check in the header or
          return to a saved research view. Unsaved edits may need to be entered
          again.
        </p>
        {error.digest && <small>Support reference: {error.digest}</small>}
      </section>
    </div>
  );
}
