import Link from "next/link";
import {
  ArrowRight, ArrowUpRight, BarChart3, ChevronDown, FileSearch,
  GitCompareArrows, Layers, Search, ShieldCheck, TrendingUp, Wallet,
} from "lucide-react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import styles from "./help.module.css";

export const metadata = buildPageMetadata({
  title: "Research Guide — Compare Companies, Search Filings & Explore Funds",
  description: "Find the right EDGAR Terminal tool for company financials, peer comparisons, disclosure search, fund holdings and CFTC context. Learn reporting dates, coverage and sharing.",
  path: "/help",
});

const WORKFLOWS = [
  {
    name: "Analysis", href: "/analysis", icon: BarChart3,
    question: "Understand a company’s financials",
    description: "Choose a company and reporting basis. Explore statements, growth, cash quality and capital, then open a figure to inspect its inputs.",
    tip: "Use Scenarios to test assumptions; results depend on the inputs you choose.",
  },
  {
    name: "Compare", href: "/compare", icon: GitCompareArrows,
    question: "See how companies differ",
    description: "Add company names or tickers. Compare gives you visual differences and a metric table; Trends & growth follows their history; Peer map plots two metrics together.",
    tip: "Use Settings for alignment and benchmarks, and Data checks for coverage.",
  },
  {
    name: "Risk", href: "/risk", icon: ShieldCheck,
    question: "Explore financial resilience",
    description: "Start with Risk Profile for liquidity, debt, capital and earnings. Business Exposures connects concentrations, credit & derivatives, market links, and funds & holders.",
    tip: "A missing amount means the supported inputs are unavailable, not zero exposure.",
  },
  {
    name: "Disclosures", href: "/disclosures", icon: Search,
    question: "Find what companies are saying",
    description: "Start with a topic or question in Smart search, or use Exact search for precise terms. Narrow by company, filing form and dates, then open a matching passage.",
    tip: "Check how your search was interpreted and how many filings were searched.",
  },
  {
    name: "Funds", href: "/fund", icon: Wallet,
    question: "Look inside reported portfolios",
    description: "Use Fund portfolios for N-PORT fund holdings, comparisons and allocation. Switch to Institutional managers for 13F positions, shared holdings and quarterly changes.",
    tip: "Compare portfolio dates before interpreting differences in positions.",
  },
  {
    name: "Portfolio", href: "/workspace", icon: Layers,
    question: "Research a group of holdings",
    description: "Import a portfolio or explore the demo. Review concentrations and financial profiles, follow What Changed?, and test assumptions in Scenarios.",
    tip: "Your portfolio weights and the dates of the underlying reports both matter.",
  },
  {
    name: "Filings", href: "/filings", icon: FileSearch,
    question: "Go straight to the original report",
    description: "Find a company’s filings and open the SEC document. Use the original tables and notes to check context that a summary or extracted passage may omit.",
    tip: "Use the filing date to locate a release and the reporting period to identify what it covers.",
  },
  {
    name: "Market", href: "/market", icon: TrendingUp,
    question: "Put company results in context",
    description: "Explore sector fundamentals and official CFTC futures positioning. Check the reporting dates and company coverage behind the market briefing.",
    tip: "CFTC positioning describes market participants, not an individual company’s holdings.",
  },
];

const SOURCES = [
  {
    title: "Company financials", tag: "SEC · XBRL",
    description: "Reported facts are mapped from SEC XBRL concepts. Ratios, free cash flow and derived periods are calculations by EDGAR Terminal.",
    check: "Inspect the unit, source concept, reporting dates, formula and original filing. Different companies may use different accounting definitions or tags for a similarly named metric.",
  },
  {
    title: "Filing passages", tag: "SEC · 10-K, 10-Q, 8-K & more",
    description: "Search results are excerpts from the filings covered by your request. Open the passage and its SEC document for surrounding text, tables and amendments.",
    check: "A first match is the earliest found within the searched filings. It does not establish the company’s first disclosure. Keyword relevance is not a risk score.",
  },
  {
    title: "Fund portfolios", tag: "SEC · N-PORT",
    description: "A public N-PORT report is a historical fund portfolio snapshot. Availability varies by fund, reporting structure and report.",
    check: "Check the portfolio date and the fund series. Several share classes can belong to the same reported portfolio; these are not live holdings.",
  },
  {
    title: "Manager holdings", tag: "SEC · 13F",
    description: "Form 13F reports a manager’s quarter-end holdings of reportable securities. Reported value is not total assets under management.",
    check: "Cash and short positions are absent; confidential holdings may be omitted. Review amendments and options separately. Value changes are not returns or cash flows, and quantity changes may reflect corporate actions.",
  },
  {
    title: "Futures positioning", tag: "CFTC · COT",
    description: "Official futures-only TFF and Disaggregated reports describe positions by participant group. Report families have different categories and are kept separate.",
    check: "Check the contract, venue, participant group, report date and units. Net positions are not prices, fund flows or a company’s exposure. SEC passages explain a company’s market connection; a proxy remains a proxy.",
  },
  {
    title: "Peer & sector summaries", tag: "Calculated · covered sample",
    description: "Benchmarks and aggregates describe the companies with usable inputs in the selected sample. They are not a whole-market measure.",
    check: "Review sample size, excluded issuers and reporting dates. A shared calendar bucket does not guarantee identical fiscal dates, durations or accounting definitions.",
  },
];

