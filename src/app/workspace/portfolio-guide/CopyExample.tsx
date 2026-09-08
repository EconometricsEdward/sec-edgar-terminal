"use client";

import { useState } from "react";
import styles from "./portfolio-guide.module.css";

export default function CopyExample({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [status, setStatus] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("Copied.");
    } catch {
      setStatus("Clipboard unavailable. Select and copy the example below.");
    }
  }
  return (
    <div className={styles.example}>
      <div className={styles.copyLine}>
        <button type="button" onClick={copy}>
          {label}
        </button>
        <span role="status">{status}</span>
      </div>
      <pre tabIndex={0} aria-label={label.replace(/^Copy /, "")}>
        <code>{value}</code>
      </pre>
    </div>
  );
}
