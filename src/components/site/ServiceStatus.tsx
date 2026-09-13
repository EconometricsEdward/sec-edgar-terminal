"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, RefreshCw } from "lucide-react";
import { describeCftcHealth, describeServiceHealth } from "../../utils/serviceStatus.js";
import styles from "./ServiceStatus.module.css";

type Status = {
  phase: "idle" | "checking" | "available" | "degraded" | "unavailable" | "offline";
  checkedAt?: string;
  secConfiguration?: string;
  cacheConfiguration?: string;
  rateLimitConfiguration?: string;
  cftcConfiguration?: string;
  message?: string;
};

const LABELS = {
  idle: "Service status",
  checking: "Checking service",
  available: "Service responds",
  degraded: "Service limited",
  unavailable: "Check unavailable",
  offline: "Browser offline",
};

export default function ServiceStatus() {
  const [status, setStatus] = useState<Status>({ phase: "idle" });
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
      const [secResult, cftcResult] = await Promise.allSettled([
        fetch("/api/health", { signal: controller.signal, headers: { Accept: "application/json" } }).then(async response => describeServiceHealth(await response.json(), response.status)),
        fetch("/api/v1/cftc/status", { signal: controller.signal, headers: { Accept: "application/json" } }).then(async response => describeCftcHealth(await response.json(), response.status)),
      ]);
      const health = secResult.status === "fulfilled" ? secResult.value : null;
      const cftcConfiguration = cftcResult.status === "fulfilled" ? cftcResult.value : "Check unavailable";
      if (id === requestId.current) {
        setStatus(health ? {
          ...health, cftcConfiguration,
          phase: health.phase as Status["phase"], checkedAt: new Date().toISOString(),
        } : {
          phase: navigator.onLine ? "unavailable" : "offline", cftcConfiguration,
          checkedAt: new Date().toISOString(),
          message: "The core SEC service check did not complete. The CFTC cache result below is independent.",
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
    const offline = () => {
      requestId.current += 1;
      pending.current?.abort();
      setStatus({
        phase: "offline",
        message: "Reconnect, then check the service again.",
      });
    };
    const online = () => {
      if (expanded) void check();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [check, expanded]);

  useEffect(() => () => {
    requestId.current += 1;
    pending.current?.abort();
  }, []);

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
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next && !status.checkedAt) void check();
        }}
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
          {(status.secConfiguration || status.cftcConfiguration) && !["idle", "checking"].includes(status.phase) && (
            <dl>
              {status.secConfiguration && <div>
                <dt>SEC request configuration</dt>
                <dd>{status.secConfiguration}</dd>
              </div>}
              {status.cacheConfiguration && <div>
                <dt>Shared cache configuration</dt>
                <dd>{status.cacheConfiguration}</dd>
              </div>}
              {status.rateLimitConfiguration && <div>
                <dt>Shared SEC request gate</dt>
                <dd>{status.rateLimitConfiguration}</dd>
              </div>}
              {status.cftcConfiguration && <div>
                <dt>CFTC positioning cache</dt>
                <dd>{status.cftcConfiguration}</dd>
              </div>}
            </dl>
          )}
          <p>
            This checks core SEC application configuration and prepared CFTC
            cache state independently. It does not contact or certify either
            upstream source, or certify that a filing or COT report is current.
            Check source and reporting dates in each tool.
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
