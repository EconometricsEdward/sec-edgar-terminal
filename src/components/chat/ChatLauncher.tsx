"use client";

import dynamic from "next/dynamic";
import { Suspense, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import styles from "./Chat.module.css";

const ChatPanel = dynamic(() => import("./ChatPanel"), { ssr: false });

export default function ChatLauncher() {
  const [opened, setOpened] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

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
          <ChatPanel open={open} onClose={() => setOpen(false)} triggerRef={triggerRef} />
        </Suspense>
      ) : null}
    </>
  );
}
