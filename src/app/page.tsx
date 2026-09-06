import Link from "next/link";
import {
  ArrowUpRight,
  BarChart3,
  FileSearch,
  FileText,
  GitCompareArrows,
  Globe2,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import HomeResearch from "../components/site/HomeResearch";
import ResearchWorkflow from "../components/site/ResearchWorkflow";
import styles from "./home.module.css";

const tools = [
  {
    title: "Filings",
    icon: FileText,
    href: "/filings",
    number: "01",
    text: "Find a report, read the relevant passage, and compare it with an earlier filing.",
  },
  {
    title: "Analysis",
    icon: BarChart3,
    href: "/analysis",
    number: "02",
    text: "Explore statements, period changes, cash flow, and the reported inputs behind each calculation.",
  },
  {
    title: "Risk",
    icon: ShieldCheck,
    href: "/risk",
    number: "03",
    text: "Review credit, liquidity, capital, and earnings with a lens suited to the company.",
  },
  {
    title: "Compare",
    icon: GitCompareArrows,
    href: "/compare",
    number: "04",
    text: "Line up as many as five peers, inspect reporting dates, and keep the evidence behind a comparison.",
  },
  {
    title: "Market",
    icon: Globe2,
    href: "/market",
    number: "05",
    text: "Explore covered companies by sector, screen fundamentals, and build a company watchlist.",
  },
  {
    title: "Funds",
    icon: Wallet,
    href: "/fund",
    number: "06",
    text: "Inspect reported fund holdings, portfolio concentration, overlap, and N-PORT source documents.",
  },
  {
    title: "Disclosures",
    icon: FileSearch,
    href: "/disclosures",
    number: "07",
    text: "Search filing language, compare passages, and collect quotations for a research brief.",
  },
];
export default function HomePage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Public filings. Connected research.</p>
          <h1>
            Follow the evidence.
            <br />
            <span>Keep the context.</span>
          </h1>
          <p className={styles.lead}>
            Move from a company’s numbers to the filing behind them. Build a
            review that connects financials, disclosures, peers, and your own
            notes.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primary} href="/filings">
              Find a filing <ArrowUpRight size={17} />
            </Link>
            <Link className={styles.secondary} href="/workspace">
              Open your Research Hub <ArrowUpRight size={17} />
            </Link>
          </div>
          <p className={styles.trust}>
            Free access · No account required · Source links and coverage shown
            in each tool
          </p>
        </div>
        <ResearchWorkflow />
      </section>
      <HomeResearch />
      <section aria-labelledby="tools-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Choose your starting point</p>
            <h2 id="tools-title">One research question. The right tool.</h2>
          </div>
          <Link href="/help">
            Read the research guide <ArrowUpRight size={15} />
          </Link>
        </div>
        <div className={styles.tools}>
          {tools.map((tool) => (
            <Link
              href={tool.href}
              key={tool.title}
              prefetch={false}
              className={styles.tool}
            >
              <div className={styles.toolTop}>
                <tool.icon size={22} strokeWidth={1.6} />
                <span>{tool.number}</span>
              </div>
              <h3>
                {tool.title}
                <ArrowUpRight size={17} />
              </h3>
              <p>{tool.text}</p>
            </Link>
          ))}
        </div>
      </section>
      <section className={styles.sourceNote}>
        <ShieldCheck size={28} strokeWidth={1.5} />
        <div>
          <h2>Read the source. Check the coverage.</h2>
          <p>
            Reported financials and filing text come from SEC records.
            Calculations, missing data, reporting dates, and limited search
            windows need context. Fund holdings are historical reports;
            supplementary market data is labeled separately.
          </p>
        </div>
        <Link href="/help#coverage">
          How the data works <ArrowUpRight size={15} />
        </Link>
      </section>
    </div>
  );
}
