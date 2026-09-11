"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpRight, Plus, Search } from "lucide-react";
import { ASSET_LABELS } from "../../utils/fundResearch.js";
import { securityWeight } from "../../utils/fundSecuritySearch.js";
import { mergeDiscoveredFunds } from "../../utils/globalFundSecurity.js";
import { fundCsv } from "../../utils/fundSecurity.js";
import { downloadText } from "../../utils/download.js";
import { money } from "./fundUi";
import type { Holding } from "./fundTypes";
import s from "./GlobalSecurityFinder.module.css";

type Settings = { securityQuery?: string; securityAsset?: string };
type Totals = {
  value: number | null;
  knownValue: number | null;
  missingValueCount: number;
  pctOfNav: number | null;
  knownWeight: number | null;
  missingWeightCount: number;
  positionCount: number;
};
type DiscoveredFund = Totals & {
  id: string;
  name: string;
  tickers: string[];
  cik: string;
  seriesId: string | null;
  asOf: string | null;
  filingDate: string | null;
  accession: string;
  sourceUrl: string;
  filingUrl: string;
  categories: (Totals & { asset: string })[];
  holdings: Holding[];
  stockPositionCount: number;
  derivativeCount: number;
};
type Coverage = {
  startDate: string;
  endDate: string;
  scannedDocuments: number;
  checkedSeries: string[];
  unavailableCount: number;
  excludedCount: number;
  rangeTotal: number;
  rangeLabel: string;
  snapshotAt: string;
};
type SearchResponse = {
  target: {
    query: string;
    label: string;
    kind: string;
    ticker?: string;
    name?: string;
    suggestions: { query: string; label: string }[];
  };
  funds: DiscoveredFund[];
  coverage: Coverage;
  issues: {
    id: string;
    name: string;
    accession: string;
    message: string;
    sourceUrl: string;
  }[];
  nextCursor: string | null;
};
type Request = {
  key: string;
  query: string;
  asset: string;
  cursor: string | null;
  append: boolean;
  sequence: number;
};

const normalizeAsset = (asset?: string) => (asset === "all" ? "all" : "EC");
const searchKey = (query: string, asset: string) =>
  JSON.stringify([query, asset]);
const assetLabels: Record<string, string> = {
  ...ASSET_LABELS,
  EC: "Common stock",
  EP: "Preferred stock",
  DBT: "Bonds / debt",
};
const securityType = (asset: string) =>
  assetLabels[asset] || "Type unavailable";
const dateLabel = (value?: string | null) => {
  if (!value) return "Unavailable";
  const date = new Date(value.slice(0, 10) + "T00:00:00Z");
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
};
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function ReportedMetric({
  value,
  known,
  missing,
  weight = false,
}: {
  value: number | null;
  known: number | null;
  missing: number;
  weight?: boolean;
}) {
  const format = weight ? securityWeight : money;
  return (
    <>
      <strong
        title={
          isNumber(value)
            ? weight
              ? `${value}% of fund net assets`
              : value.toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 2,
                })
            : undefined
        }
      >
        {isNumber(value)
          ? weight && value === 0
            ? "Reported 0%"
            : format(value)
          : "Unavailable"}
      </strong>
      {missing > 0 && (
        <small>
          {missing} {weight ? "weights" : "values"} missing
          {isNumber(known) ? ` · Known subtotal ${format(known)}` : ""}
        </small>
      )}
    </>
  );
}

