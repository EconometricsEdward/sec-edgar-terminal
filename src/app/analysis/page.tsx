import Link from "next/link";
import { ArrowUpRight, Layers, ScanLine, GitCompareArrows } from "lucide-react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import CompanySearch from "./CompanySearch";
import styles from "./analysis.module.css";
export const metadata = buildPageMetadata({
  title: "Financial Analysis — SEC XBRL Data",
  description:
    "Explore source-linked financial statements, compare reporting periods, inspect filing revisions, and build a financial research brief with bank, insurance, and corporate analysis.",
  path: "/analysis",
});
export default function AnalysisIndexPage() {
  return (
    <div className={styles.page}>
      <section className={styles.landing}>
        <div>
          <p className={styles.eyebrow}>EDGAR / Financial analysis</p>
          <h1>
            Understand the numbers.
            <br />
            <span>Follow the evidence.</span>
          </h1>
          <p className={styles.lead}>
            From a company’s financial statements to the filing behind every
            figure. A focused workspace for earnings, cash flow, capital, and
            the changes that deserve a closer look.
          </p>
          <CompanySearch />
          <p className={styles.muted}>
            Public SEC filings · No account required · Research saved in your
            browser
          </p>
        </div>
        <div className={styles.landingPreview}>
          <p className={styles.eyebrow}>Your research sequence</p>
          {[
            [
              Layers,
              "01",
              "Read the financials",
              "One period basis across statements, ratios, and charts.",
            ],
            [
              GitCompareArrows,
              "02",
              "Explain the movement",
              "Comparable periods, cash bridges, and return drivers.",
            ],
            [
              ScanLine,
              "03",
              "Verify and collect",
              "Trace formulas to SEC inputs and export your evidence.",
            ],
          ].map(([Icon, number, title, copy]: any) => (
            <div key={number}>
              <Icon size={24} />
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
            <p className={styles.eyebrow}>Start an investigation</p>
            <h2>Choose a company</h2>
          </div>
          <span className={styles.muted}>Analysis adapts to the business.</span>
        </div>
        <div className={styles.companyGrid}>
          {[
            ["JPM", "JPMorgan Chase", "Bank funding, credit, and returns"],
            ["AAPL", "Apple", "Earnings, buybacks, and cash conversion"],
            ["NVDA", "NVIDIA", "Growth, margins, and investment"],
            ["MET", "MetLife", "Premiums, investment income, and capital"],
          ].map(([ticker, name, description]) => (
            <Link href={`/analysis/${ticker}`} key={ticker}>
              <ArrowUpRight size={20} />
              <strong>{ticker}</strong>
              <span>{name}</span>
              <p>{description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
