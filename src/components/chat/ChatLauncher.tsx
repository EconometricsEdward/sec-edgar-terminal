"use client";

import dynamic from "next/dynamic";
import { Suspense, useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import styles from "./Chat.module.css";
import { normalizeSharedChatContext } from "../../utils/chatSharedContext.js";
import { CHAT_SHARE_EVENT } from "./chatPageSelection.js";

const ChatPanel = dynamic(() => import("./ChatPanel"), { ssr: false });

export default function ChatLauncher() {
  const [opened, setOpened] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [attachment, setAttachment] = useState<{ snapshot: NonNullable<ReturnType<typeof normalizeSharedChatContext>>; route: string } | null>(null);
  useEffect(() => {
    const share = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const snapshot = normalizeSharedChatContext(detail?.snapshot);
      const route = window.location.pathname + window.location.search;
      if (!snapshot || detail?.route !== route) return;
      setAttachment({ snapshot, route });
      setOpened(true); setOpen(true);
    };
    window.addEventListener(CHAT_SHARE_EVENT, share);
    return () => window.removeEventListener(CHAT_SHARE_EVENT, share);
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        className={styles.trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={opened ? "edgar-chat" : undefined}
        onClick={() => { setOpened(true); setOpen(value => !value); }}
      >
        <MessageSquare size={15} aria-hidden="true" />
        Chat
      </button>
      {opened ? (
        <Suspense fallback={null}>
          <ChatPanel open={open} onClose={() => setOpen(false)} triggerRef={triggerRef} attachment={attachment} onClearAttachment={() => setAttachment(null)} />
        </Suspense>
      ) : null}
    </>
  );
}
