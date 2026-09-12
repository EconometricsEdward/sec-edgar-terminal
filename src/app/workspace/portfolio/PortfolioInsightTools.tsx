"use client";
import { useMemo, useState } from "react";
import {
  buildCatalogReport,
  weightedFundamentals,
  financingBuffers,
  conditionOverlap,
  FINANCIAL_CONDITIONS,
  evidenceImpact,
  operatingSensitivity,
  analysisRowsCsv,
} from "../../../utils/portfolioEnrichment.js";
import { downloadText } from "../../../utils/download.js";
import s from "./PortfolioInsightTools.module.css";

export const number = (value: any, unit = "") =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2, ...(unit === "USD" ? { notation: "compact" as const } : {}) })}${unit ? ` ${unit}` : ""}`
    : "—";
const companyCountLabel = (value: number | null | undefined, qualifier = "") => {
  const count = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `${count}${qualifier ? ` ${qualifier}` : ""} ${count === 1 ? "company" : "companies"}`;
};
export function Stats({ values }: { values: [string, any][] }) {
  return (
    <div className={s.stats}>
      {values
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([label, value]) => (
          <div className={s.stat} key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
    </div>
  );
}
export type Column = {
  key: string;
  label: string;
  unit?: string;
  render?: (row: any) => React.ReactNode;
};
export function AnalysisTable({
  rows,
  columns,
  onInspect,
  title = "Companies",
  metadata = {},
  filename = "portfolio-analysis",
}: {
  rows: any[];
  columns: Column[];
  onInspect?: (rowId: string) => void;
  title?: string;
  metadata?: Record<string, any>;
  filename?: string;
}) {
  const [limit, setLimit] = useState(15),
    [message, setMessage] = useState("");
  function exportRows() {
    try {
      downloadText(
        `${filename}.csv`,
        analysisRowsCsv(rows, metadata),
        "text/csv;charset=utf-8",
      );
      setMessage(
        `CSV prepared for ${rows.length} results with calculation context and evidence.`,
      );
    } catch {
      setMessage("Export could not be prepared. Please try again.");
    }
  }
  return (
    <div className={s.tableArea}>
      <div className={s.tableHeading}>
        <h4>
          {title} · {rows.length}
        </h4>
        {rows.length > 0 && (
          <button type="button" onClick={exportRows}>
            Export this analysis
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
      {rows.length > 0 ? (
        <>
          <div
            className={s.tableWrap}
            role="region"
            aria-label={title}
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  {onInspect && <th>Company</th>}
                  {columns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((row, index) => (
                  <tr key={row.cik || row.id || index}>
                    {onInspect && (
                      <td>
                        <button
                          type="button"
                          className={s.company}
                          onClick={() => onInspect(row.rowId)}
                        >
                          {row.ticker || row.name}
                        </button>
                        <small>{row.name}</small>
                      </td>
                    )}
                    {columns.map((column) => (
                      <td key={column.key}>
                        {column.render
                          ? column.render(row)
                          : typeof row[column.key] === "number"
                            ? number(row[column.key], column.unit)
                            : String(row[column.key] ?? "—")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 15 && (
            <button
              type="button"
              onClick={() => setLimit(limit >= rows.length ? 15 : limit + 25)}
            >
              {limit >= rows.length
                ? "Show first 15 results"
                : `Show more (${Math.min(limit, rows.length)} of ${rows.length})`}
            </button>
          )}
        </>
      ) : (
        <p>
          No companies meet these conditions with compatible evidence. Adjust
          the selection to explore another group.
        </p>
      )}
    </div>
  );
}
const periodColumn: Column = {
  key: "period",
  label: "Reporting period",
  render: (row) => String(row.period || "").replaceAll("|", " · "),
};
const weightColumn: Column = {
  key: "weightPct",
  label: "Known allocation",
  unit: "%",
};
const evidenceColumn: Column = {
  key: "evidence",
  label: "SEC evidence",
  render: (row) =>
    row.evidence ? (
      <a href={row.evidence.split(" ; ")[0]} target="_blank" rel="noreferrer">
        Source ↗
      </a>
    ) : (
      "Inspect company"
    ),
};
type Props = {
  report: any;
  companies: any[];
  view: string;
  onInspect: (rowId: string) => void;
};
export default function PortfolioInsightTools({
  report,
  companies,
  view,
  onInspect,
}: Props) {
  const catalog = useMemo(
    () => buildCatalogReport(report, companies),
    [report, companies],
  );
  const ratios = catalog.metrics.filter((metric: any) =>
    ["percent", "decimal"].includes(metric.format),
  );
  const [requestedMetric, setMetric] = useState("netMargin"),
    [cohort, setCohort] = useState(""),
    [requestedBuffer, setBuffer] = useState("netDebt");
  const [conditions, setConditions] = useState(() =>
    ["revenueGrowth", "netIncome"].filter((key) =>
      catalog.metrics.some((metric: any) => metric.id === key),
    ),
  );
  const [coverageKeys, setCoverageKeys] = useState([
      "netMargin",
      "operatingCashFlow",
      "debt",
    ]),
    [age, setAge] = useState("");
  const [revenueShock, setRevenueShock] = useState("-10"),
    [variableCosts, setVariableCosts] = useState("50");
  const metricId = String(
    ratios.find((item: any) => item.id === requestedMetric)?.id ||
      ratios[0]?.id ||
      "",
  );
  const profile = useMemo(
    () => weightedFundamentals(report, companies, metricId, cohort),
    [report, companies, metricId, cohort],
  );
  const buffers = useMemo(
    () => financingBuffers(report, companies),
    [report, companies],
  );
  const buffer =
    buffers.find((item: any) => item.id === requestedBuffer) || buffers[0];
  const staleConditions = conditions.some(
    (key) => !catalog.metrics.some((metric: any) => metric.id === key),
  );
  const overlap = useMemo(
    () =>
      conditionOverlap(report, companies, staleConditions ? [] : conditions),
    [report, companies, conditions, staleConditions],
  );
  const availableConditions = FINANCIAL_CONDITIONS.filter((item) =>
    catalog.metrics.some((metric: any) => metric.id === item.id),
  );
  const impact = useMemo(
    () =>
      evidenceImpact(report, companies, coverageKeys, age ? Number(age) : null),
    [report, companies, coverageKeys, age],
  );
  const operating = useMemo(
    () => operatingSensitivity(report, companies, revenueShock, variableCosts),
    [report, companies, revenueShock, variableCosts],
  );
  const metadata = {
    captured_at: report.capturedAt,
    analysis: view,
    weights: report.weighted
      ? "Original known weights; no normalization"
      : "Company counts",
  };
  const weights = report.weighted ? [weightColumn] : [];
  function toggle(
    key: string,
    selected: string[],
    set: (values: string[]) => void,
  ) {
    set(
      selected.includes(key)
        ? selected.filter((item) => item !== key)
        : [...selected, key],
    );
  }
  return (
    <section className={s.tool}>
      {view === "weighted" && (
        <>
          <div>
            <h3>How allocation shapes company fundamentals</h3>
            <p>
              Compare equal-company and allocation-weighted summaries within one
              business model and exact reporting period.
            </p>
          </div>
          {ratios.length > 0 ? (
            <>
              <div className={s.controls}>
                <label>
                  Company ratio
                  <select
                    value={metricId}
                    onChange={(event) => {
                      setMetric(event.target.value);
                      setCohort("");
                    }}
                  >
                    {ratios.map((metric: any) => (
                      <option key={metric.id} value={metric.id}>
                        {metric.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Comparable cohort
                  <select
                    value={profile.cohort?.id || ""}
                    onChange={(event) => setCohort(event.target.value)}
                  >
                    {profile.cohorts?.map((item: any) => (
                      <option key={item.id} value={item.id}>
                        {item.lens} · {item.period.replaceAll("|", " · ")} ·{" "}
                        {companyCountLabel(item.count)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Stats
                values={[
                  [
                    `Equal-company mean (${profile.rows.length})`,
                    number(profile.equalMean, profile.unit),
                  ],
                  [
                    `Allocation-weighted mean (${profile.weightedCompanyCount ?? 0})`,
                    profile.weightedMean === null
                      ? null
                      : number(profile.weightedMean, profile.unit),
                  ],
                  [
                    "Weighted median",
                    profile.weightedMedian === null
                      ? null
                      : number(profile.weightedMedian, profile.unit),
                  ],
                  [
                    "Measured known allocation",
                    profile.coveredWeightPct === null
                      ? null
                      : number(profile.coveredWeightPct, "%"),
                  ],
                ]}
              />
              <p className={s.note}>
                {companyCountLabel(profile.excludedCount)}{" "}
                {profile.excludedCount === 1 ? "falls" : "fall"} outside this
                measured cohort.{" "}
                {profile.partial
                  ? "Some weights are partial known subtotals. "
                  : ""}
                Unknown and zero weights are excluded from the weighted mean;
                the equal-company mean uses every measured company. These
                summarize company ratios; they are not the portfolio’s
                accounting margin or investment return.
              </p>
              <AnalysisTable
                rows={profile.rows}
                onInspect={onInspect}
                columns={[
                  { key: "value", label: "Reported ratio", unit: profile.unit },
                  ...weights,
                  periodColumn,
                  evidenceColumn,
                ]}
                metadata={{
                  ...metadata,
                  metric: metricId,
                  cohort: profile.cohort?.id,
                  covered_weight: profile.coveredWeightPct,
                }}
                filename="portfolio-weighted-fundamentals"
              />
              <details>
                <summary>Calculation</summary>
                <p>
                  Weighted mean = sum of each measured ratio × its known
                  positive allocation, divided by measured allocation. The
                  weighted median is the first ratio whose cumulative allocation
                  reaches half the measured allocation. Company weights remain
                  unchanged.
                </p>
              </details>
            </>
          ) : (
            <p>
              No supported company ratios are captured. Refresh company research
              to populate this view.
            </p>
          )}
        </>
      )}
      {view === "buffers" && (
        <>
          <div>
            <h3>Cash, debt, and financing capacity</h3>
            <p>
              Inspect corporate companies’ reported financing inputs together.
              Every result uses matching reporting periods.
            </p>
          </div>
          {buffer ? (
            <>
              <label>
                Financing measure
                <select
                  value={buffer.id}
                  onChange={(event) => setBuffer(event.target.value)}
                >
                  {buffers.map((item: any) => (
                    <option key={item.id} value={item.id}>
                      {item.label} · {companyCountLabel(item.rows.length)}
                    </option>
                  ))}
                </select>
              </label>
              <p>{buffer.formula}</p>
              <p>
                {buffer.rows.length} of{" "}
                {companyCountLabel(buffer.eligibleCount, "corporate")} {" "}
                {buffer.rows.length === 1 ? "supports" : "support"} this
                calculation.
              </p>
              <AnalysisTable
                rows={buffer.rows}
                onInspect={onInspect}
                columns={[
                  { key: "value", label: buffer.label, unit: buffer.unit },
                  ...weights,
                  {
                    key: "inputs",
                    label: "Reported inputs",
                    render: (row) =>
                      row.inputValues.map((input: any) => (
                        <div key={input.key}>
                          {input.label}: {number(input.value, input.unit)}
                        </div>
                      )),
                  },
                  periodColumn,
                  evidenceColumn,
                ]}
                metadata={{ ...metadata, formula: buffer.formula }}
                filename="portfolio-financing-buffers"
              />
            </>
          ) : (
            <p>
              No corporate companies have the compatible inputs needed for these
              calculations.
            </p>
          )}
        </>
      )}
      {view === "overlap" && (
        <>
          <div>
            <h3>Which financial conditions occur together?</h3>
            <p>
              Select the conditions that must all be present. The comparison
              requires every selected measure to be available for the same full
              reporting period.
            </p>
          </div>
          {staleConditions && (
            <p role="status">
              Some selected conditions no longer have evidence in this
              portfolio.{" "}
              <button type="button" onClick={() => setConditions([])}>
                Clear conditions and choose again
              </button>
            </p>
          )}
          <div className={s.checks}>
            {availableConditions.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={conditions.includes(item.id)}
                  onChange={() => toggle(item.id, conditions, setConditions)}
                />
                {item.label}
              </label>
            ))}
          </div>
          <Stats
            values={[
              [`Companies with every selected condition`, overlap.rows.length],
              ["Companies fully measured", overlap.measuredCount],
              [
                "Known allocation matching",
                overlap.knownWeightPct === null
                  ? null
                  : number(overlap.knownWeightPct, "%"),
              ],
            ]}
          />
          <p>
            {companyCountLabel(overlap.excludedCount, "corporate")} {" "}
            {overlap.excludedCount === 1 ? "lacks" : "lack"} a compatible
            complete set of selected inputs. Missing results never count as a
            condition being absent.{" "}
            {overlap.partial
              ? "Matching allocation includes partial known weights."
              : ""}
          </p>
          <AnalysisTable
            rows={overlap.rows}
            onInspect={onInspect}
            columns={[
              {
                key: "conditions",
                label: "Observed conditions",
                render: (row) =>
                  row.conditionValues.map((condition: any) => (
                    <div key={condition.key}>
                      {condition.label}:{" "}
                      {number(condition.value, condition.unit)}
                    </div>
                  )),
              },
              ...weights,
              periodColumn,
              evidenceColumn,
            ]}
            metadata={{
              ...metadata,
              conditions: conditions.join(" AND "),
              measured_companies: overlap.measuredCount,
              measured_weight: overlap.measuredWeightPct,
            }}
            filename="portfolio-overlapping-conditions"
          />
        </>
      )}
      {view === "impact" && (
        <>
          <div>
            <h3>Prioritize evidence by portfolio importance</h3>
            <p>
              Choose up to six measures. See how much known allocation they
              cover and which holdings need more evidence.
            </p>
          </div>
          <div className={s.controls}>
            <label>
              Add a measure
              <select
                value=""
                onChange={(event) =>
                  setCoverageKeys(
                    [
                      ...new Set([...impact.metricIds, event.target.value]),
                    ].slice(0, 6),
                  )
                }
                disabled={impact.metricIds.length >= 6}
              >
                <option value="">Choose a supported measure</option>
                {catalog.metrics
                  .filter(
                    (metric: any) => !impact.metricIds.includes(metric.id),
                  )
                  .map((metric: any) => (
                    <option key={metric.id} value={metric.id}>
                      {metric.label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Also flag capture age
              <select
                value={age}
                onChange={(event) => setAge(event.target.value)}
              >
                <option value="">Missing measures only</option>
                <option value="7">Older than 7 days or unknown</option>
                <option value="30">Older than 30 days or unknown</option>
                <option value="90">Older than 90 days or unknown</option>
              </select>
            </label>
          </div>
          <div className={s.checks}>
            {impact.metricIds.map((key: string) => (
              <button
                type="button"
                key={key}
                onClick={() =>
                  setCoverageKeys(
                    impact.metricIds.filter((item: string) => item !== key),
                  )
                }
              >
                Remove{" "}
                {catalog.metrics.find((item: any) => item.id === key)?.label} ×
              </button>
            ))}
          </div>
          <AnalysisTable
            rows={impact.measures}
            title="Coverage of selected measures"
            columns={[
              { key: "label", label: "Measure" },
              { key: "measuredCount", label: "Measured companies" },
              { key: "applicableCount", label: "Applicable companies" },
              ...(report.weighted
                ? [
                    {
                      key: "coveredWeightPct",
                      label: "Known allocation covered",
                      unit: "%",
                    },
                    {
                      key: "missingWeightPct",
                      label: "Known allocation missing",
                      unit: "%",
                    },
                  ]
                : []),
            ]}
            metadata={metadata}
            filename="portfolio-measure-coverage"
          />
          <p className={s.note}>
            Weights are counted once per company and are not normalized.{" "}
            {impact.partial ? "Some allocations are partial or unknown. " : ""}
            Capture age is measured against this research snapshot (
            {String(report.capturedAt || "").slice(0, 10)}), not the financial
            reporting date.
          </p>
          <AnalysisTable
            rows={impact.rows}
            title="Holdings to investigate · largest allocation first"
            onInspect={onInspect}
            columns={[
              ...weights,
              { key: "missing", label: "Missing selected evidence" },
              { key: "captureAgeDays", label: "Capture age (days)" },
              { key: "retrievedAt", label: "Captured at" },
            ]}
            metadata={{
              ...metadata,
              selected_measures: impact.metricIds.join(";"),
              age_threshold: age || "None",
            }}
            filename="portfolio-evidence-priorities"
          />
        </>
      )}
      {view === "operating" && (
        <>
          <div>
            <h3>How could revenue changes affect operating profit?</h3>
            <p>
              Model corporate operating leverage using reported revenue and
              operating income, plus your own cost assumption.
            </p>
          </div>
          <div className={s.controls}>
            <label>
              Revenue change (%)
              <input
                type="number"
                min="-99.99"
                max="100"
                step="1"
                value={revenueShock}
                onChange={(event) => setRevenueShock(event.target.value)}
              />
            </label>
            <label>
              Variable share of operating costs (%)
              <input
                type="number"
                min="0"
                max="100"
                value={variableCosts}
                onChange={(event) => setVariableCosts(event.target.value)}
              />
            </label>
          </div>
          {operating.error ? (
            <p role="alert" className={s.error}>
              {operating.error}
            </p>
          ) : (
            <>
              <Stats
                values={[
                  [
                    `Companies modeled / corporate companies`,
                    `${operating.rows.length} / ${operating.eligibleCount}`,
                  ],
                  ["Modeled operating losses", operating.modeledLossCount],
                  ["New modeled operating losses", operating.enteringLossCount],
                  [
                    "Known allocation modeled",
                    operating.coveredWeightPct === null
                      ? null
                      : number(operating.coveredWeightPct, "%"),
                  ],
                ]}
              />
              <p className={s.note}>
                Hypothetical company profits, not a price forecast.{" "}
                {report.weighted
                  ? `${number(operating.lossWeightPct, "%")} of known allocation has modeled operating losses. `
                  : ""}
                {operating.partial ? "Some weights are partial. " : ""}Companies
                lacking compatible inputs are excluded.
              </p>
              <AnalysisTable
                rows={operating.rows}
                onInspect={onInspect}
                columns={[
                  {
                    key: "operatingIncome",
                    label: "Reported operating income",
                    unit: "USD",
                  },
                  {
                    key: "modeledIncome",
                    label: "Modeled operating income",
                    unit: "USD",
                  },
                  {
                    key: "modeledMarginPct",
                    label: "Modeled margin",
                    unit: "%",
                  },
                  ...weights,
                  periodColumn,
                  evidenceColumn,
                ]}
                metadata={{
                  ...metadata,
                  revenue_change_pct: operating.revenueChangePct,
                  variable_cost_pct: operating.variableCostPct,
                  formula:
                    "Costs = revenue - operating income; modeled costs = costs × (1 + variable share × revenue change)",
                }}
                filename="portfolio-operating-sensitivity"
              />
            </>
          )}
          <details>
            <summary>Model assumptions</summary>
            <p>
              Implied operating costs = revenue − operating income. The variable
              share changes proportionally with revenue; remaining costs stay
              fixed. Modeled income = modeled revenue − modeled costs. Only
              positive revenue and nonnegative implied costs with matching units
              and full periods qualify. No financing costs, taxes, balance-sheet
              changes, or share-price response are modeled.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
