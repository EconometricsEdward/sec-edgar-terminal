"use client";
import { useMemo, useState } from "react";
import {
  buildDisclosureMatrix,
  buildDisclosureTrends,
  DISCLOSURE_TOPICS,
} from "../../utils/disclosureResearch.js";
import type { CompanyScan } from "./disclosureTypes";
import s from "./disclosures.module.css";

export function DisclosureMatrix({
  companies,
  requested,
  inspect,
}: {
  companies: CompanyScan[];
  requested: string[];
  inspect: (ticker: string, topic: string, accessions: string[]) => void;
}) {
  const rows = useMemo(
    () => buildDisclosureMatrix(companies, requested),
    [companies, requested],
  );
  return (
    <section className={s.panel}>
      <div className={s.panelHeading}>
        <div>
          <span className={s.eyebrow}>Compare the evidence</span>
          <h2>Company × topic</h2>
        </div>
        <span className={s.badge}>Same search window & section</span>
      </div>
      <p className={s.muted}>
        Cells count successfully reviewed filings mentioning each topic,
        independently of your main query. Click a cell to read its evidence. A
        partial sample is always labeled.
      </p>
      <div className={s.tableScroll}>
        <table className={s.matrix}>
          <thead>
            <tr>
              <th>Company / coverage</th>
              {DISCLOSURE_TOPICS.map((topic) => (
                <th key={topic.id}>{topic.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ticker}>
                <th>
                  {row.ticker}
                  <small>
                    {row.error ||
                      `${row.reviewed}/${row.attempted} reviewed${row.missing ? " · partial" : ""}`}
                  </small>
                </th>
                {row.cells.map((cell) => (
                  <td key={cell.id}>
                    <button
                      data-state={cell.state}
                      aria-label={`${row.ticker} ${cell.label}: ${cell.state === "unknown" ? "not reviewed" : `${cell.hits} of ${row.reviewed} filings`}`}
                      onClick={() =>
                        inspect(row.ticker, cell.query, cell.accessions)
                      }
                      disabled={cell.state === "unknown"}
                    >
                      {cell.state === "unknown"
                        ? "Not reviewed"
                        : `${cell.hits} / ${row.reviewed}`}
                      <small>
                        {cell.state === "match"
                          ? "View evidence ↗"
                          : cell.state === "no-match"
                            ? "No matches in reviewed files"
                            : "Coverage unavailable"}
                      </small>
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.muted}>
        Topic dictionaries use literal terms, not inferred exposure. Missing
        filings and unidentified sections are excluded from denominators.
        Matches can be hypothetical or boilerplate.
      </p>
    </section>
  );
}

export function DisclosureTrends({
  companies,
  requested,
}: {
  companies: CompanyScan[];
  requested: string[];
}) {
  const [topic, setTopic] = useState("query");
  const [form, setForm] = useState("10-K");
  const rows = useMemo(
    () => buildDisclosureTrends(companies, { topic, form, requested }),
    [companies, topic, form, requested],
  );
  return (
    <section className={s.panel}>
      <div className={s.panelHeading}>
        <div>
          <span className={s.eyebrow}>Prevalence, with a denominator</span>
          <h2>Disclosure trends</h2>
        </div>
        <div className={s.filterRow}>
          <label>
            Language
            <select value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="query">Your full query</option>
              {DISCLOSURE_TOPICS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Comparable form
            <select value={form} onChange={(e) => setForm(e.target.value)}>
              <option>10-K</option>
              <option>10-Q</option>
              <option>20-F</option>
              <option>40-F</option>
            </select>
          </label>
        </div>
      </div>
      <p className={s.muted}>
        Percentage of successfully reviewed companies with matching language in
        each reporting period. Original reports only; amendments and event
        filings do not create new periods. Broader coverage is not evidence of
        increasing risk.
      </p>
      {!rows.length ? (
        <div className={s.empty}>
          No {form} reporting periods in the reviewed sample. Search that form
          over multiple years to compare prevalence.
        </div>
      ) : (
        <div className={s.tableScroll}>
          <table className={s.trends}>
            <thead>
              <tr>
                <th>Reporting period</th>
                <th>Prevalence</th>
                <th>Matched / reviewed</th>
                <th>Comparable sample change</th>
                <th>Coverage & sample</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.period}>
                  <th>{row.period}</th>
                  <td>
                    <div className={s.bar}>
                      <i style={{ width: `${row.prevalence || 0}%` }} />
                    </div>
                    <strong>
                      {row.prevalence === null
                        ? "Unavailable"
                        : `${row.prevalence.toFixed(1)}%`}
                    </strong>
                  </td>
                  <td>
                    {row.numerator} / {row.denominator}
                  </td>
                  <td>
                    {row.paired.delta === null ? (
                      "No common prior sample"
                    ) : (
                      <>
                        {row.paired.delta > 0 ? "+" : ""}
                        {row.paired.delta.toFixed(1)} pp
                        <small>
                          {row.paired.previous} → {row.paired.current} matches /{" "}
                          {row.paired.companies.length} common companies
                        </small>
                      </>
                    )}
                  </td>
                  <td>
                    <details>
                      <summary>
                        {row.missing.length} unreviewed · +{row.entered.length}{" "}
                        / −{row.left.length} companies
                      </summary>
                      <p>Reviewed: {row.reviewed.join(", ") || "None"}</p>
                      <p>Matched: {row.matched.join(", ") || "None"}</p>
                      <p>
                        Unavailable / outside selected depth:{" "}
                        {row.missing.join(", ") || "None"}
                      </p>
                      <p>
                        Entered reviewed sample:{" "}
                        {row.entered.join(", ") || "None"}
                      </p>
                      <p>
                        Left reviewed sample: {row.left.join(", ") || "None"}
                      </p>
                      <p>
                        Common comparison sample:{" "}
                        {row.paired.companies.join(", ") || "None"}
                      </p>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={s.muted}>
        Period labels use reporting-end calendar years
        {form === "10-Q" ? " and calendar quarters" : ""}; fiscal calendars can
        differ. The common-sample change compares adjacent displayed periods
        using only companies successfully reviewed in both. It is not a
        market-wide estimate.
      </p>
    </section>
  );
}
