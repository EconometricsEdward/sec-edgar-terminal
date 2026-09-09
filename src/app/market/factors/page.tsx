import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowUpRight,
  Braces,
  ChartNoAxesCombined,
  FileSearch,
  Sigma,
} from "lucide-react";
import {
  buildPageMetadata,
  canonicalUrl,
  SITE_NAME,
  SITE_URL,
} from "../../../utils/siteMetadata";
import styles from "./factors.module.css";

const PAGE_PATH = "/market/factors" as const;
const PAGE_URL = canonicalUrl(PAGE_PATH);
const API_EXAMPLE_URL =
  "/api/v1/market-signals?ticker=MSFT&window=3y&basis=ttm";
const SCHEMA_URL = "/schemas/market-signals-v1.schema.json";
const OPENAPI_URL = "/openapi.json";

export const metadata: Metadata = buildPageMetadata({
  title: "EDGAR Factor Lab — Beta & SEC Filing-Event Methodology",
  description:
    "See how EDGAR Factor Lab estimates beta term structure, HAC market beta, influence and residual-tail sensitivity, filing-event response, and the EDGAR Evidence Gap.",
  path: PAGE_PATH,
});

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  "@id": `${PAGE_URL}#dataset`,
  name: "EDGAR Factor Lab derived market and filing diagnostics",
  description:
    "Source-aware estimates of market beta, conditional beta, independent sector sensitivity, filing-event abnormal returns, peer-normalized SEC filing change, and the EDGAR Evidence Gap.",
  url: PAGE_URL,
  creator: {
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
  },
  isAccessibleForFree: true,
  keywords: [
    "market beta",
    "Newey-West HAC",
    "conditional beta",
    "sector sensitivity",
    "SEC filing event study",
    "abnormal return",
    "EDGAR Evidence Gap",
  ],
  measurementTechnique: [
    "Ordinary least squares with Newey-West heteroskedasticity- and autocorrelation-consistent covariance",
    "Upside and downside conditional market regressions",
    "Sector-return residualization against a broad-market benchmark",
    "Filing-date event study with model-adjusted cumulative log returns",
    "Leave-one-out peer normalization using median and median absolute deviation",
  ],
  variableMeasured: [
    {
      "@type": "PropertyValue",
      name: "Market beta",
      description:
        "OLS sensitivity of a security's aligned log returns to the selected broad-market benchmark.",
    },
    {
      "@type": "PropertyValue",
      name: "Conditional beta",
      description:
        "Separate return sensitivities estimated on positive- and negative-benchmark sessions.",
    },
    {
      "@type": "PropertyValue",
      name: "Independent sector sensitivity",
      description:
        "Sensitivity to the portion of the sector benchmark not explained by the broad-market benchmark.",
    },
    {
      "@type": "PropertyValue",
      name: "Filing-event response",
      description:
        "One-, five-, and twenty-session cumulative abnormal return after a supported SEC filing date.",
    },
    {
      "@type": "PropertyValue",
      name: "SEC Filing Change z",
      description:
        "Fixed-weight, leave-one-out peer-normalized change in supported filing-derived financial measures.",
    },
    {
      "@type": "PropertyValue",
      name: "EDGAR Evidence Gap",
      description:
        "Difference between clipped SEC Filing Change z and clipped twenty-session standardized price response.",
    },
  ],
};

const nonFinancialComponents = [
  ["Change in year-over-year revenue growth", "25%"],
  ["Change in operating margin", "25%"],
  ["Change in free-cash-flow margin", "25%"],
  ["Change in book equity / assets", "12.5%"],
  ["Change in cash / assets", "12.5%"],
];

const financialComponents = [
  ["Change in year-over-year revenue growth", "33⅓%"],
  ["Change in net margin", "33⅓%"],
  ["Change in book equity / assets", "33⅓%"],
];

