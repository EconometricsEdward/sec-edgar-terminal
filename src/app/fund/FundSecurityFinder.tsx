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
} from "../../utils/fundSecuritySearch.js";
import { money, pct } from "./fundUi";
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
const assetLabels: Record<string, string> = ASSET_LABELS;

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
  return (
    <section className={s.panel} aria-label="Security finder">
      <header className={s.header}>
        <div>
          <p className={s.eyebrow}>Search inside your selected funds</p>
          <h2>Who holds this security?</h2>
          <p>
            Search every reported position by name, title, ticker, CUSIP, or
            ISIN. See the supporting holdings and each fund’s share of net
            assets.
          </p>
        </div>
        <Search size={26} aria-hidden="true" />
      </header>
      <form
        className={s.form}
        onSubmit={(event) => {
          event.preventDefault();
          setMessage("");
          setPage({ key: "", page: 1 });
          setAttempt((value) => value + 1);
          onPatch({
            securityQuery: query.trim(),
            securityAsset: asset,
            securityCountry: country,
          });
        }}
      >
        <label>
          Security name or identifier
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={160}
            placeholder="Apple, AAPL, or 037833100…"
          />
        </label>
        <label>
          Asset category
          <select
            value={asset}
            onChange={(event) => setAsset(event.target.value)}
          >
            <option value="">All asset categories</option>
            {[
              ...new Set([
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
          <Search size={15} /> Search portfolios
        </button>
      </form>
      <p className={s.help}>
        All words must match reported text. Blank search shows all securities. A
        name or ticker match does not confirm corporate issuer identity.
      </p>
      {dirty && (
        <p className={s.notice}>
          The results use your last submitted search. Submit to apply these
          edits.
        </p>
      )}
      {!tickers.length ? (
        <p className={s.empty}>
          Add at least one fund to the research basket above to search its
          complete SEC portfolio.
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
        <p role="status" className={s.empty}>
          Searching complete portfolios for {tickers.join(", ")}…
        </p>
      ) : (
        result && (
          <>
            <div className={s.metrics} aria-label="Search coverage summary">
              <div>
                <strong>{result.totalGroups.toLocaleString()}</strong>
                <span>security groups / separate records</span>
              </div>
              <div>
                <strong>
                  {result.matchedFunds} / {tickers.length}
                </strong>
                <span>selected funds with matches</span>
              </div>
              <div>
                <strong>
                  {result.coverage.length} / {tickers.length}
                </strong>
                <span>complete portfolios searched</span>
              </div>
              <div>
                <strong>{result.matchedPositions.toLocaleString()}</strong>
                <span>matching position records</span>
              </div>
            </div>
            <div className={s.coverage} aria-label="Coverage by fund">
              {result.coverage.map((fund) => (
                <article key={fund.ticker}>
                  <b>{fund.ticker}</b>
                  <span className={fund.status === "matched" ? s.good : ""}>
                    {fund.matchedPositions
                      ? `${fund.matchedPositions.toLocaleString()} matching positions`
                      : "Searched · no matches"}
                  </span>
                  <small>
                    {fund.searchedPositions.toLocaleString()} positions reviewed
                    · {fund.asOf}
                  </small>
                  <a href={fund.sourceUrl} target="_blank" rel="noreferrer">
                    Filed {fund.filingDate} <ArrowUpRight size={12} />
                  </a>
                </article>
              ))}
              {data.errors.map((failure) => (
                <article key={failure.ticker} className={s.failed}>
                  <b>{failure.ticker}</b>
                  <span>Not searched · portfolio unavailable</span>
                  <small>{failure.message}</small>
                </article>
              ))}
            </div>
            {data.errors.length > 0 && (
              <p className={s.notice}>
                Coverage is incomplete. An unavailable fund is not a fund with
                no matches.{" "}
                <button
                  className={s.secondary}
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Retry unavailable portfolios
                </button>
              </p>
            )}
            {!result.sameDate && (
              <p className={s.notice}>
                Portfolio dates differ. These holdings describe the dates shown
                above and are not a single current market snapshot.
              </p>
            )}
            {result.sharedSeries.length > 0 && (
              <p className={s.notice}>
                {result.sharedSeries
                  .map((group) => group.join(" / "))
                  .join("; ")}{" "}
                share the same SEC portfolio series. Their share classes report
                the same underlying portfolio; do not count them as independent
                holdings.
              </p>
            )}
            <div className={s.toolbar}>
              <p>
                {result.unidentifiedPositions > 0 ||
                result.conflictingPositions > 0
                  ? `${result.unidentifiedPositions} unidentified and ${result.conflictingPositions} conflicting records are kept separate.`
                  : "Securities are grouped using consistent CUSIP / ISIN links."}
              </p>
              <button
                className={s.secondary}
                onClick={download}
                disabled={exporting || !result.coverage.length}
              >
                <ArrowDownToLine size={15} />
                {exporting
                  ? "Preparing complete CSV…"
                  : "Export complete search"}
              </button>
            </div>
            {!result.rows.length ? (
              <p className={s.empty}>
                {result.coverage.length
                  ? "No matching positions in the successfully searched reports. Try fewer words, another identifier, or broader filters."
                  : "No selected portfolio was available to search. Retry or choose another fund."}
              </p>
            ) : (
              <div className={s.results}>
                {result.rows.map((row) => (
                  <article className={s.result} key={row.key}>
                    <div className={s.resultHeading}>
                      <div>
                        <h3>{row.name}</h3>
                        <p>
                          {row.ids.join(" · ") || "No usable CUSIP or ISIN"}
                        </p>
                        <small>
                          {row.fundCount}{" "}
                          {row.fundCount === 1 ? "fund" : "funds"} ·{" "}
                          {row.positionCount} position records
                          {row.identityStatus === "conflicting-identifiers"
                            ? " · Conflicting identifiers; not combined"
                            : row.identityStatus === "unidentified"
                              ? " · Kept as a separate record"
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
                        <BookmarkPlus size={15} /> Pin evidence
                      </button>
                    </div>
                    <div
                      className={s.tableWrap}
                      tabIndex={0}
                      aria-label={`${row.name} holdings table`}
                    >
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Fund / portfolio date</th>
                            <th scope="col">Signed weight / NAV</th>
                            <th scope="col">Reported USD value</th>
                            <th scope="col">Evidence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.funds.map((fund) => (
                            <tr key={fund.ticker}>
                              <th scope="row">
                                {fund.ticker}
                                <small>
                                  {fund.asOf} · {fund.positionCount} records
                                </small>
                              </th>
                              <td>
                                {fund.pctOfNav == null
                                  ? "Unavailable"
                                  : pct(fund.pctOfNav)}
                                {fund.missingWeightCount > 0 && (
                                  <small>
                                    {fund.missingWeightCount} weights missing
                                    {fund.knownWeight == null
                                      ? ""
                                      : `; known subtotal ${pct(fund.knownWeight)}`}
                                  </small>
                                )}
                              </td>
                              <td>
                                {fund.value == null
                                  ? "Unavailable"
                                  : money(fund.value)}
                                {fund.missingValueCount > 0 && (
                                  <small>
                                    {fund.missingValueCount} values missing
                                    {fund.knownValue == null
                                      ? ""
                                      : `; known subtotal ${money(fund.knownValue)}`}
                                  </small>
                                )}
                              </td>
                              <td>
                                <a
                                  href={fund.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  N-PORT source ↗
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
                        Inspect {row.positionCount} reported position records
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
                                {holding.tickerSymbol || "Ticker not reported"}{" "}
                                ·{" "}
                                {holding.cusip ||
                                  holding.isin ||
                                  "Identifier unavailable"}{" "}
                                ·{" "}
                                {assetLabels[holding.assetCat] ||
                                  holding.assetCat ||
                                  "Asset unavailable"}{" "}
                                · {holding.invCountry || "Country unavailable"}{" "}
                                ·{" "}
                                {holding.payoffProfile || "Payoff unavailable"}
                              </span>
                              <span>
                                {pct(holding.pctOfNav)} NAV ·{" "}
                                {money(holding.value)} fair value
                                {!holding.textMatched
                                  ? " · Included through linked security identifiers"
                                  : ""}
                              </span>
                            </p>
                          ))}
                        </div>
                      ))}
                    </details>
                  </article>
                ))}
              </div>
            )}
            {data.pagination.pageCount > 1 && (
              <nav className={s.pagination} aria-label="Security search pages">
                <button
                  className={s.secondary}
                  disabled={data.pagination.page <= 1}
                  onClick={() =>
                    setPage({ key: searchKey, page: data.pagination.page - 1 })
                  }
                >
                  Previous 50
                </button>
                <span>
                  Page {data.pagination.page} of {data.pagination.pageCount} ·{" "}
                  {data.pagination.total.toLocaleString()} groups / records
                </span>
                <button
                  className={s.secondary}
                  disabled={data.pagination.page >= data.pagination.pageCount}
                  onClick={() =>
                    setPage({ key: searchKey, page: data.pagination.page + 1 })
                  }
                >
                  Next 50
                </button>
              </nav>
            )}
            <details className={s.method}>
              <summary>How search and totals work</summary>
              <p>{result.methodology}</p>
              <p>
                A reported security identifier is not a corporate issuer
                identifier. Separate share classes, debt issues, and securities
                from one company can appear as different groups. Signed weights
                can offset each other and can exceed 100% in leveraged
                portfolios. Results are sorted by number of matching funds, then
                security name. CSV exports every matching position, including
                results beyond this page.
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
