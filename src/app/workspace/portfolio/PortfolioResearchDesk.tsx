"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  portfolioSourceIssuers,
  portfolioSourceJson,
  mergePortfolioFilingRows,
  researchPause,
} from "../../../utils/portfolioSourceResearch.js";
import { parseDisclosureQuery } from "../../../utils/disclosureQuery.js";
import { mergeDisclosureBatch } from "../../../utils/disclosureCoverage.js";
import { portfolioMetricSourceUrl } from "../../../utils/portfolioAnalytics.js";
import { portfolioScopedSources } from "../../../utils/portfolioReport.js";
import { downloadText } from "../../../utils/download.js";
import { csvString } from "../../../utils/portfolioFiles.js";
import s from "../ResearchTools.module.css";
const GlobalSecurityFinder = dynamic(
  () => import("../../fund/GlobalSecurityFinder"),
  { loading: () => <p role="status">Opening fund ownership research…</p> },
);
const DisclosureReader = dynamic(
  () => import("../../disclosures/DisclosureReader"),
);
const initialSettings = {
  query: '"liquidity"',
  tickers: "",
  mode: "companies" as const,
  start: "",
  end: "",
  forms: "10-K,10-Q,20-F,40-F",
  section: "all",
  scope: "paragraph" as const,
  depth: 2,
  amendments: false,
  comparison: "none" as const,
};
const EMPTY: any = {};
type Props = {
  initialEvidence?: any;
  rows: any[];
  companies: any[];
  activeTab: string;
  request?: any;
  onEvidence: (data: any) => void;
  onSaveFiling?: (filing: any) => void;
};
export default function PortfolioResearchDesk({
  rows,
  companies,
  activeTab,
  request,
  onEvidence,
  onSaveFiling,
  initialEvidence,
}: Props) {
  const issuers = useMemo(() => portfolioSourceIssuers(rows), [rows]);
  const [history, setHistory] = useState<Record<string, any>>(
      initialEvidence?.filingHistory || {},
    ),
    [historyErrors, setHistoryErrors] = useState<Record<string, string>>(
      initialEvidence?.filingErrors || {},
    );
  const [scans, setScans] = useState<Record<string, any>>(() =>
      Object.fromEntries(
        (initialEvidence?.disclosures?.companies || []).map((c: any) => [
          c.cik,
          c,
        ]),
      ),
    ),
    [settings, setSettings] = useState<any>(
      () =>
        initialEvidence?.disclosures?.settings || {
          ...initialSettings,
          start: new Date(Date.now() - 366 * 86400000)
            .toISOString()
            .slice(0, 10),
          end: new Date().toISOString().slice(0, 10),
        },
    ),
    [capturedSettings, setCapturedSettings] = useState<any>(
      initialEvidence?.disclosures?.settings || null,
    ),
    [scopeCiks, setScopeCiks] = useState<string[]>([]);
  const [funds, setFunds] = useState<Record<string, any>>(() =>
      Object.fromEntries(
        (initialEvidence?.fundOwnership || []).map(
          ({ ticker, ...data }: any) => [ticker, data],
        ),
      ),
    ),
    [fundTicker, setFundTicker] = useState(""),
    [fundSettings, setFundSettings] = useState<any>({
      securityQuery: "",
      securityAsset: "EC",
    });
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [cooldown, setCooldown] = useState(0),
    [filter, setFilter] = useState(""),
    [form, setForm] = useState("all"),
    [dateFrom, setDateFrom] = useState(""),
    [dateTo, setDateTo] = useState(""),
    [limit, setLimit] = useState(30),
    [disclosureLimit, setDisclosureLimit] = useState(30),
    [selectedIssuer, setSelectedIssuer] = useState(""),
    [reader, setReader] = useState<any>(null),
    [quotes, setQuotes] = useState<any[]>(
      initialEvidence?.disclosures?.quotes || [],
    ),
    [labels, setLabels] = useState<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (selectedIssuer && !issuers.some((i) => i.cik === selectedIssuer))
      setSelectedIssuer("");
    if (fundTicker && !issuers.some((i) => i.ticker === fundTicker))
      setFundTicker("");
  }, [issuers, selectedIssuer, fundTicker]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (cooldown) {
      const timer = setTimeout(
        () => setCooldown(0),
        Math.max(0, cooldown - Date.now()),
      );
      return () => clearTimeout(timer);
    }
  }, [cooldown]);
  useEffect(() => {
    if (request) {
      controller.current?.abort();
      setBusy(false);
      setReader(null);
      setSettings((v: any) => ({ ...v, query: request.query }));
      setScopeCiks(request.ciks || []);
      setStatus(
        "Related disclosure query prepared. Choose Search to inspect this portfolio subset.",
      );
    }
  }, [request]);
  useEffect(() => {
    onEvidence(
      portfolioScopedSources(
        issuers.map((i) => ({ cik: i.cik, ticker: i.ticker })),
        {
          filingHistory: history,
          filingErrors: historyErrors,
          disclosures: {
            settings: capturedSettings,
            companies: Object.values(scans),
            quotes,
          },
          fundOwnership: Object.entries(funds).map(([ticker, result]) => ({
            ticker,
            ...result,
          })),
        },
      ),
    );
  }, [
    issuers,
    history,
    historyErrors,
    capturedSettings,
    scans,
    quotes,
    funds,
    onEvidence,
  ]);
  const onFundResult = useCallback(
    (result: any) => {
      const ticker = String(
        result.target?.ticker || result.target?.query || " ",
      ).toUpperCase();
      if (!issuers.some((i) => i.ticker === ticker)) return;
      setFunds((previous) =>
        previous[ticker] === result
          ? previous
          : { ...previous, [ticker]: result },
      );
    },
    [issuers],
  );
  const scope = scopeCiks.length
    ? issuers.filter((i) => scopeCiks.includes(i.cik))
    : issuers;
  const identity = JSON.stringify({
    ...settings,
    ciks: scope.map((i) => i.cik),
  });
  const previousIdentity = capturedSettings
    ? JSON.stringify(capturedSettings)
    : "";
  const seed = useMemo(
    () =>
      companies
        .filter((c) => issuers.some((i) => i.cik === c.cik))
        .flatMap((c) =>
          (c.filings || []).map((f: any) => ({
            ...f,
            cik: c.cik,
            ticker:
              c.ticker || issuers.find((i) => i.cik === c.cik)?.ticker || "",
            companyName: c.name,
          })),
        ),
    [companies, issuers],
  );
  const filings = useMemo(
    () =>
      mergePortfolioFilingRows(
        seed,
        Object.values(history)
          .filter((h) => issuers.some((i) => i.cik === h.cik))
          .flatMap((h) => h.filings || []),
      ),
    [seed, history, issuers],
  );
  const visibleFilings = filings.filter(
    (f) =>
      (!selectedIssuer || f.cik === selectedIssuer) &&
      (form === "all" || f.form === form) &&
      (!dateFrom || f.filingDate >= dateFrom) &&
      (!dateTo || f.filingDate <= dateTo) &&
      `${f.ticker} ${f.companyName} ${f.form}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const discoveredScans = Object.values(scans).filter((c: any) =>
    issuers.some((i) => i.cik === c.cik),
  );
  const matches = discoveredScans.flatMap((scan: any) =>
    (scan.filings || []).filter((f: any) => f.matched),
  );
  async function work(
    items: any[],
    task: (item: any, signal: AbortSignal) => Promise<void>,
  ) {
    if (busy || cooldown > Date.now() || !items.length) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    let completed = 0;
    try {
      for (const item of items) {
        current.signal.throwIfAborted();
        const started = Date.now();
        setStatus(
          `Processing ${completed + 1} of ${items.length}. Completed results remain available.`,
        );
        try {
          await task(
            item,
            AbortSignal.any([current.signal, AbortSignal.timeout(110000)]),
          );
        } catch (error: any) {
          if (current.signal.aborted) throw error;
          if (error.status === 429) {
            setCooldown(Date.now() + error.retryAfter * 1000);
            setStatus(
              `The service requested a pause. Retry after ${error.retryAfter} seconds; completed results are retained.`,
            );
            return;
          }
          setStatus(
            error.message ||
              "One company could not be retrieved; retry it below.",
          );
        }
        current.signal.throwIfAborted();
        completed++;
        if (completed < items.length)
          await researchPause(
            Math.max(0, 1600 - (Date.now() - started)),
            current.signal,
          );
      }
      current.signal.throwIfAborted();
      setStatus(
        `Finished ${completed} requested checks. Review coverage and any failures below.`,
      );
    } catch {
      if (current.signal.aborted && controller.current === current)
        setStatus(
          "Stopped. Completed research is retained; the active server check may finish independently.",
        );
    } finally {
      if (controller.current === current) setBusy(false);
    }
  }
  async function loadHistory(issuer: any, signal: AbortSignal, archive = "") {
    try {
      const data = await portfolioSourceJson(
        `/api/filings-research?ticker=${encodeURIComponent(issuer.ticker)}${archive ? `&archive=${encodeURIComponent(archive)}` : ""}`,
        signal,
      );
      signal.throwIfAborted();
      if (
        data.cik !== issuer.cik ||
        !Array.isArray(data.filings) ||
        (!archive && !Array.isArray(data.archives))
      )
        throw new Error(
          "The filing response did not match the selected portfolio company.",
        );
      setHistory((previous) => {
        const old = previous[issuer.cik];
        return {
          ...previous,
          [issuer.cik]: {
            ...old,
            ...(!archive ? data : {}),
            cik: issuer.cik,
            ticker: issuer.ticker,
            name: issuer.name,
            filings: mergePortfolioFilingRows(
              old?.filings || [],
              data.filings.map((f: any) => ({
                ...f,
                cik: issuer.cik,
                ticker: issuer.ticker,
                companyName: issuer.name,
              })),
            ),
            loadedArchives: [
              ...new Set([
                ...(old?.loadedArchives || []),
                ...(archive ? [archive] : []),
              ]),
            ],
            omittedRecords:
              (old?.omittedRecords || 0) + (data.omittedRecords || 0),
            observedAt: data.observedAt,
          },
        };
      });
      setHistoryErrors((previous) => ({ ...previous, [issuer.cik]: "" }));
    } catch (error: any) {
      if (!signal.aborted)
        setHistoryErrors((previous) => ({
          ...previous,
          [issuer.cik]: error.message,
        }));
      throw error;
    }
  }
  function scanBatch(all = false, retry = false, older: any = null) {
    try {
      parseDisclosureQuery(settings.query);
    } catch (error: any) {
      setStatus(error.message);
      return;
    }
    const supportedForms = [
      "10-K",
      "10-Q",
      "8-K",
      "20-F",
      "40-F",
      "6-K",
      "S-1",
      "S-3",
      "S-4",
      "DEF 14A",
      "DEFM14A",
      "N-CSR",
      "NPORT-P",
    ];
    if (
      settings.forms.split(",").some((f: string) => !supportedForms.includes(f))
    ) {
      setStatus(
        "Choose supported SEC forms separated by commas, for example 10-K,10-Q.",
      );
      return;
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(settings.start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(settings.end) ||
      settings.start > settings.end ||
      settings.start < "2001-01-01" ||
      settings.end > new Date().toISOString().slice(0, 10) ||
      !Number.isFinite(Date.parse(settings.start)) ||
      !Number.isFinite(Date.parse(settings.end)) ||
      new Date(settings.start).toISOString().slice(0, 10) !== settings.start ||
      new Date(settings.end).toISOString().slice(0, 10) !== settings.end
    ) {
      setStatus("Choose a valid filing-date range before searching.");
      return;
    }
    const changed = identity !== previousIdentity;
    const nextSettings = { ...settings, ciks: scope.map((i) => i.cik) };
    const prior = changed ? EMPTY : scans;
    const targets = older
      ? [older]
      : scope.filter((i) => (retry ? prior[i.cik]?.error : !prior[i.cik]));
    if (!targets.length) return;
    if (changed) {
      setReader(null);
      setScans({});
      setDisclosureLimit(30);
      setQuotes([]);
      setCapturedSettings(nextSettings);
    }
    work(all ? targets : targets.slice(0, 5), async (issuer, signal) => {
      const params = new URLSearchParams({
        ...settings,
        ticker: issuer.ticker || issuer.cik,
        depth: String(settings.depth),
        amendments: String(settings.amendments),
      });
      if (older && prior[issuer.cik]?.nextCursor)
        params.set("after", prior[issuer.cik].nextCursor);
      try {
        const data = await portfolioSourceJson(
          `/api/disclosure-research?${params}`,
          signal,
        );
        signal.throwIfAborted();
        if (data.cik !== issuer.cik || !Array.isArray(data.filings))
          throw new Error(
            "Disclosure response did not match the selected SEC company.",
          );
        setScans((previous) => ({
          ...previous,
          [issuer.cik]: mergeDisclosureBatch(previous[issuer.cik], data),
        }));
      } catch (error: any) {
        if (!signal.aborted)
          setScans((previous) => ({
            ...previous,
            [issuer.cik]: {
              ...previous[issuer.cik],
              cik: issuer.cik,
              ticker: issuer.ticker,
              filings: previous[issuer.cik]?.filings || [],
              error: error.message,
            },
          }));
        throw error;
      }
    });
  }
  function retryDocument(filing: any) {
    work([filing], async (f, signal) => {
      const params = new URLSearchParams({
        ...capturedSettings,
        ticker: f.ticker || f.cik,
        action: "document",
        accession: f.accession,
        document: f.primaryDoc || "",
        depth: String(capturedSettings.depth),
        amendments: String(capturedSettings.amendments),
      });
      const data = await portfolioSourceJson(
        `/api/disclosure-research?${params}`,
        signal,
      );
      signal.throwIfAborted();
      if (data.cik !== f.cik || data.accession !== f.accession)
        throw new Error(
          "The retried filing did not match this company and accession.",
        );
      const { matches, ...evidence } = data;
      setScans((previous) => ({
        ...previous,
        [f.cik]: mergeDisclosureBatch(previous[f.cik], {
          ...previous[f.cik],
          error: "",
          filings: [
            {
              ...evidence,
              previews: data.previews || matches?.slice(0, 3) || [],
            },
          ],
          checkedAt: new Date().toISOString(),
        }),
      }));
    });
  }
  const historyPending = issuers.filter((i) => i.ticker && !history[i.cik]);
  const disabled = busy || cooldown > Date.now();
  return (
    <section
      className={s.root}
      aria-label="Portfolio source research"
      hidden={!["filings", "disclosures", "ownership"].includes(activeTab)}
    >
      <div className={s.heading}>
        <div>
          <p className={s.eyebrow}>Research only your selected companies</p>
          <h3>
            {activeTab === "filings"
              ? "Portfolio filing library"
              : activeTab === "disclosures"
                ? "Search your portfolio’s disclosures"
                : "Funds reporting holdings in your companies"}
          </h3>
        </div>
        {busy && (
          <button
            onClick={() => {
              controller.current?.abort();
              setBusy(false);
              setStatus("Stopped. Completed results remain available.");
            }}
          >
            Stop research
          </button>
        )}
      </div>
      <p role="status">{status}</p>
      <small>
        Additional filing history, searches and ownership results remain in this
        session. Download the portfolio report to keep them. Core financial
        snapshots remain saved in your browser.
      </small>
      {activeTab === "filings" && (
        <>
          <p>
            The saved feed opens immediately. Load each company’s full recent
            submissions and then its historical archives to reach older filings
            and every available form. Coverage is explicit; unloaded archives
            are not counted as searched.
          </p>
          <div className={s.controls}>
            <button
              disabled={disabled || !historyPending.length}
              onClick={() => work(historyPending.slice(0, 5), loadHistory)}
            >
              Load recent history for next {Math.min(5, historyPending.length)}{" "}
              companies
            </button>
            <button
              disabled={disabled || !historyPending.length}
              onClick={() => work(historyPending, loadHistory)}
            >
              Continue through all {historyPending.length} remaining companies
            </button>
            <button
              onClick={() =>
                downloadText(
                  "portfolio-filing-library.csv",
                  csvString([
                    [
                      "cik",
                      "ticker",
                      "company",
                      "form",
                      "filing_date",
                      "report_date",
                      "accession",
                      "source",
                    ],
                    ...visibleFilings.map((f) => [
                      f.cik,
                      f.ticker,
                      f.companyName,
                      f.form,
                      f.filingDate,
                      f.reportDate,
                      f.accession,
                      f.documentUrl,
                    ]),
                  ]),
                  "text/csv",
                )
              }
            >
              Export filtered filing references
            </button>
          </div>
          <p>
            {Object.keys(history).length} of {issuers.length} company recent
            histories loaded ·{" "}
            {Object.values(history).reduce(
              (n: number, h: any) => n + (h.loadedArchives?.length || 0),
              0,
            )}{" "}
            archives loaded · {filings.length.toLocaleString()} filing
            references available. {issuers.filter((i) => !i.ticker).length}{" "}
            companies lack a ticker for this history endpoint.
          </p>
          <div className={s.controls}>
            <label>
              Company
              <select
                value={selectedIssuer}
                onChange={(e) => {
                  setSelectedIssuer(e.target.value);
                  setLimit(30);
                }}
              >
                <option value="">All portfolio companies</option>
                {issuers.map((i) => (
                  <option key={i.cik} value={i.cik}>
                    {i.ticker || i.cik} · {i.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Form
              <select
                value={form}
                onChange={(e) => {
                  setForm(e.target.value);
                  setLimit(30);
                }}
              >
                <option value="all">All forms</option>
                {[...new Set(filings.map((f) => f.form))].sort().map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label>
              Filed from
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </label>
            <label>
              Filed through
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </label>
            <label>
              Find filing
              <input
                type="search"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setLimit(30);
                }}
                maxLength={100}
              />
            </label>
          </div>
          {selectedIssuer && issuers.some((i) => i.cik === selectedIssuer) && (
            <div className={s.finding}>
              {(() => {
                const issuer = issuers.find((i) => i.cik === selectedIssuer)!;
                const h = history[selectedIssuer];
                const remaining = (h?.archives || []).filter(
                  (a: any) => !h.loadedArchives.includes(a.name),
                );
                return (
                  <>
                    <strong>
                      {issuer.ticker || issuer.cik}:{" "}
                      {h
                        ? `${h.filings.length} references; ${remaining.length} archives remaining`
                        : "Recent history not loaded"}
                    </strong>
                    <p>
                      {historyErrors[selectedIssuer]} {h?.omittedRecords || 0}{" "}
                      records and {h?.omittedArchives || 0} archive descriptors
                      could not be normalized.
                    </p>
                    {!h ? (
                      <button
                        disabled={disabled || !issuer.ticker}
                        onClick={() => work([issuer], loadHistory)}
                      >
                        Load this company’s recent history
                      </button>
                    ) : (
                      <>
                        <button
                          disabled={disabled || !remaining.length}
                          onClick={() =>
                            work(
                              remaining.map((archive: any) => ({
                                issuer,
                                archive,
                              })),
                              (item, signal) =>
                                loadHistory(
                                  item.issuer,
                                  signal,
                                  item.archive.name,
                                ),
                            )
                          }
                        >
                          Load all {remaining.length} remaining archives for
                          this company
                        </button>
                        {remaining.map((archive: any) => (
                          <button
                            key={archive.name}
                            disabled={disabled}
                            onClick={() =>
                              work([issuer], (i, signal) =>
                                loadHistory(i, signal, archive.name),
                              )
                            }
                          >
                            {archive.filingFrom} to {archive.filingTo} ·{" "}
                            {archive.filingCount ?? "unknown"} filings
                          </button>
                        ))}
                      </>
                    )}
                  </>
                );
              })()}
            </div>
          )}
          <p>
            {visibleFilings.length} filing references match. Select a company
            above to load older archives.
          </p>
          <div
            className={s.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="Portfolio filing references"
          >
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Form</th>
                  <th>Filed</th>
                  <th>Report end</th>
                  <th>SEC source</th>
                  <th>Save</th>
                </tr>
              </thead>
              <tbody>
                {visibleFilings.slice(0, limit).map((f) => (
                  <tr key={`${f.cik}:${f.accession}`}>
                    <th>
                      {f.ticker}
                      <small>{f.companyName}</small>
                    </th>
                    <td>{f.form}</td>
                    <td>{f.filingDate}</td>
                    <td>{f.reportDate}</td>
                    <td>
                      {portfolioMetricSourceUrl({ sources: [f] }) && (
                        <a
                          href={f.documentUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {f.accession} ↗
                        </a>
                      )}
                    </td>
                    <td>
                      {onSaveFiling && (
                        <button onClick={() => onSaveFiling(f)}>
                          Save evidence
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visibleFilings.length > limit && (
            <button onClick={() => setLimit((n) => n + 30)}>
              Show 30 more
            </button>
          )}
          {Object.entries(historyErrors).some(([, error]) => error) && (
            <details>
              <summary>History retrieval failures</summary>
              {Object.entries(historyErrors)
                .filter(([, error]) => error)
                .map(([cik, error]) => (
                  <p key={cik}>
                    {issuers.find((i) => i.cik === cik)?.ticker}: {error}
                  </p>
                ))}
            </details>
          )}
        </>
      )}
      {activeTab === "disclosures" && (
        <>
          <p>
            Search filing text across {scope.length} portfolio companies using
            the Disclosures research engine. Start with two filings per company,
            inspect matching passages, then continue into older reports where
            needed.
          </p>
          <div className={s.controls}>
            <label>
              Disclosure query
              <input
                value={settings.query}
                disabled={busy}
                onChange={(e) =>
                  setSettings({ ...settings, query: e.target.value })
                }
                maxLength={300}
              />
            </label>
            <label>
              Filed from
              <input
                type="date"
                disabled={busy}
                value={settings.start}
                onChange={(e) =>
                  setSettings({ ...settings, start: e.target.value })
                }
              />
            </label>
            <label>
              Filed through
              <input
                type="date"
                disabled={busy}
                value={settings.end}
                onChange={(e) =>
                  setSettings({ ...settings, end: e.target.value })
                }
              />
            </label>
            <label>
              Filings per company
              <select
                value={settings.depth}
                disabled={busy}
                onChange={(e) =>
                  setSettings({ ...settings, depth: Number(e.target.value) })
                }
              >
                {[1, 2, 4, 6, 12].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label>
              Forms
              <input
                value={settings.forms}
                disabled={busy}
                onChange={(e) =>
                  setSettings({ ...settings, forms: e.target.value })
                }
                maxLength={150}
              />
            </label>
            <label>
              Section
              <select
                value={settings.section}
                disabled={busy}
                onChange={(e) =>
                  setSettings({ ...settings, section: e.target.value })
                }
              >
                <option value="all">All sections</option>
                <option value="risk">Risk factors</option>
                <option value="mda">Management discussion</option>
                <option value="notes">Financial notes</option>
              </select>
            </label>
            <label>
              Company scope
              <select
                value={
                  scopeCiks.length === 1
                    ? scopeCiks[0]
                    : scopeCiks.length
                      ? "subset"
                      : "all"
                }
                disabled={busy}
                onChange={(e) =>
                  setScopeCiks(e.target.value === "all" ? [] : [e.target.value])
                }
              >
                <option value="all">Entire portfolio</option>
                {scopeCiks.length > 1 && (
                  <option value="subset" disabled>
                    Prepared subset ({scopeCiks.length})
                  </option>
                )}
                {issuers.map((i) => (
                  <option key={i.cik} value={i.cik}>
                    {i.ticker || i.cik}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={s.controls}>
            <button
              disabled={disabled || !settings.query.trim()}
              onClick={() => scanBatch()}
            >
              Search next 5 companies
            </button>
            <button
              disabled={disabled || !settings.query.trim()}
              onClick={() => scanBatch(true)}
            >
              Continue through all unsearched companies
            </button>
            <button
              disabled={disabled || !discoveredScans.some((c: any) => c.error)}
              onClick={() => scanBatch(false, true)}
            >
              Retry failed companies
            </button>
          </div>
          <div className={s.finding}>
            <strong>
              {discoveredScans.filter((c: any) => !c.error).length} company
              scans returned ·{" "}
              {discoveredScans.reduce(
                (n: number, c: any) => n + (c.reviewed || 0),
                0,
              )}{" "}
              filings reviewed · {matches.length} matching filings.
            </strong>
            <p>
              Results use query {capturedSettings?.query || "not yet searched"},
              filed {capturedSettings?.start || "unknown"} through{" "}
              {capturedSettings?.end || "unknown"}.{" "}
              {identity !== previousIdentity && capturedSettings
                ? "Settings changed; starting a new search replaces these results."
                : ""}{" "}
              No match means no match in reviewed filings, not proof that the
              topic is absent. Coverage and older-history limits are shown per
              company.
            </p>
          </div>
          {matches.slice(0, disclosureLimit).map((f: any) => (
            <article className={s.finding} key={`${f.cik}:${f.accession}`}>
              <div className={s.heading}>
                <strong>
                  {f.ticker} · {f.form} · {f.filingDate} · {f.matchCount}{" "}
                  matches
                </strong>
                <button onClick={() => setReader(f)}>
                  Read matching passages
                </button>
              </div>
              {(f.previews || []).map((p: any) => (
                <blockquote key={p.index}>{p.text}</blockquote>
              ))}
              <a
                href={portfolioMetricSourceUrl({ sources: [f] }) || undefined}
                target="_blank"
                rel="noreferrer"
              >
                Open SEC source ↗
              </a>
            </article>
          ))}
          {matches.length > disclosureLimit && (
            <button onClick={() => setDisclosureLimit((n) => n + 30)}>
              Show 30 more matching filings ({matches.length} total)
            </button>
          )}
          <details>
            <summary>Search coverage for each company</summary>
            {discoveredScans.map((c: any) => (
              <div key={c.cik} className={s.finding}>
                <strong>
                  {c.ticker || c.cik}:{" "}
                  {c.error ||
                    `${c.reviewed || 0} reviewed; ${c.matched || 0} matching; ${c.fetchFailed || 0} failed; ${c.sectionUnavailable || 0} unavailable sections`}
                </strong>
                <p>
                  {c.historyLimited
                    ? "Older-history coverage is limited. "
                    : ""}
                  {(c.historyIssues || []).join(" ")} {c.remaining ?? "Unknown"}{" "}
                  eligible filings remain. Checked{" "}
                  {c.checkedAt || c.observedAt || "unknown"}.
                </p>
                {(c.filings || [])
                  .filter((f: any) => f.status === "fetch-failed")
                  .map((f: any) => (
                    <button
                      key={f.accession}
                      disabled={disabled || identity !== previousIdentity}
                      onClick={() => retryDocument(f)}
                    >
                      Retry {f.form} · {f.filingDate}
                    </button>
                  ))}
                {c.nextCursor && (
                  <button
                    disabled={disabled || identity !== previousIdentity}
                    onClick={() =>
                      scanBatch(
                        false,
                        false,
                        issuers.find((i) => i.cik === c.cik),
                      )
                    }
                  >
                    Search older filings for this company
                  </button>
                )}
              </div>
            ))}
          </details>
        </>
      )}
      {activeTab === "ownership" && (
        <>
          <p>
            Select a portfolio company to discover funds reporting direct
            holdings in it. A position’s percentage of fund net assets describes
            that fund’s allocation—it is not your portfolio weight, market
            ownership share or a complete ownership census. Multiple fund share
            classes count as one portfolio series. If you search outside the
            portfolio in the discovery tool below, those results are excluded
            from the portfolio report.
          </p>
          <div className={s.controls}>
            <label>
              Portfolio company
              <select
                value={fundTicker}
                onChange={(e) => setFundTicker(e.target.value)}
              >
                <option value="">Choose a company</option>
                {issuers
                  .filter((i) => i.ticker)
                  .map((i) => (
                    <option key={i.cik} value={i.ticker}>
                      {i.ticker} · {i.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={!fundTicker}
              onClick={() =>
                setFundSettings({
                  securityQuery: fundTicker,
                  securityAsset: "EC",
                })
              }
            >
              Find funds holding this company
            </button>
          </div>
          {fundSettings.securityQuery && (
            <GlobalSecurityFinder
              settings={fundSettings}
              onPatch={(patch: any) =>
                setFundSettings((v: any) => ({ ...v, ...patch }))
              }
              onResult={onFundResult}
              onAddFund={(ticker, accession) =>
                window.open(
                  `/fund/${encodeURIComponent(ticker)}?accession=${encodeURIComponent(accession)}`,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
              selectedTickers={[]}
            />
          )}
          {Object.keys(funds).length > 0 && (
            <p>
              Ownership results for {Object.keys(funds).join(", ")} are included
              when you download the portfolio report. Review each fund’s report
              date and search coverage.
            </p>
          )}
        </>
      )}
      {reader && (
        <DisclosureReader
          filing={reader}
          settings={capturedSettings || initialSettings}
          changesOnly={false}
          notebook={
            {
              collections: [
                {
                  id: "portfolio-report",
                  name: "Portfolio report",
                  items: quotes,
                },
              ],
              labels,
            } as any
          }
          onLabel={(id, label) => setLabels((v) => ({ ...v, [id]: label }))}
          onCollect={(filing, passage, search) => {
            const id = `${filing.cik}:${filing.accession}:${passage.index}`;
            setQuotes((v) => [
              ...v.filter((q) => q.id !== id),
              {
                id,
                ticker: filing.ticker,
                cik: filing.cik,
                accession: filing.accession,
                companyName: filing.companyName,
                form: filing.form,
                filingDate: filing.filingDate,
                reportDate: filing.reportDate,
                documentUrl: filing.documentUrl,
                quote: passage.text,
                section: passage.section,
                settings: search,
                observedAt: filing.observedAt || new Date().toISOString(),
              },
            ]);
          }}
          close={() => setReader(null)}
        />
      )}
    </section>
  );
}
