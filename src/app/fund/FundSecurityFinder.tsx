"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookmarkPlus,
  Search,
} from "lucide-react";
import { ASSET_LABELS } from "../../utils/fundResearch.js";
import {
  searchFundHoldings,
  securitySearchEvidence,
  securityWeight,
} from "../../utils/fundSecuritySearch.js";
import { money } from "./fundUi";
import type { Fund } from "./fundTypes";
import s from "./FundSecurityFinder.module.css";

type Settings = {
  reportMap?: Record<string, string>;
  securityQuery?: string;
  securityAsset?: string;
  securityCountry?: string;
};
type SearchResult = ReturnType<typeof searchFundHoldings>;
type SearchResponse = {
  result: SearchResult;
  funds: Fund[];
  errors: { ticker: string; message: string }[];
  resolvedReports: Record<string, string>;
  pagination: {
    page: number;
    pageCount: number;
    pageSize: number;
    total: number;
  };
};
const assetLabels: Record<string, string> = {
  ...ASSET_LABELS,
  EC: "Common stock",
  EP: "Preferred stock",
  DBT: "Bonds / debt",
  UNKNOWN: "Type unavailable",
};
const preciseMoney = (value: number | null) =>
  value == null
    ? "Unavailable"
    : value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      });
function HoldingValue({
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
          value == null
            ? undefined
            : weight
              ? `${value}% of fund net assets`
              : preciseMoney(value)
        }
      >
        {value == null ? "Unavailable" : format(value)}
      </strong>
      {missing > 0 && (
        <small>
          {missing} {weight ? "weights" : "values"} missing
          {known == null ? "" : ` · Known subtotal ${format(known)}`}
        </small>
      )}
    </>
  );
}

function requestParams(
  tickers: string[],
  settings: Settings,
  reports: Record<string, string>,
  page: number,
) {
  const params = new URLSearchParams({
    mode: "search",
    tickers: tickers.join(","),
    reports: JSON.stringify(
      Object.fromEntries(
        tickers.map((ticker) => [ticker, reports[ticker] || ""]),
      ),
    ),
    q: settings.securityQuery || "",
    asset: settings.securityAsset || "",
    country: settings.securityCountry || "",
    page: String(page),
  });
  return params;
}

