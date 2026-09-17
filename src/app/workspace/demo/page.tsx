import Link from "next/link";
import { buildPageMetadata } from "../../../utils/siteMetadata";
import { normalizePortfolioDestination } from "../../../utils/researchHubNavigation.js";
import universe from "../../../../public/portfolio/portfolio-demo-100-universe.json";
import DemoResults from "./DemoResults";
import s from "./demo.module.css";

export const metadata = buildPageMetadata({
  title: "Portfolio Analytics Demo — SEC Financials & CFTC Context",
  description:
    "Explore a 100-company portfolio across Summary, Holdings, Financials, Concentration & Exposure, and What Changed, with SEC evidence and CFTC market context.",
  path: "/workspace/demo",
});

export default async function PortfolioDemoPage({ searchParams }: {
  searchParams: Promise<{ portfolioTab?: string | string[]; analyticsArea?: string | string[]; holdingsMode?: string | string[] }>;
}) {
  const query = await searchParams;
  const destination = normalizePortfolioDestination(query);
  const initialArea = destination.portfolioTab === "changes" || destination.portfolioTab === "research"
    ? destination.portfolioTab
    : "analytics";
  const initialAnalyticsArea = destination.analyticsArea === "financial" || destination.analyticsArea === "concentration"
    ? destination.analyticsArea
    : "overview";
  return (
    <div className={s.page} data-research-workspace data-demo-universe="sp500-coverage">
      <DemoResults
        initialArea={initialArea}
        initialAnalyticsArea={initialAnalyticsArea}
        initialHoldingsMode={destination.holdingsMode === "screen" ? "screen" : "all"}
      />
      <details className={s.notice}>
        <summary>About this portfolio example and its sources</summary>
        <p>
          Explore {universe.companies.length} companies selected by combined issuer weight from the demo’s stored IVV holdings,
          dated <time dateTime={universe.source.asOf}>{universe.source.asOf}</time>. The list is a dated S&amp;P 500 coverage proxy.
          Example weights are hypothetical; equal weights and company counts are also available.
        </p>
        <ul>
          <li><Link href="/workspace/demo" prefetch={false}>Summary</Link> — What should I notice about this portfolio?</li>
          <li><Link href="/workspace/demo?portfolioTab=research" prefetch={false}>Holdings</Link> — What do I own, and which holdings meet my criteria?</li>
          <li><Link href="/workspace/demo?portfolioTab=analytics&analyticsArea=financial" prefetch={false}>Financials</Link> — What financial characteristics does my allocation represent?</li>
          <li><Link href="/workspace/demo?portfolioTab=analytics&analyticsArea=concentration" prefetch={false}>Concentration &amp; Exposure</Link> — Where are holdings concentrated, and which markets connect them?</li>
          <li><Link href="/workspace/demo?portfolioTab=changes" prefetch={false}>What Changed</Link> — What new information affects this portfolio?</li>
        </ul>
        <p>
          Financial measures link to SEC company evidence. CFTC data describes aggregate futures-market positioning;
          SEC filing references connect companies to markets without measuring the size or direction of company exposure.
          Each research view shows its available coverage and observation periods.
        </p>
        <p>
          <Link href="/workspace/demo/changes" prefetch={false}>Read the public SEC-linked CFTC changes brief</Link>
          {" · "}<Link href="/workspace/portfolio-guide" prefetch={false}>Portfolio import guide</Link>
        </p>
      </details>
    </div>
  );
}
