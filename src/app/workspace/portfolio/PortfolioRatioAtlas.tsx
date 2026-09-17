"use client";

import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUpRight, CircleHelp, Fingerprint, MoveHorizontal } from "lucide-react";
import { buildPortfolioRatioAtlas } from "../../../utils/portfolioRatioAtlas.js";
import s from "./PortfolioRatioAtlas.module.css";

type Props = {
  catalogReport: any;
  profile: any;
  requestedMetric: string;
  onRequestedMetric: (id: string) => void;
  onInspectCompany: (rowId: string) => void;
  onOpenHoldings?: () => void;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const valueLabel = (value: unknown, unit: string) => finite(value) ? `${number(value)}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}` : "Unavailable";
const periodLabel = (period: any) => {
  if (!period?.end) return "Reporting dates unavailable";
  return period.start ? `${period.start} → ${period.end}` : `As of ${period.end}`;
};
const basisLabel = (basis: string) => ({ annual: "Annual", quarter: "Quarterly", ytd: "Fiscal year to date", ttm: "Trailing twelve months", instant: "Balance-sheet date" }[basis] || basis || "Reported period");

export default function PortfolioRatioAtlas({ catalogReport, profile, requestedMetric, onRequestedMetric, onInspectCompany, onOpenHoldings }: Props) {
  const id = useId();
  const atlas = useMemo(() => buildPortfolioRatioAtlas(catalogReport, { profile }), [catalogReport, profile]);
  const [selectedCik, setSelectedCik] = useState<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailRef = useRef<HTMLElement>(null);
  const category = atlas.categories.find((entry: any) => entry.metricIds.includes(requestedMetric)) || atlas.categories[0];
  const metric = category?.metrics.find((entry: any) => entry.id === requestedMetric) || category?.metrics[0];
  const company = atlas.companies.find((entry: any) => entry.cik === selectedCik) || atlas.companies[0];
  const cell = company?.cells[metric?.id];
  const requestedOutsideAtlas = requestedMetric && !atlas.metrics.some((entry: any) => entry.id === requestedMetric);
  const requestedLabel = catalogReport.metrics?.find((entry: any) => entry.id === requestedMetric)?.label || requestedMetric;
  const activeRow = atlas.companies.findIndex((entry: any) => entry.cik === company?.cik);
  const activeColumn = category?.metrics.findIndex((entry: any) => entry.id === metric?.id) ?? 0;

  function chooseCell(cik: string, metricId: string, focus = false) {
    setSelectedCik(cik);
    onRequestedMetric(metricId);
    if (focus) {
      const element = cellRefs.current.get(`${cik}:${metricId}`);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function moveCell(event: KeyboardEvent<HTMLButtonElement>, row: number, column: number) {
    let nextRow = row, nextColumn = column;
    if (event.key === "ArrowDown") nextRow++;
    else if (event.key === "ArrowUp") nextRow--;
    else if (event.key === "ArrowRight") nextColumn++;
    else if (event.key === "ArrowLeft") nextColumn--;
    else if (event.key === "Home") { nextColumn = 0; if (event.ctrlKey || event.metaKey) nextRow = 0; }
    else if (event.key === "End") { nextColumn = category.metrics.length - 1; if (event.ctrlKey || event.metaKey) nextRow = atlas.companies.length - 1; }
    else return;
    event.preventDefault();
    nextRow = Math.max(0, Math.min(atlas.companies.length - 1, nextRow));
    nextColumn = Math.max(0, Math.min(category.metrics.length - 1, nextColumn));
    chooseCell(atlas.companies[nextRow].cik, category.metrics[nextColumn].id, true);
  }

  if (!category || !company || !metric) return <p className={s.empty}>Company ratios become available when compatible financial evidence is present. Your holdings remain available in Holdings.</p>;

  return (
    <div className={s.atlas}>
      <header className={s.intro}>
        <div><p className={s.eyebrow}><Fingerprint size={15} aria-hidden="true" /> The ratio map</p><h3>One portfolio. Many financial characters.</h3><p>Read across a company’s ratios, or down a measure to explore your holdings. Select any value to reveal the calculation and evidence.</p></div>
        <div className={s.scopeStats}><strong>{atlas.companyCount}<span>companies</span></strong><i aria-hidden="true" /><strong>{atlas.metrics.length}<span>ratios &amp; growth measures</span></strong></div>
      </header>

      {requestedOutsideAtlas ? <aside className={s.requestNotice}><CircleHelp size={17} aria-hidden="true" /><p><strong>{requestedLabel}</strong> is outside this ratio map. Explore statement amounts and other measures in Holdings, or choose a ratio below.</p>{onOpenHoldings ? <button type="button" onClick={onOpenHoldings}>Open Holdings <ArrowUpRight size={14} aria-hidden="true" /></button> : null}</aside> : null}

      <nav className={s.families} aria-label="Ratio families">
        {atlas.categories.map((entry: any, index: number) => (
          <button key={entry.id} type="button" aria-pressed={category.id === entry.id} onClick={() => onRequestedMetric(entry.metrics[0].id)}>
            <span className={s.familyMark} aria-hidden="true"><i style={{ height: `${30 + index * 8}%` }} /><i style={{ height: `${80 - index * 7}%` }} /><i style={{ height: `${45 + index * 5}%` }} /></span>
            <span>{entry.label}<small>{entry.metrics.length} {entry.metrics.length === 1 ? "measure" : "measures"}</small></span>
          </button>
        ))}
      </nav>

      <section className={s.map} aria-labelledby={`${id}-map-title`}>
        <div className={s.mapHeader}>
          <div><p className={s.eyebrow}>Explore a financial dimension</p><h4 id={`${id}-map-title`}>{category.label}</h4><p>{category.description}</p></div>
          <label className={s.companyJump}>Follow a company<select value={company.cik} onChange={(event) => chooseCell(event.target.value, metric.id, true)}>{atlas.companies.map((entry: any) => <option key={entry.cik} value={entry.cik}>{entry.ticker || entry.name} · {entry.name}</option>)}</select></label>
        </div>
        <div className={s.mapGuide} id={`${id}-map-help`}>
          <span className={s.legend}><i aria-hidden="true" /> Lower → higher within each ratio’s same-period peer range</span>
          <span>Color shows position, not financial quality.</span>
        </div>
        <div className={s.canvas} role="region" aria-label={`${category.label} company ratio map`} tabIndex={0} aria-describedby={`${id}-map-help ${id}-keyboard-help`}>
          <table>
            <caption className={s.srOnly}>{category.label} ratios for all {atlas.companyCount} companies in {profile.lensDefinition?.label}. Values use each company’s latest available reporting period. Peer positions use matching accounting models and exact periods.</caption>
            <thead><tr><th scope="col">Company<span>{profile.weighted ? "Known allocation" : "Alphabetical order"}</span></th>{category.metrics.map((entry: any) => <th key={entry.id} scope="col" data-selected={metric.id === entry.id}><button type="button" onClick={() => onRequestedMetric(entry.id)} aria-pressed={metric.id === entry.id}>{entry.label}<small>{entry.availableCompanyCount}/{atlas.companyCount} available</small></button></th>)}</tr></thead>
            <tbody>
              {atlas.companies.map((entry: any, rowIndex: number) => <tr key={entry.cik} data-selected={entry.cik === company.cik}>
                <th scope="row"><span className={s.companyIdentity}><b>{entry.ticker || entry.name}</b><small title={entry.name}>{entry.name}</small></span>{profile.weighted ? <span className={s.weight}>{finite(entry.weightPct) ? `${number(entry.weightPct)}%${entry.weightComplete ? "" : " known"}` : "Allocation unknown"}</span> : null}</th>
                {category.metrics.map((entryMetric: any, columnIndex: number) => {
                  const entryCell = entry.cells[entryMetric.id];
                  const available = entryCell.status === "available";
                  const position = entryCell.peerPositionPct;
                  const selected = rowIndex === activeRow && columnIndex === activeColumn;
                  const tone = finite(position) ? Math.min(4, Math.floor(position / 25)) : "none";
                  return <td key={entryMetric.id} data-column={entryMetric.id === metric.id}><button
                    ref={(element) => { const key = `${entry.cik}:${entryMetric.id}`; if (element) cellRefs.current.set(key, element); else cellRefs.current.delete(key); }}
                    type="button" className={s.cell} data-tone={tone} data-available={available} aria-pressed={selected} tabIndex={selected ? 0 : -1}
                    aria-label={`${entry.ticker || entry.name}, ${entryMetric.label}: ${available ? valueLabel(entryCell.value, entryMetric.unit) : entryCell.status === "not-applicable" ? "Not applicable" : "Unavailable"}. ${available ? periodLabel(entryCell.period) : "Select for evidence coverage."}`}
                    onClick={() => chooseCell(entry.cik, entryMetric.id)} onKeyDown={(event) => moveCell(event, rowIndex, columnIndex)}
                  ><span>{available ? valueLabel(entryCell.value, entryMetric.unit) : entryCell.status === "not-applicable" ? "N/A" : "—"}</span><span className={s.position} aria-hidden="true">{finite(position) ? <i style={{ "--position": `${position}%` } as CSSProperties} /> : <em>{available ? "No peer range" : entryCell.status === "not-applicable" ? "Not applicable" : "Unavailable"}</em>}</span></button></td>;
                })}
              </tr>)}
            </tbody>
          </table>
        </div>
        <footer className={s.mapFooter}><span id={`${id}-keyboard-help`}><MoveHorizontal size={14} aria-hidden="true" /> All {atlas.companyCount} companies · use arrow keys within the map</span><button type="button" onClick={() => { detailRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); detailRef.current?.focus({ preventScroll: true }); }}>Inspect {company.ticker || "selected company"} · {metric.label}<ArrowDown size={14} aria-hidden="true" /></button></footer>
      </section>

      <section className={s.detail} aria-labelledby={`${id}-detail-title`} ref={detailRef} tabIndex={-1}>
        <div className={s.detailMain}>
          <p className={s.eyebrow}>Inside the selected ratio</p>
          <div className={s.detailHeading}><div><span className={s.ticker}>{company.ticker || company.name}</span><h4 id={`${id}-detail-title`}>{metric.label}</h4><p>{company.name}</p></div><strong className={s.selectedValue}>{valueLabel(cell.value, metric.unit)}</strong></div>
          <p className={s.formula}>{cell.formula || metric.formula || "Calculation details are available with company evidence."}</p>
          <dl className={s.facts}><div><dt>Reporting period</dt><dd>{cell.status === "available" ? periodLabel(cell.period) : "Unavailable"}<small>{cell.status === "available" ? basisLabel(cell.period?.kind) : "No usable observation for this ratio"}</small></dd></div><div><dt>{profile.weighted ? "Known portfolio allocation" : "Accounting model"}</dt><dd>{profile.weighted ? finite(company.weightPct) ? `${number(company.weightPct)}%${company.weightComplete ? "" : " known portion"}` : "Unavailable" : profile.lensDefinition?.label}<small>{profile.weighted ? "Original portfolio denominator" : "Compared within this business model"}</small></dd></div></dl>
          <div className={s.evidenceActions}>{company.rowId ? <button type="button" onClick={() => onInspectCompany(company.rowId)}>Company evidence <ArrowUpRight size={14} aria-hidden="true" /></button> : null}{cell.sourceUrl ? <a href={cell.sourceUrl} target="_blank" rel="noopener noreferrer">Open SEC filing <ArrowUpRight size={14} aria-hidden="true" /></a> : null}</div>
          <details className={s.definitionNotes} key={`${company.cik}:${metric.id}`}><summary>Definition &amp; reporting notes</summary><div>{metric.description ? <p>{metric.description}</p> : null}{metric.caution ? <p>{metric.caution}</p> : null}{cell.scopeNotes?.map((note: string) => <p key={note}>{note}</p>)}{cell.evidenceUrls?.length > 1 ? <p>Calculation sources: {cell.evidenceUrls.map((url: string, index: number) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">SEC source {index + 1}</a>)}</p> : null}</div></details>
        </div>
        <div className={s.detailPeers}>
          <p className={s.eyebrow}>Comparable company context</p>
          {cell.status === "available" && cell.peerCount > 1 ? <>
            <h4>Where this value sits</h4><p>{cell.peerCount} companies, including {company.ticker || "this company"}, share this accounting model and exact reporting period. {profile.sector === "all" ? "Industries may differ." : `Within ${profile.sector}.`}</p>
            {finite(cell.peerPositionPct) ? <div className={s.range} role="img" aria-label={`${company.ticker || company.name}: ${valueLabel(cell.value, metric.unit)}. Same-period peer range ${valueLabel(cell.peerMin, metric.unit)} to ${valueLabel(cell.peerMax, metric.unit)}.`}><i style={{ left: `${cell.peerPositionPct}%` }} /><span style={{ left: `${Math.max(0, Math.min(100, cell.peerMax === cell.peerMin ? 50 : ((cell.peerMedian - cell.peerMin) / (cell.peerMax - cell.peerMin)) * 100))}%` }} /></div> : null}
            <div className={s.rangeLabels}><span>Lowest<strong>{valueLabel(cell.peerMin, metric.unit)}</strong></span><span>Peer median<strong>{valueLabel(cell.peerMedian, metric.unit)}</strong></span><span>Highest<strong>{valueLabel(cell.peerMax, metric.unit)}</strong></span></div>
            <p className={s.peerNote}>The marker shows the company value; the line marks the median. Higher values are not automatically better.</p>
          </> : <><h4>{cell.status === "available" ? "A value without a peer range" : cell.status === "not-applicable" ? "Outside this ratio’s scope" : "An evidence gap, kept visible"}</h4><p>{cell.status === "available" ? "No other company in this view has a usable value for the same exact period and accounting model. The reported value is preserved without assigning a relative position." : cell.status === "not-applicable" ? "This ratio is not applicable to this company’s reporting model." : "The captured evidence does not provide a usable ratio. Required inputs or compatible reporting periods may be missing; unavailable values are never treated as zero."}</p></>}
          <div className={s.coverage}><span>{metric.availableCompanyCount} of {atlas.companyCount} companies have this ratio</span>{profile.weighted ? <strong>{finite(metric.knownAllocationPct) ? `${number(metric.knownAllocationPct)}% known allocation covered${metric.weightCoverageComplete ? "" : " · partial weights"}` : "Covered allocation unavailable"}</strong> : null}</div>
        </div>
      </section>

      <details className={s.method}><summary>How to read this map</summary><div><p>Each cell is an individual company ratio from its latest captured reporting period. Different cells can have different dates. Allocation describes the holdings represented; the ratios are not a consolidated portfolio balance sheet.</p><p>Dots and color intensity locate a value between the lowest and highest available observations with the same accounting model, ratio definition and exact period. A cell without comparable peers keeps its value and has no position. Equal values share a position. Company weights do not change the position.</p><p>Missing observations remain visible. Select a cell for reporting dates, calculation and SEC evidence. Banks and insurers use their own ratio families; change the accounting model above to explore them.</p></div></details>
      <p className={s.srOnly} role="status" aria-live="polite">Selected {company.ticker || company.name}: {metric.label}, {valueLabel(cell.value, metric.unit)}.</p>
    </div>
  );
}
