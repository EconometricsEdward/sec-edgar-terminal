import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { buildPageMetadata, SITE_URL } from "../../utils/siteMetadata";
import { FUND_CATALOG } from "../../utils/fundResearch";
import { PUBLIC_FUND_MANAGERS } from "../../utils/fundPublicSelectors.js";
import { fundDirectoryStructuredData, serializeResearchJsonLd } from "../../utils/fundPublicMetadata.js";
import FundsWorkspace from "./FundsWorkspace";
import base from "./fund.module.css";
import s from "./FundResearchBrief.module.css";
export const metadata: Metadata = buildPageMetadata({
  title: "Funds & Institutional Managers — N-PORT and 13F Research",
  description:
    "Explore SEC 13F manager holdings and N-PORT fund portfolios. See concentration, compare quarterly reported positions, and follow the source filings behind every snapshot.",
  path: "/fund",
});
export default function FundIndexPage() {
  const structuredData = fundDirectoryStructuredData({ funds: FUND_CATALOG, managers: PUBLIC_FUND_MANAGERS, siteUrl: SITE_URL });
  return (
    <>
      <script id="fund-research-directory" type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeResearchJsonLd(structuredData) }} />
      <Suspense fallback={<p role="status">Opening fund research…</p>}>
        <FundsWorkspace />
      </Suspense>
      <section className={`${base.page} ${s.directory}`} aria-labelledby="public-fund-research">
        <h2 id="public-fund-research">Reported portfolios, with the sources attached.</h2>
        <p>Open a concise research brief for portfolio dates, holdings, concentration and original SEC filings. N-PORT describes a fund portfolio; Form 13F describes an institutional manager’s reportable securities. Coverage varies by reporting structure.</p>
        <div className={s.directoryGrid}>
          <div><h3>Fund portfolio research · N-PORT</h3><ul>{FUND_CATALOG.map(fund => <li key={fund.ticker}><Link href={`/fund/${fund.ticker}`} prefetch={false}><strong>{fund.ticker} · {fund.name}</strong><span>{fund.family} · {fund.focus}</span></Link></li>)}</ul></div>
          <div><h3>Institutional manager research · 13F</h3><ul>{PUBLIC_FUND_MANAGERS.map(manager => <li key={manager.cik}><Link href={`/fund/manager/${manager.cik}`} prefetch={false}><strong>{manager.name}</strong><span>Reported holdings · SEC CIK {manager.cik}</span></Link></li>)}</ul></div>
        </div>
      </section>
    </>
  );
}
