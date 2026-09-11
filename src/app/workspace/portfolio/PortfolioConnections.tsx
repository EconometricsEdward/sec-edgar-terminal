"use client";
import { useMemo, useState } from "react";
import {
  portfolioConnections,
  portfolioResearchIssuers,
  metricDisplay,
} from "../../../utils/portfolioDeepResearch.js";
import { portfolioMetricDefinitionFor } from "../../../utils/portfolioMetricCatalog.js";
import s from "../ResearchTools.module.css";
export default function PortfolioConnections({
  report,
  companies,
  onInspect,
  onDisclosure,
}: {
  report: any;
  companies: any[];
  onInspect: (id: string) => void;
  onDisclosure?: (query: string, ciks: string[]) => void;
}) {
  const result = useMemo(
    () => portfolioConnections(report, companies),
    [report, companies],
  );
  const issuers = useMemo(
    () => portfolioResearchIssuers(report, companies),
    [report, companies],
  );
  const [selected, setSelected] = useState("");
  const group = result.groups.find((g) => g.id === selected);
  return (
    <section className={s.root} aria-labelledby="portfolio-connections-title">
      <div>
        <p className={s.eyebrow}>Connect the financial statements</p>
        <h3 id="portfolio-connections-title">What deserves a closer look?</h3>
      </div>
      <p>{result.interpretation}</p>
      <div className={s.cards}>
        {result.groups
          .filter((g) => g.eligible > 0)
          .map((g) => (
            <article key={g.id}>
              <h4>{g.title}</h4>
              <p>{g.reading}</p>
              <button
                disabled={!g.count}
                aria-pressed={selected === g.id}
                onClick={() => setSelected(selected === g.id ? "" : g.id)}
              >
                Inspect {g.count} {g.count === 1 ? "company" : "companies"}
              </button>
            </article>
          ))}
      </div>
      {group && (
        <>
          <div className={s.heading}>
            <h4>{group.title}</h4>
            {onDisclosure && (
              <button onClick={() => onDisclosure(group.query, group.ciks)}>
                Search these companies’ disclosures
              </button>
            )}
          </div>
          <div
            className={s.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="Companies behind the financial connection"
          >
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  {group.keys.map((k) => (
                    <th key={k}>
                      {portfolioMetricDefinitionFor(k)?.label || k}
                    </th>
                  ))}
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {issuers
                  .filter((i) => group.ciks.includes(i.cik))
                  .map((i) => (
                    <tr key={i.cik}>
                      <th>
                        {i.ticker}
                        <small>{i.company?.period?.end}</small>
                      </th>
                      {group.keys.map((k) => (
                        <td key={k}>
                          {metricDisplay(i.company?.metrics?.[k])}
                        </td>
                      ))}
                      <td>
                        <button onClick={() => onInspect(i.rowIds[0])}>
                          Inspect company
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
