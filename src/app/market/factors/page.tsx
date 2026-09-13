import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Braces, FileSearch, Scale, Sigma } from "lucide-react";
import { buildPageMetadata, canonicalUrl, SITE_NAME, SITE_URL } from "../../../utils/siteMetadata";
import styles from "./factors.module.css";

const PAGE_PATH = "/market/factors" as const;
const PAGE_URL = canonicalUrl(PAGE_PATH);
const API_URL = "/api/v2/factor-universe?basis=ttm";
const SCHEMA_URL = "/schemas/factor-universe-v2.schema.json";

export const metadata: Metadata = buildPageMetadata({
  title: "SEC Fundamental Lab — Filing Breadth & Dispersion Methodology",
  description: "Definitions, eligibility rules, formulas and limitations for EDGAR Terminal's SEC-only Fundamental Lab.",
  path: PAGE_PATH,
});

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  "@id": `${PAGE_URL}#dataset`,
  name: "EDGAR Terminal SEC Fundamental Lab",
  description: "Equal-issuer-weight diagnostics calculated from comparable SEC filing periods, with metric-specific coverage and source accessions.",
  url: PAGE_URL,
  creator: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
  isAccessibleForFree: true,
  keywords: ["SEC fundamentals", "filing breadth", "paired dispersion", "cash confirmation", "sector variance"],
  measurementTechnique: [
    "Same-issuer comparable-period differences",
    "Equal-issuer-weight direction breadth and median change",
    "Paired interquartile-range comparison",
    "Fixed-sample within-sector and between-sector population variance decomposition",
  ],
  variableMeasured: ["Revenue-growth acceleration", "Operating margin", "Free-cash-flow margin", "Net margin", "Book equity to assets", "Cash to assets"],
  distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE_URL}${API_URL}` }],
};

const measures = [
  ["Revenue-growth acceleration", "Current year-over-year revenue growth minus the comparable prior period's year-over-year growth."],
  ["Operating margin", "Operating income divided by revenue. Financial issuers are excluded from this operating-company measure."],
  ["Free-cash-flow margin", "Operating cash flow less purchases of property, plant and equipment, divided by revenue. Financial issuers are excluded."],
  ["Net margin", "Net income divided by revenue."],
  ["Book equity / assets", "Book equity divided by total assets. This is not regulatory capital or a safety grade."],
  ["Cash / assets", "Reported cash divided by total assets. Financial issuers are excluded from this operating-company measure."],
];

export default function FundamentalMethodologyPage() {
  return <main className={styles.page}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd).replace(/</g, "\\u003c") }} />
    <header className={styles.hero}>
      <div className={styles.heroTopline}>
        <Link className={styles.backLink} href="/market?tab=fundamentals">← Open Fundamental Lab</Link>
        <span className={styles.version}>Schema edgar.factor-universe.v2 · Method fundamental-universe-2.0.0</span>
      </div>
      <div className={styles.heroGrid}>
        <div>
          <p className={styles.eyebrow}>SEC-only market diagnostics</p>
          <h1>Fundamental Lab</h1>
          <p className={styles.lede}>See how reported company fundamentals are changing across the covered issuer universe. Every statistic keeps its filing dates, eligible population and missing-data denominator visible.</p>
        </div>
        <aside className={styles.distinction}>
          <p>Evidence boundary</p>
          <dl>
            <div><dt>Included</dt><dd>SEC-reported financial facts and source accessions</dd></div>
            <div><dt>Not included</dt><dd>Security prices, returns, volatility, beta, correlations or event-response estimates</dd></div>
            <div><dt>Separate context</dt><dd><Link href="/market?tab=positioning">CFTC Positioning</Link> describes futures positions; it is not an equity-price substitute.</dd></div>
          </dl>
        </aside>
      </div>
      <nav className={styles.sectionLinks} aria-label="Methodology sections">
        <a href="#scope">Scope</a><a href="#measures">Measures</a><a href="#diagnostics">Diagnostics</a><a href="#coverage">Coverage</a><a href="#api">API</a><a href="#limits">Limits</a>
      </nav>
    </header>

    <section className={styles.intro}>
      <div><p className={styles.eyebrow}>What this answers</p><h2>Is the filing-based financial shape of the covered universe improving, weakening or dispersing?</h2><p>Fundamental Lab compares each issuer with its own compatible prior-year filing period before aggregating. It does not turn accounting changes into a trade signal.</p></div>
      <div className={styles.principles}>
        <article><FileSearch size={19}/><h3>Paired evidence</h3><p>A company enters a metric only when both current and prior observations pass the same period and source checks.</p></article>
        <article><Scale size={19}/><h3>Visible denominator</h3><p>Each measure reports eligible, missing and excluded populations. Missing never means zero or unchanged.</p></article>
        <article><Sigma size={19}/><h3>Equal issuer weight</h3><p>Each unique SEC issuer contributes once. Results are not market-cap weighted or an investable index.</p></article>
      </div>
    </section>

    <section id="scope" className={styles.section}><span className={styles.number}>01</span><div className={styles.sectionBody}>
      <p className={styles.eyebrow}>Scope and periods</p><h2>One issuer, one primary sector, comparable filings</h2>
      <p>Expanded coverage uses published IVV, IJH and IJR equity holdings mapped to unique SEC issuers. It is a dated research coverage proxy, not certified index membership or the whole U.S. market. Share classes are deduplicated by CIK.</p>
      <div className={styles.twoColumns}><div><h3>TTM</h3><p>Trailing-12-month flows and the matching period-end balances are compared with a compatible prior-year period.</p></div><div><h3>Annual</h3><p>The latest full-year period is compared with the compatible prior full year. Fiscal calendars differ across issuers.</p></div></div>
      <p className={styles.note}>A comparison is eligible only when the current and prior fiscal ends are 350–380 days apart and the application has a reviewable point-in-time filing comparison.</p>
    </div></section>

    <section id="measures" className={styles.section}><span className={styles.number}>02</span><div className={styles.sectionBody}>
      <p className={styles.eyebrow}>Supported measures</p><h2>Six filing-derived changes</h2>
      <div className={styles.limitGrid}>{measures.map(([name, description]) => <article key={name}><h3>{name}</h3><p>{description}</p></article>)}</div>
      <div className={styles.formulaCard}><span>Change for issuer i</span><code>Δᵢ = current valueᵢ − prior valueᵢ</code><p>Ratio changes are percentage points. Revenue-growth acceleration is the difference between two year-over-year growth rates.</p></div>
    </div></section>

    <section id="diagnostics" className={styles.section}><span className={styles.number}>03</span><div className={styles.sectionBody}>
      <p className={styles.eyebrow}>Aggregate diagnostics</p><h2>Breadth, magnitude, dispersion and confirmation</h2>
      <div className={styles.twoColumns}>
        <div><h3>Direction breadth</h3><p>Higher share = 100 × higher / paired. Direction balance = 100 × (higher − lower) / paired. The selectable ±0, ±0.5 or ±1 percentage-point band changes direction labels only; neutral issuers stay in the denominator.</p></div>
        <div><h3>Magnitude and dispersion</h3><p>Magnitude is the median issuer-level change. Dispersion compares current and prior IQRs on the identical paired issuer set. The sensitivity band does not alter these samples.</p></div>
        <div><h3>Cash confirmation</h3><p>A 3×3 table crosses growth-acceleration direction with free-cash-flow-margin direction on the same complete operating-company sample.</p></div>
        <div><h3>Sector variance</h3><p>Population variance is decomposed exactly into within-sector and between-sector components using fixed paired issuers and group membership. Units are squared percentage points.</p></div>
      </div>
      <div className={styles.equationStack}><code>breadth = 100 × higher / paired</code><code>balance = 100 × (higher − lower) / paired</code><code>IQR change = current IQR − prior IQR</code><code>total variance = within-sector variance + between-sector variance</code></div>
    </div></section>

    <section id="coverage" className={styles.section}><span className={styles.number}>04</span><div className={styles.sectionBody}>
      <p className={styles.eyebrow}>Eligibility and evidence</p><h2>Coverage belongs to each statistic</h2>
      <p>Every metric publishes its population, paired observations, missing count, filing-date range and fiscal-end range. Operating measures exclude SIC 6000–6799 because bank, insurer and other financial-company statements are not directly comparable with industrial margins and cash ratios.</p>
      <p>Company rows retain the current filing date, current and prior fiscal ends, accession, SEC source link, retrieval clocks and an explicit unavailable reason. Rows with missing inputs stay visible in the audit views but never enter that metric’s denominator.</p>
    </div></section>

    <section id="api" className={styles.section}><span className={styles.number}>05</span><div className={styles.sectionBody}>
      <p className={styles.eyebrow}>Public contract</p><h2>Reproduce the prepared snapshot</h2>
      <p>The read-only API accepts exactly one <code>basis</code> value: <code>ttm</code> or <code>annual</code>. Preserve nulls, per-metric eligibility and source clocks. Public requests read prepared SEC data and never start a bulk issuer refresh.</p>
      <div className={styles.apiLinks}><a href={API_URL}><Braces size={15}/>Universe API</a><a href={SCHEMA_URL}>JSON Schema</a><a href="/openapi.json">OpenAPI</a></div>
      <p className={styles.note}>Version 1 and the former company market-signals API return HTTP 410. They depended on retired third-party price-derived analytics and are not silently reinterpreted as this v2 contract.</p>
    </div></section>

    <section id="limits" className={styles.section}><span className={styles.number}>06</span><div className={styles.sectionBody}>
      <p className={styles.eyebrow}>Interpretation limits</p><h2>Descriptive accounting statistics, not forecasts</h2>
      <div className={styles.limitGrid}>
        <article><h3>Fiscal calendars vary</h3><p>Comparable issuer pairs do not imply a single synchronized economic observation date.</p></article>
        <article><h3>Accounting affects comparability</h3><p>Tagging, restatements, acquisitions, one-off items and classification changes can move a measure.</p></article>
        <article><h3>Sectors behave differently</h3><p>A direction that is economically favorable for one business model may be neutral or unfavorable for another.</p></article>
        <article><h3>No causal claim</h3><p>Breadth, IQR and variance describe this covered sample. Thresholds are sensitivity settings, not statistical significance.</p></article>
      </div>
    </div></section>

    <section className={styles.footerCta}><div><p className={styles.eyebrow}>Inspect the companies</p><h2>Open the live Fundamental Lab.</h2><p>Move from the aggregate to each issuer’s current and prior SEC filing evidence.</p></div><Link href="/market?tab=fundamentals">Open Fundamental Lab <ArrowUpRight size={16}/></Link></section>
  </main>;
}
