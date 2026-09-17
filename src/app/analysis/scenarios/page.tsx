import Link from "next/link";
import { ArrowRight, BookOpen, GitBranch, SlidersHorizontal } from "lucide-react";
import { buildPageMetadata, canonicalUrl, SITE_NAME, SITE_URL } from "../../../utils/siteMetadata";
import styles from "./scenarios-guide.module.css";

const PAGE_PATH = "/analysis/scenarios" as const;
const PAGE_URL = canonicalUrl(PAGE_PATH);
const description = "How SEC-based company scenarios connect operating assumptions to cash, borrowing and financial strength. Formulas, reporting periods, historical context, sensitivity drivers and evidence limits.";

export const metadata = buildPageMetadata({
  title: "Company Scenario Analysis — Models, Cash Flow & SEC Evidence",
  description,
  path: PAGE_PATH,
});

const article = {
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "@id": `${PAGE_URL}#methodology`,
  headline: "Company scenario analysis: assumptions, cash flow and SEC evidence",
  description,
  url: PAGE_URL,
  mainEntityOfPage: PAGE_URL,
  author: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
  isAccessibleForFree: true,
  inLanguage: "en-US",
  about: ["Financial scenario analysis", "Cash flow sensitivity", "SEC financial statements"],
};

const equations = [
  ["Operating effect", "ΔOI = hypothetical operating income − reported operating income", "The operating model changes revenue and either operating margin or implied operating costs."],
  ["New financing", "new borrowing = reported revenue × borrowing assumption / 100", "Repayment is a chosen percentage of supported reported current plus noncurrent debt. Repayment does not automatically create an interest saving."],
  ["Incremental interest", "interest = new borrowing × annual borrowing rate / 100 × period days / 365", "Period days include the start and end dates. New borrowing is assumed outstanding throughout that reporting period."],
  ["Earnings effect", "Δearnings = ΔOI − interest − max(ΔOI − interest, 0) × assumed tax rate / 100", "Only positive incremental earnings incur the assumed tax. Negative changes receive no assumed tax refund, loss carryforward or other tax relief."],
  ["Working capital", "extra working-capital cash use = reported revenue × working-capital assumption / 100", "A positive input consumes cash; a negative input releases cash. The model treats this change as net noncash operating assets."],
  ["Capital spending", "Δcapex = reported purchases of property, plant and equipment × capex change / 100", "The assumption changes this reported spending measure. It does not represent every possible acquisition or investing cash flow."],
  ["Operating cash flow", "hypothetical CFO = reported CFO + Δearnings − extra working-capital cash use", "Reported CFO already includes reported earnings and existing cash adjustments. Only the modeled differences are added."],
  ["Free cash flow", "hypothetical FCF = hypothetical CFO − (reported capex + Δcapex)", "Free cash flow is an application calculation using operating cash flow less the selected property, plant and equipment spending measure."],
  ["Ending cash", "hypothetical ending cash = reported ending cash + Δearnings − extra working-capital cash use − Δcapex + new borrowing − repayment", "This adjusts cash at the end of the same reporting period. It never adds the entire reported CFO to an ending cash balance."],
];

