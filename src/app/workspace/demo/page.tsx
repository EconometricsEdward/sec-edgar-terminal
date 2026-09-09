import Link from "next/link";
import { buildPageMetadata } from "../../../utils/siteMetadata";
import DemoResults from "./DemoResults";
import s from "./demo.module.css";

export const metadata = buildPageMetadata({
  title: "100-Company Portfolio Research Example",
  description:
    "Download a prefilled 100-ticker CSV or Excel template and explore its captured SEC research results, financial evidence, and filings before starting your own research.",
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
          <p className={s.eyebrow}>A worked example · 100 company tickers</p>
          <h1>
            Your list goes in.
            <br />
            The evidence comes together.
          </h1>
          <p className={s.lede}>
            Try a prefilled company list, then explore what the analysis
            produces: financial measures, reporting dates, SEC sources, and
            questions to follow up.
          </p>
          <div className={s.actions}>
            <a
              className={s.primary}
              href="/portfolio/portfolio-demo-100.csv"
              download
            >
              Download 100-ticker CSV ↓
            </a>
            <a
              className={s.secondary}
              href="/portfolio/portfolio-demo-100.xlsx"
              download
            >
              Download Excel ↓
            </a>
            <a className={s.textLink} href="#example-results">
              See example results ↓
            </a>
          </div>
        </div>
        <aside className={s.recipe} aria-label="How to try the example">
          <span className={s.eyebrow}>From template to research</span>
          <ol>
            <li>
              <strong>100 prefilled tickers</strong>
              <span>Keep the list or replace companies with your own.</span>
            </li>
            <li>
              <strong>Review company matches</strong>
              <span>Confirm the issuer before retrieving its evidence.</span>
            </li>
            <li>
              <strong>Research, inspect, export</strong>
              <span>
                Explore the captured example below, then try the full Hub.
              </span>
            </li>
          </ol>
          <p>
            A company research list. No allocations or holdings are assumed.
          </p>
        </aside>
      </header>
      <DemoResults />
      <section className={s.nextSteps} aria-labelledby="demo-next-heading">
        <div>
          <p className={s.eyebrow}>Ready for your own research?</p>
          <h2 id="demo-next-heading">
            Keep the format. Make the questions yours.
          </h2>
          <p>
            Edit the tickers in the downloaded file, upload it in Portfolio
            research, and review the matches. Tickers alone are enough; weights
            and notes are optional.
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
