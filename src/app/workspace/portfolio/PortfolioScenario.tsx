"use client";

import { useId, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowDownRight,
  ArrowUpRight,
  ArrowRight,
  Banknote,
  ChartNoAxesCombined,
  ChevronDown,
  Download,
  Layers3,
  RotateCcw,
  Shield,
  SlidersHorizontal,
  TrendingDown,
} from "lucide-react";
import {
  IMPACT_SCENARIOS,
  buildPortfolioImpactScenarios,
} from "../../../utils/portfolioImpactScenarios.js";
import { csvString } from "../../../utils/portfolioFiles.js";
import { downloadText } from "../../../utils/download.js";
import {
  ImpactWaterfall,
  ImpactSensitivity,
  impactMoney,
  impactNumber,
} from "./PortfolioImpactVisuals";
import s from "./PortfolioImpact.module.css";

const PriceScenarios = dynamic(() => import("./PortfolioPriceScenarios"), {
  loading: () => <p role="status">Opening the price and allocation tools…</p>,
});
const MarketContext = dynamic(
  () => import("./PortfolioScenarioMarketContext"),
  { loading: () => <p role="status">Opening related market context…</p> },
);
type Props = {
  report: any;
  rows: any[];
  settings: any;
  companies: any[];
  onInspectCompany: (rowId: string) => void;
};
const icons: Record<string, typeof TrendingDown> = {
  demand: TrendingDown,
  cost: Layers3,
  combined: ArrowDownRight,
  recovery: ArrowUpRight,
  cash: Banknote,
  assets: Shield,
};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const periodText = (period: any) =>
  !period
    ? "Period unavailable"
    : typeof period === "string"
      ? period.replaceAll("|", " · ")
      : `${period.kind || "Reported period"} · ${period.start ? `${period.start} to ` : "As of "}${period.end || "Unavailable"}`;
const sourceUrl = (source: any) =>
  typeof source === "string" ? source : source.documentUrl || source.url || "";
const ratioText = (value: any, unit: string) =>
  finite(value)
    ? `${impactNumber(value, false, unit === "x" ? 2 : 1)}${unit === "x" ? "×" : "%"}`
    : "—";

function AssumptionControl({
  control,
  value,
  onChange,
  id,
}: {
  control: any;
  value: any;
  onChange: (value: string) => void;
  id: string;
}) {
  const numeric = value === "" ? NaN : Number(value);
  return (
    <div className={s.assumption}>
      <div className={s.controlHeading}>
        <label htmlFor={id}>{control.label}</label>
        <div className={s.inputSuffix}>
          <input
            id={id}
            type="number"
            min={control.min}
            max={control.max}
            step={control.step || 1}
            value={value ?? ""}
            onChange={(event) => onChange(event.target.value)}
            aria-describedby={`${id}-help`}
          />
          <span>%</span>
        </div>
      </div>
      <input
        type="range"
        aria-label={`Adjust ${control.label.toLowerCase()}`}
        min={control.min}
        max={control.max}
        step={control.step || 1}
        value={
          Number.isFinite(numeric)
            ? Math.max(control.min, Math.min(control.max, numeric))
            : control.min
        }
        onChange={(event) => onChange(event.target.value)}
      />
      <div className={s.rangeLabels}>
        <span>{control.min}%</span>
        <span>{control.max}%</span>
      </div>
      <p id={`${id}-help`}>{control.description}</p>
    </div>
  );
}