export default function MarketFactorsMethodologyPage() {
  return (
    <article className={styles.page}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />

      <header className={styles.hero}>
        <div className={styles.heroTopline}>
          <Link className={styles.backLink} href="/market?tab=factors">
            <Sigma size={16} aria-hidden="true" />
            Open the interactive Factor Lab
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
          <span className={styles.version}>Methodology · version 1.1</span>
        </div>

        <div className={styles.heroGrid}>
          <div>
            <p className={styles.eyebrow}>Econometric research methodology</p>
            <h1>EDGAR Factor Lab</h1>
            <p className={styles.lede}>
              Separate broad-market sensitivity, sector-specific movement,
              filing change, and the price response after public SEC evidence
              arrives. Every estimate carries its sample, dates, model
              definition, coverage, and limitations.
            </p>
          </div>
          <aside className={styles.distinction} aria-label="Three distinct research questions">
            <p>Keep three questions separate</p>
            <dl>
              <div>
                <dt>Risk β</dt>
                <dd>How returns historically moved with market conditions.</dd>
              </div>
              <div>
                <dt>Filing change</dt>
                <dd>How reported fundamentals changed versus comparable peers.</dd>
              </div>
              <div>
                <dt>Evidence Gap</dt>
                <dd>Whether filing change and model-adjusted price response differ.</dd>
              </div>
            </dl>
          </aside>
        </div>

        <nav className={styles.sectionLinks} aria-label="Factor methodology sections">
          <a href="#risk-beta">Risk beta</a>
          <a href="#conditional-beta">Conditional beta</a>
          <a href="#sector-sensitivity">Sector sensitivity</a>
          <a href="#filing-event">Filing event</a>
          <a href="#evidence-gap">Evidence Gap</a>
          <a href="#api">API & schema</a>
          <a href="#limitations">Limitations</a>
        </nav>
      </header>

      <section className={styles.intro} aria-labelledby="purpose-heading">
        <div>
          <p className={styles.eyebrow}>Purpose</p>
          <h2 id="purpose-heading">A diagnostic workspace, not a black-box score</h2>
          <p>
            The lab joins a provenance-aware market-price pipeline with
            source-linked SEC financial evidence. It does not collapse every
            result into one recommendation. Instead, it shows the separate
            quantities that support an interpretation and leaves unavailable
            values unavailable.
          </p>
        </div>
        <div className={styles.principles}>
          <article>
            <ChartNoAxesCombined size={20} aria-hidden="true" />
            <h3>Return behavior</h3>
            <p>Regression estimates include uncertainty, overlap, and stability diagnostics.</p>
          </article>
          <article>
            <FileSearch size={20} aria-hidden="true" />
            <h3>Filing evidence</h3>
            <p>Period changes preserve reporting dates, coverage, and source accessions.</p>
          </article>
          <article>
            <Braces size={20} aria-hidden="true" />
            <h3>Reusable output</h3>
            <p>Versioned JSON gives researchers and AI assistants the same definitions.</p>
          </article>
        </div>
      </section>

      <section id="risk-beta" className={styles.section}>
        <div className={styles.number}>01</div>
        <div className={styles.sectionBody}>
          <p className={styles.eyebrow}>Systematic sensitivity</p>
          <h2>Market beta with HAC uncertainty</h2>
          <p>
            The model converts positive price observations into close-to-close
            log returns and keeps only intervals whose start and end dates match
            the security and benchmark exactly. Prices and returns are not
            forward-filled across unmatched intervals. Version 1 estimates
            daily models only. The price transport excludes the current UTC
            calendar date so a still-forming Yahoo daily candle cannot enter a
            regression; the prior U.S. session becomes eligible after midnight
            UTC.
          </p>
          <div className={styles.equation} role="math" aria-label="Security return equals alpha plus market beta times market return plus an error">
            <code>rᵢ,ₜ = α + βₘrₘ,ₜ + εₜ</code>
            <span>and</span>
            <code>βₘ = Cov(rᵢ, rₘ) / Var(rₘ)</code>
          </div>
          <div className={styles.twoColumns}>
            <div>
              <h3>Point estimate</h3>
              <p>
                Ordinary least squares estimates the intercept and market beta.
                The standard model requires at least 126 aligned return
                intervals and at least 80% coverage of eligible benchmark
                intervals. The output also reports correlation, R², adjusted
                R², residual volatility, influential dates, and the effective
                sample period.
              </p>
            </div>
            <div>
              <h3>Newey–West inference</h3>
              <p>
                Beta and intercept standard errors use a Newey–West
                heteroskedasticity- and autocorrelation-consistent covariance
                estimate. The automatic lag is the integer part of
                4(n / 100)<sup>2/9</sup>, bounded by the available sample. The
                displayed 95% interval is β̂ ± 1.96 × HAC standard error.
              </p>
            </div>
          </div>
          <div className={styles.note}>
            The model uses raw log returns rather than excess returns. Its
            annualized intercept is therefore a descriptive regression
            intercept—not CAPM or Jensen alpha and not an expected return.
            Intercepts use 252-times scaling; volatility uses square-root-of-252
            scaling. Headline models also require complete adjusted-close
            histories for the security, broad-market benchmark, and sector
            proxy; fallback or mixed-basis inputs are disclosed but withheld
            from these estimates.
          </div>
          <div className={styles.twoColumns}>
            <div>
              <h3>Term structure and rolling location</h3>
              <p>
                One-, three-, and five-year summaries share one five-year price
                panel, so they do not start separate provider calls. Each label
                requires at least 126 matched returns and 80% of SPY intervals
                across its requested span; a shorter issuer history leaves the
                longer horizon unavailable rather than relabeling a since-listing estimate.
                The 126-session rolling series reports quartiles and the current
                empirical percentile. Overlapping windows are not independent tests.
              </p>
            </div>
            <div>
              <h3>Influence and residual tails</h3>
              <p>
                A sensitivity refit excludes the three largest Cook-distance
                sessions and reports the beta change without replacing headline
                OLS. The residual dashboard reports the empirical 5% quantile,
                mean lower-tail abnormal return, and extreme dates. These are in-sample model
                diagnostics—not portfolio VaR, expected loss, or forecasts.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="conditional-beta" className={styles.section}>
        <div className={styles.number}>02</div>
        <div className={styles.sectionBody}>
          <p className={styles.eyebrow}>Regime comparison</p>
          <h2>Upside and downside beta</h2>
          <p>
            The aligned sample is split by the sign of the benchmark return.
            One OLS market model is estimated when the benchmark return is
            positive and another when it is negative. Each side requires at
            least 30 observations; zero-return benchmark intervals belong to
            neither subset. Because sign-filtered observations are not
            consecutive trading sessions, each conditional regression uses a
            lag-0 HAC (HC1) covariance rather than serial-correlation lags.
          </p>
          <div className={styles.equation} role="math" aria-label="Conditional beta asymmetry equals downside beta minus upside beta">
            <code>β asymmetry = β downside − β upside</code>
          </div>
          <p>
            A positive difference means the estimated historical sensitivity
            was higher on negative benchmark sessions. This is a conditional
            sample comparison, not a crash forecast, tail-loss probability, or
            proof that the two coefficients differ statistically.
          </p>
        </div>
      </section>

      <section id="sector-sensitivity" className={styles.section}>
        <div className={styles.number}>03</div>
        <div className={styles.sectionBody}>
          <p className={styles.eyebrow}>Orthogonalized exposure</p>
          <h2>Independent sector sensitivity</h2>
          <p>
            A sector benchmark often rises and falls with the broad market.
            Using it directly beside the market can blur the meaning of both
            coefficients. The lab first removes the sector benchmark&apos;s fitted
            broad-market component. The remaining sector residual represents
            movement not explained by that market model.
          </p>
          <div className={styles.equationStack} role="math" aria-label="First regress the sector return on the market return. Then regress the issuer return on the market return and the market-orthogonal sector residual.">
            <code>rₛ,ₜ = aₛ + bₛrₘ,ₜ + uₛ,ₜ</code>
            <code>rᵢ,ₜ = α + βₘrₘ,ₜ + βₛ⊥uₛ,ₜ + εₜ</code>
          </div>
          <p>
            βₛ⊥ is sensitivity to the independent part of the selected sector
            proxy, after broad-market movement is removed. It is not the same
            as a simple company-versus-sector beta. Results retain the sector
            proxy, overlap, effective dates, and residual volatility so users
            can judge whether the comparison fits the company&apos;s business. The
            estimate is withheld unless at least 80% of eligible benchmark
            intervals have exact company, SPY, and sector-proxy matches.
          </p>
        </div>
      </section>

      <section id="filing-event" className={styles.section}>
        <div className={styles.number}>04</div>
        <div className={styles.sectionBody}>
          <p className={styles.eyebrow}>Public-information event</p>
          <h2>Price response after a filing date</h2>
          <p>
            When a supported SEC acceptance timestamp is available, only a
            filing accepted before the regular 9:30 a.m. America/New_York open
            uses that session&apos;s ending return. An intraday, post-close, or
            non-trading-day acceptance starts with the next benchmark session.
            A date-only filing is also assigned strictly to the next session. Expected
            return comes from the broad-market and independent-sector model estimated over
            as many as 252 earlier aligned sessions. The estimation sample ends
            20 sessions before the event and requires at least 180 observations.
          </p>
          <div className={styles.equationStack} role="math" aria-label="The EDGAR Evidence Gap equals the filing-change z score clipped between negative three and positive three, minus the price-response z score clipped to the same range.">
            <code>ARₜ = rᵢ,ₜ − r̂ᵢ,ₜ</code>
            <code>CARₕ = exp(Σ ARₜ) − 1, for h = 1, 5, or 20 sessions</code>
            <code>Standardized responseₕ = Σ ARₜ / √(HAC cumulative residual varianceₕ)</code>
          </div>
          <p>
            The Filing–Market Map uses the 20-session standardized response.
            Version 1.1 estimates cumulative residual variance from the pre-event
            residual autocovariances with Bartlett weights and publishes the full
            daily path through session 20. Standardization makes responses more
            comparable across securities; it is approximate and not a p-value. The event
            output retains the acceptance timestamp, assigned return interval,
            and timing-quality code. Every published 1-, 5-, or 20-session
            window must contain each expected benchmark interval in all three
            price series; a suspension or missing quote withholds that horizon.
          </p>
        </div>
      </section>

      <section id="evidence-gap" className={styles.section}>
        <div className={styles.number}>05</div>
        <div className={styles.sectionBody}>
          <p className={styles.eyebrow}>Filing–Market Map</p>
          <h2>SEC Filing Change z and EDGAR Evidence Gap</h2>
          <p>
            The map keeps reported change on one axis and model-adjusted price
            response on the other. Filing components are measured as
            period-over-period percentage-point changes, then normalized against
            other valid issuers in the same selected cohort and template. The
            focus issuer is excluded from its own peer reference. Peer reports
            are the latest point-in-time snapshots available when the lab runs,
            not a reconstructed cross-section frozen at the focus filing&apos;s
            event time; the API therefore reports peer filing-clock dispersion.
          </p>

          <div className={styles.formulaCard}>
            <span>Peer-normalized component</span>
            <code>
              z = clip((company change − peer median) / (1.4826 × peer MAD), −3, +3)
            </code>
            <p>
              Each component requires at least eight valid other issuers. If
              median absolute deviation is zero, scale falls back to IQR / 1.349,
              then sample standard deviation. If dispersion is still zero, the
              component is unavailable. Raw changes are not winsorized; clipping
              the normalized z-score limits outlier influence.
            </p>
          </div>

          <div className={styles.templateGrid}>
            <div>
              <h3>Non-financial template</h3>
              <dl className={styles.weights}>
                {nonFinancialComponents.map(([label, weight]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{weight}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <h3>Bank and insurance template</h3>
              <p className={styles.templateNote}>
                Used for the credit-bank and insurance research cohorts.
              </p>
              <dl className={styles.weights}>
                {financialComponents.map(([label, weight]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{weight}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          <p>
            Current and comparable-prior values must both exist. Missing values
            are never replaced with zero, and fixed weights are never silently
            redistributed. Version 1.1 requires every component in the applicable
            template; otherwise the composite Filing Change z is unavailable.
            Each change is recomputed from the current value minus its
            comparable-prior value. A separately supplied change is retained
            only as an audit consistency check.
          </p>

          <div className={styles.gapCard}>
            <div>
              <p className={styles.eyebrow}>Derived disagreement measure</p>
              <h3>EDGAR Evidence Gap</h3>
            </div>
            <code>
              clip(Filing Change z, −3, +3) − clip(20-day standardized response, −3, +3)
            </code>
            <p>
              The range is −6 to +6. Positive means reported filing change was
              stronger than the model-adjusted price response; negative means
              price response was stronger than reported change. The map treats
              an absolute axis value below 0.5 as a neutral band.
            </p>
            <strong>
              Diagnostic only—not valuation, a forecast, a significance test,
              or a trade signal.
            </strong>
          </div>
        </div>
      </section>

      <section id="api" className={styles.section}>
        <div className={styles.number}>06</div>
        <div className={styles.sectionBody}>
          <p className={styles.eyebrow}>Machine-readable research</p>
          <h2>One model definition for people and AI assistants</h2>
          <p>
            The versioned response identifies the security and benchmarks,
            effective dates, observation counts, overlap, return and price
            basis, model coefficients, confidence interval, diagnostics,
            full filing-event path, peer coverage, SEC evidence, explicit
            quality gates, stable SHA-256 fingerprints, calculation definitions,
            and warnings. Missing outputs remain explicit rather
            than being inferred.
          </p>
          <div className={styles.apiLinks}>
            <a href={API_EXAMPLE_URL}>
              View a derived API example
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <a href={SCHEMA_URL}>
              Open the response schema
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <a href={OPENAPI_URL}>
              OpenAPI description
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </div>
          <div className={styles.note}>
            The interactive lab provides a compact, versioned AI context packet,
            tidy raw-decimal CSV, full JSON, and Markdown. An AI assistant should
            preserve dates, units, coverage, equations, uncertainty, provenance,
            and limitations. It should not convert a
            missing coefficient into zero, call the Evidence Gap expected alpha,
            or infer an investment recommendation.
          </div>
        </div>
      </section>

      <section id="limitations" className={styles.section}>
        <div className={styles.number}>07</div>
        <div className={styles.sectionBody}>
          <p className={styles.eyebrow}>Interpretation limits</p>
          <h2>What the lab does not establish</h2>
          <div className={styles.limitGrid}>
            <article>
              <h3>No EDGAR factor beta yet</h3>
              <p>
                Version 1.1 does not publish a historical high-minus-low EDGAR
                factor-return series and does not estimate β<sub>EDGAR</sub>.
                That requires point-in-time scores, historical membership,
                delisted securities, and effective-dated security mapping.
              </p>
            </article>
            <article>
              <h3>Current research universe</h3>
              <p>
                Peer normalization uses the available curated cohort at the
                calculation date. It is not an exhaustive industry index or a
                survivorship-free reconstruction of the investable market, and
                peer filings need not have become public on the same date.
              </p>
            </article>
            <article>
              <h3>Model uncertainty remains</h3>
              <p>
                HAC inference addresses certain residual variance and serial
                correlation patterns; it does not repair omitted variables,
                structural breaks, stale prices, non-synchronous trading, or an
                unsuitable benchmark.
              </p>
            </article>
            <article>
              <h3>Filing dates are imperfect event times</h3>
              <p>
                SEC acceptance timestamps govern session alignment when they
                are available, but daily returns cannot isolate the intraday
                response from earnings calls, guidance, macro news, or other
                information arriving during the event window.
              </p>
            </article>
            <article>
              <h3>Observed sessions are a proxy</h3>
              <p>
                Session sequences are inferred from observed SPY dates rather
                than a separately licensed official exchange calendar. Missing
                expected company or benchmark intervals withhold the affected
                event horizon.
              </p>
            </article>
            <article>
              <h3>Sector proxies are approximations</h3>
              <p>
                A traded sector benchmark can differ from a company&apos;s actual
                revenue mix, geography, capital structure, or economic peers.
                Independent sensitivity remains conditional on that choice.
              </p>
            </article>
            <article>
              <h3>Historical association is not causality</h3>
              <p>
                Betas, abnormal returns, peer z-scores, and the Evidence Gap are
                descriptive research outputs. None establishes mispricing,
                expected return, financial strength, or future performance.
              </p>
            </article>
          </div>
        </div>
      </section>

      <footer className={styles.footerCta}>
        <div>
          <p className={styles.eyebrow}>Run the research</p>
          <h2>Take the methodology into the Market workspace.</h2>
          <p>
            Choose a covered company and inspect the estimate, evidence, and
            warnings together.
          </p>
        </div>
        <Link href="/market?tab=factors">
          Open Factor Lab
          <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      </footer>
    </article>
  );
}
