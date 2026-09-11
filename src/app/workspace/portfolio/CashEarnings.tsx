"use client";

import { useMemo, useState } from "react";
import { buildCashEarnings } from "../../../utils/portfolioCashEarnings.js";
import { downloadText } from "../../../utils/download.js";
import s from "../ResearchTools.module.css";

const labels: Record<string, string> = {
  "positive:positive": "Positive earnings · positive operating cash",
  "positive:nonpositive": "Positive earnings · non-positive operating cash",
  "nonpositive:positive": "Non-positive earnings · positive operating cash",
  "nonpositive:nonpositive": "Neither earnings nor operating cash is positive",
};
const money = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    notation: "compact",
  });
export default function CashEarnings({
  report,
  companies,
  capturedAt,
  onInspect,
}: {
  report: any;
  companies: any[];
  capturedAt?: string | null;
  onInspect: (rowId: string) => void;
}) {
  const result = useMemo(
    () => buildCashEarnings(report, companies),
    [report, companies],
  );
  const [selected, setSelected] = useState("positive:nonpositive");
  const [limit, setLimit] = useState(15);
  const cell = result.cells.find((entry: any) => entry.id === selected)!;
  return (
    <section className={s.root} aria-labelledby="cash-earnings-title">
      <div className={s.heading}>
        <div>
          <p className={s.eyebrow}>Cash backing of reported earnings</p>
          <h3 id="cash-earnings-title">
            Are profits accompanied by operating cash?
          </h3>
        </div>
        <button
          onClick={() =>
            downloadText(
              "portfolio-cash-earnings.json",
              JSON.stringify(
                {
                  schema_version: "edgar.portfolio-cash-earnings.v1",
                  captured_at: capturedAt || null,
                  exported_at: new Date().toISOString(),
                  selected_cell: selected,
                  ...result,
                },
                null,
                2,
              ),
              "application/json",
            )
          }
        >
          Export cash / earnings evidence
        </button>
      </div>
      <div className={s.finding}>
        <strong>
          {result.profitable
            ? `${result.confirmed} of ${result.profitable} profitable companies with aligned evidence generated positive operating cash flow (${result.confirmationPct!.toFixed(1)}%).`
            : "No profitable companies have aligned earnings and cash-flow evidence in this snapshot."}
        </strong>
        <p>
          {result.profitable > 0 &&
            `${result.profitable - result.confirmed} did not. `}
          Working-capital timing and non-cash items can explain differences.
          This is a prompt to inspect the statements, not an earnings-quality
          score.
        </p>
      </div>
      <p>
        {result.count} operating companies have both USD measures on the same
        full annual or TTM period. Each company counts once. Zero is included in
        “non-positive.” Banks, insurers, REITs and funds are excluded because
        cash flows need different interpretation.
      </p>
      <details className={s.details}>
        <summary>Explore the four combinations and source companies</summary>
        <div className={s.matrix}>
          {result.cells.map((entry: any) => (
            <button
              key={entry.id}
              aria-pressed={selected === entry.id}
              onClick={() => {
                setSelected(entry.id);
                setLimit(15);
              }}
            >
              <span>{labels[entry.id]}</span>
              <strong>{entry.observations.length}</strong>
              <small>
                {result.count
                  ? `${((100 * entry.observations.length) / result.count).toFixed(1)}% of ${result.count} paired companies`
                  : "No paired observations"}
                {report.weighted &&
                  ` · ${entry.knownWeightPct === null ? "Unknown allocation" : `${entry.knownWeightPct.toFixed(2)}% known saved allocation`}${entry.missingWeightCount ? `; ${entry.missingWeightCount} incomplete holding weights` : ""}`}
              </small>
            </button>
          ))}
        </div>
        <p role="status">
          {cell.observations.length} companies: {labels[selected].toLowerCase()}
          .
        </p>
        {cell.observations.length > 0 && (
          <div
            className={s.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="Selected cash and earnings observations"
          >
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Net income</th>
                  <th>Operating cash flow</th>
                  <th>Reporting period</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {cell.observations.slice(0, limit).map((row: any) => (
                  <tr key={row.cik}>
                    <th>{row.ticker}</th>
                    <td>{money(row.income)}</td>
                    <td>{money(row.operatingCashFlow)}</td>
                    <td>
                      {row.period.start} to {row.period.end}
                      <small>{row.period.kind}</small>
                    </td>
                    <td>
                      <button onClick={() => onInspect(row.rowId)}>
                        Inspect company
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cell.observations.length > limit && (
          <button onClick={() => setLimit((n) => n + 15)}>
            Show 15 more companies
          </button>
        )}
        <p>
          Excluded identified holdings: {result.excluded.businessType} business
          types outside this diagnostic; {result.excluded.missing} missing or
          unsupported evidence; {result.excluded.period} mismatched or unknown
          full periods. Unresolved holdings cannot be classified. Fiscal periods
          can differ between companies.
        </p>
        {report.weighted && (
          <p>
            Allocation subtotals retain saved portfolio allocation weights,
            including any explicit normalization you selected. Missing weights
            remain unknown and this diagnostic never rescales its covered subset
            to 100%.
          </p>
        )}
      </details>
    </section>
  );
}
