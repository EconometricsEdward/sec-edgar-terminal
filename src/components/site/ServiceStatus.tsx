"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, RefreshCw } from "lucide-react";
import { describeServiceHealth } from "../../utils/serviceStatus.js";
import styles from "./ServiceStatus.module.css";

type Status = {
  phase: "checking" | "available" | "degraded" | "unavailable" | "offline";
  checkedAt?: string;
  secConfiguration?: string;
  cacheConfiguration?: string;
  message?: string;
};

const LABELS = {
  checking: "Checking service",
  available: "Service responds",
  degraded: "Service limited",
  unavailable: "Check unavailable",
  offline: "Browser offline",
};

export default function ServiceStatus() {
  const [status, setStatus] = useState<Status>({ phase: "checking" });
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbortController | null>(null);
  const requestId = useRef(0);

  const check = useCallback(async () => {
    pending.current?.abort();
    const id = ++requestId.current;
    if (!navigator.onLine) {
      setStatus({
        phase: "offline",
        message: "Reconnect, then check the service again.",
      });
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setStatus((previous) => ({
      ...previous,
      phase: "checking",
      message: undefined,
    }));
    try {
      const response = await fetch("/api/health", {
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const health = describeServiceHealth(
        await response.json(),
        response.status,
      );
      if (id === requestId.current) {
        setStatus({
          ...health,
          phase: health.phase as Status["phase"],
          checkedAt: new Date().toISOString(),
        });
      }
    } catch {
      if (id === requestId.current) {
        setStatus({
          phase: navigator.onLine ? "unavailable" : "offline",
          checkedAt: new Date().toISOString(),
          message:
            "The service check did not complete. Individual research tools may still work.",
        });
      }
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    void check();
    const offline = () => {
      requestId.current += 1;
      pending.current?.abort();
      setStatus({
        phase: "offline",
        message: "Reconnect, then check the service again.",
      });
    };
    const online = () => void check();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      requestId.current += 1;
      pending.current?.abort();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [check]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [expanded]);

  return (
    <div className={styles.root} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label={`Service status: ${LABELS[status.phase]}`}
        title={LABELS[status.phase]}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span
          className={styles.dot}
          data-state={status.phase}
          aria-hidden="true"
        />
        <span className={styles.label}>{LABELS[status.phase]}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {expanded && (
        <section
          id={panelId}
          className={styles.panel}
          aria-label="Service status details"
        >
          <h2>Service check</h2>
          <p role="status">
            {LABELS[status.phase]}
            {status.checkedAt && (
              <>
                {" "}
                · Last checked{" "}
                <time dateTime={status.checkedAt}>
                  {new Date(status.checkedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </>
            )}
          </p>
          {status.message && <p>{status.message}</p>}
          {status.secConfiguration && status.phase !== "checking" && (
            <dl>
              <div>
                <dt>SEC request configuration</dt>
                <dd>{status.secConfiguration}</dd>
              </div>
              <div>
                <dt>Shared cache configuration</dt>
                <dd>{status.cacheConfiguration}</dd>
              </div>
            </dl>
          )}
          <p>
            This checks the application response and configuration. It does not
            test SEC availability or certify that a filing or price is current.
            Check the source and reporting dates in each tool.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => void check()}
              disabled={status.phase === "checking"}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Check again
            </button>
            <Link href="/help#sources" onClick={() => setExpanded(false)}>
              Source & coverage guide
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
