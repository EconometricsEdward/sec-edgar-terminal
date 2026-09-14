"use client";

import { useEffect, useId, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowRight,
  ArrowUpRight,
  Download,
  Layers3,
  RefreshCw,
  Network,
  Search,
  Square,
} from "lucide-react";
import {
  buildPortfolioMarketConnections,
  marketConnectionIssuers,
  marketConnectionCsvRows,
} from "../../../utils/portfolioMarketConnections.js";
import {
  clearPortfolioMarketConnections,
  scanPortfolioMarketConnections,
  PORTFOLIO_MARKET_SCAN_LIMIT,
} from "../../../utils/portfolioMarketConnectionsClient.js";
import { csvString } from "../../../utils/portfolioFiles.js";
import { downloadText } from "../../../utils/download.js";
import s from "./PortfolioMarketConnections.module.css";

const Positioning = dynamic(() => import("./PortfolioMarketPositioning"), {
  loading: () => <p role="status">Opening market positioning…</p>,
});
const number = (value: unknown, digits = 1) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "—";
const statusText: Record<string, string> = {
  linked: "Source-backed filing link",
  no_match: "No verified passage",
  no_filing: "Annual filing unavailable",
  unavailable: "Scan unavailable",
  unchecked: "Not checked",
};
type Props = {
  report: any;
  active: boolean;
  onInspectCompany: (rowId: string) => void;
};

