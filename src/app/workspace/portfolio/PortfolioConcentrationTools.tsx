"use client";

import { useId, useMemo, useState } from "react";
import { ArrowUpRight, SlidersHorizontal, TrendingUp } from "lucide-react";
import {
  buildConcentrationAnalysis,
  DEFAULT_RESEARCH_LIMITS,
} from "../../../utils/portfolioConcentration.js";
import s from "./PortfolioConcentrationTools.module.css";

const numeric = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const num = (value: unknown, digits = 2) =>
  numeric(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "Unavailable";
const percent = (value: unknown) =>
  numeric(value) ? `${num(value)}%` : "Unknown";
const labels = {
  "invalid-limit": "Set a valid limit",
  unweighted: "No allocation",
  breached: "Above limit",
  "within-limit": "Within limit",
  "not-confirmed": "Not confirmed",
};

export default function PortfolioConcentrationTools({
  report,
  onInspectCompany,
}: {
  report: any;
  onInspectCompany: (rowId: string) => void;
}) {
  const id = useId();
  const [issuerLimit, setIssuerLimit] = useState(
    String(DEFAULT_RESEARCH_LIMITS.issuerPct),
  );
  const [industryLimit, setIndustryLimit] = useState(
    String(DEFAULT_RESEARCH_LIMITS.industryPct),
  );
  const [kind, setKind] = useState<"issuer" | "industry">("issuer");
  const [breachesOnly, setBreachesOnly] = useState(false);
  const [rowsShown, setRowsShown] = useState(10);
  const [curveRows, setCurveRows] = useState(10);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const analysis = useMemo(
    () =>
      buildConcentrationAnalysis(report, {
        issuerPct: issuerLimit,
        industryPct: industryLimit,
      }),
    [report, issuerLimit, industryLimit],
  );
  const checks =
    kind === "issuer" ? analysis.issuerChecks : analysis.industryChecks;
  const filtered = checks.filter(
    (entry) => !breachesOnly || entry.status === "breached",
  );
  const selected = checks.find((entry) => entry.id === selectedGroup);
  const members = selected
    ? report.concentration.issuers.filter((issuer: any) =>
        selected.ciks.includes(issuer.cik),
      )
    : [];
  const maxWeight = Math.max(100, analysis.cumulativeKnownWeightPct || 0);
  const x = (rank: number) =>
    48 + (rank / Math.max(analysis.curve.length, 1)) * 540;
  const y = (weight: number) => 132 - (weight / maxWeight) * 112;
  const points = [
    `48,132`,
    ...analysis.curve.map(
      (issuer) => `${x(issuer.rank)},${y(issuer.cumulativeWeightPct)}`,
    ),
  ].join(" ");
  return (
    <div className={s.root}>
      <section className={s.panel} aria-labelledby={`${id}-limits`}>
        <div className={s.heading}>
          <div>
            <p className={s.eyebrow}>
              <SlidersHorizontal size={15} aria-hidden="true" /> Your research
              limits
            </p>
            <h3 id={`${id}-limits`}>Where does exposure exceed your limits?</h3>
          </div>
        </div>
        <p className={s.intro}>
          Set your own review thresholds. The starting values are illustrative,
          not recommendations. Changes apply only to this view.
        </p>
        <div className={s.controls}>
          <label htmlFor={`${id}-issuer`}>
            Issuer limit (%)
            <input
              id={`${id}-issuer`}
              type="number"
              min="0"
              max="100"
              step="0.5"
              value={issuerLimit}
              onChange={(event) => setIssuerLimit(event.target.value)}
              aria-invalid={analysis.limits.issuerPct === null}
              aria-describedby={
                analysis.limits.issuerPct === null ? `${id}-errors` : undefined
              }
            />
          </label>
          <label htmlFor={`${id}-industry`}>
            SEC-industry limit (%)
            <input
              id={`${id}-industry`}
              type="number"
              min="0"
              max="100"
              step="0.5"
              value={industryLimit}
              onChange={(event) => setIndustryLimit(event.target.value)}
              aria-invalid={analysis.limits.industryPct === null}
              aria-describedby={
                analysis.limits.industryPct === null
                  ? `${id}-errors`
                  : undefined
              }
            />
          </label>
          <div className={s.limitSummary} aria-live="polite">
            <strong>
              {!analysis.weighted
                ? "Add an allocation"
                : analysis.errors.length
                  ? "Check your limits"
                  : `${analysis.breaches.length} known ${analysis.breaches.length === 1 ? "breach" : "breaches"}`}
            </strong>
            <span>Issuer and industry checks can overlap.</span>
          </div>
        </div>
        {analysis.errors.length > 0 && (
          <p id={`${id}-errors`} className={s.notice} role="status">
            {analysis.errors.join(" ")}
          </p>
        )}
        {!analysis.complete && (
          <p className={s.notice}>
            {analysis.weighted
              ? "Incomplete allocation: supplied weights can identify known breaches, but cannot confirm that other groups are within a limit. Missing weights or unresolved identities may increase exposure. Weights are not normalized."
              : "A company count does not establish exposure. Choose an explicit allocation basis to use percentage limits."}
          </p>
        )}
        <div className={s.toolbar}>
          <div className={s.tabs} aria-label="Concentration limit groups">
            {(["issuer", "industry"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => {
                  setKind(value);
                  setSelectedGroup(null);
                  setRowsShown(10);
                }}
              >
                {value === "issuer" ? "Issuers" : "SEC industries"}
              </button>
            ))}
          </div>
          <label className={s.checkbox}>
            <input
              type="checkbox"
              checked={breachesOnly}
              onChange={(event) => {
                setBreachesOnly(event.target.checked);
                setRowsShown(10);
              }}
            />
            Only known breaches
          </label>
        </div>
        <div
          className={s.tableWrap}
          role="region"
          aria-label="Concentration limit results"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">
                  {kind === "issuer" ? "Issuer" : "SEC industry"}
                </th>
                <th scope="col">
                  {analysis.complete ? "Allocation" : "Known weight"}
                </th>
                <th scope="col">Limit check</th>
                <th scope="col">Above limit</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, rowsShown).map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">
                    {entry.tickers.length > 0 && (
                      <strong>{entry.tickers.join(" / ")}</strong>
                    )}
                    <span>{entry.label}</span>
                    <small>
                      {entry.rowIds.length} included{" "}
                      {entry.rowIds.length === 1 ? "position" : "positions"}
                    </small>
                  </th>
                  <td className={s.numeric}>
                    {percent(entry.knownWeightPct)}
                    {entry.lowerBound && numeric(entry.knownWeightPct) && (
                      <small>Known subtotal</small>
                    )}
                  </td>
                  <td>
                    <span className={s.status} data-status={entry.status}>
                      {labels[entry.status]}
                    </span>
                    <small>
                      {numeric(entry.limitPct)
                        ? `${percent(entry.limitPct)} limit`
                        : "Invalid limit"}
                    </small>
                  </td>
                  <td className={s.numeric}>
                    {numeric(entry.excessPct)
                      ? `${num(entry.excessPct)} percentage points`
                      : "—"}
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedGroup(
                          selectedGroup === entry.id ? null : entry.id,
                        )
                      }
                      aria-expanded={selectedGroup === entry.id}
                      aria-label={`Review positions in ${entry.label}`}
                    >
                      {selectedGroup === entry.id ? "Close" : "Review"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <p className={s.empty}>
            {analysis.errors.length
              ? "Enter valid limits to complete these checks."
              : breachesOnly
                ? analysis.complete
                  ? "No groups exceed the limits shown."
                  : "No known breaches are shown. Incomplete exposure cannot establish that a group is within its limit."
                : "No included groups are available yet."}
          </p>
        )}
        {filtered.length > rowsShown && (
          <button
            className={s.more}
            type="button"
            onClick={() => setRowsShown((value) => value + 20)}
          >
            Show more limit checks ({Math.min(rowsShown, filtered.length)} of{" "}
            {filtered.length})
          </button>
        )}
        {selected && (
          <div className={s.members}>
            <div className={s.memberHeading}>
              <h4>{selected.label}</h4>
              <span>
                {selected.rowIds.length} included positions ·{" "}
                {percent(selected.knownWeightPct)}{" "}
                {analysis.complete ? "allocation" : "known weight"}
              </span>
            </div>
            {members.length ? (
              <ul>
                {members.map((issuer: any) => (
                  <li key={issuer.cik}>
                    <button
                      type="button"
                      onClick={() => onInspectCompany(issuer.rowIds[0])}
                    >
                      <span>
                        <strong>
                          {issuer.tickers.join(" / ") || issuer.name}
                        </strong>
                        <small>
                          {issuer.name} · {issuer.rowIds.length}{" "}
                          {issuer.rowIds.length === 1
                            ? "position"
                            : "positions"}
                        </small>
                      </span>
                      <span>
                        {percent(issuer.weightPct)}
                        <ArrowUpRight size={15} aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                Confirm these positions in Evidence coverage before opening
                company evidence.
              </p>
            )}
          </div>
        )}
      </section>
      <section className={s.panel} aria-labelledby={`${id}-curve`}>
        <div className={s.heading}>
          <div>
            <p className={s.eyebrow}>
              <TrendingUp size={15} aria-hidden="true" /> Concentration in
              context
            </p>
            <h3 id={`${id}-curve`}>How quickly does exposure accumulate?</h3>
          </div>
        </div>
        <p className={s.intro}>
          Issuers are ordered by{" "}
          {analysis.complete ? "allocation" : "known supplied weight"}, largest
          first. The curve adds their original weights; share classes are
          combined.
        </p>
        {!analysis.weighted || !analysis.curve.length ? (
          <p className={s.notice}>
            Add valid position weights to see cumulative exposure. Company
            counts are not converted into portfolio weights.
          </p>
        ) : (
          <>
            <div className={s.curveStats}>
              <div>
                <span>
                  {analysis.complete
                    ? "Issuers covering at least 50%"
                    : "Known issuer exposure"}
                </span>
                <strong>
                  {analysis.complete
                    ? analysis.halfExposureIssuerCount
                    : percent(analysis.cumulativeKnownWeightPct)}
                </strong>
              </div>
              <div>
                <span>
                  {analysis.complete
                    ? "Issuers covering at least 80%"
                    : "Issuers with incomplete weights"}
                </span>
                <strong>
                  {analysis.complete
                    ? analysis.eightyExposureIssuerCount
                    : analysis.unknownIssuerCount}
                </strong>
              </div>
              <div>
                <span>
                  {analysis.complete
                    ? "Herfindahl–Hirschman index"
                    : "Unresolved positions"}
                </span>
                <strong>
                  {analysis.complete
                    ? num(analysis.hhi)
                    : analysis.unresolvedCount}
                </strong>
              </div>
            </div>
            {!analysis.complete && (
              <p className={s.notice}>
                This curve shows known issuer subtotals only. Missing weights
                can change the order; unresolved positions are excluded from
                issuer grouping. Full concentration statistics require a
                complete, reviewed 100% allocation.
              </p>
            )}
            <svg
              className={s.curve}
              viewBox="0 0 640 182"
              role="img"
              aria-labelledby={`${id}-curve-title ${id}-curve-desc`}
            >
              <title id={`${id}-curve-title`}>
                Cumulative {analysis.complete ? "portfolio" : "known issuer"}{" "}
                exposure
              </title>
              <desc id={`${id}-curve-desc`}>
                Largest issuer first. {analysis.curve.length} issuers with known
                weights sum to {percent(analysis.cumulativeKnownWeightPct)}.
                Values are available in the table below.
              </desc>
              {[0, maxWeight / 2, maxWeight].map((value) => (
                <g key={value}>
                  <line
                    x1="48"
                    x2="588"
                    y1={y(value)}
                    y2={y(value)}
                    className={s.gridLine}
                  />
                  <text x="39" y={y(value) + 4} textAnchor="end">
                    {num(value, 0)}%
                  </text>
                </g>
              ))}
              <polyline
                points={points}
                fill="none"
                className={s.curveLine}
                vectorEffect="non-scaling-stroke"
              />
              <text x="48" y="154" textAnchor="middle">
                0
              </text>
              <text x="588" y="154" textAnchor="middle">
                {analysis.curve.length}
              </text>
              <text x="318" y="176" textAnchor="middle">
                Number of issuers, largest known weight first
              </text>
            </svg>
            <div
              className={s.tableWrap}
              role="region"
              aria-label="Cumulative exposure and HHI contributions"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Rank</th>
                    <th scope="col">Issuer</th>
                    <th scope="col">
                      {analysis.complete ? "Allocation" : "Known weight"}
                    </th>
                    <th scope="col">Cumulative weight</th>
                    {analysis.complete && (
                      <>
                        <th scope="col">HHI points</th>
                        <th scope="col">Share of HHI</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {analysis.curve.slice(0, curveRows).map((issuer) => (
                    <tr key={issuer.cik}>
                      <td>{issuer.rank}</td>
                      <th scope="row">
                        <button
                          className={s.issuerLink}
                          type="button"
                          onClick={() => onInspectCompany(issuer.rowIds[0])}
                        >
                          {issuer.tickers.join(" / ") || issuer.name}
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </button>
                        <small>{issuer.name}</small>
                      </th>
                      <td className={s.numeric}>{percent(issuer.weightPct)}</td>
                      <td className={s.numeric}>
                        {percent(issuer.cumulativeWeightPct)}
                      </td>
                      {analysis.complete && (
                        <>
                          <td className={s.numeric}>{num(issuer.hhiPoints)}</td>
                          <td className={s.numeric}>
                            {percent(issuer.hhiSharePct)}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {analysis.curve.length > curveRows && (
              <button
                className={s.more}
                type="button"
                onClick={() => setCurveRows((value) => value + 20)}
              >
                Show more issuer contributions (
                {Math.min(curveRows, analysis.curve.length)} of{" "}
                {analysis.curve.length})
              </button>
            )}
            {analysis.complete && (
              <p className={s.footnote}>
                HHI points = issuer weight in percentage points squared. Share
                of HHI = issuer HHI points ÷ total HHI. A 60% issuer contributes
                3,600 points. This measures direct issuer concentration; it does
                not measure volatility, correlation, or underlying fund
                holdings.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
