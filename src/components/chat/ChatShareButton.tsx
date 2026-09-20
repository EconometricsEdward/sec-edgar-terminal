"use client";

import { MessageSquare } from "lucide-react";
import { normalizeSharedChatContext } from "../../utils/chatSharedContext.js";
import { CHAT_SHARE_EVENT } from "./chatPageSelection.js";
import styles from "./Chat.module.css";

export default function ChatShareButton({ kind, getSnapshot, disabled = false }: { kind: "portfolio" | "scenario"; getSnapshot: () => unknown; disabled?: boolean }) {
  return <span className={styles.shareAction}>
    <button type="button" disabled={disabled} className={styles.shareButton} onClick={() => {
      const snapshot = normalizeSharedChatContext(getSnapshot());
      if (snapshot) window.dispatchEvent(new CustomEvent(CHAT_SHARE_EVENT, { detail: { snapshot, route: window.location.pathname + window.location.search } }));
    }}><MessageSquare size={14} aria-hidden="true" /> Use this {kind} in chat</button>
    <small>{kind === "portfolio" ? "Share up to 25 tickers and modeled weights with the AI service. No names or account values." : "Share applied assumptions and the selected company and period with the AI service."}</small>
  </span>;
}