export default function PortfolioMarketConnections({
  report,
  active,
  onInspectCompany,
}: Props) {
  const id = useId();
  const [basis, setBasis] = useState("companies");
  const [category, setCategory] = useState("all");
  const [selectedKey, setSelectedKey] = useState("");
  const [selectedCik, setSelectedCik] = useState("");
  const [scan, setScan] = useState<{ key: string; results: any[] }>({
    key: "",
    results: [],
  });
  const [pending, setPending] = useState(false);
  const [paused, setPaused] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [memberPage, setMemberPage] = useState(0);
  const [coveragePage, setCoveragePage] = useState(0);
  const [coverageFilter, setCoverageFilter] = useState("all");
  const [matrixShown, setMatrixShown] = useState(false);
  const scanKey = JSON.stringify(
    marketConnectionIssuers(report)
      .filter((issuer: any) => issuer.eligible)
      .map(({ cik, ticker }: any) => ({ cik, ticker })),
  );
  const scanCompanies = useMemo(() => JSON.parse(scanKey), [scanKey]);
  const model: any = useMemo(
    () =>
      buildPortfolioMarketConnections(
        report,
        scan.key === scanKey ? scan.results : [],
        { basis, category },
      ),
    [report, scan, scanKey, basis, category],
  );

  useEffect(() => {
    if (!active || paused || !scanCompanies.length) return;
    const controller = new AbortController();
    setPending(true);
    setError("");
    scanPortfolioMarketConnections(scanCompanies, {
      signal: controller.signal,
      onProgress: (next: any[]) => {
        if (!controller.signal.aborted)
          setScan({ key: scanKey, results: next });
      },
    })
      .catch((cause: any) => {
        if (!controller.signal.aborted)
          setError(cause?.message || "The filing scan could not complete.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => {
      controller.abort();
      setPending(false);
    };
  }, [active, paused, revision, scanCompanies, scanKey]);

  const selected =
    model.markets.find((market: any) => market.key === selectedKey) ||
    model.markets[0] ||
    null;
  const members = (selected?.members || []).filter((member: any) =>
    `${member.ticker} ${member.name} ${member.sector}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const member =
    members.find((entry: any) => entry.cik === selectedCik) ||
    members[0] ||
    null;
  const page = Math.min(
    memberPage,
    Math.max(0, Math.ceil(members.length / 10) - 1),
  );
  const visibleMembers = members.slice(page * 10, page * 10 + 10);
  const coverageRows = model.companyRows.filter(
    (company: any) =>
      coverageFilter === "all" || company.status === coverageFilter,
  );
  const currentCoveragePage = Math.min(
    coveragePage,
    Math.max(0, Math.ceil(coverageRows.length / 10) - 1),
  );
  const denominator =
    model.basis === "allocation" ? 100 : model.coverage.eligible;
  const progress = model.coverage.eligible
    ? (100 * model.coverage.attempted) / model.coverage.eligible
    : 0;
  const maxMatrixCount = Math.max(
    1,
    ...model.markets.flatMap((market: any) =>
      market.sectors.map(
        (sector: string) =>
          market.members.filter((entry: any) => entry.sector === sector).length,
      ),
    ),
  );
  const matrixSectors: string[] = [
    ...new Set<string>(model.markets.flatMap((market: any) => market.sectors)),
  ].sort();
  const pickMarket = (key: string) => {
    setSelectedKey(key);
    setSelectedCik("");
    setQuery("");
    setMemberPage(0);
  };
  const retry = (all: boolean) => {
    if (all) clearPortfolioMarketConnections(scanCompanies);
    setPaused(false);
    setRevision((value) => value + 1);
    setNotice("");
  };

  return (
    <section className={s.root} aria-labelledby={`${id}-title`}>
      <header className={s.header}>
        <div>
          <p className={s.eyebrow}>
            <Network size={16} aria-hidden="true" /> SEC + CFTC
          </p>
          <h3 id={`${id}-title`}>Find common market connections.</h3>
          <p>
            SEC filing passages suggest links to market benchmarks across
            sectors. Explore the evidence, then examine CFTC positioning and
            trader concentration in each market.
          </p>
        </div>
        <div className={s.actions}>
          <button
            type="button"
            disabled={pending || !scanCompanies.length}
            onClick={() => retry(true)}
          >
            <RefreshCw size={15} aria-hidden="true" /> Refresh connections
          </button>
          <button
            type="button"
            disabled={!model.allMarkets.length}
            onClick={() => {
              downloadText(
                "portfolio-market-connections.csv",
                csvString(marketConnectionCsvRows(model)),
                "text/csv;charset=utf-8",
              );
              setNotice(
                "Exported market connections, scan coverage and original SEC evidence.",
              );
            }}
          >
            <Download size={15} aria-hidden="true" /> Export
          </button>
        </div>
      </header>

      <div className={s.coverageBar}>
        <div>
          <strong>
            {pending
              ? "Reading company filings"
              : paused
                ? "Scan paused"
                : model.completeScan
                  ? "Filing scan complete"
                  : "Partial filing coverage"}
          </strong>
          <span>
            {model.coverage.attempted} / {model.coverage.eligible} companies
            attempted · {model.coverage.checked} usable filing scans
          </span>
        </div>
        <progress
          max={100}
          value={progress}
          aria-label="Company filing scan progress"
        />
        {pending ? (
          <button type="button" onClick={() => setPaused(true)}>
            <Square size={12} aria-hidden="true" /> Pause
          </button>
        ) : (
          (paused ||
            model.coverage.unchecked > 0 ||
            model.coverage.unavailable > 0) && (
            <button type="button" onClick={() => retry(false)}>
              Continue / retry
            </button>
          )
        )}
      </div>
      {error && (
        <p className={s.notice} role="status">
          {error}
        </p>
      )}
      {scanCompanies.length > PORTFOLIO_MARKET_SCAN_LIMIT && (
        <p className={s.notice}>
          This scan supports the first {PORTFOLIO_MARKET_SCAN_LIMIT} identified
          companies. The remaining companies stay unchecked in coverage.
        </p>
      )}
      {!scanCompanies.length && (
        <p className={s.notice}>
          Add identified operating companies to build shared-market connections.
          Fund holdings are not scanned on a look-through basis.
        </p>
      )}

      <div className={s.stats}>
        <div>
          <span>Companies with filing links</span>
          <strong>
            {model.coverage.linked}
            <small> / {model.coverage.eligible}</small>
          </strong>
          <p>Unique SEC issuers, across all markets</p>
        </div>
        <div>
          <span>Markets found</span>
          <strong>{model.allMarkets.length || (pending ? "—" : "0")}</strong>
          <p>Verified filing passages in the scanned companies</p>
        </div>
        <div>
          <span>Markets spanning sectors</span>
          <strong>{model.crossSectorMarkets || (pending ? "—" : "0")}</strong>
          <p>Connections across two or more classified sectors</p>
        </div>
        {model.allocationAvailable && (
          <div>
            <span>Allocation in linked companies</span>
            <strong>{number(model.coverage.linkedAllocationPct)}%</strong>
            <p>Each company counted once in this total</p>
          </div>
        )}
      </div>

      <div className={s.toolbar}>
        <div className={s.categories} aria-label="Market categories">
          <button
            type="button"
            aria-pressed={category === "all"}
            onClick={() => {
              setCategory("all");
              setQuery("");
              setSelectedCik("");
              setMemberPage(0);
            }}
          >
            All markets <span>{model.allMarkets.length}</span>
          </button>
          {model.categories
            .filter((entry: any) => entry.marketCount > 0)
            .map((entry: any) => (
              <button
                key={entry.key}
                type="button"
                aria-pressed={category === entry.key}
                onClick={() => {
                  setCategory(entry.key);
                  setQuery("");
                  setSelectedCik("");
                  setMemberPage(0);
                }}
                title={`${entry.count} unique companies; market memberships overlap`}
              >
                {entry.label}
                <span>{entry.count} companies</span>
              </button>
            ))}
        </div>
        <label className={s.basis}>
          Compare by
          <select
            value={model.basis}
            onChange={(event) => setBasis(event.target.value)}
            aria-label="Market connection measure"
          >
            <option value="companies">Companies</option>
            {model.allocationAvailable && (
              <option value="allocation">Allocation in linked companies</option>
            )}
          </select>
        </label>
      </div>
      <p className={s.explanation}>
        Market groups overlap. A company can appear in several groups, so these
        bars do not add to 100%.{" "}
        {model.basis === "allocation"
          ? "Percentages retain your full portfolio denominator; they measure allocation in linked companies, not exposure to a commodity or interest rate."
          : "Counts use unique companies and work without portfolio weights. A filing connection does not quantify exposure, hedges or price sensitivity."}
      </p>
      {!model.allocationAvailable && report?.weighted && (
        <p className={s.note}>
          Allocation comparisons become available when all position weights and
          identities are reviewed and total 100%.
        </p>
      )}

      {!!model.markets.length && (
        <>
          <div
            className={s.marketBars}
            role="group"
            aria-label="Shared market connections"
          >
            <div className={s.barHeading}>
              <span>Market</span>
              <span>
                {model.basis === "allocation"
                  ? "Allocation in linked companies"
                  : "Companies with source-backed filing links"}
              </span>
              <span>Sector breadth</span>
            </div>
            {model.markets.map((market: any) => (
              <button
                key={market.key}
                type="button"
                className={s.marketRow}
                aria-pressed={selected?.key === market.key}
                onClick={() => pickMarket(market.key)}
                aria-label={`Review ${market.label}: ${market.count} of ${model.coverage.eligible} eligible companies across ${market.sectorCount} sectors${model.basis === "allocation" ? `; ${number(market.allocationPct)} percent of full portfolio allocation in linked companies` : ""}`}
              >
                <div className={s.marketLabel}>
                  <strong>{market.label}</strong>
                  <span>
                    {market.family === "tff"
                      ? "Financial futures"
                      : "Commodity futures"}{" "}
                    · {market.groupLabel}
                    {market.contract === "043602"
                      ? " · Broad rates proxy"
                      : " · Benchmark link"}
                  </span>
                </div>
                <div className={s.barCell}>
                  <div className={s.track} aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.min(100, denominator > 0 ? (100 * market.value) / denominator : 0)}%`,
                      }}
                    />
                  </div>
                  <strong>
                    {model.basis === "allocation"
                      ? `${number(market.allocationPct)}%`
                      : market.count}
                    <small>
                      {model.basis === "allocation"
                        ? `${market.count} companies`
                        : ` / ${model.coverage.eligible}`}
                    </small>
                  </strong>
                </div>
                <div className={s.sectorCount}>
                  <strong>{market.sectorCount}</strong>
                  <span>sectors</span>
                  <ArrowRight size={16} aria-hidden="true" />
                </div>
              </button>
            ))}
          </div>
          <div className={s.matrixToggle}>
            <button
              type="button"
              aria-expanded={matrixShown}
              onClick={() => setMatrixShown((value) => !value)}
            >
              <Layers3 size={15} aria-hidden="true" />{" "}
              {matrixShown
                ? "Hide sector connections"
                : "Compare connections across sectors"}
            </button>
            <span>All bars use the same denominator.</span>
          </div>
          {matrixShown && (
            <div
              className={s.matrixWrap}
              role="region"
              aria-label="Market connections by sector"
              tabIndex={0}
            >
              <table className={s.matrix}>
                <caption>
                  Companies linked to each market, by sector. A company can
                  appear in multiple columns.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Sector</th>
                    {model.markets.map((market: any) => (
                      <th scope="col" key={market.key}>
                        <button
                          type="button"
                          onClick={() => pickMarket(market.key)}
                        >
                          {market.label}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixSectors.map((sector) => (
                    <tr key={sector}>
                      <th scope="row">{sector}</th>
                      {model.markets.map((market: any) => {
                        const count = market.members.filter(
                          (entry: any) => entry.sector === sector,
                        ).length;
                        return (
                          <td
                            key={market.key}
                            style={{
                              backgroundColor: count
                                ? `rgba(105, 195, 177, ${0.08 + (0.44 * count) / maxMatrixCount})`
                                : undefined,
                            }}
                          >
                            {count || "—"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {!model.markets.length && (
        <div className={s.empty}>
          <Network size={28} aria-hidden="true" />
          <h4>
            {pending
              ? "Building your shared-market map…"
              : "No source-backed filing links are available yet"}
          </h4>
          <p>
            {pending
              ? "Results appear as each batch finishes. You can continue using the portfolio while filings are checked."
              : "Review the scan coverage below. Unavailable filings or no passage matches do not establish that market exposure is absent."}
          </p>
        </div>
      )}

      {selected && (
        <section className={s.detail} aria-labelledby={`${id}-market`}>
          <div className={s.detailHeading}>
            <div>
              <p className={s.eyebrow}>FOLLOW THE CONNECTION</p>
              <h4 id={`${id}-market`}>{selected.label}</h4>
              <p>
                {selected.count} companies · {selected.sectorCount} sectors
                {model.allocationAvailable
                  ? ` · ${number(selected.allocationPct)}% allocation in linked companies`
                  : ""}
              </p>
            </div>
            <span className={s.badge}>Contract {selected.contract}</span>
          </div>
          <div className={s.detailColumns}>
            <section
              className={s.memberPanel}
              aria-labelledby={`${id}-companies`}
            >
              <h5 id={`${id}-companies`}>Companies with filing links</h5>
              <label className={s.search}>
                <Search size={15} aria-hidden="true" />
                <span className={s.srOnly}>Find a linked company</span>
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setMemberPage(0);
                  }}
                  placeholder="Ticker, company or sector"
                />
              </label>
              <div className={s.companyList}>
                {visibleMembers.map((entry: any) => (
                  <button
                    key={entry.cik}
                    type="button"
                    aria-pressed={member?.cik === entry.cik}
                    onClick={() => setSelectedCik(entry.cik)}
                    aria-label={`Read ${entry.ticker} filing connection`}
                  >
                    <span>
                      <strong>{entry.ticker}</strong>
                      <small>{entry.name}</small>
                    </span>
                    <span>
                      {entry.sector}
                      {model.allocationAvailable && (
                        <small>{number(entry.weightPct)}% allocation</small>
                      )}
                    </span>
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
              {!members.length && (
                <p className={s.note}>No linked companies match this search.</p>
              )}
              {members.length > 10 && (
                <div className={s.pagination}>
                  <button
                    type="button"
                    disabled={page === 0}
                    onClick={() => setMemberPage(page - 1)}
                  >
                    Previous
                  </button>
                  <span>
                    {page * 10 + 1}–{Math.min(page * 10 + 10, members.length)}{" "}
                    of {members.length}
                  </span>
                  <button
                    type="button"
                    disabled={(page + 1) * 10 >= members.length}
                    onClick={() => setMemberPage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </section>
            {member && (
              <section
                className={s.evidence}
                aria-labelledby={`${id}-evidence`}
              >
                <div className={s.evidenceHeading}>
                  <h5 id={`${id}-evidence`}>
                    {member.ticker} · Why this market?
                  </h5>
                  <button
                    type="button"
                    onClick={() => onInspectCompany(member.rowIds[0])}
                  >
                    Inspect company{" "}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                </div>
                <p>{member.reason}</p>
                {member.evidence.map((evidence: any) => (
                  <blockquote key={`${evidence.accession}:${evidence.text}`}>
                    <p>“{evidence.text}”</p>
                    <a
                      href={evidence.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {evidence.form} · Filed {evidence.filed}
                      <ArrowUpRight size={13} aria-hidden="true" />
                    </a>
                    {evidence.reportDate && (
                      <small>
                        Reporting period ended {evidence.reportDate}
                      </small>
                    )}
                  </blockquote>
                ))}
                <div className={s.question}>
                  <strong>Research question</strong>
                  <p>{member.reviewQuestion}</p>
                </div>
              </section>
            )}
          </div>
          <Positioning key={selected.key} market={selected} active={active} />
        </section>
      )}

      {notice && (
        <p role="status" className={s.note}>
          {notice}
        </p>
      )}
      <details className={s.coverage}>
        <summary>
          Coverage & methodology{" "}
          <span>
            {model.coverage.checked} filings checked ·{" "}
            {model.coverage.unavailable +
              model.coverage.noFiling +
              model.coverage.unchecked}{" "}
            unavailable or unchecked
          </span>
        </summary>
        <div className={s.coverageBody}>
          <p>
            The scan checks the latest accessible complete annual report for
            supported market passages. Connections can differ from the financial
            reporting perspective selected above. Later quarterly filings,
            amendments, unscanned passages and unsupported markets may contain
            other exposures. A text match does not establish the size, direction
            or materiality of an exposure.
          </p>
          <div className={s.coverageCounts}>
            {[
              ["Source-backed filing link", model.coverage.linked],
              ["No verified passage", model.coverage.noMatch],
              ["No annual filing", model.coverage.noFiling],
              ["Scan unavailable", model.coverage.unavailable],
              ["Unchecked", model.coverage.unchecked],
              ["Funds / unsupported holdings", model.coverage.unsupported],
              ["Unresolved positions", model.coverage.unresolved],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          {!!model.coverage.omittedLinks && (
            <p className={s.notice}>
              {model.coverage.omittedLinks} candidate links did not pass source
              validation and were excluded.
            </p>
          )}
          <p>
            Company counts deduplicate share classes by SEC company ID. Category
            totals and the overall linked allocation count each company once.
            Individual markets overlap. Fund look-through is not included. CFTC
            records describe aggregate futures traders, not the companies’
            positions, portfolio returns or correlations.
          </p>
          <label className={s.coverageFilter}>
            Company scan status
            <select
              value={coverageFilter}
              onChange={(event) => {
                setCoverageFilter(event.target.value);
                setCoveragePage(0);
              }}
            >
              <option value="all">All companies</option>
              {Object.entries(statusText).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div
            className={s.coverageTable}
            role="region"
            aria-label="Company market-connection coverage"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">Status</th>
                  <th scope="col">Explanation</th>
                </tr>
              </thead>
              <tbody>
                {coverageRows
                  .slice(
                    currentCoveragePage * 10,
                    currentCoveragePage * 10 + 10,
                  )
                  .map((company: any) => (
                    <tr key={company.cik}>
                      <th scope="row">
                        {company.ticker}
                        <small>{company.name}</small>
                      </th>
                      <td>{statusText[company.status]}</td>
                      <td>{company.message}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {coverageRows.length > 10 && (
            <div className={s.pagination}>
              <button
                type="button"
                disabled={currentCoveragePage === 0}
                onClick={() => setCoveragePage(currentCoveragePage - 1)}
              >
                Previous coverage
              </button>
              <span>
                {currentCoveragePage * 10 + 1}–
                {Math.min(currentCoveragePage * 10 + 10, coverageRows.length)}{" "}
                of {coverageRows.length}
              </span>
              <button
                type="button"
                disabled={(currentCoveragePage + 1) * 10 >= coverageRows.length}
                onClick={() => setCoveragePage(currentCoveragePage + 1)}
              >
                Next coverage
              </button>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