export default function PortfolioScenario(props: Props) {
  const { report, companies, onInspectCompany } = props;
  const id = useId();
  const [area, setArea] = useState("impact");
  const [priceOpened, setPriceOpened] = useState(false);
  const [scenarioId, setScenarioId] = useState("demand");
  const definition =
    IMPACT_SCENARIOS.find((scenario) => scenario.id === scenarioId) ||
    IMPACT_SCENARIOS[0];
  const [assumptions, setAssumptions] = useState<Record<string, any>>({
    ...definition.defaults,
  });
  const [sector, setSector] = useState("all");
  const [companyCik, setCompanyCik] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [showWeights, setShowWeights] = useState(false);
  const [notice, setNotice] = useState("");
  const unfiltered = useMemo(
    () =>
      buildPortfolioImpactScenarios(report, companies, {
        ...assumptions,
        scenarioId,
        scope: "all",
      }),
    [report, companies, assumptions, scenarioId],
  );
  const sectors = useMemo(
    () =>
      [
        ...new Set<string>(
          [...unfiltered.rows, ...unfiltered.exclusions]
            .map((row: any) => row.sector)
            .filter(Boolean),
        ),
      ].sort(),
    [unfiltered],
  );
  const effectiveSector = sectors.includes(sector) ? sector : "all";
  const result = useMemo(
    () =>
      effectiveSector === "all"
        ? unfiltered
        : buildPortfolioImpactScenarios(report, companies, {
            ...assumptions,
            scenarioId,
            scope: "sector",
            targetSector: effectiveSector,
          }),
    [unfiltered, effectiveSector, report, companies, assumptions, scenarioId],
  );
  const improving =
    finite(result.summary.medianImpactPct) &&
    result.summary.medianImpactPct > 0;
  const ordered = useMemo(
    () =>
      [...result.rows].sort((a: any, b: any) => {
        if (!finite(a.impactPct))
          return finite(b.impactPct) ? 1 : a.ticker.localeCompare(b.ticker);
        if (!finite(b.impactPct)) return -1;
        return (
          (improving ? b.impactPct - a.impactPct : a.impactPct - b.impactPct) ||
          a.ticker.localeCompare(b.ticker)
        );
      }),
    [result, improving],
  );
  const alphabetical = useMemo(
    () =>
      [...result.rows].sort((a: any, b: any) =>
        a.ticker.localeCompare(b.ticker),
      ),
    [result],
  );
  const selected =
    ordered.find((row: any) => row.cik === companyCik) || alphabetical[0];
  const selectedCompany = (
    Array.isArray(companies) ? companies : Object.values(companies || {})
  ).find(
    (company: any) => String(company.cik).padStart(10, "0") === selected?.cik,
  );
  const visible = showAll ? ordered : ordered.slice(0, 8);
  const maxImpact = Math.max(
    1,
    ...ordered.map((row: any) =>
      finite(row.impactPct) ? Math.abs(row.impactPct) : 0,
    ),
  );
  const impactLabel = selected?.impactLabel || definition.impactLabel;
  const lossCount = result.summary.enteredLossCount;
  const isAssets = scenarioId === "assets",
    isCash = scenarioId === "cash";
  const metricName = isAssets
    ? "equity"
    : isCash
      ? "cash after capital spending"
      : "operating profit";
  const weighted = result.coverage.weighted;

  function chooseScenario(next: typeof definition) {
    setScenarioId(next.id);
    setAssumptions({ ...next.defaults });
    setShowAll(false);
    setNotice("");
  }
  function exportImpact() {
    try {
      const data: any[][] = [
        ["EDGAR Terminal company impact scenario"],
        ["Scenario", definition.label],
        ["Sector", effectiveSector],
        ["SEC research captured", report.capturedAt || "Unavailable"],
        [
          "Interpretation",
          "Company financial sensitivity; not a stock-return forecast or probability estimate. Portfolio weights do not enter company calculations. CFTC market context does not calibrate these assumptions.",
        ],
        ...definition.controls.map((control) => [
          "User assumption",
          control.label,
          assumptions[control.key],
          control.unit,
        ]),
        ...result.assumptions.map((item) => ["Methodology", item]),
        [],
        [
          "Ticker",
          "Company",
          "CIK",
          "Sector",
          "Reporting period",
          "Measure",
          "Reported USD",
          "Scenario USD",
          "Change USD",
          "Impact (%)",
          "Impact definition",
          "Reported ratio",
          "Scenario ratio",
          "Ratio definition",
          "Ratio unit",
          "New negative result",
          "Reviewed allocation (%)",
          "SEC evidence",
        ],
        ...ordered.map((row: any) => [
          row.ticker,
          row.name,
          row.cik,
          row.sector,
          periodText(row.period),
          row.metricLabel,
          row.baseline,
          row.modeled,
          row.change,
          row.impactPct ?? "Unavailable",
          row.impactLabel,
          row.beforeRatio ?? "Unavailable",
          row.afterRatio ?? "Unavailable",
          row.ratioLabel,
          row.ratioUnit,
          row.enteredLoss ? "Yes" : "No",
          weighted && finite(row.weightPct) ? row.weightPct : "Not used",
          row.evidence
            .flatMap((input: any) => input.sources.map(sourceUrl))
            .filter(Boolean)
            .join(" ; "),
        ]),
        [],
        ["Excluded company", "Reason"],
        ...result.exclusions.map((row: any) => [
          row.ticker || row.name,
          row.reason,
        ]),
        [],
        [
          "Ticker",
          "Input",
          "Reported value",
          "Unit",
          "Metric period",
          "Source period",
          "SEC source",
        ],
        ...ordered.flatMap((row: any) =>
          row.evidence.flatMap((input: any) =>
            input.sources.map((source: any) => [
              row.ticker,
              input.label,
              input.value,
              input.unit,
              periodText(input.period),
              periodText(input.observationPeriod),
              sourceUrl(source),
            ]),
          ),
        ),
      ];
      downloadText(
        `company-impact-${scenarioId}.csv`,
        csvString(data),
        "text/csv",
      );
      setNotice(
        `Exported ${ordered.length} company scenarios with assumptions and SEC sources.`,
      );
    } catch {
      setNotice("The download could not be created. Please try again.");
    }
  }

  return (
    <section className={s.lab} aria-labelledby={`${id}-title`}>
      <header className={s.header}>
        <div>
          <p className={s.eyebrow}>SCENARIO LAB</p>
          <h3 id={`${id}-title`}>Explore what could change.</h3>
          <p>
            See how your assumptions change company financial capacity. Start
            with SEC evidence, then explore the market context.
          </p>
        </div>
        <span className={s.evidenceBadge}>
          <span /> SEC financials · CFTC context
        </span>
      </header>
      <div className={s.modeNav} aria-label="Scenario approach">
        <button
          type="button"
          aria-pressed={area === "impact"}
          onClick={() => setArea("impact")}
        >
          <ChartNoAxesCombined size={17} aria-hidden="true" /> Company impact
          <span>Works without weights</span>
        </button>
        <button
          type="button"
          aria-pressed={area === "price"}
          onClick={() => {
            setArea("price");
            setPriceOpened(true);
          }}
        >
          <SlidersHorizontal size={17} aria-hidden="true" /> Price & allocation
          <span>Explicit price assumptions</span>
        </button>
      </div>
      {priceOpened && (
        <div hidden={area !== "price"}>
          <PriceScenarios {...props} />
        </div>
      )}
      {area === "impact" && (
        <>
          <div className={s.sectionTitle}>
            <div>
              <span className={s.step}>01</span>
              <h4>Choose a scenario</h4>
            </div>
            <p>Illustrative starting points. Every assumption is editable.</p>
          </div>
          <div className={s.presets} aria-label="Company impact scenarios">
            {IMPACT_SCENARIOS.map((scenario) => {
              const Icon = icons[scenario.id] || ChartNoAxesCombined;
              return (
                <button
                  key={scenario.id}
                  type="button"
                  className={s.preset}
                  aria-pressed={scenarioId === scenario.id}
                  onClick={() => chooseScenario(scenario)}
                >
                  <span className={s.presetTop}>
                    <Icon size={19} aria-hidden="true" />
                    <span>
                      {scenario.category === "balance"
                        ? "Balance sheet"
                        : scenario.category === "cash"
                          ? "Cash generation"
                          : "Operating profit"}
                    </span>
                    {scenarioId === scenario.id && (
                      <span className={s.selectedDot} />
                    )}
                  </span>
                  <strong>{scenario.label}</strong>
                  <span className={s.presetDescription}>
                    {scenario.description}
                  </span>
                </button>
              );
            })}
          </div>
          <div className={s.experiment}>
            <aside
              className={s.assumptionsPanel}
              aria-label="Scenario assumptions"
            >
              <div className={s.panelHeading}>
                <h4>Your assumptions</h4>
                <button
                  type="button"
                  className={s.iconButton}
                  aria-label="Reset scenario assumptions"
                  onClick={() => {
                    setAssumptions({ ...definition.defaults });
                    setNotice("");
                  }}
                >
                  <RotateCcw size={16} aria-hidden="true" />
                </button>
              </div>
              <p>Applied to each eligible company’s reported baseline.</p>
              {definition.controls.map((control) => (
                <AssumptionControl
                  key={`${scenarioId}-${control.key}`}
                  control={control}
                  value={assumptions[control.key]}
                  id={`${id}-${control.key}`}
                  onChange={(value) => {
                    setAssumptions((current) => ({
                      ...current,
                      [control.key]: value,
                    }));
                    setNotice("");
                  }}
                />
              ))}
              <label className={s.sectorControl} htmlFor={`${id}-sector`}>
                Company group
                <select
                  id={`${id}-sector`}
                  value={effectiveSector}
                  onChange={(event) => {
                    setSector(event.target.value);
                    setShowAll(false);
                  }}
                >
                  <option value="all">All sectors</option>
                  {sectors.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <div className={s.weightContext}>
                <strong>Do I need portfolio weights?</strong>
                <p>
                  No. Company impact comes from its financial statements.
                  Reviewed weights can show how much of your allocation is
                  covered.
                </p>
                {weighted ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={showWeights}
                      onChange={(event) => setShowWeights(event.target.checked)}
                    />{" "}
                    Show allocation context
                  </label>
                ) : (
                  <span>
                    Company analysis is available without an allocation model.
                  </span>
                )}
              </div>
            </aside>
            <div className={s.resultsPanel}>
              <div className={s.panelHeading}>
                <div>
                  <p className={s.eyebrow}>UNDER THESE ASSUMPTIONS</p>
                  <h4>Where the impact appears</h4>
                </div>
                <button
                  className={s.exportButton}
                  type="button"
                  onClick={exportImpact}
                  disabled={!ordered.length}
                >
                  <Download size={15} aria-hidden="true" /> Export
                </button>
              </div>
              {result.errors.length > 0 ? (
                <div className={s.empty} role="alert">
                  <strong>Review the assumptions</strong>
                  {result.errors.map((error) => (
                    <p key={error}>{error}</p>
                  ))}
                </div>
              ) : (
                <>
                  <div
                    className={s.stats}
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    <div>
                      <span>Companies modeled</span>
                      <strong>
                        {ordered.length}
                        <small> / {result.coverage.includedCount}</small>
                      </strong>
                      <p>Verified, compatible SEC inputs</p>
                    </div>
                    <div>
                      <span>Median relative impact</span>
                      <strong
                        className={
                          finite(result.summary.medianImpactPct) &&
                          result.summary.medianImpactPct < 0
                            ? s.negative
                            : s.positive
                        }
                      >
                        {impactNumber(result.summary.medianImpactPct, true)}
                        {finite(result.summary.medianImpactPct) ? "%" : ""}
                      </strong>
                      <p>
                        {isAssets
                          ? "Equity change / reported equity"
                          : isCash
                            ? "Cash change / magnitude of reported operating cash flow"
                            : "Profit change / reported revenue"}
                      </p>
                    </div>
                    <div>
                      <span>
                        {isAssets
                          ? "New equity deficits"
                          : isCash
                            ? "New cash shortfalls"
                            : "New operating losses"}
                      </span>
                      <strong className={lossCount > 0 ? s.negative : ""}>
                        {lossCount}
                      </strong>
                      <p>Positive or zero baseline turns negative</p>
                    </div>
                  </div>
                  {showWeights && weighted && (
                    <p className={s.allocationNote}>
                      {impactNumber(result.coverage.coveredWeightPct)}% of
                      reviewed allocation has usable inputs. This describes
                      coverage; it is not a portfolio return.
                    </p>
                  )}
                  {ordered.length ? (
                    <>
                      <div className={s.impactHeading}>
                        <strong>Company sensitivity</strong>
                        <span>{impactLabel}</span>
                      </div>
                      <div
                        className={s.companyList}
                        aria-label="Company scenario impacts"
                      >
                        {visible.map((row: any) => (
                          <button
                            type="button"
                            key={row.cik}
                            className={s.companyRow}
                            aria-pressed={selected?.cik === row.cik}
                            onClick={() => setCompanyCik(row.cik)}
                            aria-label={`Inspect scenario for ${row.ticker}: ${impactNumber(row.impactPct, true)} percent relative impact`}
                          >
                            <span className={s.companyIdentity}>
                              <strong>{row.ticker}</strong>
                              <span>{row.name}</span>
                            </span>
                            <span className={s.barTrack} aria-hidden="true">
                              <span className={s.barZero} />
                              {finite(row.impactPct) && (
                                <span
                                  className={
                                    row.impactPct < 0
                                      ? s.negativeBar
                                      : s.positiveBar
                                  }
                                  style={{
                                    width: `${(Math.abs(row.impactPct) / maxImpact) * 48}%`,
                                    left:
                                      row.impactPct < 0
                                        ? `${50 - (Math.abs(row.impactPct) / maxImpact) * 48}%`
                                        : "50%",
                                  }}
                                />
                              )}
                            </span>
                            <span className={s.companyValue}>
                              <strong
                                className={
                                  row.impactPct < 0
                                    ? s.negative
                                    : row.impactPct > 0
                                      ? s.positive
                                      : ""
                                }
                              >
                                {impactNumber(row.impactPct, true)}
                                {finite(row.impactPct) ? "%" : ""}
                              </strong>
                              {row.enteredLoss ? (
                                <span className={s.lossTag}>
                                  {isAssets
                                    ? "Equity deficit"
                                    : isCash
                                      ? "Cash shortfall"
                                      : "Turns loss-making"}
                                </span>
                              ) : showWeights &&
                                weighted &&
                                finite(row.weightPct) ? (
                                <span>
                                  {impactNumber(row.weightPct)}% allocation
                                </span>
                              ) : (
                                <span>{row.sector}</span>
                              )}
                            </span>
                            <ArrowRight size={15} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                      {ordered.length > 8 && (
                        <button
                          type="button"
                          className={s.showMore}
                          onClick={() => setShowAll(!showAll)}
                        >
                          {showAll
                            ? "Show fewer companies"
                            : `Show all ${ordered.length} companies`}
                          <ChevronDown size={15} aria-hidden="true" />
                        </button>
                      )}
                      <p className={s.chartNote}>
                        {improving
                          ? "Largest relative improvements first."
                          : "Lowest relative outcomes first."}{" "}
                        Company figures are not added together; reporting
                        periods can differ.
                      </p>
                    </>
                  ) : (
                    <div className={s.empty}>
                      <Shield size={24} aria-hidden="true" />
                      <h4>No compatible inputs for this selection</h4>
                      <p>
                        Choose another scenario or company group. The coverage
                        details below explain which inputs are missing or
                        unsuitable.
                      </p>
                    </div>
                  )}
                </>
              )}
              {notice && (
                <p role="status" className={s.notice}>
                  {notice}
                </p>
              )}
            </div>
          </div>
          {selected && !result.errors.length && (
            <section
              className={s.companyDetail}
              aria-labelledby={`${id}-company-heading`}
            >
              <div className={s.sectionTitle}>
                <div>
                  <span className={s.step}>02</span>
                  <h4 id={`${id}-company-heading`}>
                    Understand the company impact
                  </h4>
                </div>
                <label className={s.companyPicker}>
                  Company
                  <select
                    aria-label="Company to visualize"
                    value={selected.cik}
                    onChange={(event) => setCompanyCik(event.target.value)}
                  >
                    {alphabetical.map((row: any) => (
                      <option value={row.cik} key={row.cik}>
                        {row.ticker} · {row.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={s.detailHeader}>
                <div>
                  <strong className={s.tickerBadge}>{selected.ticker}</strong>
                  <h5>{selected.name}</h5>
                  <p>{periodText(selected.period)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onInspectCompany(selected.rowId)}
                >
                  Inspect company <ArrowUpRight size={16} aria-hidden="true" />
                </button>
              </div>
              <div className={s.companyStats}>
                <div>
                  <span>Reported {metricName}</span>
                  <strong title={impactMoney(selected.baseline, false, true)}>
                    {impactMoney(selected.baseline)}
                  </strong>
                  <p>SEC baseline</p>
                </div>
                <ArrowRight
                  className={s.transitionArrow}
                  size={23}
                  aria-hidden="true"
                />
                <div>
                  <span>Scenario {metricName}</span>
                  <strong
                    className={selected.modeled < 0 ? s.negative : ""}
                    title={impactMoney(selected.modeled, false, true)}
                  >
                    {impactMoney(selected.modeled)}
                  </strong>
                  <p className={selected.change < 0 ? s.negative : s.positive}>
                    {impactMoney(selected.change, true)} change
                  </p>
                </div>
                <div className={s.ratioStat}>
                  <span>{selected.ratioLabel}</span>
                  <strong>
                    {ratioText(selected.beforeRatio, definition.ratioUnit)}{" "}
                    <ArrowRight size={18} aria-hidden="true" />{" "}
                    {ratioText(selected.afterRatio, definition.ratioUnit)}
                  </strong>
                  <p>
                    {finite(selected.beforeRatio) && finite(selected.afterRatio)
                      ? `${impactNumber(selected.afterRatio - selected.beforeRatio, true, definition.ratioUnit === "x" ? 2 : 1)} ${definition.ratioUnit === "x" ? "turns" : "percentage points"}`
                      : "Ratio unavailable for this baseline"}
                  </p>
                </div>
              </div>
              {selected.stale && (
                <p className={s.notice}>
                  This company uses retained SEC evidence from an earlier
                  successful retrieval. Check the reporting period and refresh
                  research before relying on it.
                </p>
              )}
              {(selected.notes || []).map((note: string) => (
                <p className={s.chartNote} key={note}>
                  {note}
                </p>
              ))}
              <div className={s.visualGrid}>
                <div>
                  <h5>From the reported baseline to your scenario</h5>
                  <p>Each step shows its contribution to the change.</p>
                  <ImpactWaterfall row={selected} />
                </div>
                <div>
                  <h5>Explore a range of outcomes</h5>
                  <p>The marker shows your current assumption.</p>
                  <ImpactSensitivity
                    row={selected}
                    control={definition.controls[0]}
                    value={Number(assumptions[definition.controls[0].key])}
                  />
                </div>
              </div>
              <div className={s.interpretation}>
                <strong>
                  {selected.enteredLoss
                    ? isAssets
                      ? "This assumption exhausts the reported equity buffer."
                      : isCash
                        ? "Operating cash flow no longer covers capital spending in this scenario."
                        : "This assumption moves the company into an operating loss."
                    : selected.alreadyNegative
                      ? `Reported ${metricName} was already negative.`
                      : `Modeled ${metricName} remains ${selected.modeled >= 0 ? "nonnegative" : "negative"}.`}
                </strong>
                <p>
                  {isAssets
                    ? "The write-down reduces assets and equity dollar for dollar before tax effects. It does not estimate the fair value of the company or regulatory capital."
                    : isCash
                      ? "Capital spending stays at its reported level. This cash measure excludes financing, dividends, acquisitions, and other investing flows."
                      : "Costs that vary with revenue adjust by your selected variable share; the remaining costs stay fixed before the separate cost-pressure assumption."}
                </p>
              </div>
              <details className={s.evidence}>
                <summary>
                  SEC inputs & calculation evidence{" "}
                  <span>{selected.evidence.length} financial inputs</span>
                </summary>
                <div className={s.evidenceBody}>
                  {selected.evidence.map((input: any) => (
                    <article key={input.key}>
                      <div>
                        <h5>{input.label}</h5>
                        <strong>{impactMoney(input.value, false, true)}</strong>
                      </div>
                      <p>
                        {periodText(input.period)} · {input.unit}
                      </p>
                      <p>
                        Source observation:{" "}
                        {periodText(input.observationPeriod)}
                      </p>
                      {input.formula && (
                        <p>
                          Calculated baseline: {input.formula}. Reconciled to
                          the retained SEC values.
                        </p>
                      )}
                      <div className={s.sourceLinks}>
                        {input.sources.map((source: any, index: number) => (
                          <a
                            href={sourceUrl(source)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`${source.tag || "SEC source"}: ${impactMoney(source.value, false, true)} · ${source.start ? `${source.start} to ` : "As of "}${source.end || ""}`}
                            key={`${sourceUrl(source)}-${index}`}
                          >
                            {source.linkKind === "filing-index"
                              ? source.linkLabel
                              : source.form || "SEC filing"}
                            {source.filed ? ` · ${source.filed}` : ""}
                            <ArrowUpRight size={13} aria-hidden="true" />
                          </a>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
                <p className={s.chartNote}>
                  Source periods and concepts remain attached to each input. The
                  scenario does not modify reported financials.
                </p>
              </details>
              {selectedCompany && (
                <MarketContext
                  company={selectedCompany}
                  scenarioId={scenarioId}
                />
              )}
            </section>
          )}
          <details className={s.methodology}>
            <summary>
              Coverage & methodology{" "}
              <span>
                {result.exclusions.length} companies outside this model
              </span>
            </summary>
            <div>
              <p>
                Company impact uses financial evidence, with no investment
                weights in the calculation. The median summarizes eligible
                companies equally. CFTC observations provide separately labeled
                market context and do not supply a price forecast, probability,
                or automatic financial shock.
              </p>
              <p>
                SEC research captured:{" "}
                {report.capturedAt || "Capture time unavailable"}. Financial
                periods can differ across companies. All numerical starting
                assumptions are illustrative.
              </p>
              {result.assumptions.map((item) => (
                <p key={item}>{item}</p>
              ))}
              {result.exclusions.length > 0 && (
                <div className={s.exclusions}>
                  <table>
                    <caption>Companies excluded from this scenario</caption>
                    <thead>
                      <tr>
                        <th scope="col">Company</th>
                        <th scope="col">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.exclusions.map((row: any) => (
                        <tr key={row.cik || row.rowId}>
                          <th scope="row">{row.ticker || row.name}</th>
                          <td>{row.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
