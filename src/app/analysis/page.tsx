import Link from "next/link";
import { ArrowUpRight, Layers, ScanLine, GitCompareArrows } from "lucide-react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import CompanySearch from "./CompanySearch";
import styles from "./analysis.module.css";
export const metadata = buildPageMetadata({
  title: "Financial Analysis — SEC XBRL Data",
  description:
    "Explain financial movements, examine growth and cash quality, test scenarios, build custom ratios, and compose source-linked research briefs from SEC filings.",
  path: "/analysis",
});
export default function AnalysisIndexPage() {
  return (
    <div className={styles.page}>
      <section className={styles.landing}>
        <div>
          <p className={styles.eyebrow}>EDGAR / Financial analysis</p>
          <h1>
            From financial data
            <br />
            <span>to a defensible view.</span>
          </h1>
          <p className={styles.lead}>
            Explain what changed, follow the cash, and test your assumptions. A
            complete financial workbench with business-specific analysis and the
            SEC evidence behind every reported input.
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
              "Find the movement",
              "Prioritized changes, growth persistence, and fiscal seasonality.",
            ],
            [
              GitCompareArrows,
              "02",
              "Test the explanation",
              "Profit bridges, cash quality, custom ratios, and transparent scenarios.",
            ],
            [
              ScanLine,
              "03",
              "Make the case",
              "Compare source evidence, inspect revisions, and compose your research brief.",
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
