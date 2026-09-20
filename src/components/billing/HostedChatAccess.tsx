"use client";

import Link from "next/link";
import { useEffect } from "react";
import { getBillingToken, initializeBilling, refreshBilling } from "./billingClient";
import { useBilling } from "./useBilling";
import styles from "../chat/Chat.module.css";

export type HostedAccess = { canSend: boolean; getToken: typeof getBillingToken; refresh: typeof refreshBilling };

export default function HostedChatAccess({ onChange, onNavigate }: { onChange: (state: HostedAccess) => void; onNavigate: () => void }) {
  const { status, loading, error } = useBilling();
  const canSend = !loading && !error && !!status?.configured && !!status.user && status.balance > 0;
  useEffect(() => { onChange({ canSend, getToken: getBillingToken, refresh: refreshBilling }); }, [canSend, onChange]);
  return <div className={styles.paidAccess} aria-live="polite">
    <div>
      <strong>{loading ? "Checking your AI account…" : error ? "AI account unavailable" : !status?.configured ? "Hosted AI is being prepared" : !status.user ? "Sign in for hosted AI" : `${status.balance.toLocaleString()} response${status.balance === 1 ? "" : "s"} remaining`}</strong>
      <span>{error || (loading ? "Your free research tools are ready to use." : !status?.configured ? "Paid access is not available yet. Data answers and browser AI remain free." : "1 credit per completed answer · Fast or Reasoning")}</span>
    </div>
    {error ? <button type="button" onClick={() => { void initializeBilling().then(refreshBilling); }}>Retry</button> : <Link href="/ai" prefetch={false} onClick={onNavigate}>{!status?.user ? "Plans & account" : status.balance > 0 ? "Manage" : "Buy responses"}</Link>}
  </div>;
}
