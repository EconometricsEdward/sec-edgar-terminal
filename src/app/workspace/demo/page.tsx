import { buildPageMetadata } from "../../../utils/siteMetadata";
import DemoResults from "./DemoResults";
import s from "./demo.module.css";

export const metadata = buildPageMetadata({
  title: "S&P 500 Top 100 Company Research Demo",
  description:
    "Explore the top 100 unique companies by combined weight in the stored S&P 500 holdings. Every demo view uses the same company list, with SEC evidence and optional hypothetical weights.",
  path: "/workspace/demo",
});

export default async function PortfolioDemoPage({ searchParams }: {
  searchParams: Promise<{ portfolioTab?: string | string[] }>;
}) {
  const query = await searchParams;
  return (
    <div className={s.page} data-research-workspace data-demo-universe="sp500-coverage">
      <DemoResults initialArea={query.portfolioTab === "changes" ? "changes" : "analytics"} />
    </div>
  );
}
