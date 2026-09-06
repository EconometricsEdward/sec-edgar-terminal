"use client";
import { ArrowUpRight, Building2, Landmark, ShieldCheck } from "lucide-react";
import { buildCapitalLab } from "../../utils/analysisCapital.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./analysisLabs.module.css";

export default function AnalysisCapitalLab({
  data,
  settings,
  index,
  onInspect,
}: any) {
  const capital = buildCapitalLab(data, settings, index);
  const bank = data.lens === "banking";
  const insurer = data.lens === "insurance";
  const Icon = bank ? Landmark : insurer ? ShieldCheck : Building2;
  const inspect = (definition: any, point: any) =>
    onInspect({ definition, point });
  const fmt = (point: any, format = "currency") =>
    analysisValue(point?.value, format, settings.units);
  const renderTable = (rows: any[], title: string, subtitle: string) => (
    <section className={styles.panel} aria-label={title}>
      <div className={styles.heading}>
        <div>
          <h3>{title}</h3>
          <p className={styles.description}>{subtitle}</p>
        </div>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>
            {capital.period?.end}
            {capital.beforePeriod
              ? ` compared with ${capital.beforePeriod.end}`
              : " · comparison unavailable"}
            . Select amounts, asset shares or changes to inspect their sources.
          </caption>
          <thead>
            <tr>
              <th scope="col">Reported category</th>
              <th scope="col">Selected balance</th>
              <th scope="col">Share of assets</th>
              <th scope="col">Change in balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.definition.key}>
                <th scope="row">
                  {row.definition.label}
                  {["shortTermDebt", "longTermDebt"].includes(
                    row.definition.key,
                  ) && (
                    <small>
                      {row.point.sources?.map((s: any) => s.tag).join(" · ") ||
                        "Concept unavailable"}
                    </small>
                  )}
                </th>
                <td>
                  <button onClick={() => inspect(row.definition, row.point)}>
                    {fmt(row.point)}
                  </button>
                </td>
                <td>
                  <button
                    className={styles.shareButton}
                    onClick={() =>
                      inspect(
                        {
                          key: `${row.definition.key}AssetShare`,
                          label: `${row.definition.label} / assets`,
                          format: "percent",
                        },
                        row.share,
                      )
                    }
                  >
                    <span className={styles.shareTrack} aria-hidden="true">
                      <i
                        style={{
                          width: Number.isFinite(row.share.value)
                            ? `${Math.min(100, Math.max(0, row.share.value))}%`
                            : "0%",
                        }}
                      />
                    </span>
                    {fmt(row.share, "percent")}
                  </button>
                </td>
                <td>
                  <button
                    title={
                      row.change.reason ||
                      `Compared with ${capital.beforePeriod?.end}`
                    }
                    onClick={() =>
                      inspect(
                        {
                          key: `${row.definition.key}BalanceChange`,
                          label: `Change in ${row.definition.label.toLowerCase()}`,
                          format: "currency",
                        },
                        row.change,
                      )
                    }
                  >
                    {Number.isFinite(row.change.value) && row.change.value > 0
                      ? "+"
                      : ""}
                    {fmt(row.change)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
  return (
    <div className={styles.lab}>
      <section className={styles.panel} aria-labelledby="capital-lab-title">
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>
              <Icon size={14} />{" "}
              {bank
                ? "Bank funding"
                : insurer
                  ? "Insurance capital"
                  : "Corporate balance sheet"}
            </p>
            <h2 id="capital-lab-title">What funds the balance sheet?</h2>
            <p className={styles.description}>
              {bank
                ? "Trace deposits, net loans and book capital without assuming a bank has a corporate working-capital structure."
                : insurer
                  ? "Inspect reported assets, liabilities and book equity. Insurance reserves and regulatory capital need the original insurance disclosures."
                  : "See the scale and movement of reported asset categories alongside the liabilities and equity that support them."}
            </p>
          </div>
          <button
            className={styles.assetTotal}
            onClick={() =>
              inspect(
                {
                  key: "totalAssets",
                  label: "Total assets",
                  format: "currency",
                },
                capital.assets,
              )
            }
          >
            <span>Total assets · {capital.period?.end}</span>
            <strong>{fmt(capital.assets)}</strong>
            <small>
              Inspect SEC source <ArrowUpRight size={13} />
            </small>
          </button>
        </div>
        <div className={styles.cards}>
          {capital.ratios.map((row: any) => (
            <button
              className={styles.metric}
              key={row.definition.key}
              onClick={() => inspect(row.definition, row.point)}
            >
              <span>{row.definition.label}</span>
              <strong>{fmt(row.point, "percent")}</strong>
              <small>
                Inspect definition and source <ArrowUpRight size={13} />
              </small>
            </button>
          ))}
        </div>
        <p className={styles.notice}>
          {bank
            ? "Book equity is not CET1 or regulatory capital; reported cash is not an LCR buffer. Net loans / deposits does not establish deposit stability or available borrowing capacity."
            : insurer
              ? "These are consolidated accounting measures, not statutory surplus, risk-based capital or insurer solvency ratios. Review separate-account, reserve and reinsurance disclosures in the original filings."
              : "Cash and debt balances do not reveal all restrictions, undrawn facilities, maturities or guarantees. Current and long-term debt concepts are shown separately because their XBRL scopes can overlap or omit borrowings."}
        </p>
        {!capital.beforePeriod && (
          <p className={styles.notice}>
            No compatible comparison date is available for the selected
            baseline. Change cells remain unavailable; choose another baseline
            in the page controls.
          </p>
        )}
      </section>
      {renderTable(
        capital.assetRows,
        "Where assets are held",
        "Selected reported categories, each measured against total assets. They are not an exhaustive asset breakdown and are not summed.",
      )}
      {renderTable(
        capital.fundingRows,
        "Funding and capital movements",
        "Liability totals include the component balances shown below them. These rows overlap and must not be added.",
      )}
      <section className={styles.panel}>
        <h3>Read the scope before drawing conclusions</h3>
        <div className={styles.methodGrid}>
          <div>
            <strong>Changes preserve the reported concept</strong>
            <p className={styles.description}>
              A change is withheld when either date is missing or the source
              concept switches. Review the filing definitions before treating
              two different tags as comparable.
            </p>
          </div>
          <div>
            <strong>Accounting equity has a defined perimeter</strong>
            <p className={styles.description}>
              The reported equity concept can exclude noncontrolling interests.
              Use Data Checks for the separately reported consolidated balance
              equation.
            </p>
          </div>
          <div>
            <strong>Debt concepts are not a maturity schedule</strong>
            <p className={styles.description}>
              The current-debt selector can represent current long-term debt,
              short-term borrowings or aggregate current debt. The long-term
              concept can vary too. This lab does not add them into total debt.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
