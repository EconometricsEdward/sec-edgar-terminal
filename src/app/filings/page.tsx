import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight, Search, BookOpen, ListChecks } from "lucide-react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import { validTicker } from "../../utils/researchWorkspace.js";
import CompanySearch from "./CompanySearch";
import styles from "./filings.module.css";

export const metadata = buildPageMetadata({
  title: "SEC Filings Browser — 13F, 10-K, 10-Q, 8-K & More",
  description:
    "Find companies and investment managers by name, ticker or CIK. Browse 13F holdings reports and other SEC filings, load older archives, and keep source-linked evidence.",
  path: "/filings",
});

export default async function FilingsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ ticker?: string }>;
}) {
  const query = await searchParams;
  const ticker = String(query.ticker || "")
    .trim()
    .toUpperCase();
  if (validTicker(ticker)) redirect(`/filings/${encodeURIComponent(ticker)}`);
  return (
    <div className={styles.page}>
      <section className={styles.landing}>
        <div>
          <p className={styles.eyebrow}>EDGAR / Filing research</p>
          <h1>
            Find the filing.
            <br />
            <span>Read what matters.</span>
          </h1>
          <p className={styles.lead}>
            Find companies and investment managers by name, ticker, or CIK.
            Explore 13F holdings reports, company disclosures, and earlier
            filings, then keep a clear record of the evidence you’ve reviewed.
          </p>
          <CompanySearch />
          <p className={styles.muted}>
            SEC primary sources · No account required · Research saved in your
            browser
          </p>
        </div>
        <div className={styles.landingPreview}>
          <p className={styles.eyebrow}>A focused research workflow</p>
          {[
            [
              Search,
              "01",
              "Find the right report",
              "Find 13F holdings reports, annual reports, amendments, and other forms. Load older archives with visible coverage.",
            ],
            [
              BookOpen,
              "02",
              "Read and compare",
              "Search inside documents and compare supported reporting periods or amendments.",
            ],
            [
              ListChecks,
              "03",
              "Build your evidence",
              "Queue filings, keep notes, collect passages, and export a source-linked brief.",
            ],
          ].map(([Icon, number, title, copy]: any) => (
            <div key={number}>
              <Icon size={23} />
              <span>{number}</span>
              <h2>{title}</h2>
              <p>{copy}</p>
            </div>
          ))}
        </div>
      </section>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Start a review</p>
            <h2>Choose a company</h2>
          </div>
          <span className={styles.muted}>
            Fund tickers open the Funds workspace.
          </span>
        </div>
        <div className={styles.companyGrid}>
          {[
            ["JPM", "JPMorgan Chase", "Annual reports and bank disclosures"],
            ["AAPL", "Apple", "Quarterly reports and capital returns"],
            ["NVDA", "NVIDIA", "Growth, governance, and insider filings"],
            ["XOM", "Exxon Mobil", "Energy, investment, and material events"],
          ].map(([symbol, name, description]) => (
            <Link key={symbol} href={`/filings/${symbol}`}>
              <ArrowUpRight size={20} />
              <strong>{symbol}</strong>
              <span>{name}</span>
              <p>{description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
