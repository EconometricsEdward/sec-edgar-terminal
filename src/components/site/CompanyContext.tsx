"use client";

import { useContext, useEffect, useRef, useState } from "react";
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
  const bannerRef = useRef<HTMLElement>(null);
  const hasEntity = Boolean(entity);
  useEffect(() => {
    setCopyStatus("");
  }, [pathname, params]);
  useEffect(() => {
    const header = document.querySelector<HTMLElement>("[data-site-header]");
    const banner = bannerRef.current;
    if (!header) return;

    // Measure wrapping, reading preferences, and browser zoom rather than
    // assuming that the global header has the same height on every screen.
    const root = document.documentElement;
    function measureStack() {
      const headerHeight = Math.ceil(header!.getBoundingClientRect().height);
      const bannerHeight = Math.ceil(banner?.getBoundingClientRect().height || 0);
      root.style.setProperty("--site-header-height", `${headerHeight}px`);
      root.style.setProperty("--company-context-height", `${bannerHeight}px`);
      root.style.setProperty("--site-sticky-stack-height", `${headerHeight + bannerHeight + 12}px`);
    }
    measureStack();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureStack);
    observer?.observe(header);
    if (banner) observer?.observe(banner);
    window.addEventListener("resize", measureStack);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureStack);
      root.style.removeProperty("--site-header-height");
      root.style.removeProperty("--company-context-height");
      root.style.removeProperty("--site-sticky-stack-height");
    };
  }, [hasEntity]);
  if (!entity) return null;

  const isFiler = entity.kind === "filer";
  const isManagerResearch = isFiler && !!entity.fundPath;
  const entry = isFiler ? undefined : context?.tickerMap?.[entity.ticker];
  // The route remains authoritative. Map data adds a name only for this exact ticker.
  const isFund = entity.kind === "fund" || entry?.isFund === true;
  const name = entry?.ticker === entity.ticker ? entry.name : "";
  const identityLabel = isFiler ? `CIK ${entity.ticker}` : entity.ticker;
  const Icon = isFund || isManagerResearch ? Wallet : Building2;
  const links = isFund
    ? ["fund"]
    : isManagerResearch ? ["fund", "filings", "disclosures"]
    : isFiler ? ["filings", "disclosures"] : ["filings", "analysis", "risk", "disclosures"];

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
      ref={bannerRef}
      className={styles.companyContext}
      data-company-context
      aria-label={`${identityLabel} research context`}
    >
      <div className={styles.contextIdentity}>
        <span className={styles.contextIcon}>
          <Icon size={16} aria-hidden="true" />
        </span>
        <div className={styles.contextText}>
          <div className={styles.contextBreadcrumb}>
            <Link href={isManagerResearch ? "/fund?view=13f" : isFund ? "/fund" : isFiler ? "/filings" : "/analysis"} prefetch={false}>
              {isManagerResearch ? "13F manager research" : isFund ? "Fund research" : isFiler ? "SEC filer research" : "Company research"}
            </Link>
            <ChevronRight size={12} aria-hidden="true" />
            <strong>{identityLabel}</strong>
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
        <nav aria-label={`${identityLabel} research tools`}>
          {links.map((id) => {
            const item = SITE_TOOLS.find((value) => value.id === id)!;
            return (
              <Link
                key={id}
                href={id === "fund" && entity.fundPath ? entity.fundPath : companyToolPath(id, entity.ticker)!}
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
          aria-label={`Copy link to this ${identityLabel} research view`}
        >
          <ArrowUpRight size={13} aria-hidden="true" /> <span className={styles.contextShareLabel}>Share view</span>
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