export default function ScenarioMethodologyPage() {
  return <article className={styles.page}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(article).replace(/</g, "\\u003c") }} />
    <header className={styles.hero}>
      <Link className={styles.back} href="/analysis">← Company analysis</Link>
      <p className={styles.eyebrow}>Scenarios / Methodology</p>
      <h1>Change the assumption.<br /><span>Trace the financial effect.</span></h1>
      <p className={styles.intro}>Start with a reported SEC period. Explore how explicit assumptions change earnings, cash and financing needs, with the evidence behind every baseline.</p>
      <div className={styles.steps}>
        <div><SlidersHorizontal aria-hidden="true" size={19} /><span>01 / Assume</span><strong>Choose the change</strong></div>
        <div><GitBranch aria-hidden="true" size={19} /><span>02 / Trace</span><strong>Follow the calculation</strong></div>
        <div><BookOpen aria-hidden="true" size={19} /><span>03 / Check</span><strong>Review the evidence</strong></div>
      </div>
      <nav className={styles.navigation} aria-label="Scenario methodology sections">
        <a href="#baseline">Reported baseline</a><a href="#operating">Operating models</a><a href="#connected-model">Connected cash model</a><a href="#history">Historical context</a><a href="#drivers">Drivers</a><a href="#new-filings">New filings</a>
      </nav>
    </header>

    <section id="baseline" className={styles.section}>
      <p className={styles.eyebrow}>01 / Start with a period</p>
      <h2>A same-period counterfactual, not a forecast</h2>
      <p>A scenario asks what a selected reporting period might have looked like under different assumptions. Annual, standalone quarter, fiscal year-to-date and trailing-twelve-month selections retain their own start and end dates. Flow measures cover that duration; balance-sheet measures describe its ending date.</p>
      <p>The results are hypothetical calculations. They are not SEC-reported results, a forecast of the next period or a probability estimate. The workbench keeps baseline evidence and optional CFTC context in expandable sections beside the model.</p>
      <div className={styles.callout}><strong>Units stay explicit.</strong> Revenue and cost changes use percentages. Margin changes use percentage points. Currency inputs and results follow the selected display scale; calculations use the underlying currency values.</div>
    </section>

    <section id="operating" className={styles.section}>
      <p className={styles.eyebrow}>02 / Operating companies</p>
      <h2>Two ways to change operating performance</h2>
      <div className={styles.columns}>
        <div><h3>Margin model</h3><p>Change revenue and operating margin independently. With revenue change <var>g</var> as a decimal and margin change <var>m</var> in percentage points:</p><code>revenue′ = revenue × (1 + g)</code><code>operating income′ = reported operating income × (1 + g) + revenue′ × m / 100</code></div>
        <div><h3>Cost model</h3><p>Start with implied operating costs: reported revenue less operating income. Split these into an assumed variable share and a fixed remainder. Variable costs move proportionately with revenue; the cost-change assumption then applies to both parts.</p><code>operating income′ = revenue′ − (fixed costs + variable costs × (1 + g)) × (1 + cost change / 100)</code></div>
      </div>
      <p>The variable-cost share is a modeling assumption, not a reported expense breakdown. These operating models require compatible reported revenue and operating income and apply to the operating-company financial lens. Banking and insurance statements do not automatically receive an industrial earnings model.</p>
    </section>

    <section id="connected-model" className={styles.section}>
      <p className={styles.eyebrow}>03 / Optional connected model</p>
      <h2>Follow earnings into cash and borrowing needs</h2>
      <p>Enable the connected cash model to supply explicit assumptions for incremental taxes, working-capital cash use, capital spending, new borrowing and debt repayment. The model starts with reported operating cash flow and ending cash, then applies only the changes caused by those assumptions.</p>
      <dl className={styles.equations}>{equations.map(([label, equation, explanation]) => <div key={label}><dt>{label}</dt><dd><code>{equation}</code><p>{explanation}</p></dd></div>)}</dl>
      <div className={styles.columns}>
        <div><h3>Financial strength</h3><p>When compatible evidence supports them, equity changes by Δearnings, debt changes by new borrowing less repayment, and assets change by Δearnings plus new borrowing less repayment. Working capital and capex exchange cash for noncash assets under the model assumptions. Ratios use these hypothetical balances.</p></div>
        <div><h3>Unfunded cash shortfall</h3><p>If hypothetical cash falls below zero, the workbench shows a funding shortfall. It does not silently fill that gap with debt. Funded balance-sheet outcomes and ratios are withheld until the user supplies sufficient explicit financing.</p></div>
      </div>
      <div className={styles.callout}>Noncash charges, dividends and other cash flows remain unchanged. There is no automatic financing, tax relief, depreciation response to new capex or interest saving from repayment. The separate static asset-loss exercise is not added to this connected model.</div>
    </section>

    <section id="history" className={styles.section}>
      <p className={styles.eyebrow}>04 / Context for assumptions</p>
      <h2>Compare with the company’s reported history</h2>
      <p>Historical context uses up to five preceding, compatible annual or same-season observations. Revenue growth compares each observation with its immediately preceding comparable year. Margin changes compare adjacent supported historical margins in percentage points.</p>
      <p>Ranges, medians, observation counts and actual reporting dates describe the available sample. Missing years, duplicate anchors or fiscal-season changes stop the sequence; the workbench does not skip across gaps to create a longer history. Reporting windows, concepts, units and the selected filing cutoff must remain compatible.</p>
      <p>Reported history provides context for revenue and margins. Assumptions such as variable-cost share or borrowing cost remain user estimates. A historical range does not establish a likely future range.</p>
    </section>

    <section id="drivers" className={styles.section}>
      <p className={styles.eyebrow}>05 / Read the sensitivity</p>
      <h2>Which assumption moves the result most?</h2>
      <p>The driver chart changes one assumption at a time, from its selected low value to its high value, while holding the remaining applied settings constant. Every endpoint runs the same model as the main result.</p>
      <code className={styles.ranking}>driver size = max(|low outcome − applied outcome|, |high outcome − applied outcome|)</code>
      <p>Drivers are ordered by this largest absolute change in the selected outcome. Edit the shock ranges to ask a different sensitivity question. Changing those ranges can change the order; the chart does not infer causality, probability or observed historical importance. An unavailable outcome retains its reason and is not converted to zero.</p>
    </section>

    <section id="new-filings" className={styles.section}>
      <p className={styles.eyebrow}>06 / Keep the comparison clear</p>
      <h2>Separate new evidence from new assumptions</h2>
      <p>When updating a scenario to a newer reported baseline, preserve the original period, source evidence and assumptions. First apply the original assumptions to the newer baseline; then apply any revised assumptions. This separates the effect of changed reported inputs from the effect of a changed scenario.</p>
      <p>Different period lengths, accounting scopes and missing evidence can prevent a meaningful comparison. Review the displayed reporting dates and availability reasons before interpreting the difference. An updated filing is new evidence, not proof that an earlier hypothetical outcome occurred.</p>
    </section>

    <section className={styles.section} aria-labelledby="evidence-heading">
      <p className={styles.eyebrow}>Evidence and availability</p>
      <h2 id="evidence-heading">Keep facts, assumptions and market context distinct</h2>
      <p>Reported inputs link to their SEC source filings. Missing or incompatible inputs withhold dependent results. Supported results remain available when an unrelated input is missing; an unavailable debt balance, for example, need not suppress cash when no repayment is assumed.</p>
      <p>CFTC Commitments of Traders observations describe aggregate futures positioning for their own report dates. They may inform a research question, but do not measure an issuer’s exposure, establish a commodity-price shock or automatically change an earnings assumption.</p>
      <p>The public <Link href="/analysis">company analysis pages</Link> provide dated, server-rendered SEC highlights. The <a href={`${SITE_URL}/api/v1/analysis/AAPL`}>prepared Analysis JSON endpoint</a> returns reported and calculated financial evidence, not a user’s hypothetical scenario. Company scenario URLs are interactive selections; cite the methodology and original filings separately from user assumptions.</p>
    </section>

    <footer className={styles.examples}>
      <div><p className={styles.eyebrow}>Open a company</p><h2>Put an assumption to work.</h2><p>Examples are starting points, not recommended investments. Each workspace shows the evidence and tools available for that company.</p></div>
      <div className={styles.exampleLinks}>
        <Link href="/analysis/AAPL?view=scenarios" prefetch={false}>Apple scenarios <ArrowRight size={16} aria-hidden="true" /></Link>
        <Link href="/analysis/GOOGL?view=scenarios" prefetch={false}>Alphabet scenarios <ArrowRight size={16} aria-hidden="true" /></Link>
        <Link href="/analysis/JPM?view=scenarios" prefetch={false}>JPMorgan balance sensitivity <ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    </footer>
  </article>;
}
