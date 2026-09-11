"use client";
import { useMemo, useState } from "react";
import { buildPortfolioScenario } from "../../../utils/portfolioScenario.js";
import {
  mixedPriceScenario,
  rebalanceAllocation,
} from "../../../utils/portfolioEnrichment.js";
import PortfolioInsightTools, {
  AnalysisTable,
  Stats,
  number,
} from "./PortfolioInsightTools";
import s from "./PortfolioInsightTools.module.css";
type Override = { scope: string; target: string; shockPct: string };
export default function PortfolioScenarioWorkbench({
  report,
  rows,
  settings,
  companies,
  view,
  onInspect,
}: {
  report: any;
  rows: any[];
  settings: any;
  companies: any[];
  view: string;
  onInspect: (rowId: string) => void;
}) {
  const [overrides, setOverrides] = useState<Override[]>([]),
    [remainder, setRemainder] = useState("-10"),
    [equal, setEqual] = useState(false);
  const basis = (settings.allocation || settings).basis;
  const [previousBasis, setPreviousBasis] = useState(basis);
  const [targets, setTargets] = useState<Record<string, string>>({}),
    [afterShock, setAfterShock] = useState(false);
  if (previousBasis !== basis) {
    setPreviousBasis(basis);
    setEqual(false);
    setTargets({});
  }
  const base = useMemo(
    () =>
      buildPortfolioScenario(rows, settings, companies, {
        scope: "all",
        targetShockPct: 0,
        remainderShockPct: 0,
        equalWeight: equal,
      }),
    [rows, settings, companies, equal],
  );
  const mixed = useMemo(
    () => mixedPriceScenario(base, overrides, remainder),
    [base, overrides, remainder],
  );
  const effectiveTargets = useMemo(
    () =>
      Object.fromEntries(
        (mixed.contributions || []).map((row: any) => [
          row.cik,
          targets[row.cik] ?? String(row.weightPct),
        ]),
      ),
    [mixed, targets],
  );
  const rebalanced = useMemo(
    () => rebalanceAllocation(mixed, effectiveTargets, afterShock),
    [mixed, effectiveTargets, afterShock],
  );
  const metadata = {
    captured_at: report.capturedAt,
    hypothetical: true,
    basis: base.basisLabel,
    custom_assumptions: overrides,
    remainder_shock_pct: remainder,
    precedence: "Company > industry > remainder",
    tool: view,
    after_shock: view === "rebalance" && afterShock,
  };
  function update(index: number, patch: Partial<Override>) {
    setOverrides(
      overrides.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }
  if (view === "operating")
    return (
      <PortfolioInsightTools
        report={report}
        companies={companies}
        view="operating"
        onInspect={onInspect}
      />
    );
  return (
    <section className={s.tool}>
      <div>
        <h3>
          {view === "mixed"
            ? "Model several price changes at once"
            : "Explore a different allocation"}
        </h3>
        <p>
          {view === "mixed"
            ? "Apply different assumptions to companies and industries in one scenario. A company override takes priority over its industry; all other holdings receive the remainder change."
            : "Compare your current allocation with editable targets. See the allocation changes, turnover, concentration, and impact of your chosen price assumptions."}
        </p>
      </div>
      {base.basis === "none" && !equal && (
        <div className={s.note}>
          <p>This company list has no invested weights.</p>
          <button type="button" onClick={() => setEqual(true)}>
            Use temporary equal weights
          </button>
        </div>
      )}
      {equal && (
        <p className={s.note}>
          Temporary equal weights across included positions.{" "}
          <button
            type="button"
            onClick={() => {
              setEqual(false);
              setTargets({});
            }}
          >
            Use saved allocation
          </button>
        </p>
      )}
      <div className={s.controls}>
        <label>
          Remainder price change (%)
          <input
            type="number"
            min="-100"
            max="100"
            value={remainder}
            onChange={(event) => setRemainder(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={overrides.length >= 20 || !base.issuers.length}
          onClick={() =>
            setOverrides([
              ...overrides,
              {
                scope: "company",
                target:
                  base.issuers.find(
                    (row: any) =>
                      !overrides.some(
                        (rule) =>
                          rule.scope === "company" && rule.target === row.cik,
                      ),
                  )?.cik || "",
                shockPct: "-20",
              },
            ])
          }
        >
          Add company or industry assumption
        </button>
      </div>
      {overrides.map((rule, index) => (
        <div className={s.override} key={index}>
          <label>
            Assumption {index + 1}
            <select
              value={rule.scope}
              onChange={(event) =>
                update(index, { scope: event.target.value, target: "" })
              }
            >
              <option value="company">Company</option>
              <option value="industry">SEC industry</option>
            </select>
          </label>
          <label>
            Target
            <select
              value={rule.target}
              onChange={(event) =>
                update(index, { target: event.target.value })
              }
            >
              <option value="">Choose a target</option>
              {rule.scope === "company"
                ? base.issuers.map((row: any) => (
                    <option key={row.cik} value={row.cik}>
                      {row.tickers.join(" / ") || row.name}
                    </option>
                  ))
                : base.industries.map((industry: string) => (
                    <option key={industry} value={industry}>
                      {industry}
                    </option>
                  ))}
            </select>
          </label>
          <label>
            Price change (%)
            <input
              type="number"
              min="-100"
              max="100"
              value={rule.shockPct}
              onChange={(event) =>
                update(index, { shockPct: event.target.value })
              }
            />
          </label>
          <button
            type="button"
            onClick={() =>
              setOverrides(overrides.filter((_, i) => i !== index))
            }
          >
            Remove assumption {index + 1}
          </button>
        </div>
      ))}
      {!mixed.eligible ? (
        <div role="alert">
          <p className={s.error}>{mixed.errors.join(" ")}</p>
        </div>
      ) : view === "mixed" ? (
        <>
          <Stats
            values={[
              [`Modeled portfolio change`, number(mixed.totalReturnPct, "%")],
              ["Holdings modeled", mixed.contributions.length],
              ["Custom assumptions", overrides.length],
            ]}
          />
          {!mixed.endingWeightsDefined && (
            <p className={s.note}>
              The modeled portfolio value is zero. Ending allocations are
              undefined.
            </p>
          )}
          <AnalysisTable
            rows={mixed.contributions.map((row: any) => ({
              cik: row.cik,
              rowId: row.rowId,
              name: row.name,
              ticker: row.ticker,
              industry: row.industry,
              weightPct: row.weightPct,
              assumption: row.assumption,
              shockPct: row.shockPct,
              contributionPct: row.contributionPct,
              endingWeightPct: row.endingWeightPct,
            }))}
            title="Scenario contributions"
            onInspect={onInspect}
            columns={[
              { key: "weightPct", label: "Starting allocation", unit: "%" },
              { key: "assumption", label: "Applied assumption" },
              { key: "shockPct", label: "Price change", unit: "%" },
              {
                key: "contributionPct",
                label: "Portfolio contribution",
                unit: "pp",
              },
              ...(mixed.endingWeightsDefined
                ? [
                    {
                      key: "endingWeightPct",
                      label: "Ending allocation",
                      unit: "%",
                    },
                  ]
                : []),
            ]}
            metadata={metadata}
            filename="portfolio-mixed-shocks"
          />
        </>
      ) : (
        <>
          <div className={s.controls}>
            <label>
              Starting allocation
              <select
                value={afterShock ? "after" : "current"}
                onChange={(event) =>
                  setAfterShock(event.target.value === "after")
                }
              >
                <option value="current">Current weights</option>
                <option value="after">Weights after these price changes</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() =>
                setTargets(
                  Object.fromEntries(
                    mixed.contributions.map((row: any) => [
                      row.cik,
                      String(100 / mixed.contributions.length),
                    ]),
                  ),
                )
              }
            >
              Set equal company targets
            </button>
            <button type="button" onClick={() => setTargets({})}>
              Restore original targets
            </button>
          </div>
          <p>
            Target total: <strong>{number(rebalanced.targetTotal, "%")}</strong>
            . Targets must total 100%; no residual is filled automatically.
          </p>
          {rebalanced.valid ? (
            <Stats
              values={[
                [
                  `One-way allocation turnover`,
                  number(rebalanced.turnoverPct, "%"),
                ],
                [
                  "Concentration (HHI), starting → target",
                  `${number(rebalanced.startingHhi)} → ${number(rebalanced.targetHhi)}`,
                ],
                [
                  afterShock
                    ? "Repeat scenario, starting → target"
                    : "Price scenario, current → target",
                  `${number(rebalanced.startingShockPct, "%")} → ${number(rebalanced.targetShockPct, "%")}`,
                ],
              ]}
            />
          ) : (
            <p role="alert" className={s.error}>
              {rebalanced.errors.join(" ")}
            </p>
          )}
          <AnalysisTable
            rows={rebalanced.rows}
            title="Edit target allocations"
            onInspect={onInspect}
            columns={[
              {
                key: "startingWeightPct",
                label: "Starting allocation",
                unit: "%",
              },
              {
                key: "targetWeightPct",
                label: "Target allocation (%)",
                render: (row) => (
                  <input
                    aria-label={`Target allocation for ${row.ticker || row.name}`}
                    type="number"
                    min="0"
                    max="100"
                    step="any"
                    value={effectiveTargets[row.cik] ?? ""}
                    onChange={(event) =>
                      setTargets({ ...targets, [row.cik]: event.target.value })
                    }
                  />
                ),
              },
              { key: "changePct", label: "Increase / decrease", unit: "pp" },
            ]}
            metadata={{
              ...metadata,
              valid_targets: rebalanced.valid,
              target_total: rebalanced.targetTotal,
              turnover_pct: rebalanced.valid ? rebalanced.turnoverPct : null,
              scope: "Hypothetical allocation exercise; not orders",
            }}
            filename="portfolio-target-allocations"
          />
          <p className={s.note}>
            Turnover = half the sum of absolute allocation changes. HHI = sum of
            squared percentage weights. After a shock, the scenario comparison
            applies the assumptions again to the starting and target
            allocations. Targets stay in this sandbox; no trades or saved-weight
            changes occur.
          </p>
        </>
      )}
      <details>
        <summary>Price-scenario assumptions</summary>
        <p>
          Each holding receives one price change. Contribution = starting
          allocation × price change ÷ 100. Company assumptions override industry
          assumptions. No correlations, taxes, fees, liquidity effects,
          dividends, or share quantities are modeled. Custom assumptions and
          effective holding shocks are included in this analysis’s CSV.
        </p>
      </details>
    </section>
  );
}
