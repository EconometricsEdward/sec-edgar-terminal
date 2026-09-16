import Link from "next/link";
import { unstable_cache } from "next/cache";
import { buildPageMetadata } from "../../../../utils/siteMetadata";
import { isCftcEnabled } from "../../../../utils/cftcFeature.js";
import { readPreparedDemoCftcChanges } from "../../../../utils/portfolioCftcPreparation.js";
import universe from "../../../../../public/portfolio/portfolio-demo-100-universe.json";
import s from "./changes.module.css";

export const runtime = "nodejs";
export const revalidate = 60;
export const maxDuration = 15;
export const metadata = buildPageMetadata({
  title: "What Changed — S&P 500 Top 100 Research Demo",
  description: "Recent SEC-linked CFTC market changes for the Research Hub’s 100-company demo, with company coverage, observation dates, calculations and original sources.",
  path: "/workspace/demo/changes",
});

type CompanyCheck = { ticker: string; cik: string; status: string; checkedAt?: string };
type Filing = { form: string; filed: string; reportDate?: string; url: string; text?: string };
type RelatedCompany = { ticker: string; candidate?: { reason?: string; filing?: Filing; evidence?: Filing[] } };
type MarketEvent = {
  id: string; reportDate: string; priorDate: string; title: string; description: string;
  netPctChange: number; openInterestChangePct: number; traderGroupLabel: string;
  marketPath: string; cftcSource: string; relatedCompanies: RelatedCompany[];
  latestReportDate?: string; retrievedAt?: string; sourceCurrency?: string; historyStatus?: string;
};
type PreparedChanges = {
  generatedAt: string; cutoff: string; events: MarketEvent[]; companyChecks: CompanyCheck[];
  coverage: { checked: number; linked: number; noLink: number; noFiling: number; unavailable: number;
    uniqueMarkets: number; marketsChecked: number; marketUnavailable: number; staleMarkets: number; partialMarkets: number };
  methodology: string; limitation: string;
  preparation: { status: string; checkedAt: string; nextCheckAt: string; totalCompanies: number; completedCompanies: number };
};

// The shared cache stores a projection of public prepared research, never user
// portfolio state. Revalidating it only reads storage; it cannot fetch sources.
const readPublicSnapshot = unstable_cache(
  async () => await readPreparedDemoCftcChanges({ days: 30, signal: AbortSignal.timeout(8_000) }) as PreparedChanges | null,
  ["public-demo-cftc-changes-v1"], { revalidate: 60 },
);