const QUESTIONS = [
  {
    question: "Why is a financial metric unavailable?",
    answer: "The selected period may lack a supported SEC tag, a compatible reporting duration or an input needed for the calculation. Open the figure’s source details or coverage checks. Try another reporting period or basis, and consult the original filing. A blank value is not treated as zero.",
  },
  {
    question: "Why do peers show different dates or definitions?",
    answer: "Companies have different fiscal calendars and filing schedules. In Compare, review the basis, period and alignment settings, then open Data checks. Comparability checks can exclude an input from a benchmark even when its reported value remains visible. Matching dates alone do not make accounting definitions identical.",
  },
  {
    question: "Why did my disclosure search find no matches?",
    answer: "Check the interpreted search, company, filing forms and date range. Broaden the terms or load more filings where offered. No match in successfully searched documents differs from an unsupported filing or a failed request; review coverage before drawing a conclusion.",
  },
  {
    question: "How should I use CFTC data alongside a company?",
    answer: "Read the company’s SEC passage first to understand the business connection, then examine the dated positioning for the relevant market. Compare’s Shared market drivers lets you inspect those connections across companies. A named contract, a proxy and a qualified reference have different meanings. Positioning does not establish the company’s hedge, position size or profit sensitivity.",
  },
  {
    question: "A page or report will not load. What should I try?",
    answer: "Retry the failed request, confirm the company or fund identity, and check the selected dates. The header’s Service status shows application response and configuration, not SEC uptime or the freshness of every report. A successful refresh can return the same reporting period when no newer supported data is available.",
  },
  {
    question: "Will a shared link preserve exactly what I see?",
    answer: "A Share control preserves the supported page selections in a URL. Public data can change as new filings arrive or source data is revised. Keep an export, the reporting dates and the original filing links when you need a record of the figures you used. Browser-local portfolios do not automatically transfer with a page URL.",
  },
];

