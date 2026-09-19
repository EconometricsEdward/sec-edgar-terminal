import { FEATURED_COMPARE_GROUPS } from "../../utils/comparePublicMetadata.js";
import styles from "./CompareGuide.module.css";

/** Useful public HTML without a second financial-data fetch on every visit. */
export default function CompareGuide({ tickers = [] }: { tickers?: string[] }) {
  return (
    <details className={styles.guide}>
      <summary>About these comparisons &amp; related research</summary>
      <div className={styles.body}>
        <section>
          <h2>Compare the reporting periods as well as the numbers.</h2>
          <p>
            Annual, standalone quarter, and trailing-year views use SEC XBRL
            financial statements. Check the reporting dates and selected industry
            metrics before comparing companies with different fiscal calendars
            or business models. Open a figure to inspect its calculation and
            original filing. An unavailable figure is a coverage gap, not zero.
          </p>
          <a href="/about">Sources and methodology</a>
        </section>
        {tickers.length > 0 && (
          <nav aria-label="Research the selected companies">
            <h2>Go deeper on a company</h2>
            <ul>
              {tickers.map(ticker => (
                <li key={ticker}>
                  <strong>{ticker}</strong>
                  <a href={`/analysis/${ticker}`}>Financial analysis</a>
                  <a href={`/filings/${ticker}`}>SEC filings</a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <nav aria-label="Example peer comparisons">
          <h2>Explore a peer group</h2>
          <ul>
            {FEATURED_COMPARE_GROUPS.map(group => (
              <li key={group.tickers}>
                <a href={`/compare/${group.tickers}`}>{group.label}</a>
                <small>{group.tickers.replaceAll(",", " · ")}</small>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </details>
  );
}