export default function FundSecurityFinder({
  tickers,
  settings,
  onPatch,
  onEvidence,
  onFunds,
}: {
  tickers: string[];
  settings: Settings;
  onPatch: (patch: Partial<Settings>) => unknown;
  onEvidence: (evidence: ReturnType<typeof securitySearchEvidence>) => unknown;
  onFunds?: (funds: Fund[]) => void;
}) {
  const [query, setQuery] = useState(settings.securityQuery || "");
  const [asset, setAsset] = useState(settings.securityAsset || "");
  const [country, setCountry] = useState(settings.securityCountry || "");
  const [pageState, setPage] = useState({ key: "", page: 1 });
  const [attempt, setAttempt] = useState(0);
  const [payload, setPayload] = useState<{
    key: string;
    data: SearchResponse;
  } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState("weight");
  const [showDetails, setShowDetails] = useState(false);
  const frozenReports = useRef<{ key: string; map: Record<string, string> }>({
    key: "",
    map: {},
  });
  const patchRef = useRef(onPatch);
  const fundsRef = useRef(onFunds);
  useEffect(() => {
    patchRef.current = onPatch;
  }, [onPatch]);
  useEffect(() => {
    fundsRef.current = onFunds;
  }, [onFunds]);
  useEffect(() => {
    setQuery(settings.securityQuery || "");
    setAsset(settings.securityAsset || "");
    setCountry(settings.securityCountry || "");
  }, [
    settings.securityQuery,
    settings.securityAsset,
    settings.securityCountry,
  ]);
  const selected = tickers.join(",");
  const reportKey = JSON.stringify(
    Object.fromEntries(
      tickers.map((ticker) => [ticker, settings.reportMap?.[ticker] || ""]),
    ),
  );
  const searchKey = JSON.stringify([
    selected,
    reportKey,
    settings.securityQuery || "",
    settings.securityAsset || "",
    settings.securityCountry || "",
  ]);
  const page = pageState.key === searchKey ? pageState.page : 1;
  const responseKey = `${searchKey}:${page}:${attempt}`;
  const data = payload?.key === responseKey ? payload.data : null;
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setPayload(null);
    if (!selected) return () => controller.abort();
    const reports = JSON.parse(reportKey);
    const frozenKey = `${selected}:${reportKey}`;
    const requestReports =
      frozenReports.current.key === frozenKey
        ? frozenReports.current.map
        : reports;
    const params = requestParams(
      selected.split(","),
      {
        securityQuery: settings.securityQuery,
        securityAsset: settings.securityAsset,
        securityCountry: settings.securityCountry,
      },
      requestReports,
      page,
    );
    fetch(`/api/fund-workspace?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body.error || "The portfolio search could not be completed.",
          );
        if (controller.signal.aborted) return;
        fundsRef.current?.(body.funds || []);
        frozenReports.current = {
          key: frozenKey,
          map: { ...reports, ...body.resolvedReports },
        };
        setPayload({ key: responseKey, data: body });
        const newlyResolved = Object.fromEntries(
          Object.entries(body.resolvedReports || {}).filter(
            ([ticker]) => !reports[ticker],
          ),
        );
        if (Object.keys(newlyResolved).length)
          patchRef.current({ reportMap: { ...reports, ...newlyResolved } });
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure.message ||
              "Search unavailable. Retry the selected reports.",
          );
      });
    return () => controller.abort();
  }, [
    selected,
    reportKey,
    settings.securityQuery,
    settings.securityAsset,
    settings.securityCountry,
    page,
    responseKey,
  ]);
  const dirty =
    query !== (settings.securityQuery || "") ||
    asset !== (settings.securityAsset || "") ||
    country !== (settings.securityCountry || "");
  const result = data?.result;
  async function download() {
    if (!data || exporting) return;
    setExporting(true);
    setMessage("");
    try {
      const params = requestParams(
        tickers,
        settings,
        { ...settings.reportMap, ...data.resolvedReports },
        1,
      );
      params.set("format", "csv");
      const response = await fetch(`/api/fund-workspace?${params}`);
      if (!response.ok) {
        const failure = await response.json();
        throw new Error(
          failure.error || "The complete search export could not be created.",
        );
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `fund-security-search-${tickers.join("-")}.csv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        "Complete search CSV downloaded with report dates, settings, position records, and coverage.",
      );
    } catch (failure) {
      setMessage(
        failure instanceof Error
          ? failure.message
          : "Export failed. Please retry.",
      );
    } finally {
      setExporting(false);
    }
  }
  function submitSearch(
    nextQuery = query,
    nextAsset = asset,
    nextCountry = country,
  ) {
    setMessage("");
    setPage({ key: "", page: 1 });
    setAttempt((value) => value + 1);
    onPatch({
      securityQuery: nextQuery.trim(),
      securityAsset: nextAsset,
      securityCountry: nextCountry,
    });
  }
  const funds = [...(result?.exposureByFund || [])].sort((a, b) => {
    if (sort === "name")
      return String(a.ticker).localeCompare(String(b.ticker));
    const key = sort === "value" ? "value" : "pctOfNav";
    return (
      Number(b.status === "matched") - Number(a.status === "matched") ||
      Number(b[key] != null) - Number(a[key] != null) ||
      (b[key] ?? 0) - (a[key] ?? 0) ||
      String(a.ticker).localeCompare(String(b.ticker))
    );
  });
  const largestWeight = Math.max(
    0,
    ...funds.map((fund) => Math.abs(fund.pctOfNav || 0)),
  );
  const stockFunds = funds.filter((fund) => fund.stockPositionCount > 0).length;
  const submittedQuery = settings.securityQuery?.trim() || "";
  const activeFilters = [
    settings.securityAsset
      ? assetLabels[settings.securityAsset] || settings.securityAsset
      : "All security types",
    settings.securityCountry || "All countries",
  ];
  return (
    <section className={s.panel} aria-label="Security finder">
      <header className={s.header}>
        <div>
          <p className={s.eyebrow}>Find a security</p>
          <h2>Which funds hold it?</h2>
          <p>
            Search a company or security to compare its reported holdings in
            your selected funds. See how much each fund holds, then open the
            supporting positions.
          </p>
        </div>
        <Search size={28} aria-hidden="true" />
      </header>
      <div className={s.scope}>
        <b>
          Searching {tickers.length} selected{" "}
          {tickers.length === 1 ? "fund" : "funds"}
        </b>
        <span>{tickers.join(" · ") || "Add funds above"}</span>
        <small>
          Add or change funds in your research selection above. This search
          covers that selection only.
        </small>
      </div>
      <form
        className={s.form}
        onSubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
      >
        <label>
          Company, stock ticker or security identifier
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={160}
            placeholder="Apple, AAPL, or 037833100…"
            aria-describedby="security-search-help"
          />
        </label>
        <label>
          Security type
          <select
            value={asset}
            onChange={(event) => setAsset(event.target.value)}
          >
            <option value="">All security types</option>
            {[
              ...new Set([
                "EC",
                "DBT",
                ...(result?.options.assets || []),
                ...(asset ? [asset] : []),
              ]),
            ].map((value) => (
              <option key={value} value={value}>
                {assetLabels[value] || value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reported country
          <select
            value={country}
            onChange={(event) => setCountry(event.target.value)}
          >
            <option value="">All countries</option>
            {[
              ...new Set([
                ...(result?.options.countries || []),
                ...(country ? [country] : []),
              ]),
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button className={s.primary} type="submit" disabled={!tickers.length}>
          <Search size={17} aria-hidden="true" /> Find holdings
        </button>
      </form>
      <div className={s.quickFilters} aria-label="Quick security filters">
        <span>Show:</span>
        {[
          ["", "All securities"],
          ["EC", "Stocks only"],
          ["DBT", "Bonds only"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={asset === value}
            disabled={!tickers.length}
            onClick={() => {
              setAsset(value);
              submitSearch(query, value);
            }}
          >
            {label}
          </button>
        ))}
        {(asset || country) && (
          <button
            type="button"
            onClick={() => {
              setAsset("");
              setCountry("");
              submitSearch(query, "", "");
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      <p id="security-search-help" className={s.help}>
        Company names can match both shares and bonds. Choose “Stocks only” for
        common shares. If a ticker finds nothing, try the company name; some SEC
        records omit tickers.
      </p>
      {query.trim().toUpperCase() === "APPL" && (
        <div className={s.suggestion}>
          <div>
            <b>Looking for Apple stock?</b>
            <p>
              Apple’s ticker is AAPL. “APPL” is a text search and can also match
              names such as Applied Materials.
            </p>
          </div>
          <button
            className={s.secondary}
            onClick={() => {
              setQuery("Apple");
              setAsset("EC");
              submitSearch("Apple", "EC");
            }}
          >
            Search Apple · Stocks only
          </button>
        </div>
      )}
      {dirty && (
        <p className={s.notice} role="status">
          Search edits are ready. Select “Find holdings” to update the results
          below.
        </p>
      )}
      {!tickers.length ? (
        <p className={s.empty}>
          Add at least one fund to the research selection above to search its
          SEC portfolio.
        </p>
      ) : error ? (
        <div role="alert" className={s.notice}>
          {error}{" "}
          <button
            className={s.secondary}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry search
          </button>
        </div>
      ) : !data ? (
        <div role="status" className={s.empty}>
          <b>Searching reported holdings…</b>
          <p>
            Reviewing the complete portfolios for {tickers.join(", ")}. Large
            bond portfolios may take a moment.
          </p>
        </div>
      ) : (
        result && (
          <>
            <div className={s.answerHeading}>
              <div>
                <p className={s.eyebrow}>
                  Results for{" "}
                  {submittedQuery
                    ? `“${submittedQuery}”`
                    : "all reported securities"}
                </p>
                <h3>
                  {result.matchedFunds} of {tickers.length} selected funds have
                  matches
                </h3>
                <p>
                  {activeFilters.join(" · ")} · {result.coverage.length} of{" "}
                  {tickers.length} portfolios searched
                </p>
              </div>
              <button
                className={s.secondary}
                onClick={download}
                disabled={exporting || !result.coverage.length}
              >
                <ArrowDownToLine size={16} aria-hidden="true" />
                {exporting ? "Preparing CSV…" : "Export results"}
              </button>
            </div>
            {result.totalGroups > 0 && !stockFunds && (
              <p className={s.notice}>
                <b>No common-stock matches in these results.</b> The matching
                positions are other security types, such as bonds. They do not
                establish stock ownership.
              </p>
            )}
            <div className={s.summaryIntro}>
              <div>
                <h3>Holdings by fund</h3>
                <p>
                  Totals cover all matching securities in each fund, including
                  results on other pages. A text match does not confirm a single
                  company.
                </p>
              </div>
              <label>
                Sort funds
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="weight">Largest % of fund</option>
                  <option value="value">Largest USD holding</option>
                  <option value="name">Fund ticker A–Z</option>
                </select>
              </label>
            </div>
            <div className={s.fundSummaries} aria-label="Holdings by fund">
              {funds.map((fund) => (
                <article key={fund.ticker} className={s.fundSummary}>
                  <div className={s.fundIdentity}>
                    <a
                      href={`/fund/${encodeURIComponent(fund.ticker || "")}?accession=${encodeURIComponent(fund.accession || "")}`}
                    >
                      <b>{fund.ticker}</b>
                      <ArrowUpRight size={15} aria-hidden="true" />
                    </a>
                    <span>{fund.name}</span>
                    <small>
                      Portfolio as of {fund.asOf || "date unavailable"}
                    </small>
                  </div>
                  {fund.status === "matched" ? (
                    <>
                      <div className={s.amounts}>
                        <div>
                          <span>Share of fund net assets</span>
                          <HoldingValue
                            value={fund.pctOfNav}
                            known={fund.knownWeight}
                            missing={fund.missingWeightCount}
                            weight
                          />
                          <div className={s.weightTrack} aria-hidden="true">
                            <i
                              className={
                                fund.pctOfNav != null && fund.pctOfNav < 0
                                  ? s.negative
                                  : ""
                              }
                              style={{
                                width: `${largestWeight && fund.pctOfNav != null ? (Math.abs(fund.pctOfNav) / largestWeight) * 100 : 0}%`,
                              }}
                            />
                          </div>
                        </div>
                        <div>
                          <span>Reported holding value</span>
                          <HoldingValue
                            value={fund.value}
                            known={fund.knownValue}
                            missing={fund.missingValueCount}
                          />
                        </div>
                      </div>
                      <div
                        className={s.breakdown}
                        aria-label={`${fund.ticker} holdings by security type`}
                      >
                        {fund.categories.map((category) => (
                          <div key={category.asset}>
                            <span>
                              {assetLabels[category.asset] || category.asset}
                            </span>
                            <b
                              title={
                                category.pctOfNav == null
                                  ? undefined
                                  : `${category.pctOfNav}%`
                              }
                            >
                              {securityWeight(category.pctOfNav)}
                            </b>
                            <small>
                              {category.positionCount}{" "}
                              {category.positionCount === 1
                                ? "position"
                                : "positions"}{" "}
                              ·{" "}
                              {category.value == null
                                ? "Value unavailable"
                                : money(category.value)}
                            </small>
                          </div>
                        ))}
                      </div>
                      {!!fund.derivativeCount && (
                        <p className={s.cardNote}>
                          Includes derivative fair values, which do not measure
                          exposure to the underlying stock.
                        </p>
                      )}
                      {!!fund.nonLongCount && (
                        <p className={s.cardNote}>
                          Includes short or unspecified positions. Signed
                          weights may offset one another.
                        </p>
                      )}
                      <p className={s.cardNote}>
                        {fund.matchedPositions} matching{" "}
                        {fund.matchedPositions === 1 ? "position" : "positions"}{" "}
                        ·{" "}
                        {fund.stockPositionCount
                          ? `${fund.stockPositionCount} common-stock ${fund.stockPositionCount === 1 ? "position" : "positions"}`
                          : "No common-stock match"}
                      </p>
                    </>
                  ) : (
                    <div className={s.noMatch}>
                      <b>No matching reported holdings</b>
                      <p>
                        {fund.searchedPositions.toLocaleString()} positions
                        searched. This is not proof of zero exposure; try a
                        company name or another identifier.
                      </p>
                    </div>
                  )}
                  <a
                    className={s.source}
                    href={fund.sourceUrl || undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View SEC report{" "}
                    <ArrowUpRight size={14} aria-hidden="true" />
                    <span>Filed {fund.filingDate || "date unavailable"}</span>
                  </a>
                </article>
              ))}
              {data.errors.map((failure) => (
                <article
                  key={failure.ticker}
                  className={`${s.fundSummary} ${s.failed}`}
                >
                  <div className={s.fundIdentity}>
                    <b>{failure.ticker}</b>
                  </div>
                  <div className={s.noMatch}>
                    <b>Not searched · report unavailable</b>
                    <p>{failure.message}</p>
                    <p>Exposure is unknown for this fund.</p>
                  </div>
                  <button
                    className={s.secondary}
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    Retry unavailable reports
                  </button>
                </article>
              ))}
            </div>
            {!!result.matchedFunds && (
              <p className={s.help}>
                % of fund = reported position weight as a share of that fund’s
                net assets. Bars compare the absolute weights above; they are
                not a 0–100% scale. Percentages belong to separate funds and are
                not added together.
              </p>
            )}
            {data.errors.length > 0 && (
              <p className={s.notice}>
                Coverage is incomplete: {data.errors.length} selected{" "}
                {data.errors.length === 1 ? "fund was" : "funds were"} not
                searched. Unavailable reports are not treated as no matches.
              </p>
            )}
            {!result.sameDate && (
              <p className={s.notice}>
                <b>Different portfolio dates.</b> Compare the dates beside each
                fund. These are historical reported holdings, not today’s
                holdings.
              </p>
            )}
            {result.sharedSeries.length > 0 && (
              <p className={s.notice}>
                {result.sharedSeries
                  .map((group) => group.join(" / "))
                  .join("; ")}{" "}
                share the same SEC portfolio series. These share classes are not
                independent portfolios.
              </p>
            )}
            {!result.rows.length ? (
              <div className={s.empty}>
                <b>
                  {result.coverage.length
                    ? "No securities match this search."
                    : "No selected portfolio was available to search."}
                </b>
                <p>
                  {result.coverage.length
                    ? "Try the company name instead of a ticker, fewer words, or broader filters. You can also add another fund above."
                    : "Retry an unavailable report or choose another fund above."}
                </p>
                {(settings.securityAsset || settings.securityCountry) && (
                  <button
                    className={s.secondary}
                    onClick={() => {
                      setAsset("");
                      setCountry("");
                      submitSearch(submittedQuery, "", "");
                    }}
                  >
                    Search all types and countries
                  </button>
                )}
              </div>
            ) : (
              <details
                className={s.securities}
                open={showDetails}
                onToggle={(event) => setShowDetails(event.currentTarget.open)}
              >
                <summary>
                  <span>
                    Matching securities{" "}
                    <b>{result.totalGroups.toLocaleString()}</b>
                  </span>
                  <small>Open individual holdings and pin evidence</small>
                </summary>
                <p className={s.help}>
                  Each security stays separate, including different bonds from
                  the same company.{" "}
                  {result.unidentifiedPositions > 0 ||
                  result.conflictingPositions > 0
                    ? `${result.unidentifiedPositions} unidentified and ${result.conflictingPositions} conflicting records are kept separate.`
                    : "Consistent CUSIP / ISIN identifiers link the same security across funds."}
                </p>
                <div className={s.results}>
                  {result.rows.map((row) => {
                    const positions = row.funds.flatMap(
                      (fund) => fund.positions,
                    );
                    const categories = [
                      ...new Set(positions.map((holding) => holding.assetCat)),
                    ];
                    const titles = [
                      ...new Set(
                        positions
                          .map((holding) => holding.title)
                          .filter(Boolean),
                      ),
                    ];
                    return (
                      <article className={s.result} key={row.key}>
                        <div className={s.resultHeading}>
                          <div>
                            <div className={s.badges}>
                              {categories.map((category) => (
                                <span key={category}>
                                  {assetLabels[category] ||
                                    category ||
                                    "Type unavailable"}
                                </span>
                              ))}
                            </div>
                            <h3>{row.name}</h3>
                            {titles.length > 0 && (
                              <p className={s.securityTitle}>
                                {titles.join(" · ")}
                              </p>
                            )}
                            <p>
                              {row.ids.join(" · ") || "No usable CUSIP or ISIN"}
                            </p>
                            <small>
                              {row.fundCount}{" "}
                              {row.fundCount === 1 ? "fund" : "funds"} ·{" "}
                              {row.positionCount}{" "}
                              {row.positionCount === 1
                                ? "position"
                                : "positions"}
                              {row.identityStatus === "conflicting-identifiers"
                                ? " · Conflicting identifiers; not combined"
                                : row.identityStatus === "unidentified"
                                  ? " · Kept separate"
                                  : ""}
                            </small>
                          </div>
                          <button
                            className={s.secondary}
                            onClick={() => {
                              const saved = onEvidence(
                                securitySearchEvidence(row, {
                                  ...result,
                                  errors: data.errors,
                                }),
                              );
                              setMessage(
                                saved === false
                                  ? "Evidence was not saved. Check the research board storage message and retry."
                                  : `Pinned ${row.name} to your research board.`,
                              );
                            }}
                          >
                            <BookmarkPlus size={15} aria-hidden="true" /> Pin
                            evidence
                          </button>
                        </div>
                        <div
                          className={s.tableWrap}
                          tabIndex={0}
                          role="region"
                          aria-label={`${row.name} ${row.ids[0] || row.key} holdings table`}
                        >
                          <table>
                            <thead>
                              <tr>
                                <th scope="col">Fund / portfolio date</th>
                                <th scope="col">% of fund net assets</th>
                                <th scope="col">Holding value (USD)</th>
                                <th scope="col">SEC evidence</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.funds.map((fund) => (
                                <tr key={fund.ticker}>
                                  <th scope="row">
                                    {fund.ticker}
                                    <small>
                                      {fund.asOf} · {fund.positionCount}{" "}
                                      {fund.positionCount === 1
                                        ? "position"
                                        : "positions"}
                                    </small>
                                  </th>
                                  <td>
                                    <HoldingValue
                                      value={fund.pctOfNav}
                                      known={fund.knownWeight}
                                      missing={fund.missingWeightCount}
                                      weight
                                    />
                                  </td>
                                  <td>
                                    <HoldingValue
                                      value={fund.value}
                                      known={fund.knownValue}
                                      missing={fund.missingValueCount}
                                    />
                                  </td>
                                  <td>
                                    <a
                                      href={fund.sourceUrl || undefined}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      View report ↗
                                    </a>
                                    <small>Filed {fund.filingDate}</small>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <details className={s.positions}>
                          <summary>
                            Inspect {row.positionCount} reported{" "}
                            {row.positionCount === 1 ? "position" : "positions"}
                          </summary>
                          {row.funds.map((fund) => (
                            <div key={fund.ticker}>
                              <h4>
                                {fund.ticker} · {fund.asOf}
                              </h4>
                              {fund.positions.map((holding) => (
                                <p key={holding.holdingIndex}>
                                  <b>{holding.name}</b>
                                  {holding.title ? ` · ${holding.title}` : ""}
                                  <span>
                                    {holding.tickerSymbol ||
                                      "Ticker not reported"}{" "}
                                    ·{" "}
                                    {holding.cusip ||
                                      holding.isin ||
                                      "Identifier unavailable"}{" "}
                                    ·{" "}
                                    {assetLabels[holding.assetCat] ||
                                      holding.assetCat ||
                                      "Type unavailable"}{" "}
                                    ·{" "}
                                    {holding.invCountry ||
                                      "Country unavailable"}{" "}
                                    ·{" "}
                                    {holding.payoffProfile ||
                                      "Payoff unavailable"}
                                  </span>
                                  <span>
                                    {securityWeight(holding.pctOfNav)} of fund
                                    net assets ·{" "}
                                    {holding.value == null
                                      ? "Value unavailable"
                                      : money(holding.value)}{" "}
                                    fair value
                                    {!holding.textMatched
                                      ? " · Linked by security identifiers"
                                      : ""}
                                  </span>
                                </p>
                              ))}
                            </div>
                          ))}
                        </details>
                      </article>
                    );
                  })}
                </div>
                {data.pagination.pageCount > 1 && (
                  <nav
                    className={s.pagination}
                    aria-label="Security search pages"
                  >
                    <button
                      className={s.secondary}
                      disabled={data.pagination.page <= 1}
                      onClick={() =>
                        setPage({
                          key: searchKey,
                          page: data.pagination.page - 1,
                        })
                      }
                    >
                      Previous {data.pagination.pageSize}
                    </button>
                    <span>
                      Page {data.pagination.page} of {data.pagination.pageCount}{" "}
                      · {data.pagination.total.toLocaleString()} matching
                      securities
                    </span>
                    <button
                      className={s.secondary}
                      disabled={
                        data.pagination.page >= data.pagination.pageCount
                      }
                      onClick={() =>
                        setPage({
                          key: searchKey,
                          page: data.pagination.page + 1,
                        })
                      }
                    >
                      Next {data.pagination.pageSize}
                    </button>
                  </nav>
                )}
              </details>
            )}
            <details className={s.method}>
              <summary>Search coverage and calculation details</summary>
              <div className={s.coverage}>
                {result.coverage.map((fund) => (
                  <p key={fund.ticker}>
                    <b>{fund.ticker}</b> ·{" "}
                    {fund.searchedPositions.toLocaleString()} positions searched
                    · {fund.matchedPositions} matches · Portfolio {fund.asOf}
                  </p>
                ))}
              </div>
              <p>{result.methodology}</p>
              <p>
                Fund summaries include every search match before pagination.
                Different securities and unrelated company names can match the
                same text. A reported security identifier is not a corporate
                issuer identifier. Signed weights can exceed 100% or offset each
                other. Stocks only means common equity; preferred shares and
                equity derivatives are separate categories. Securities are
                sorted by number of matching funds, then name. CSV includes all
                matching positions, fund and asset-type summaries, report dates,
                and coverage.
              </p>
            </details>
          </>
        )
      )}
      <p className={s.message} role="status">
        {message}
      </p>
    </section>
  );
}
