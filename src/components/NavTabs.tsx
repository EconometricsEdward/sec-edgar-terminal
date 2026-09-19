"use client";

import Link from "next/link";
import { useContext } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Activity,
  BarChart3,
  Info,
  FileSearch,
  FileText,
  GitCompare,
  Home,
  LayoutDashboard,
  ShieldAlert,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import {
  SITE_TOOLS,
  activeTool,
  companyToolPath,
  entityFromRoute,
} from "../utils/siteRoutes.js";
import { TickerContext } from "../contexts/TickerContext";
import styles from "./site/SiteShell.module.css";

const ICONS: Record<string, LucideIcon> = {
  home: Home,
  workspace: LayoutDashboard,
  filings: FileText,
  analysis: BarChart3,
  market: Activity,
  risk: ShieldAlert,
  compare: GitCompare,
  fund: Wallet,
  about: Info,
  disclosures: FileSearch,
};

export default function NavTabs() {
  const pathname = usePathname() || "/";
  const params = useSearchParams();
  const entity = entityFromRoute(pathname, params);
  const context = useContext(TickerContext);
  const fundContext =
    entity?.kind === "fund" ||
    (entity?.kind === "company" && context?.tickerMap?.[entity.ticker]?.isFund === true);
  const selected = activeTool(pathname);

  return (
    <nav className={styles.navigation} aria-label="Primary navigation">
      {SITE_TOOLS.map((tool) => {
        const Icon = ICONS[tool.id];
        const preserveCompany =
          entity?.kind === "company" &&
          !fundContext &&
          ["filings", "analysis", "risk", "disclosures"].includes(tool.id);
        const preserveFund = !!entity && fundContext && tool.id === "fund";
        const preserveManager = entity?.kind === "filer" && !!entity.fundPath && tool.id === "fund";
        const preserveFiler = entity?.kind === "filer" && ["filings", "disclosures"].includes(tool.id);
        const href =
          preserveManager ? entity!.fundPath! : preserveCompany || preserveFund || preserveFiler
            ? companyToolPath(tool.id, entity!.ticker) || tool.href
            : tool.href;
        const active = selected === tool.id;
        return (
          <Link
            key={tool.id}
            href={href}
            prefetch={false}
            className={`${styles.navLink} ${active ? styles.navActive : ""}`}
            aria-current={active ? "page" : undefined}
            title={`${tool.description}${preserveCompany || preserveFund || preserveFiler || preserveManager ? ` · ${preserveFiler || preserveManager ? "CIK " : ""}${entity!.ticker}` : ""}`}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{tool.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
