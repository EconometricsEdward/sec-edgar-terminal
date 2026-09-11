"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import s from "./WorkspaceMenu.module.css";

export default function WorkspaceMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function close(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node))
        root.current.open = false;
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <details
      ref={root}
      className={s.menu}
      onKeyDown={(event) => {
        if (event.key === "Escape" && root.current?.open) {
          root.current.open = false;
          root.current.querySelector("summary")?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          event.currentTarget.open = false;
      }}
    >
      <summary>
        {label}
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div
        className={s.body}
        onClick={(event) => {
          if ((event.target as Element).closest("a,button") && root.current)
            root.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
