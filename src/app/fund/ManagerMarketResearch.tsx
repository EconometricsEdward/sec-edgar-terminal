import { cache } from "react";
import Link from "next/link";
import { thirteenFReviewStore } from "../../utils/thirteenFReviewStore.js";
import { createPublic13FReviewReader, public13FReview } from "../../utils/thirteenFPublicReview.js";
import { isCftcEnabled } from "../../utils/cftcFeature.js";
import s from "./ManagerMarketResearch.module.css";

// One read of the same saved publication used by the interactive workspace.
// Missing publications and transport failures never start background research.
const readPublication = cache(createPublic13FReviewReader({
  read: (selection, options) => thirteenFReviewStore.snapshot(selection, options),
}));

const number = (value: number | null) => value === null ? "Not available" : value.toLocaleString("en-US");
const percent = (value: number | null) => value === null ? "Not available" : `${value.toFixed(2)}%`;
function ResearchDate({ value, withTime = false }: { value: string | null; withTime?: boolean }) {
  if (!value) return <>Not available</>;
  return <time dateTime={value}>{new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short" } as const : {}),
  }).format(new Date(value))}</time>;
}

export function ManagerMarketResearchContent({ model, briefPeriod = "" }: { model: NonNullable<ReturnType<typeof public13FReview>>; briefPeriod?: string }) {
  const coverage = model.coverage;
  const finished = ["complete", "complete_with_gaps"].includes(model.state);
  return <section className={s.section} aria-labelledby="saved-manager-connections" data-publication-version={model.publicationVersion}>
    <header className={s.header}><div><p className={s.eyebrow}>SEC issuer disclosures · Saved research</p><h2 id="saved-manager-connections">The markets behind the reported holdings</h2></div><Link href={model.interactiveUrl} prefetch={false}>Explore market connections →</Link></header>
    <p className={s.scope}>Company filing passages connect disclosed holdings to supported futures benchmarks. These are research connections, not measured economic exposures or the manager’s own futures positions.</p>
    {briefPeriod && briefPeriod !== model.period && <p className={s.note}><strong>Different saved quarter.</strong> This market review covers <ResearchDate value={model.period} />; the holdings brief above covers <ResearchDate value={briefPeriod} />. The two reports are kept separate.</p>}
    <dl className={s.metrics}>
      <div><dt>Portfolio reviewed</dt><dd><ResearchDate value={model.period} /></dd></div>
      <div><dt>Issuer filings checked</dt><dd>{number(coverage.checked)} <small>/ {number(coverage.total)} holdings</small></dd></div>
      <div><dt>Holdings with connections</dt><dd>{number(coverage.linked)} <small>/ {number(coverage.total)}</small></dd></div>
      <div><dt>Associated reported value</dt><dd>{percent(coverage.linkedSharePct)}</dd></div>
    </dl>
    <p className={s.freshness}><strong>{finished ? "Published review" : "Review in progress"}</strong> · Published <ResearchDate value={model.publishedAt} withTime />.{model.checkedAt && <> 13F source checked <ResearchDate value={model.checkedAt} withTime />.</>}</p>
    {!finished && <p className={s.note}>This publication contains the results saved so far. {number(coverage.unchecked)} holdings have no saved review yet; incomplete checks remain separate from findings that have source evidence.</p>}
    {!!coverage.stale && <p className={s.note}>{number(coverage.stale)} saved holding reviews await an updated source check. Previously supported connections may be retained while a refresh runs.</p>}
    {model.markets.length ? <div className={s.tableWrap}><table>
      <caption>Supported market connections across the published review. A holding may appear in several markets; the shares below must not be added together.</caption>
      <thead><tr><th scope="col">Futures benchmark</th><th scope="col">Connected holdings</th><th scope="col">Share of full reported value</th></tr></thead>
      <tbody>{model.markets.map(market => <tr key={market.key}><th scope="row">{market.label}</th><td>{number(market.count)}</td><td>{percent(market.sharePct)}</td></tr>)}</tbody>
    </table></div> : <p className={s.note}>No supported market connection is present in this saved publication. Missing or unfinished research does not establish that the holdings have no market exposure.</p>}
    <p className={s.note}>{model.denominatorUsd === null ? "Percentage shares are withheld because complete reported holdings value is unavailable." : <>All shares use the full reconciled 13F value of {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(model.denominatorUsd)}, including holdings not yet reviewed. The overview counts each connected holding once.</>} Option values describe underlying securities, not premiums or net directional exposure.</p>
    {model.examples.length > 0 && <div className={s.sources}><h3>Examples from the saved issuer evidence</h3><p>Up to three examples from the first 50 holdings in the published review. Issuer filing dates are separate from the 13F portfolio date.</p><div className={s.exampleGrid}>{model.examples.map(example => <article key={example.key}><h4>{example.name}</h4><p>{example.markets.map(market => `${market.label} · ${market.fit}`).join("; ")}</p><ul>{example.sources.map(source => <li key={source.url}><a href={source.url}>{source.form} · filed <ResearchDate value={source.filed} /> ↗</a><span>Issuer reporting period <ResearchDate value={source.reportDate} /></span></li>)}</ul><small>Evidence checked <ResearchDate value={example.checkedAt} withTime />{example.stale ? " · Update pending" : ""}</small></article>)}</div></div>}
    <details className={s.coverage}><summary>Coverage and interpretation</summary><p>{number(coverage.reviewed)} of {number(coverage.total)} holdings have completed an attempt in the current review cycle. Completed attempts can include unavailable sources or unresolved issuer identities.</p><p>Unresolved issuer identities: {number(coverage.unresolved)}. Unavailable checks: {number(coverage.unavailable)}. Partial checks: {number(coverage.partial)}. These categories describe the review and should not be summed as a separate portfolio total.</p><p>Named references and research proxies remain distinct in the underlying evidence. A proxy does not establish exposure to the contract’s grade, geography, maturity or currency. The filing search is bounded and may miss other passages.</p><p><a href={model.jsonUrl}>Published market review (JSON)</a></p></details>
  </section>;
}

export default async function ManagerMarketResearch({ cik, period = "", briefPeriod = "" }: { cik: string; period?: string; briefPeriod?: string }) {
  if (!isCftcEnabled()) return null;
  const model = await readPublication(cik, period).catch(() => null);
  return model ? <ManagerMarketResearchContent model={model} briefPeriod={briefPeriod} /> : null;
}
