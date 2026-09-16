import Link from "next/link";
import { ArrowUpRight, Layers, ScanLine, GitCompareArrows } from "lucide-react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import CompanySearch from "./CompanySearch";
import { isCftcEnabled } from "../../utils/cftcFeature.js";
import styles from "./analysis.module.css";
import briefStyles from "./AnalysisResearchBrief.module.css";
import { getActiveSecCoverageCompanies, loadSecCoverageRegistry } from "../../utils/secCoverageRegistry.js";
export const revalidate = 3600;
export const metadata = buildPageMetadata({
  title: "Financial Analysis — SEC XBRL Data",
  description:
    "Explain financial movements, examine growth and cash quality, test scenarios, build custom ratios, and compose source-linked research briefs from SEC filings.",
  path: "/analysis",
});
export default async function AnalysisIndexPage() {
  const cftcEnabled = isCftcEnabled();
  await loadSecCoverageRegistry();
  const companies = getActiveSecCoverageCompanies();
  const sectors = [...new Set<string>(companies.map(company => String(company.sector)))].sort();
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
      {cftcEnabled && (
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Official CFTC positioning</p>
              <h2>Put the business in market context.</h2>
            </div>
            <span className={styles.badge}>Inside each company’s CFTC context view</span>
          </div>
          <p className={styles.muted}>
            Investigate the commodity, currency, and rate markets behind a
            company’s business. Review dated futures positioning, check its
            relevance against SEC disclosures, and carry evidence into your
            Notebook or scenario review.
          </p>
          <div className={styles.companyGrid}>
            {[
              ["CVX", "Chevron", "Oil and natural gas context"],
              ["AAPL", "Apple", "Rates and financing research"],
              ["JPM", "JPMorgan Chase", "Rates and funding context"],
              ["CAT", "Caterpillar", "Commodity-cycle research"],
            ].map(([ticker, name, description]) => (
              <Link href={`/analysis/${ticker}?view=cftc`} key={ticker}>
                <ArrowUpRight size={20} />
                <strong>{ticker}</strong>
                <span>{name}</span>
                <p>{description}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
      <section className={`${styles.panel} ${briefStyles.directory}`} aria-labelledby="analysis-directory-title">
        <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Company research directory</p><h2 id="analysis-directory-title">Financial highlights and the SEC evidence.</h2></div></div>
        <p className={styles.muted}>Browse companies in the prepared research universe. Each company page provides dated financial highlights and original SEC sources, followed by the full analysis workspace. Annual, standalone quarter, year-to-date and trailing-twelve-month views remain separate. Coverage and source freshness are shown with each result.</p>
        {sectors.map(sector => <details key={sector}><summary>{sector}</summary><ul>{companies.filter(company => company.sector === sector).sort((a, b) => a.name.localeCompare(b.name)).map(company => <li key={company.cik}><Link href={`/analysis/${company.ticker}`} prefetch={false}><strong>{company.ticker}</strong> · {company.name}</Link></li>)}</ul></details>)}
      </section>
    </div>
  );
}
