import { buildPageMetadata } from "../../../utils/siteMetadata";
import DemoResults from "./DemoResults";
import s from "./demo.module.css";

export const metadata = buildPageMetadata({
  title: "S&P 500 Coverage Portfolio Demo",
  description:
    "Explore 100 companies from EDGAR Terminal's active S&P 500 coverage list with hypothetical weights. Compare concentration, evidence coverage, recent SEC research and scenarios, then make your own copy.",
  path: "/workspace/demo",
});

export default function PortfolioDemoPage() {
  return (
    <div className={s.page} data-research-workspace data-demo-universe="sp500-coverage">
      <DemoResults />
    </div>
  );
}
