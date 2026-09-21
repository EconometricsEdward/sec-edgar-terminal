import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight, Search, BookOpen, ListChecks } from "lucide-react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import { validTicker } from "../../utils/researchWorkspace.js";
import { filingPath, normalizeFilingsSettings } from "../../utils/filingsResearch.js";
import { isBrokerDealerForm } from "../../utils/brokerDealerForms.js";
import CompanySearch from "./CompanySearch";
import styles from "./filings.module.css";

export const metadata = buildPageMetadata({
  title: "SEC Filings Browser — 10-K, 13F & Broker-Dealer Filings",
  description:
    "Search SEC filings by legal name, ticker or CIK. Read company disclosures, 13F holdings and public X-17A-5 broker-dealer filings with original source documents.",
  path: "/filings",
});

export default async function FilingsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ ticker?: string; form?: string }>;
}) {
  const query = await searchParams;
  const ticker = String(query.ticker || "")
    .trim()
    .toUpperCase();
  const { form } = normalizeFilingsSettings({
    form: typeof query.form === "string" ? query.form : "",
  });
  const brokerDealerReports = isBrokerDealerForm(form);
  if (validTicker(ticker)) redirect(filingPath(ticker, { form }));
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
            Find companies, investment managers, and broker-dealers by legal
            name, ticker, or CIK. Explore company disclosures, 13F holdings, and
            public broker-dealer filings with a path to the original
            documents.
          </p>
          <CompanySearch form={form === "all" ? undefined : form} />
          <p className={styles.muted}>
            {brokerDealerReports ? (
              <>
                Public X-17A-5 filings selected. Search the broker-dealer’s
                legal filer name or CIK; its parent company may file separately.{" "}
                <Link href="/filings">Browse all forms</Link>
              </>
            ) : (
              <>
                Reviewing a broker-dealer?{" "}
                <Link href="/filings?form=X-17A-5">
                  Find public X-17A-5 filings
                </Link>{" "}
                using its legal filer name or CIK.
              </>
            )}
          </p>
          {brokerDealerReports && <p className={styles.muted}>Part III identifies annual-report material; Parts II, IIA and Schedule I identify periodic FOCUS reporting. Open the document to check its type, audit evidence, reporting period and available statements. Confidential submissions are not included.</p>}
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
              "Find company and broker-dealer filings, 13F holdings, and amendments. Load older archives with visible coverage.",
            ],
            [
              BookOpen,
              "02",
              "Read and compare",
              "Open original financial-statement PDFs, search available extracted text, and compare supported reporting periods or amendments.",
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
