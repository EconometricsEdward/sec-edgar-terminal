"use client";

import { useMemo, useState } from "react";
import {
  comparePortfolioProfiles,
  portfolioComparisonProfile,
} from "../../utils/portfolioComparison.js";
import { downloadText } from "../../utils/download.js";
import s from "./ResearchTools.module.css";

const number = (n: number | null, unit = "") =>
  typeof n === "number" && Number.isFinite(n)
    ? `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}${unit}`
    : "Unavailable";
type Props = {
  documents: any[];
  activeId: string;
  onNavigate: (view: string, options?: any) => void;
};

export default function HubComparison({
  documents,
  activeId,
  onNavigate,
}: Props) {
  const [leftId, setLeftId] = useState(activeId || documents[0]?.id || "");
  const [rightId, setRightId] = useState(
    documents.find((d) => d.id !== (activeId || documents[0]?.id))?.id || "",
  );
  const [metricId, setMetricId] = useState("netMargin");
  const [membership, setMembership] = useState("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(20);
  const leftDocument = documents.find((d) => d.id === leftId);
  const rightDocument = documents.find((d) => d.id === rightId);
  const left = useMemo(
    () => (leftDocument ? portfolioComparisonProfile(leftDocument) : null),
    [leftDocument],
  );
  const right = useMemo(
    () => (rightDocument ? portfolioComparisonProfile(rightDocument) : null),
    [rightDocument],
  );
  const comparison: any = useMemo(
    () =>
      left && right ? comparePortfolioProfiles(left, right, metricId) : null,
    [left, right, metricId],
  );
  const valid = comparison && leftId !== rightId;
  const members = valid
    ? comparison.members
        .filter(
          (row: any) =>
            (membership === "all" || row.membership === membership) &&
            `${row.ticker} ${row.name}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
        )
        .sort(
          (a: any, b: any) =>
            Math.abs(b.difference || 0) - Math.abs(a.difference || 0) ||
            a.ticker.localeCompare(b.ticker),
        )
    : [];
  const selectionChanged = () => setLimit(20);
  const inspect = (portfolioId: string, rowId: string) =>
    onNavigate("portfolios", { portfolioId, rowId, portfolioTab: "research" });
  return (
    <section className={s.root} aria-labelledby="hub-comparison-title">
      <div className={s.heading}>
        <div>
          <p className={s.eyebrow}>Two saved portfolios, one view</p>
          <h3 id="hub-comparison-title">
            Compare coverage, holdings and fundamentals
          </h3>
        </div>
        <button
          disabled={!valid}
          onClick={() =>
            downloadText(
              "portfolio-comparison.json",
              JSON.stringify(
                {
                  schema_version: "edgar.portfolio-comparison.v1",
                  exported_at: new Date().toISOString(),
                  ...comparison,
                  selection: { membership, query, resultCount: members.length },
                  selectedMembers: members,
                },
                null,
                2,
              ),
              "application/json",
            )
          }
        >
          Export this comparison
        </button>
      </div>
      <p>
        Uses the snapshots saved in this browser. “A” and “B” identify your
        selections; differences are B minus A. Opening this comparison does not
        request new SEC data.
      </p>
      <div className={s.controls}>
        <label>
          Portfolio A
          <select
            value={leftId}
            onChange={(e) => {
              setLeftId(e.target.value);
              selectionChanged();
            }}
          >
            {!leftDocument && (
              <option value={leftId}>Choose a saved portfolio</option>
            )}
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Portfolio B
          <select
            value={rightId}
            onChange={(e) => {
              setRightId(e.target.value);
              selectionChanged();
            }}
          >
            {!rightDocument && (
              <option value={rightId}>Choose a saved portfolio</option>
            )}
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!valid ? (
        <p role="status">Choose two different saved portfolios to compare.</p>
      ) : (
        <>
          <div className={s.cards}>
            {[comparison.left, comparison.right].map(
              (profile: any, i: number) => (
                <article key={profile.id}>
                  <h4>
                    {i ? "B" : "A"} · {profile.name}
                  </h4>
                  <strong>
                    {profile.availableCompanies === null
                      ? "Not captured"
                      : `${profile.availableCompanies} / ${profile.totalCompanies} operating issuers`}
                  </strong>
                  <p>
                    {profile.hasSnapshot
                      ? "At least one supported financial measure available"
                      : "Capture a snapshot in Portfolio research"}{" "}
                    · {profile.basis}
                  </p>
                  <small>
                    Captured {profile.capturedAt || "not yet"} ·{" "}
                    {profile.unresolved} unresolved positions ·{" "}
                    {profile.incomplete} retrieval gaps
                  </small>
                  <button
                    onClick={() =>
                      onNavigate("portfolios", {
                        portfolioId: profile.id,
                        analyticsArea: "coverage",
                        portfolioTab: "analytics",
                      })
                    }
                  >
                    Inspect evidence coverage
                  </button>
                </article>
              ),
            )}
          </div>
          <div className={s.finding} role="status">
            <strong>
              {comparison.membership.shared} shared issuers out of{" "}
              {comparison.membership.union} across both portfolios.
            </strong>
            <p>
              {comparison.membership.leftOnly} appear only in A;{" "}
              {comparison.membership.rightOnly} only in B. Shared issuers make
              up {number(comparison.membership.jaccardPct, "%")} of the combined
              issuer set. Share classes count once; funds are not looked through
              to their holdings.
            </p>
            {comparison.allocation.available ? (
              <p>
                <strong>
                  {number(comparison.allocation.overlapPct, "%")} allocation
                  overlap:
                </strong>{" "}
                the smaller allocation to each issuer, added across shared
                issuers. This describes shared holdings; different issuers can
                still carry similar economic risks. Saved allocation bases: A{" "}
                {comparison.allocation.leftBasis}
                {comparison.allocation.leftNormalized
                  ? " (explicitly normalized)"
                  : ""}
                ; B {comparison.allocation.rightBasis}
                {comparison.allocation.rightNormalized
                  ? " (explicitly normalized)"
                  : ""}
                .
              </p>
            ) : (
              <p>
                Allocation comparison unavailable.{" "}
                {comparison.allocation.reason}
              </p>
            )}
          </div>
          <div className={s.controls}>
            <label>
              Issuer group
              <select
                value={membership}
                onChange={(e) => {
                  setMembership(e.target.value);
                  selectionChanged();
                }}
              >
                <option value="all">All issuers</option>
                <option value="shared">Shared issuers</option>
                <option value="left">Only in A</option>
                <option value="right">Only in B</option>
              </select>
            </label>
            <label>
              Find an issuer
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  selectionChanged();
                }}
                placeholder="Ticker or company"
                maxLength={160}
              />
            </label>
          </div>
          <p role="status">
            {members.length} matching issuers. Complete allocations sort by
            largest absolute difference.
          </p>
          <div
            className={s.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="Issuer and allocation comparison"
          >
            <table>
              <thead>
                <tr>
                  <th>Issuer</th>
                  <th>Membership</th>
                  <th>A allocation</th>
                  <th>B allocation</th>
                  <th>B − A</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {members.slice(0, limit).map((row: any) => (
                  <tr key={row.cik}>
                    <th>
                      {row.ticker}
                      <small>{row.name}</small>
                    </th>
                    <td>
                      {row.membership === "shared"
                        ? "Both"
                        : row.membership === "left"
                          ? "Only A"
                          : "Only B"}
                    </td>
                    <td>
                      {comparison.allocation.available
                        ? number(row.leftWeight ?? 0, "%")
                        : "Unavailable"}
                    </td>
                    <td>
                      {comparison.allocation.available
                        ? number(row.rightWeight ?? 0, "%")
                        : "Unavailable"}
                    </td>
                    <td>{number(row.difference, " pp")}</td>
                    <td>
                      {row.leftRow && (
                        <button onClick={() => inspect(leftId, row.leftRow)}>
                          Open A
                        </button>
                      )}{" "}
                      {row.rightRow && (
                        <button onClick={() => inspect(rightId, row.rightRow)}>
                          Open B
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {members.length > limit && (
            <button onClick={() => setLimit((n) => n + 20)}>
              Show 20 more issuers
            </button>
          )}
          <details className={s.details}>
            <summary>
              Compare financial profiles and matched reporting periods
            </summary>
            <div className={s.controls}>
              <label>
                Financial measure
                <select
                  value={metricId}
                  onChange={(e) => setMetricId(e.target.value)}
                >
                  {left!.report.metrics.map((m: any) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p>
              Whole-list medians: A{" "}
              {number(comparison.financial.leftMedian, comparison.unit)} across{" "}
              {comparison.financial.leftAvailable} eligible observations; B{" "}
              {number(comparison.financial.rightMedian, comparison.unit)} across{" "}
              {comparison.financial.rightAvailable}. These describe each saved
              sample. Membership, reporting periods and business types can
              differ.
            </p>
            <div className={s.finding}>
              <strong>
                {comparison.financial.pairedCount} shared issuers have
                comparable {comparison.metricLabel.toLowerCase()} observations.
              </strong>
              <p>
                Matching requires the same metric definition, unit, accounting
                basis and full reporting period.{" "}
                {comparison.financial.excluded.length} shared issuers are
                excluded.
              </p>
              {comparison.financial.pairedCount > 0 ? (
                <p>
                  On this matched sample, A’s median is{" "}
                  {number(
                    comparison.financial.leftPairedMedian,
                    comparison.unit,
                  )}{" "}
                  and B’s is{" "}
                  {number(
                    comparison.financial.rightPairedMedian,
                    comparison.unit,
                  )}
                  . The median issuer difference is{" "}
                  {number(
                    comparison.financial.medianDifference,
                    comparison.unit === "%" ? " pp" : comparison.unit,
                  )}
                  . Differences for the same reporting period can reflect
                  revisions or retrieval methodology; they do not measure
                  subsequent growth.
                </p>
              ) : (
                <p>
                  No matched-period difference is reported. Capture comparable
                  snapshots or choose another measure.
                </p>
              )}
            </div>
            {comparison.financial.pairs.length > 0 && (
              <div
                className={s.tableWrap}
                tabIndex={0}
                role="region"
                aria-label="Matched financial observations"
              >
                <table>
                  <thead>
                    <tr>
                      <th>Issuer</th>
                      <th>Reporting period</th>
                      <th>A</th>
                      <th>B</th>
                      <th>Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.financial.pairs.map((pair: any) => (
                      <tr key={pair.cik}>
                        <th>{pair.ticker}</th>
                        <td>
                          {pair.period.start} to {pair.period.end}
                          <small>{pair.period.kind}</small>
                        </td>
                        <td>{number(pair.left, comparison.unit)}</td>
                        <td>{number(pair.right, comparison.unit)}</td>
                        <td>
                          {number(
                            pair.difference,
                            comparison.unit === "%" ? " pp" : comparison.unit,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {comparison.financial.excluded.length > 0 && (
              <details>
                <summary>Why shared issuers were excluded</summary>
                <ul>
                  {comparison.financial.excluded.map((row: any) => (
                    <li key={row.cik}>
                      {comparison.members.find(
                        (member: any) => member.cik === row.cik,
                      )?.ticker || row.cik}
                      : {row.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </details>
          <small>
            The JSON export includes the selected measure, all comparison
            results, the current issuer filter, timestamps and matched source
            links. Private notes are omitted. No portfolio return or performance
            ranking is calculated.
          </small>
        </>
      )}
    </section>
  );
}
