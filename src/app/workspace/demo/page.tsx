import { buildPageMetadata } from "../../../utils/siteMetadata";
import DemoResults from "./DemoResults";
import s from "./demo.module.css";

export const metadata = buildPageMetadata({
  title: "Hypothetical Weighted Portfolio Demo",
  description:
    "Explore 100 companies with hypothetical weights totaling 100%. Compare concentration, weighted evidence coverage and scenarios using captured SEC research, then make your own copy.",
  path: "/workspace/demo",
});

export default function PortfolioDemoPage() {
  return (
    <div className={s.page} data-research-workspace>
      <DemoResults />
    </div>
  );
}