function date(value?: string, includeTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short" } as const : {}) }).format(new Date(value));
}
function signed(value: number) {
  return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}` : "Unavailable";
}
function checkLabel(status?: string) {
  if (status === "linked") return "Candidate connection found";
  if (status === "no_matches") return "Checked · no supported connection";
  if (status === "no_filing") return "Checked · annual filing unavailable";
  if (status === "unavailable") return "Check incomplete · retry needed";
  return "Not yet checked";
}

export default async function DemoChangesPage() {
  const enabled = isCftcEnabled();
  const snapshot = enabled ? await readPublicSnapshot().catch(() => null) : null;
  const events = snapshot?.events.slice(0, 20) || [];
  const checks = new Map((snapshot?.companyChecks || []).map(check => [check.ticker, check]));
  const total = universe.companies.length;
  const checked = snapshot?.coverage.checked || 0;
  const stale = snapshot?.preparation.status === "stale";
  const incomplete = snapshot && (checked < total || snapshot.coverage.marketUnavailable > 0 || snapshot.coverage.partialMarkets > 0);

  return (
    <article className={s.page}>
      <header className={s.header}>
        <Link href="/workspace/demo?portfolioTab=changes" prefetch={false} className={s.back}>← Interactive Research Hub demo</Link>
        <p className={s.eyebrow}>Public research brief · 100-company demo</p>
        <h1>What changed?</h1>
        <p className={s.lead}>Recent changes in futures-market positioning, connected to companies through SEC filing evidence.</p>
        <div className={s.links}>
          <a href="#recent-changes">Recent changes</a>
          <a href="#coverage">Company coverage</a>
          <a href="#methodology">Sources &amp; methodology</a>
          <a href="/api/v1/cftc/portfolio-changes/demo?days=30">Structured research (JSON)</a>
        </div>
      </header>

      <div className={s.scope}>
        <p><strong>CFTC market context, linked by SEC evidence.</strong> These are aggregate futures positions, not the companies’ own trades or measured exposures. The interactive Hub also contains SEC filing changes and comparisons with your saved research.</p>
        <p>The company list uses the 100 largest issuers in the demo’s stored IVV holdings, dated <time dateTime={universe.source.asOf}>{date(universe.source.asOf)}</time>. It is a dated S&amp;P 500 coverage proxy, not a live index-membership claim.</p>
      </div>

      {snapshot ? (
        <>
          <div className={s.status} data-preparation-status={snapshot.preparation.status}>
            <span className={stale || incomplete ? s.warning : s.ready}>{stale ? "Refresh due" : incomplete ? "Partial coverage" : "Prepared research"}</span>
            <p>Prepared <time dateTime={snapshot.preparation.checkedAt}>{date(snapshot.preparation.checkedAt, true)}</time>.
              {stale ? " Showing the last available prepared results; newer findings may be missing." : " Report dates below identify when positions were observed."}
              {incomplete ? " Some company or market checks are incomplete; an absent event does not establish that nothing changed." : ""}
            </p>
          </div>
          <dl className={s.metrics}>
            <div><dt>Company checks completed</dt><dd>{checked}<span> / {total}</span></dd></div>
            <div><dt>Companies with candidates</dt><dd>{snapshot.coverage.linked}</dd></div>
            <div><dt>Shared markets checked</dt><dd>{snapshot.coverage.marketsChecked}<span> / {snapshot.coverage.uniqueMarkets}</span></dd></div>
            <div><dt>Qualifying weekly changes</dt><dd>{snapshot.events.length}</dd></div>
          </dl>
        </>
      ) : (
        <div className={s.empty} role="status">
          <h2>{enabled ? "Prepared research is not yet available" : "CFTC research is currently disabled"}</h2>
          <p>{enabled ? "Company and market results are prepared separately from page visits. Coverage and findings will appear here when a prepared snapshot is available." : "This page is not reporting CFTC findings while the feature is disabled."} This is not evidence that there were no market changes.</p>
        </div>
      )}

      <section id="recent-changes" className={s.section}>
        <div className={s.sectionHeading}>
          <div><p className={s.eyebrow}>SEC-linked CFTC observations</p><h2>Recent market changes</h2></div>
          {snapshot && <p>From <time dateTime={snapshot.cutoff}>{date(snapshot.cutoff)}</time><br />through {date(snapshot.generatedAt)}</p>}
        </div>
        {events.length ? (
          <ol className={s.events}>
            {events.map(event => (
              <li key={event.id}>
                <article className={s.event}>
                  <div className={s.eventTop}><time dateTime={event.reportDate}>{date(event.reportDate)}</time><span>{event.traderGroupLabel} · Futures only</span></div>
                  <h3><Link href={event.marketPath} prefetch={false}>{event.title}</Link></h3>
                  <p>{event.description}</p>
                  <dl className={s.eventMetrics}>
                    <div><dt>Net share of open interest</dt><dd>{signed(event.netPctChange)} percentage points</dd></div>
                    <div><dt>Total contract open interest</dt><dd>{signed(event.openInterestChangePct)}%</dd></div>
                  </dl>
                  <p className={s.small}>Compared with <time dateTime={event.priorDate}>{date(event.priorDate)}</time>, exactly seven days earlier. These are position observation dates; release times have not been verified.</p>
                  {(event.sourceCurrency === "aged" || event.historyStatus === "stale" || event.historyStatus === "partial") && <p className={s.warning}>Source history is {event.historyStatus === "partial" ? "partial" : "stale"}; later observations may be missing. Latest available report: {date(event.latestReportDate)}.</p>}
                  <div className={s.companyLinks}><span>Candidate connections:</span>{event.relatedCompanies.map(company => <Link key={company.ticker} href={`/analysis/${company.ticker}`} prefetch={false}>{company.ticker}</Link>)}</div>
                  <details className={s.evidence}>
                    <summary>SEC evidence for these candidate connections</summary>
                    {event.relatedCompanies.slice(0, 3).map(company => {
                      const filing = company.candidate?.filing || company.candidate?.evidence?.[0];
                      return filing ? <div key={company.ticker}>
                        <p><strong>{company.ticker}</strong> · <a href={filing.url}>{filing.form} filed {date(filing.filed)}</a></p>
                        <p>{company.candidate?.reason}</p>
                        {filing.text && <blockquote>{filing.text.length > 350 ? `${filing.text.slice(0, 350)}…` : filing.text}</blockquote>}
                      </div> : null;
                    })}
                    {event.relatedCompanies.length > 3 && <p className={s.small}>Additional company evidence is available in the structured research linked above.</p>}
                  </details>
                  <div className={s.sourceLine}><a href={event.cftcSource}>Original CFTC dataset</a><Link href={event.marketPath} prefetch={false}>Inspect this market →</Link>{event.retrievedAt && <span>Retrieved {date(event.retrievedAt, true)}</span>}</div>
                </article>
              </li>
            ))}
          </ol>
        ) : <p className={s.empty}>{snapshot ? "No qualifying weekly changes are present in this prepared window. Check company and market coverage before interpreting an empty result." : "No prepared events are available to display."}</p>}
        {snapshot && snapshot.events.length > events.length && <p className={s.small}>Showing the {events.length} most recent of {snapshot.events.length} qualifying changes. The structured research contains all prepared events for this window.</p>}
      </section>

      <section id="coverage" className={s.section}>
        <h2>Coverage is part of the finding</h2>
        <p>A completed check may find a candidate connection, no supported connection, or no accessible annual filing. A failed check remains incomplete. A candidate connection does not establish the size, direction or materiality of a company’s exposure.</p>
        {snapshot && <p>{snapshot.coverage.noLink} checked without a supported connection · {snapshot.coverage.noFiling} without an accessible annual filing · {snapshot.coverage.unavailable} incomplete company checks. Market histories: {snapshot.coverage.marketUnavailable} unavailable, {snapshot.coverage.partialMarkets} partial, {snapshot.coverage.staleMarkets} stale.</p>}
        <details className={s.coverageDetails}>
          <summary>Company-by-company coverage · {checked} of {total} checks completed</summary>
          <div className={s.tableWrap}>
            <table>
              <caption>The same source-dated company list used across the Research Hub demo.</caption>
              <thead><tr><th scope="col">Company</th><th scope="col">Connection check</th><th scope="col">Checked</th><th scope="col">SEC research</th></tr></thead>
              <tbody>{universe.companies.map(company => {
                const check = checks.get(company.ticker);
                return <tr key={company.cik}>
                  <th scope="row"><Link href={`/analysis/${company.ticker}`} prefetch={false}>{company.ticker}</Link><span>{company.name}</span></th>
                  <td>{checkLabel(check?.status)}</td>
                  <td>{check?.checkedAt ? <time dateTime={check.checkedAt}>{date(check.checkedAt)}</time> : "—"}</td>
                  <td><Link href={`/filings/${company.ticker}`} prefetch={false}>Filings</Link></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </details>
      </section>

      <section id="methodology" className={s.section}>
        <h2>Sources &amp; methodology</h2>
        <p>{snapshot?.methodology || "Weekly comparisons require the same contract, futures-only report family and trader category exactly seven calendar days apart. Changes qualify when net share of total open interest moves by at least 1 percentage point or total contract open interest changes by at least 5%. These display thresholds are not statistical significance tests."}</p>
        <p>{snapshot?.limitation || "Connections come from candidate passages in the latest accessible annual SEC filing. CFTC observations describe aggregate futures-market positioning, not an individual company’s positions, hedge size, cash flows or expected stock-price direction."}</p>
        <div className={s.links}>
          <a href="https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm">CFTC report guidance</a>
          <a href="/portfolio/portfolio-demo-100-universe.json">Dated company universe</a>
          <a href={universe.source.url}>IVV holdings source</a>
          <Link href="/workspace/demo?portfolioTab=changes" prefetch={false}>Open the complete interactive workspace →</Link>
        </div>
      </section>
    </article>
  );
}
