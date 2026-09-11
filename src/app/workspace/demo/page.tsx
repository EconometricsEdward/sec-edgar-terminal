import Link from "next/link";
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
    <div className={s.page}>
      <Link className={s.back} href="/workspace">
        ← Research Hub
      </Link>
      <header className={s.hero}>
        <div>
          <p className={s.eyebrow}>Research Hub demo · 100 companies</p>
          <h1>A hypothetical portfolio. Real SEC evidence.</h1>
          <p className={s.lede}>
            Explore unequal weights totaling 100%, compare them with equal
            weights, and see which holdings drive concentration and evidence
            gaps.
          </p>
          <div className={s.actions}>
            <a
              className={s.primary}
              href="/portfolio/portfolio-demo-100.csv"
              download
            >
              Weighted CSV ↓
            </a>
            <a
              className={s.secondary}
              href="/portfolio/portfolio-demo-100.xlsx"
              download
            >
              Weighted Excel ↓
            </a>
            <a
              className={s.secondary}
              href="/portfolio/portfolio-demo-100.json"
              download
            >
              Weighted JSON ↓
            </a>
          </div>
          <p className={s.downloadHelp}>
            Downloads contain the fixed hypothetical weights. After CSV or Excel
            import, select supplied weight percentages in Allocation settings.
            JSON preserves that setting.
          </p>
        </div>
      </header>
      <DemoResults />
      <section className={s.nextSteps} aria-labelledby="demo-next-heading">
        <div>
          <p className={s.eyebrow}>Ready for your own research?</p>
          <h2 id="demo-next-heading">
            Keep the format. Make the questions yours.
          </h2>
          <p>
            Replace the example tickers and weights with your own, upload the
            file, and review the company matches. Clear the weights if you only
            want a company research list.
          </p>
        </div>
        <div className={s.actions}>
          <Link className={s.primary} href="/workspace?view=portfolios">
            Open Portfolio research →
          </Link>
          <Link className={s.secondary} href="/workspace/portfolio-guide">
            Templates & format guide
          </Link>
        </div>
      </section>
    </div>
  );
}
