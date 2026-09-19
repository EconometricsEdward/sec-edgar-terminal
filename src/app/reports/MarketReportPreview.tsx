import { ArrowUpRight } from "lucide-react";
import type { ReportDocument } from "../../utils/reportTypes";
import s from "./marketReportPreview.module.css";

const number = (value: number | null | undefined, digits = 0) => value == null || !Number.isFinite(value) ? "Unavailable" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const percent = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? "Unavailable" : `${number(value, digits)}%`;
const signed = (value: number | null | undefined, suffix: string) => value == null || !Number.isFinite(value) ? "Unavailable" : `${value > 0 ? "+" : ""}${number(value, 1)}${suffix}`;

export default function MarketReportPreview({ report }: { report: ReportDocument }) {
  const market = report.marketBriefing;
  if (!market) return null;
  const growth = market.breadth.find(item => item.id === "revenue-growth") || market.breadth[0];
  const leaders = market.growthLeaders;
  const positioning = market.positioning;
  const covered = market.coverage;
  const marketLink = `/market?basis=${report.period.basis === "annual" ? "annual" : "ttm"}`;
  return <div className={s.edition}>
    <nav className={s.navigation} aria-label="Market report sections">
      <a href="#report-market-briefing">Market Briefing</a>
      <a href="#report-cftc-positioning">CFTC Positioning</a>
      <a href="#report-sector-performance">Sector Performance</a>
      <a href={marketLink}>Open Market page <ArrowUpRight size={14} aria-hidden="true" /></a>
    </nav>
    <div className={s.universe} aria-label="Report market universe">
      <span>Market universe <small>Snapshot {covered.snapshotAt?.slice(0, 16).replace("T", " ")} UTC</small></span>
      <span><b>{number(covered.companyCount)}</b> companies</span>
      <span><b>{number(covered.sectorCount)}</b> sectors</span>
      <span><b>{number(covered.industryCount)}</b> industries</span>
    </div>
    <section id="report-market-briefing" className={s.briefing} aria-labelledby="report-briefing-heading">
      <div className={s.readout}>
        <p className={s.kicker}>01 / Market Briefing <span>{report.period.basis?.toUpperCase()} · SEC</span></p>
        <h3 id="report-briefing-heading">{growth?.share == null ? "The business picture, sector by sector." : <>{percent(growth.share * 100, 0)} of companies<br />grew revenue.</>}</h3>
        <p>Business conditions across {number(covered.companyCount)} reported issuers. Read the breadth of growth alongside profitability, cash generation and differences between sectors.</p>
        <div className={s.dispersion}>
          <div><span>Revenue growth · sector medians</span><b>{leaders.spreadPp == null ? "Spread unavailable" : `${number(leaders.spreadPp, 1)} pp spread`}</b></div>
          <div className={s.extremes}>{[{ item: leaders.highest, label: "Highest" }, { item: leaders.lowest, label: "Lowest" }].map(({ item, label }) => <div key={label}><small>{label}</small><strong>{item?.sector || "Unavailable"}</strong><b>{percent(item?.value)}</b><small>{item ? `${number(item.count)} / ${number(item.companies)} companies with data` : "Comparable sector data unavailable"}</small></div>)}</div>
        </div>
      </div>
      <div className={s.breadth}>
        <p className={s.kicker}>How broad is the strength?</p>
        <p className={s.caption}>Share of companies with an available observation</p>
        {market.breadth.map((item, index) => <div key={item.id} className={s.breadthRow} data-tone={index}>
          <div><span>{item.label}</span><b>{percent(item.share == null ? null : item.share * 100, 0)}</b></div>
          <div className={s.breadthTrack} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, (item.share ?? 0) * 100))}%` }} /></div>
          <small>{number(item.positive)} / {number(item.count)} available · {item.context}</small>
        </div>)}
        <p className={s.caption}>Reported business outcomes, with each measure’s own denominator. Financial periods can differ across companies.</p>
      </div>
    </section>
    <section id="report-cftc-positioning" className={s.section} aria-labelledby="report-positioning-heading">
      <div className={s.heading}><div><p className={s.kicker}>02 / CFTC Positioning</p><h3 id="report-positioning-heading">Six windows into the macro market.</h3><p>Rates, currencies, equity indices and real assets through reported futures positions.</p></div><span>{positioning.availableCount} / 6 available</span></div>
      <div className={s.reportDates}>{positioning.families.map(family => <span key={family.family}><b>{family.label}</b> · {family.reportDate || "Unavailable"}{family.aged || family.stale ? " · Preserved or older snapshot" : family.valid ? " · Futures only" : ""}</span>)}</div>
      <div className={s.positionCards}>{positioning.cards.map(card => {
        const width = Math.min(50, Math.abs(card.netPctOi ?? 0) / 2);
        return <article key={card.id} className={s.positionCard} data-tone={card.netPctOi != null && card.netPctOi < 0 ? "short" : "long"}>
          <div><span>{card.category}</span><small>{card.lens}</small></div>
          <h4>{card.label}</h4><p>{card.groupLabel} · {card.familyLabel}</p>
          <strong>{signed(card.netPctOi, "%")}</strong><small>net / open interest</small>
          <div className={s.positionTrack} aria-hidden="true"><i style={{ width: `${width}%`, left: `${(card.netPctOi ?? 0) < 0 ? 50 - width : 50}%` }} /><span /></div>
          <div className={s.change}><b>{signed(card.weeklyChange, " pp")}</b><span>one-week change</span></div>
          <time dateTime={card.reportDate || undefined}>{card.reportDate || "Report date unavailable"}</time>
        </article>;
      })}</div>
      {positioning.largestMove && <p className={s.spotlight}><span>Largest weekly shift in this selection</span><b>{positioning.largestMove.label} · {signed(positioning.largestMove.weeklyChange, " pp")}</b><small>{positioning.largestMove.description} Among {positioning.comparableCount} comparable observations.</small></p>}
      <p className={s.caption}>Each bar uses the same −100% to +100% scale. Teal indicates net long; gold indicates net short. Changes are percentage points of a contract’s own open interest. Separate report dates and trader groups remain visible in both downloads.</p>
    </section>
    <section id="report-sector-performance" className={s.section} aria-labelledby="report-sector-heading">
      <div className={s.heading}><div><p className={s.kicker}>03 / Sector Performance</p><h3 id="report-sector-heading">Find the dispersion.</h3><p>Read across each sector to connect growth, profits, cash generation, investment and capital.</p></div><span>Median · Equal issuer weights</span></div>
      <div className={s.matrix} role="region" aria-label="Report sector financial comparison" tabIndex={0}>
        <table><caption>Sector medians with available observations beneath each value.</caption><thead><tr><th scope="col">Sector</th>{market.sectorMetrics.map(metric => <th key={metric.key} scope="col">{metric.label}</th>)}<th scope="col">Companies</th></tr></thead><tbody>{market.sectors.map(sector => <tr key={sector.id}><th scope="row">{sector.label}<small>{sector.industries.length} industries</small></th>{market.sectorMetrics.map(metric => { const stat = sector.metrics[metric.key]; return <td key={metric.key} data-sign={stat?.median == null ? "missing" : stat.median < 0 ? "negative" : "positive"}><strong>{percent(stat?.median)}</strong><small>{number(stat?.count)} / {number(sector.count)}</small></td>; })}<td>{number(sector.count)}</td></tr>)}</tbody></table>
      </div>
      <div className={s.downloadGuide}><div><b>In the PDF</b><p>Business briefing, CFTC positioning, sector comparisons and a profile of every covered sector.</p></div><div><b>In the Excel workbook</b><p>Matching overview sections, median and mean statistics, industry composition, every covered company and the full available CFTC contract detail.</p></div></div>
      <p className={s.caption}>Sector figures describe reported financial fundamentals. They are not stock-price returns or risk ratings. Missing observations remain unavailable.</p>
    </section>
  </div>;
}
