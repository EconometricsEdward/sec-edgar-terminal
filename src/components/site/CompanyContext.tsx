"use client";

import { useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowUpRight, Building2, ChevronRight, Wallet } from "lucide-react";
import { TickerContext } from "../../contexts/TickerContext";
import {
  SITE_TOOLS,
  activeTool,
  companyToolPath,
  entityFromRoute,
} from "../../utils/siteRoutes.js";
import styles from "./SiteShell.module.css";

export default function CompanyContext() {
  const pathname = usePathname() || "/";
  const params = useSearchParams();
  const context = useContext(TickerContext);
  const entity = entityFromRoute(pathname, params);
  const tool = SITE_TOOLS.find((item) => item.id === activeTool(pathname));
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    setCopyStatus("");
  }, [pathname, params]);
  if (!entity) return null;

  const entry = context?.tickerMap?.[entity.ticker];
  // The route remains authoritative. Map data adds a name only for this exact ticker.
  const isFund = entity.kind === "fund" || entry?.isFund === true;
  const name = entry?.ticker === entity.ticker ? entry.name : "";
  const Icon = isFund ? Wallet : Building2;
  const links = isFund
    ? ["fund"]
    : ["filings", "analysis", "risk", "disclosures"];

  async function share() {
    const href = window.location.href;
    try {
      await navigator.clipboard.writeText(href);
      if (window.location.href === href)
        setCopyStatus(
          "Research link copied. Notes and saved evidence stay on this device.",
        );
    } catch {
      if (window.location.href === href)
        setCopyStatus(
          "Copy the URL from your browser’s address bar to share this view.",
        );
    }
  }

  return (
    <section
      className={styles.companyContext}
      aria-label={`${entity.ticker} research context`}
    >
      <div className={styles.contextIdentity}>
        <span className={styles.contextIcon}>
          <Icon size={16} aria-hidden="true" />
        </span>
        <div className={styles.contextText}>
          <div className={styles.contextBreadcrumb}>
            <Link href={isFund ? "/fund" : "/analysis"} prefetch={false}>
              {isFund ? "Fund research" : "Company research"}
            </Link>
            <ChevronRight size={12} aria-hidden="true" />
            <strong>{entity.ticker}</strong>
            {tool && (
              <>
                <ChevronRight size={12} aria-hidden="true" />
                <span>{tool.label}</span>
              </>
            )}
          </div>
          {name && <p>{name}</p>}
        </div>
      </div>
      <div className={styles.contextActions}>
        <nav aria-label={`${entity.ticker} research tools`}>
          {links.map((id) => {
            const item = SITE_TOOLS.find((value) => value.id === id)!;
            return (
              <Link
                key={id}
                href={companyToolPath(id, entity.ticker)!}
                prefetch={false}
                aria-current={tool?.id === id ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <button
          type="button"
          onClick={share}
          aria-label={`Copy link to this ${entity.ticker} research view`}
        >
          <ArrowUpRight size={13} aria-hidden="true" /> Share view
        </button>
      </div>
      {copyStatus && (
        <p className={styles.contextStatus} role="status">
          {copyStatus}
        </p>
      )}
    </section>
  );
}