export default function GlobalSecurityFinder({
  settings,
  onPatch,
  onAddFund,
  selectedTickers,
  onResult,
}: {
  settings: Settings;
  onPatch: (patch: Partial<Settings>) => unknown;
  onAddFund: (ticker: string, accession: string) => void;
  selectedTickers: string[];
  onResult?: (result: any) => void;
}) {
  const externalQuery = (settings.securityQuery || "").trim();
  const externalAsset = normalizeAsset(settings.securityAsset);
  const [query, setQuery] = useState(externalQuery);
  const [asset, setAsset] = useState(externalAsset);
  const [request, setRequest] = useState<Request | null>(() =>
    externalQuery
      ? {
          key: searchKey(externalQuery, externalAsset),
          query: externalQuery,
          asset: externalAsset,
          cursor: null,
          append: false,
          sequence: 0,
        }
      : null,
  );
  const [result, setResult] = useState<SearchResponse | null>(null);
  useEffect(() => { if(result) onResult?.(result); }, [result, onResult]);
  const [loading, setLoading] = useState(Boolean(externalQuery));
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [sort, setSort] = useState("weight");
  const [shareClasses, setShareClasses] = useState<Record<string, string>>({});
  const sequence = useRef(0);
  const activeKey = useRef(searchKey(externalQuery, externalAsset));

  // URL changes start a new search; our own URL patch must not reset a page
  // already being fetched or a draft the user has begun typing.
  useEffect(() => {
    const key = searchKey(externalQuery, externalAsset);
    if (key === activeKey.current) return;
    activeKey.current = key;
    sequence.current += 1;
    setQuery(externalQuery);
    setAsset(externalAsset);
    setResult(null);
    setError("");
    setMessage("");
    setShareClasses({});
    setLoading(Boolean(externalQuery));
    setRequest(
      externalQuery
        ? {
            key,
            query: externalQuery,
            asset: externalAsset,
            cursor: null,
            append: false,
            sequence: sequence.current,
          }
        : null,
    );
  }, [externalQuery, externalAsset]);

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    const current = () =>
      !controller.signal.aborted &&
      sequence.current === request.sequence &&
      activeKey.current === request.key;
    const params = new URLSearchParams({
      q: request.query,
      asset: request.asset,
    });
    if (request.cursor) params.set("cursor", request.cursor);
    setLoading(true);
    setError("");
    fetch(`/api/fund-security-discovery?${params}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body.error || "The SEC fund search could not be completed.",
          );
        if (!current()) return;
        const incoming = body as SearchResponse;
        setResult((previous) => {
          if (!request.append || !previous) return incoming;
          const issues = new Map(
            [...previous.issues, ...incoming.issues].map((issue) => [
              `${issue.id}:${issue.accession}`,
              issue,
            ]),
          );
          return {
            ...incoming,
            funds: mergeDiscoveredFunds(previous.funds, incoming.funds),
            issues: [...issues.values()],
            coverage: {
              ...incoming.coverage,
              checkedSeries: [
                ...new Set([
                  ...previous.coverage.checkedSeries,
                  ...incoming.coverage.checkedSeries,
                ]),
              ],
              scannedDocuments:
                previous.coverage.scannedDocuments +
                incoming.coverage.scannedDocuments,
              unavailableCount:
                previous.coverage.unavailableCount +
                incoming.coverage.unavailableCount,
              excludedCount:
                previous.coverage.excludedCount +
                incoming.coverage.excludedCount,
            },
          };
        });
      })
      .catch((failure) => {
        if (current())
          setError(
            failure instanceof Error
              ? failure.message
              : "The search is temporarily unavailable. Please try again.",
          );
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => controller.abort();
  }, [request]);

  function startSearch(nextQuery: string, nextAsset = asset) {
    const cleanQuery = nextQuery.trim().slice(0, 100);
    if (!cleanQuery) return;
    const key = searchKey(cleanQuery, nextAsset);
    activeKey.current = key;
    sequence.current += 1;
    setQuery(cleanQuery);
    setAsset(nextAsset);
    setResult(null);
    setError("");
    setMessage("");
    setShareClasses({});
    setLoading(true);
    setRequest({
      key,
      query: cleanQuery,
      asset: nextAsset,
      cursor: null,
      append: false,
      sequence: sequence.current,
    });
    onPatch({ securityQuery: cleanQuery, securityAsset: nextAsset });
  }

  function fetchMore(retry = false) {
    if (!request || loading) return;
    const cursor = retry ? request.cursor : result?.nextCursor;
    if (!retry && !cursor) return;
    sequence.current += 1;
    setLoading(true);
    setError("");
    setRequest({
      ...request,
      cursor: cursor || null,
      append: retry ? request.append : true,
      sequence: sequence.current,
    });
  }

  const sortedFunds = useMemo(() => {
    const funds = [...(result?.funds || [])];
    return funds.sort((left, right) => {
      if (sort !== "name") {
        const field = sort === "value" ? "value" : "pctOfNav";
        const a = left[field];
        const b = right[field];
        if (isNumber(a) && !isNumber(b)) return -1;
        if (!isNumber(a) && isNumber(b)) return 1;
        if (isNumber(a) && isNumber(b) && a !== b) return b - a;
      }
      return left.name.localeCompare(right.name);
    });
  }, [result, sort]);

  function download() {
    if (!result || !request || !sortedFunds.length) return;
    const coverage = result.coverage;
    const rows: (string | number | null)[][] = [
      [
        "Search",
        "Security types",
        "Coverage",
        "Funds found so far",
        "Unique fund series checked",
        "Reports examined",
        "Search start date",
        "Search end date",
        "More search batches available",
        "Fund name",
        "Tickers",
        "CIK",
        "Series ID",
        "Portfolio date",
        "Filing date",
        "Matching positions",
        "Reported value USD",
        "Known value subtotal USD",
        "Missing value count",
        "Percent of fund net assets",
        "Known weight subtotal",
        "Missing weight count",
        "Reported types",
        "Accession",
        "SEC filing",
        "N-PORT source",
      ],
      ...sortedFunds.map((fund) => [
        request.query,
        request.asset === "EC" ? "Common stock" : "All reported security types",
        "Found results only; not a complete list of funds or live holdings",
        result.funds.length,
        coverage.checkedSeries.length,
        coverage.scannedDocuments,
        coverage.startDate,
        coverage.endDate,
        result.nextCursor ? "Yes" : "No",
        fund.name,
        fund.tickers.join("; "),
        fund.cik,
        fund.seriesId,
        fund.asOf,
        fund.filingDate,
        fund.positionCount,
        fund.value,
        fund.knownValue,
        fund.missingValueCount,
        fund.pctOfNav,
        fund.knownWeight,
        fund.missingWeightCount,
        fund.categories
          .map((category) => securityType(category.asset))
          .join("; "),
        fund.accession,
        fund.filingUrl,
        fund.sourceUrl,
      ]),
    ];
    downloadText(
      `funds-found-${request.query.replace(/[^a-zA-Z0-9_-]+/g, "-")}.csv`,
      fundCsv(rows),
      "text/csv",
    );
    setMessage(
      `Downloaded ${sortedFunds.length} found funds with search coverage and SEC sources.`,
    );
  }

  const coverage = result?.coverage;
  const suggestions = result?.target.suggestions || [];
  const draftChanged = Boolean(
    request && (query.trim() !== request.query || asset !== request.asset),
  );

  return (
    <section className={s.panel} aria-labelledby="global-security-heading">
      <header className={s.header}>
        <p className={s.eyebrow}>Search by stock · Across SEC fund reports</p>
        <h2 id="global-security-heading">Which funds hold this security?</h2>
        <p>
          Enter a company or ticker to find mutual funds and ETFs with reported
          holdings, and see how much of each fund it represents. No fund
          selection needed.
        </p>
      </header>

      <form
        className={s.form}
        onSubmit={(event) => {
          event.preventDefault();
          startSearch(query);
        }}
      >
        <label className={s.queryLabel}>
          Company, ticker or security identifier
          <span className={s.searchInput}>
            <Search size={19} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="e.g. Apple or AAPL"
              maxLength={100}
              required
              aria-describedby="global-security-scope"
            />
          </span>
        </label>
        <label>
          Security type
          <select
            value={asset}
            onChange={(event) => setAsset(event.target.value)}
          >
            <option value="EC">Common stock</option>
            <option value="all">All reported security types</option>
          </select>
        </label>
        <button
          className={s.primary}
          type="submit"
          disabled={!query.trim() || (loading && !draftChanged)}
        >
          <Search size={17} aria-hidden="true" />
          {loading && !draftChanged ? "Searching…" : "Search funds"}
        </button>
      </form>
      <div className={s.searchHelp} id="global-security-scope">
        <p>
          Searches SEC N-PORT reports across funds, independently of your
          comparison selection.
        </p>
        <div className={s.examples}>
          <span>Try:</span>
          <button type="button" onClick={() => startSearch("Apple", "EC")}>
            Apple
          </button>
          <button type="button" onClick={() => startSearch("Microsoft", "EC")}>
            Microsoft
          </button>
        </div>
      </div>

      <div
        className={s.status}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {loading
          ? request?.append
            ? "Checking more SEC reports. Funds already found remain below."
            : `Searching SEC reports for ${request?.query || "this security"} and verifying fund holdings. This can take about a minute…`
          : message}
      </div>

      {error && (
        <div className={s.error} role="alert">
          <p>{error}</p>
          {result && <p>Your previously found funds are still shown below.</p>}
          <button
            className={s.secondary}
            type="button"
            onClick={() => fetchMore(true)}
            disabled={loading}
          >
            Retry {request?.append ? "this batch" : "search"}
          </button>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className={s.suggestions}>
          <strong>Did you mean one of these companies?</strong>
          <p>Select a match to search its reported holdings.</p>
          <div>
            {suggestions.map((suggestion) => (
              <button
                className={s.secondary}
                type="button"
                key={suggestion.query}
                onClick={() => startSearch(suggestion.query)}
              >
                {suggestion.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {result && coverage && (
        <>
          <div className={s.resultHeader}>
            <div>
              <p className={s.eyebrow}>
                {result.target.label || request?.query}
                {request?.asset === "EC"
                  ? " · Common stock"
                  : " · All security types"}
              </p>
              <h3 aria-live="polite" aria-atomic="true">
                {result.funds.length.toLocaleString()}{" "}
                {result.funds.length === 1 ? "fund" : "funds"} found so far
              </h3>
              <p>
                {coverage.checkedSeries.length.toLocaleString()} fund series
                checked
                {result.nextCursor
                  ? " · More reports remain to search"
                  : " · Available search batches checked"}
              </p>
              {coverage.unavailableCount > 0 && (
                <p>
                  {coverage.unavailableCount} report checks unavailable. See
                  search coverage below.
                </p>
              )}
            </div>
            {result.funds.length > 0 && (
              <div className={s.resultActions}>
                <label>
                  Sort results found
                  <select
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                  >
                    <option value="weight">Largest % of fund</option>
                    <option value="value">Largest reported value</option>
                    <option value="name">Fund name</option>
                  </select>
                </label>
                <button
                  className={s.secondary}
                  type="button"
                  onClick={download}
                >
                  <ArrowDownToLine size={16} aria-hidden="true" />
                  Export found funds
                </button>
              </div>
            )}
          </div>

          {draftChanged && (
            <p className={s.draftNotice}>
              Results below are for {request?.query}. Select Search funds to
              apply your changes.
            </p>
          )}

          {!result.funds.length && !loading && (
            <div className={s.empty}>
              <strong>
                No matching funds found in the reports checked so far.
              </strong>
              <p>
                {result.nextCursor
                  ? "Continue searching more reports below. A fund may appear in a later batch."
                  : suggestions.length
                    ? "Choose a suggested company, or search its exact name or ticker."
                    : "Try the company’s full name, ticker, CUSIP or ISIN. Missing or unavailable reports can leave gaps."}
              </p>
            </div>
          )}

          <div className={s.results}>
            {sortedFunds.map((fund) => {
              const ticker = shareClasses[fund.id] || fund.tickers[0] || "";
              const alreadySelected = selectedTickers.includes(ticker);
              const full = selectedTickers.length >= 4;
              return (
                <article className={s.card} key={fund.id}>
                  <div className={s.cardHeader}>
                    <div className={s.fundIdentity}>
                      <h4>{fund.name}</h4>
                      <div className={s.identityMeta}>
                        {fund.tickers.length === 1 && (
                          <span className={s.ticker}>{ticker}</span>
                        )}
                        <span>
                          Portfolio: <strong>{dateLabel(fund.asOf)}</strong>
                        </span>
                        <span>Filed: {dateLabel(fund.filingDate)}</span>
                      </div>
                    </div>
                    <a
                      href={fund.filingUrl || fund.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={s.source}
                    >
                      SEC filing <ArrowUpRight size={15} aria-hidden="true" />
                    </a>
                  </div>
                  <dl className={s.metrics}>
                    <div className={s.weightMetric}>
                      <dt>% of fund net assets</dt>
                      <dd>
                        <ReportedMetric
                          value={fund.pctOfNav}
                          known={fund.knownWeight}
                          missing={fund.missingWeightCount}
                          weight
                        />
                      </dd>
                    </div>
                    <div>
                      <dt>Reported holding value</dt>
                      <dd>
                        <ReportedMetric
                          value={fund.value}
                          known={fund.knownValue}
                          missing={fund.missingValueCount}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt>Matching positions</dt>
                      <dd>
                        <strong>{fund.positionCount.toLocaleString()}</strong>
                      </dd>
                    </div>
                  </dl>
                  <div className={s.cardFooter}>
                    <div className={s.types}>
                      {fund.categories.map((category) => (
                        <span key={category.asset}>
                          {securityType(category.asset)}
                          {fund.categories.length > 1 &&
                          isNumber(category.pctOfNav)
                            ? ` · ${securityWeight(category.pctOfNav)}`
                            : ""}
                        </span>
                      ))}
                    </div>
                    {ticker ? (
                      <div className={s.compare}>
                        {fund.tickers.length > 1 && (
                          <label>
                            <span className={s.srOnly}>
                              Share class for {fund.name}
                            </span>
                            <select
                              value={ticker}
                              onChange={(event) =>
                                setShareClasses((current) => ({
                                  ...current,
                                  [fund.id]: event.target.value,
                                }))
                              }
                            >
                              {fund.tickers.map((symbol) => (
                                <option value={symbol} key={symbol}>
                                  {symbol}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <button
                          className={s.secondary}
                          type="button"
                          disabled={alreadySelected || full}
                          title={
                            full && !alreadySelected
                              ? "Remove a fund from your selection to compare another (maximum 4)."
                              : undefined
                          }
                          onClick={() => {
                            onAddFund(ticker, fund.accession);
                            setMessage(
                              `Added ${ticker} to your comparison selection with this report.`,
                            );
                          }}
                        >
                          {!alreadySelected && (
                            <Plus size={15} aria-hidden="true" />
                          )}
                          {alreadySelected
                            ? "In comparison"
                            : full
                              ? "Comparison full (4/4)"
                              : "Add to comparison"}
                        </button>
                      </div>
                    ) : (
                      <span className={s.noTicker}>
                        Fund series {fund.seriesId || fund.cik} · No ticker
                        listed
                      </span>
                    )}
                  </div>
                  {fund.derivativeCount > 0 && (
                    <p className={s.derivativeNote}>
                      Includes derivatives: reported fair value is not the
                      underlying stock exposure.
                    </p>
                  )}
                  <details className={s.details}>
                    <summary>
                      View {fund.positionCount} matching{" "}
                      {fund.positionCount === 1 ? "holding" : "holdings"} and
                      source
                    </summary>
                    <div
                      className={s.tableWrap}
                      tabIndex={0}
                      role="region"
                      aria-label={`Matching holdings for ${fund.name}`}
                    >
                      <table>
                        <thead>
                          <tr>
                            <th>Reported security</th>
                            <th>Type</th>
                            <th>Value</th>
                            <th>% of net assets</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fund.holdings.map((holding, index) => (
                            <tr key={`${holding.id}:${index}`}>
                              <td>
                                <strong>{holding.name}</strong>
                                {holding.title && (
                                  <small>{holding.title}</small>
                                )}
                                <small>
                                  {holding.tickerSymbol
                                    ? `${holding.tickerSymbol} · `
                                    : ""}
                                  {holding.cusip
                                    ? `CUSIP ${holding.cusip}`
                                    : holding.isin
                                      ? `ISIN ${holding.isin}`
                                      : "Identifier unavailable"}
                                  {holding.payoffProfile
                                    ? ` · ${holding.payoffProfile}`
                                    : ""}
                                </small>
                              </td>
                              <td>{securityType(holding.assetCat)}</td>
                              <td>
                                {isNumber(holding.value)
                                  ? money(holding.value)
                                  : "Unavailable"}
                              </td>
                              <td>
                                {isNumber(holding.pctOfNav)
                                  ? securityWeight(holding.pctOfNav)
                                  : "Unavailable"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className={s.sourceDetail}>
                      Series {fund.seriesId || "unavailable"} · CIK {fund.cik} ·
                      Accession {fund.accession}
                      {fund.sourceUrl && (
                        <>
                          {" "}
                          ·{" "}
                          <a
                            href={fund.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Read N-PORT source
                          </a>
                        </>
                      )}
                    </p>
                  </details>
                </article>
              );
            })}
          </div>

          {result.nextCursor && (
            <div className={s.more}>
              <button
                className={s.primary}
                type="button"
                disabled={loading || Boolean(error)}
                onClick={() => fetchMore()}
              >
                {loading ? "Checking more reports…" : "Find more funds"}
              </button>
              <p>
                Search the next batch of reports and add verified matches to
                these results.
              </p>
            </div>
          )}

          <details className={s.coverage}>
            <summary>Search coverage and reporting dates</summary>
            <p>
              Searches public SEC N-PORT filings from{" "}
              {dateLabel(coverage.startDate)} to {dateLabel(coverage.endDate)}.{" "}
              {coverage.scannedDocuments.toLocaleString()} reports examined and{" "}
              {coverage.checkedSeries.length.toLocaleString()} unique fund
              series checked so far. Candidate funds are checked against their
              latest available report before a match is shown.
            </p>
            <p>
              {result.nextCursor
                ? "More search batches remain. Counts and sorting apply only to funds found so far."
                : "Available search batches are finished; this does not guarantee complete coverage of every fund."}{" "}
              Funds that do not file public N-PORT reports and unavailable
              filings are outside the verified results. Different funds can have
              different portfolio dates. Share classes of the same fund series
              share one portfolio result.
            </p>
            {(coverage.unavailableCount > 0 || coverage.excludedCount > 0) && (
              <p>
                {coverage.unavailableCount.toLocaleString()} report checks
                unavailable · {coverage.excludedCount.toLocaleString()}{" "}
                candidates excluded after verification.
              </p>
            )}
            {result.issues.length > 0 && (
              <ul>
                {result.issues.map((issue) => (
                  <li key={`${issue.id}:${issue.accession}`}>
                    {issue.sourceUrl ? (
                      <a
                        href={issue.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {issue.name || issue.id}
                      </a>
                    ) : (
                      issue.name || issue.id
                    )}
                    : {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </>
      )}

      <p className={s.caveat}>
        Reported holdings are historical, not live positions. Percentages
        measure the holding against that fund’s net assets; they are not the
        fund’s share of the company. Security names may match different
        instruments—use the type filter and filing evidence.
      </p>
    </section>
  );
}
