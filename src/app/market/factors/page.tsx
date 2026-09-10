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
  "/api/v1/factor-universe?basis=ttm";
const SCHEMA_URL = "/schemas/factor-universe-v1.schema.json";
const OPENAPI_URL = "/openapi.json";

export const metadata: Metadata = buildPageMetadata({
  title: "EDGAR Quant Lab — Universe Breadth & Market Research Methodology",
  description:
    "Understand universe-wide SEC breadth, paired dispersion, market exposure, fixed-sample co-movement and filing-response associations, with company econometric drilldowns.",
  path: PAGE_PATH,
});

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  "@id": `${PAGE_URL}#dataset`,
  name: "EDGAR Quant Lab derived market and filing diagnostics",
  description:
    "Derived universe-wide SEC breadth, paired dispersion, market-exposure distributions and fixed-sample pairwise correlations, with source-linked issuer event studies.",
  url: PAGE_URL,
  creator: {
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
  },
  isAccessibleForFree: true,
  keywords: [
    "SEC fundamental breadth",
    "paired fundamental dispersion",
    "market co-movement",
    "market beta",
    "Newey-West HAC",
    "conditional beta",
    "sector sensitivity",
    "SEC filing event study",
    "abnormal return",
    "EDGAR Evidence Gap",
  ],
  measurementTechnique: [
    "Equal-issuer-weight absolute filing-change breadth and paired interquartile dispersion",
    "Fixed-sample rolling pairwise correlation and descriptive Spearman rank association",
    "Ordinary least squares with Newey-West heteroskedasticity- and autocorrelation-consistent covariance",
    "Upside and downside conditional market regressions",
    "Sector-return residualization against a broad-market benchmark",
    "Filing-date event study with model-adjusted cumulative log returns",
    "Leave-one-out peer normalization using median and median absolute deviation",
  ],
  variableMeasured: [
    { "@type": "PropertyValue", name: "SEC fundamental breadth", description: "Share of comparable issuers with an increase, decrease or unchanged filing measure, with metric-specific denominators." },
    { "@type": "PropertyValue", name: "Paired fundamental dispersion", description: "Current versus comparable prior-year interquartile ranges on the same eligible companies." },
    { "@type": "PropertyValue", name: "Return co-movement", description: "Average company-pair correlation over adjacent 63-session windows on a fixed complete issuer set." },
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
            Open the interactive Quant Lab
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
          <span className={styles.version}>Methodology · version 1</span>
        </div>

        <div className={styles.heroGrid}>
          <div>
            <p className={styles.eyebrow}>Econometric research methodology</p>
            <h1>EDGAR Quant Lab</h1>
            <p className={styles.lede}>
              Quantify how fundamentals and return patterns differ across the
              EDGAR Terminal coverage universe. Begin with absolute filing-change
              breadth and dispersion, then investigate market exposure, co-movement
              and individual filing events. Each result carries its sample and dates.
            </p>
          </div>
          <aside className={styles.distinction} aria-label="Three distinct research questions">
            <p>Keep three questions separate</p>
            <dl>
              <div>
                <dt>Fundamental breadth</dt>
                <dd>How widely reported measures are rising or falling.</dd>
              </div>
              <div>
                <dt>Return behavior</dt>
                <dd>Where sensitivities and common return movements concentrate.</dd>
              </div>
              <div>
                <dt>Filing response</dt>
                <dd>How filing changes relate to subsequent model-adjusted responses.</dd>
              </div>
            </dl>
          </aside>
        </div>

        <nav className={styles.sectionLinks} aria-label="Factor methodology sections">
          <a href="#universe-method">Universe methodology</a><a href="#risk-beta">Company model details</a>
          <a href="#conditional-beta">Conditional beta</a>
          <a href="#sector-sensitivity">Sector sensitivity</a>
          <a href="#filing-event">Filing event</a>
          <a href="#evidence-gap">Evidence Gap</a>
          <a href="#api">API & schema</a>
          <a href="#limitations">Limitations</a>
        </nav>
      </header>

      <section id="universe-method" className={styles.section}>
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>The default Quant Lab view</p><h2>A quantitative view of the covered universe</h2></div>
        <div className={styles.sectionBody}>
          <h3>Scope and weighting</h3><p>The Market briefing, sector heatmap, Companies and Quant Lab use the same prepared SEC issuer universe and primary sectors. The first three show current financial levels and year-over-year revenue growth; Quant Lab measures comparable filing changes and market-return diagnostics. Their metric eligibility counts can differ. Optional research themes remain overlapping subsets of the covered universe. Company evidence loads separately when requested.</p><p>Expanded coverage targets approximately 1,500 SEC issuers represented in the published equity holdings of IVV, IJH and IJR, spanning large-, mid- and small-cap companies. Cash, futures, unlisted residual holdings and duplicate rows are excluded. Listed equity exposures include an equity swap underlying when it has no separate physical holding; only its SEC issuer identity is used, never the fund position value. Share classes are deduplicated by CIK; an existing representative ticker is preserved where possible. Every issuer receives equal weight. Fund holdings are a dated research coverage proxy, not certified current S&amp;P index membership or an investable index.</p>
          <p>Expanded aggregate groups use the fund-reported sectors, assigning every issuer exactly once. Legacy snapshots use curated research groups. Original company drilldowns retain their thematic peer cohorts; newly covered issuers use their reported sector. These peer scores are separate from absolute breadth. The coverage section identifies the source, date, targeted issuer count, successful SEC checks and missing issuers.</p>
          <h3>Fundamental breadth: direction and magnitude</h3><p>For each metric, compare the latest annual or trailing-12-month period with its comparable period ending 350–380 days earlier. Both values use information eligible at the current filing cutoff, including revised prior-year comparatives available then. The change is current minus prior, in percentage points. Higher share is 100 × positive changes / issuers with both values. Lower and unchanged shares use that same denominator; missing values are never assigned zero.</p>
          <p>The magnitude is the median of issuer-level changes. Revenue growth acceleration is the difference between two year-over-year growth rates; acceleration can occur while revenue is still falling. Free cash flow is operating cash flow minus purchases of property, plant and equipment. A lower free cash flow margin can reflect greater investment.</p>
          <p>Operating-margin, free-cash-flow-margin and cash/assets breadth exclude financial and property/investment issuers with SIC codes 6000–6799. Revenue growth, net margin and book equity/assets retain all eligible issuer types, with industry context required. Book equity/assets is not regulatory capital.</p>
          <h3>Separate breadth, magnitude and dispersion</h3><p>Net direction balance equals 100 × (higher count − lower count) / paired count. It ranges from −100 to +100 percentage points and is separate from the median issuer change and the change in IQR. Balanced directions can produce a zero balance even when every company changed.</p><p>The default direction band is zero. Optional ±0.5 and ±1 percentage-point bands classify only changes outside the band as higher or lower. Inside-band companies remain in the denominator. Magnitude and dispersion retain all raw paired observations. These sensitivity settings do not define statistical significance or universally meaningful economic materiality.</p>
          <h3>Growth and cash margins on the same companies</h3><p>The nine-cell cash-confirmation table requires comparable growth-acceleration and free-cash-flow-margin changes for the same operating issuers. Its growth and cash higher shares therefore have an identical denominator. Conditional confirmation is both-higher count divided by growth-higher count, with null when no issuer has higher growth. Financial and property/investment issuers are excluded. Every cell is traceable to its constituent companies, and source periods are disclosed.</p>
          <h3>Dispersion and simultaneous declines</h3><p>The interquartile range (IQR) is the 75th percentile minus the 25th percentile, using linear interpolation. Current and prior IQRs use exactly the same paired issuers. A positive difference means the range of reported outcomes widened across those companies relative to their comparable prior periods. The IQR of individual changes instead measures variation in how companies changed.</p>
          <p>Simultaneous declines require slower revenue growth, lower operating margin and lower free cash flow margin in the same operating issuer. Only companies with all three comparisons enter the denominator. This is an investigation screen, not a distress probability.</p>
          <h3>Within-group and between-group dispersion</h3><p>A secondary population-variance decomposition keeps exactly the same eligible issuers and group assignments in both periods. Total variance equals within-group variance plus between-group variance. Within = Σ(n_g / N) × group population variance. Between = Σ(n_g / N) × (group mean − universe mean)². Each issuer has equal weight; groups contribute according to eligible counts. Units are squared percentage points.</p><p>This decomposition is sensitive to extreme observations, so the IQR remains the primary spread measure. Neither IQR nor standard deviation is additive in this formula. A higher component share need not mean a higher absolute component; both periods and absolute changes are supplied. Zero total variance produces null shares. A group with one eligible issuer contributes zero within-group variance.</p>
          <h3>Market exposure and co-movement</h3><p>Universe market models use fully adjusted Yahoo prices and daily log returns over the latest 252 SPY intervals. A model requires at least 240 exact start-and-end interval matches and the same final session. Down-market slopes require at least 30 negative-SPY observations. Sector sensitivity uses the group-matched ETF after removing its fitted SPY component. Newey–West beta coefficient intervals remain in the issuer data. Exposure distributions below 80% coverage are identified as subset results.</p>
          <p>Co-movement is the average Pearson correlation across company pairs. A fixed issuer set must have complete observations and nonzero return variance in every chart window on the latest 126 SPY intervals, with at least 8 issuers and 60% of the selected scope represented. Valid pairs are fixed across all chart windows, excluding pairs with undefined correlations in any window. The comparison uses two adjacent 63-session windows; the rolling chart advances by seven sessions. Correlation is not a portfolio-specific diversification estimate.</p>
          <h3>Filing-response research</h3><p>The universe map places absolute filing-measure change on the horizontal axis and standardized 20-session model-adjusted response on the vertical axis. It does not use a peer z-score on the horizontal axis. The response comes from the issuer event-study method below, and filing dates vary across issuers. Spearman correlations compare filing-change ranks with response ranks, requiring at least 12 paired observations and average ranks for ties.</p>
          <p>These associations are descriptive, unadjusted cross-sections. They do not establish significance, causality, prediction or a realized factor premium. The displayed period can contain earnings releases, guidance and other news. Company drilldowns have selectable calendar-year estimation windows, so their regression samples can differ from the universe’s 252-session models.</p>
          <h3>Freshness and reproducibility</h3><p>Sixteen bounded daily batches check SEC filing histories and prepare adjusted prices, preserving per-issuer checkpoints. Company Facts are reused when the annual/quarterly filing fingerprint is unchanged, with a weekly reconciliation refresh. The original facts-retrieval clock is preserved separately from the filing-history check. Three small fund-holdings downloads update membership weekly and must pass count, sector, date and SEC-identity validation. Existing SEC and price-provider gates coordinate all upstream traffic. A later publication job assembles the prepared data; page requests never start a universe-wide refresh.</p>
          <p>Large snapshots are compressed into immutable cache chunks. Only complete, validated writes switch the published snapshot. At least 95% of target issuers must have a SEC check within 30 hours before the expanded atlas can be published; metric eligibility is disclosed separately. Partial runs retain their checkpoints for the next scheduled batch. Initial production migration uses the same bounded jobs. Prepared snapshots have a 25-hour fresh window and up to seven days of retained data. Incomplete refreshes cannot replace a materially fuller retained result within that period. Original source dates remain visible. If no aggregate exists, the endpoint can calculate real SEC-only breadth from the cached atlas, explicitly withholding price results. Historical observations begin with actual saved calculations and are not reconstructed backtests. A membership change starts a new history segment; growth in coverage must not be interpreted as stronger market fundamentals. Additive diagnostics can be recalculated from cached issuer rows while preserving the original source and calculation clocks; this requires no additional SEC or price request.</p>
          <p><a href="/api/v1/factor-universe?basis=ttm">Universe API</a> · <a href="/schemas/factor-universe-v1.schema.json">Universe JSON Schema</a> · <a href="/api/v1/market-signals?ticker=MSFT&amp;window=3y&amp;basis=ttm">Company API example</a></p>
        </div>
      </section>

      <section className={styles.intro} aria-labelledby="reading-results-heading">
        <div><p className={styles.eyebrow}>Reading your results</p><h2 id="reading-results-heading">Sensitivity, uncertainty, and business change answer different questions</h2>
          <p>Beta describes a historical relationship with SPY. A beta of 1.2 associates a small 1% market move with approximately 1.2% from the market component. The rest of the stock’s return comes from other influences. A low beta can coexist with high total risk.</p>
          <p>The 95% beta interval describes sampling uncertainty in that slope. An interval that includes one does not clearly establish different sensitivity from SPY; an interval that includes zero leaves direction uncertain. The interval is not a range for future stock returns.</p>
          <p>R² describes the share of historical daily return variation captured by the model. It is not forecast accuracy. The page shows actual interval width, matched observations, and coverage instead of combining them into an uncalibrated reliability score.</p>
        </div>
        <div><h3>Peer strength can still mean an absolute decline</h3>
          <p>A margin that fell from 10% to 8% declined by 2 percentage points. If peers declined more, its peer score may be positive. Read the current and prior reported values before concluding that business conditions improved.</p>
          <p>The Evidence Gap subtracts two separately scaled measures. It is not a statistical z score; zero can represent two positive or two negative inputs. Event response scores are descriptive residual-scale units, without a calibrated event significance test.</p>
          <p>The scenario translator uses 100 × [exp(beta × log(1 + shock/100)) − 1] to convert the fitted log-return relationship to percentage returns. Its bounds transform the beta interval and exclude the intercept and residual movement.</p>
          <p>Each interactive metric includes a definition, a result-specific interpretation, and a limitation. The same text is supplied in the optional API reading_guide and downloadable research notes. <a href="https://www.statsmodels.org/stable/generated/statsmodels.stats.sandwich_covariance.cov_hac.html">Newey–West inference reference</a> · <a href="https://www.statsmodels.org/stable/generated/statsmodels.regression.linear_model.OLSResults.rsquared.html">R² definition</a>.</p>
        </div>
      </section>

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
          <p>The universe uncertainty audit groups individual 95% HAC slope intervals into entirely above one, positive and entirely below one, entirely below zero, including zero, positive and including one, or unavailable. Intervals touching zero enter the zero group before testing one. Missing, nonfinite, reversed, or point-excluding intervals are unavailable. Groups partition all issuers in the selected scope; these individual intervals have no multiple-comparison adjustment and are not predictive return ranges.</p>
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
          <div className={styles.equation} aria-label="Security return equals alpha plus market beta times market return plus an error">
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
          <div className={styles.equation} aria-label="Conditional beta asymmetry equals downside beta minus upside beta">
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
          <div className={styles.equationStack}>
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
          <div className={styles.equationStack}>
            <code>ARₜ = rᵢ,ₜ − r̂ᵢ,ₜ</code>
            <code>CARₕ = exp(Σ ARₜ) − 1, for h = 1, 5, or 20 sessions</code>
            <code>Standardized responseₕ = Σ ARₜ / (σ residual × √h)</code>
          </div>
          <p>
            The Filing–Market Map uses the 20-session standardized response.
            Standardization makes responses more comparable across securities
            with different residual volatility; it is not a p-value. The event
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
            redistributed. Version 1 requires every component in the applicable
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
            The universe response supplies absolute breadth, paired dispersion,
            market-exposure distributions, co-movement, issuer observations,
            definitions and source dates. The separate company endpoint adds
            detailed coefficients, confidence intervals, event windows and peer
            evidence. Both preserve missing values, sample limits and methodology versions.
          </p>
          <div className={styles.apiLinks}>
            <a href={API_EXAMPLE_URL}>
              View the universe API example
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <a href={SCHEMA_URL}>
              Open the universe response schema
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <a href={OPENAPI_URL}>
              OpenAPI description
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </div>
          <div className={styles.note}>
            An AI assistant should preserve dates, units, coverage, equations,
            uncertainty, provenance, and limitations. It should not convert a
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
                Version 1 does not publish a historical high-minus-low EDGAR
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
          Open Quant Lab
          <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      </footer>
    </article>
  );
}