export default function HelpPage() {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>The EDGAR Terminal guide</p>
        <h1>Start with a question.<br /><span>Find the right view.</span></h1>
        <p className={styles.heroLead}>A practical guide to company research, portfolio holdings and the public data behind every view.</p>
        <div className={styles.heroFooter}>
          <a className={styles.startLink} href="#tools">Find your starting point <ArrowRight size={17} aria-hidden="true" /></a>
          <span>SEC filings <span aria-hidden="true">/</span> Fund reports <span aria-hidden="true">/</span> CFTC positioning</span>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.rail}>
          <nav aria-label="Research guide sections">
            <p className={styles.eyebrow}>In this guide</p>
            <a href="#tools"><span>01</span> Choose a tool</a>
            <a href="#sources"><span>02</span> Sources & dates</a>
            <a href="#coverage"><span>03</span> Common questions</a>
            <a href="#workspace"><span>04</span> Sharing & storage</a>
            <a href="#keyboard"><span>05</span> Keyboard & reading</a>
          </nav>
          <p className={styles.railNote}>New here? Use the search in the header to find a company, filing or research tool.</p>
          <Link href="/about" prefetch={false} className={styles.aboutLink}>About & methodology <ArrowUpRight size={14} aria-hidden="true" /></Link>
        </aside>

        <div className={styles.content}>
          <section id="tools" className={styles.section} aria-labelledby="tools-title">
            <div className={styles.sectionHeading}><span className={styles.sectionNumber}>01</span><div><h2 id="tools-title">What are you researching?</h2><p>Choose a starting point. Follow the source when you need more detail.</p></div></div>
            <div className={styles.workflows}>
              {WORKFLOWS.map(({ name, href, icon: Icon, question, description, tip }) => (
                <article key={name} className={styles.workflow}>
                  <Link href={href} prefetch={false} className={styles.toolLink}><Icon size={18} aria-hidden="true" /><span>{name}</span><ArrowUpRight size={17} aria-hidden="true" /></Link>
                  <h3>{question}</h3>
                  <p>{description}</p>
                  <p className={styles.tip}>{tip}</p>
                </article>
              ))}
            </div>
          </section>

          <section id="sources" className={styles.section} aria-labelledby="sources-title">
            <div className={styles.sectionHeading}><span className={styles.sectionNumber}>02</span><div><h2 id="sources-title">Read the date before the number.</h2><p>These dates answer different questions. A recent retrieval does not make an older report current.</p></div></div>
            <dl className={styles.dates}>
              <div><dt>Reporting period</dt><dd>When the company’s results or portfolio holdings were measured.</dd></div>
              <div><dt>Filing date</dt><dd>When the report was submitted to the SEC.</dd></div>
              <div><dt>CFTC report date</dt><dd>The as-of date of the positions, distinct from publication.</dd></div>
              <div><dt>Retrieved</dt><dd>When the application fetched a copy of the source data.</dd></div>
            </dl>
            <div className={styles.sources}>
              {SOURCES.map(source => (
                <details key={source.title} className={styles.source}>
                  <summary><span><span className={styles.sourceTag}>{source.tag}</span><span className={styles.sourceTitle}>{source.title}</span></span><ChevronDown size={18} aria-hidden="true" /></summary>
                  <div><p>{source.description}</p><p>{source.check}</p></div>
                </details>
              ))}
            </div>
            <p className={styles.sourceNote}>For financial figures, check the unit, reporting basis and source inputs together. Annual, standalone quarter, year-to-date and trailing periods describe different time windows.</p>
          </section>

          <section id="coverage" className={styles.section} aria-labelledby="questions-title">
            <span id="recovery" className={styles.anchor} />
            <div className={styles.sectionHeading}><span className={styles.sectionNumber}>03</span><div><h2 id="questions-title">A few useful answers.</h2><p>Missing data, reporting differences and the next step to take.</p></div></div>
            <div className={styles.questions}>
              {QUESTIONS.map(item => (
                <details key={item.question}>
                  <summary>{item.question}<ChevronDown size={18} aria-hidden="true" /></summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </section>

          <section id="workspace" className={styles.section} aria-labelledby="workspace-title">
            <div className={styles.sectionHeading}><span className={styles.sectionNumber}>04</span><div><h2 id="workspace-title">Keep a useful record.</h2><p>Share the view, export the result, and know what stays in your browser.</p></div></div>
            <div className={styles.storage}>
              <article><span>01 / Share</span><h3>Return to a view</h3><p>Use Share where offered to copy the supported filters and selections. A link opens the research view; it is not a frozen copy of its data.</p></article>
              <article><span>02 / Export</span><h3>Keep the figures</h3><p>Use the page’s export controls where available. Retain the source filings and reporting dates alongside your exported results.</p></article>
              <article><span>03 / Browser</span><h3>Protect local work</h3><p>Saved portfolios and preferences stay in this browser profile and do not automatically sync across devices. Export a portfolio before clearing site data or switching browsers.</p></article>
            </div>
            <p className={styles.sourceNote}>Private browsing, storage limits and blocked storage can affect persistence. If saving fails, keep the page open and export where possible. Public-data requests are sent to the application; page usage and performance are measured with Vercel Analytics and Speed Insights.</p>
          </section>

          <section id="keyboard" className={styles.section} aria-labelledby="keyboard-title">
            <div className={styles.sectionHeading}><span className={styles.sectionNumber}>05</span><div><h2 id="keyboard-title">Make yourself comfortable.</h2><p>Use the header’s Reading menu for text size, table density and motion preferences.</p></div></div>
            <dl className={styles.shortcuts}>
              <div><dt><kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd></dt><dd>Focus the site search.</dd></div>
              <div><dt><kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd></dt><dd>Navigate search suggestions and open a result.</dd></div>
              <div><dt><kbd>Esc</kbd></dt><dd>Close search suggestions or the service status panel.</dd></div>
              <div><dt><kbd>Tab</kbd> / <kbd>Shift</kbd> + <kbd>Tab</kbd></dt><dd>Move between links and controls. The first skip link goes to the main content.</dd></div>
            </dl>
          </section>
          <div className={styles.closing}><p>A good comparison starts with the right context.</p><Link href="/compare" prefetch={false}>Compare companies <ArrowRight size={17} aria-hidden="true" /></Link></div>
        </div>
      </div>
    </div>
  );
}
