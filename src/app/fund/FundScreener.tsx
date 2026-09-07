"use client";
import Link from "next/link";
import {
  Bookmark,
  Download,
  RefreshCw,
  Plus,
  Check,
  ExternalLink,
} from "lucide-react";
import {
  fundSnapshotFacts,
  fundScreenerCsv,
} from "../../utils/fundScreener.js";
import { money, pct } from "./fundUi";
import s from "./FundWorkspace.module.css";
const download = (name: string, text: string) => {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export default function FundScreener({
  screen,
  settings,
  onPatch,
  shelf,
  snapshots,
  onSelect,
  onEvidence,
  families: allFamilies,
}: any) {
  const selected = settings.tickers;
  const busy = snapshots.progress.busy;
  const families = allFamilies as string[];
  const status = (fund: any) =>
    fund.state.status === "ready"
      ? "Loaded"
      : fund.state.status === "idle"
        ? "Not loaded"
        : fund.state.status === "error"
          ? "Fetch failed"
          : fund.state.status === "unavailable"
            ? "Coverage unavailable"
            : fund.state.status === "cancelled"
              ? "Cancelled"
              : "Loading";
  const controls = (fund: any) => (
    <div className={s.rowActions}>
      <button
        type="button"
        aria-label={`${selected.includes(fund.ticker) ? "Remove" : "Add"} ${fund.ticker} ${selected.includes(fund.ticker) ? "from" : "to"} research selection`}
        aria-pressed={selected.includes(fund.ticker)}
        onClick={() => onSelect(fund.ticker)}
        disabled={!selected.includes(fund.ticker) && selected.length >= 4}
      >
        {selected.includes(fund.ticker) ? (
          <Check size={14} />
        ) : (
          <Plus size={14} />
        )}
      </button>
      <button
        type="button"
        aria-label={`${shelf.saved.includes(fund.ticker) ? "Unsave" : "Save"} ${fund.ticker}`}
        aria-pressed={shelf.saved.includes(fund.ticker)}
        disabled={!shelf.ready}
        onClick={() => shelf.toggle(fund.ticker)}
      >
        <Bookmark
          size={14}
          fill={shelf.saved.includes(fund.ticker) ? "currentColor" : "none"}
        />
      </button>
      <button
        type="button"
        aria-label={`${fund.state.status === "ready" ? "Refresh" : "Load"} ${fund.ticker} snapshot`}
        disabled={busy}
        onClick={() => snapshots.load([fund.ticker], settings.reportMap, true)}
      >
        <RefreshCw size={14} />
      </button>
    </div>
  );
  function pin(fund: any) {
    const data = fund.state.data,
      facts = fundSnapshotFacts(fund.state);
    if (!facts) return;
    onEvidence({
      kind: "coverage",
      title: `${fund.ticker} portfolio snapshot`,
      summary: `${data.name}; portfolio dated ${data.asOf}, filed ${data.filingDate}.`,
      values: [
        { label: "Portfolio net assets", value: facts.netAssets, unit: "USD" },
        {
          label: "Top 10 positive position weights",
          value: facts.concentration,
          unit: "% NAV",
        },
        { label: "Reported positions", value: facts.positions },
        { label: "Positions with weights", value: facts.knownWeights },
        { label: "Positions with values", value: facts.knownValues },
      ],
      sources: [
        {
          ticker: fund.ticker,
          name: data.name,
          accession: data.accession,
          asOf: data.asOf,
          filingDate: data.filingDate,
          sourceUrl: data.sourceUrl,
        },
      ],
      methodology:
        "Series-level historical portfolio totals can include multiple share classes. Top-10 concentration counts position rows. Missing weights do not become zero; NAV weights are not normalized.",
    });
  }
  return (
    <section className={s.screener} aria-labelledby="fund-screener-heading">
      <div className={s.heading}>
        <div>
          <p className={s.eyebrow}>Discover and verify</p>
          <h2 id="fund-screener-heading">
            Find the funds worth investigating.
          </h2>
          <p className={s.muted}>
            {screen.rows.length} shown from {screen.candidates.length} matching
            fund names and strategies. Curated labels are navigation aids; added
            tickers remain visible.
          </p>
        </div>
        <div className={s.actions}>
          <button
            type="button"
            disabled={busy || !screen.candidates.length}
            onClick={() =>
              snapshots.load(
                screen.candidates.map((fund: any) => fund.ticker),
                settings.reportMap,
              )
            }
          >
            {busy
              ? `Reading ${snapshots.progress.ticker}…`
              : "Load matching snapshots"}
          </button>
          {busy && (
            <button type="button" onClick={snapshots.cancel}>
              Cancel loading
            </button>
          )}
          <button
            type="button"
            disabled={!screen.rows.length}
            onClick={() =>
              download(
                "fund-screen.csv",
                fundScreenerCsv(screen.rows, settings),
              )
            }
          >
            <Download size={14} />
            Export screen
          </button>
        </div>
      </div>
      <div className={s.coverage}>
        <span>
          <strong>{screen.ready}</strong> loaded
        </span>
        <span>
          <strong>{screen.failed}</strong> failed or unavailable
        </span>
        <span>
          <strong>
            {screen.candidates.length - screen.ready - screen.failed}
          </strong>{" "}
          pending or not loaded
        </span>
        <p>
          Numeric filters require a loaded, available value. Missing values
          never become zero. Portfolio dates differ from filing dates.
        </p>
      </div>
      {snapshots.progress.total > 0 && (
        <p className={s.notice} role="status">
          {snapshots.progress.cancelled
            ? "Loading cancelled. Completed snapshots are retained."
            : busy
              ? `Reading ${snapshots.progress.ticker}; other funds continue if one fails.`
              : "Snapshot batch finished."}{" "}
          {snapshots.progress.completed} / {snapshots.progress.total} requests
          completed.
        </p>
      )}
      <div className={s.filterGrid}>
        <label>
          Fund family
          <select
            value={settings.family}
            onChange={(e) => onPatch({ family: e.target.value })}
          >
            <option value="">All families</option>
            {[...new Set([settings.family, ...families].filter(Boolean))]
              .sort()
              .map((family) => (
                <option key={family}>{family}</option>
              ))}
          </select>
        </label>
        <label>
          Coverage
          <select
            value={settings.coverage}
            onChange={(e) => onPatch({ coverage: e.target.value })}
          >
            <option value="all">All statuses</option>
            <option value="ready">Loaded portfolios</option>
            <option value="missing">Failed or unavailable</option>
            <option value="unloaded">Not loaded / cancelled</option>
          </select>
        </label>
        <label>
          Minimum net assets (USD billions)
          <input
            type="text"
            inputMode="decimal"
            value={settings.minAssets}
            onChange={(e) => onPatch({ minAssets: e.target.value })}
            placeholder="Any"
            aria-invalid={!!screen.errors.minAssets}
          />
        </label>
        <label>
          Maximum top-10 weight (% NAV)
          <input
            type="text"
            inputMode="decimal"
            value={settings.maxConcentration}
            onChange={(e) => onPatch({ maxConcentration: e.target.value })}
            placeholder="Any"
            aria-invalid={!!screen.errors.maxConcentration}
          />
        </label>
        <label>
          Maximum portfolio age (days)
          <input
            type="text"
            inputMode="numeric"
            value={settings.maxAge}
            onChange={(e) => onPatch({ maxAge: e.target.value })}
            placeholder="Any"
            aria-invalid={!!screen.errors.maxAge}
          />
        </label>
      </div>
      {Object.keys(screen.errors).length > 0 && (
        <p className={s.notice} role="alert">
          {Object.values(screen.errors).join(" ")} Invalid filters are not
          applied.
        </p>
      )}
      <div className={s.displayControls}>
        <label>
          Sort by
          <select
            value={settings.sort}
            onChange={(e) => onPatch({ sort: e.target.value })}
          >
            <option value="ticker">Ticker</option>
            <option value="name">Fund name</option>
            <option value="netAssets">Portfolio net assets</option>
            <option value="concentration">Top-10 concentration</option>
            <option value="positions">Reported positions</option>
            <option value="age">Portfolio age</option>
          </select>
        </label>
        <label>
          Order
          <select
            value={settings.direction}
            onChange={(e) => onPatch({ direction: e.target.value })}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
        <div className={s.actions}>
          <button
            type="button"
            aria-pressed={settings.layout === "table"}
            onClick={() => onPatch({ layout: "table" })}
          >
            Table
          </button>
          <button
            type="button"
            aria-pressed={settings.layout === "cards"}
            onClick={() => onPatch({ layout: "cards" })}
          >
            Cards
          </button>
        </div>
        <button
          type="button"
          onClick={() =>
            onPatch({
              family: "",
              coverage: "all",
              minAssets: "",
              maxConcentration: "",
              maxAge: "",
              query: "",
              category: "All funds",
            })
          }
        >
          Clear filters
        </button>
      </div>
      {settings.layout === "table" ? (
        <div className={s.tableScroll}>
          <table>
            <caption>
              Complete-portfolio summary facts from each selected N-PORT report.
              Blank values mean not loaded or unavailable.
            </caption>
            <thead>
              <tr>
                <th scope="col">Fund / portfolio</th>
                <th scope="col">Coverage</th>
                <th scope="col">Net assets</th>
                <th scope="col">Top 10 / NAV</th>
                <th scope="col">Positions</th>
                <th scope="col">Portfolio date</th>
                <th scope="col">Research actions</th>
              </tr>
            </thead>
            <tbody>
              {screen.rows.map((fund: any) => {
                const facts = fundSnapshotFacts(fund.state);
                return (
                  <tr
                    key={fund.ticker}
                    data-selected={selected.includes(fund.ticker)}
                  >
                    <th scope="row">
                      <Link href={`/fund/${fund.ticker}`}>
                        {fund.ticker} <ExternalLink size={11} />
                      </Link>
                      <span>{fund.name}</span>
                      <small>
                        {fund.family} · {fund.focus}
                      </small>
                    </th>
                    <td>
                      <span
                        className={s.statusPill}
                        data-status={fund.state.status}
                      >
                        {status(fund)}
                      </span>
                      {fund.state.error && <small>{fund.state.error}</small>}
                      {facts && (
                        <small>
                          {facts.knownWeights}/{facts.positions} positions with
                          weights
                        </small>
                      )}
                    </td>
                    <td>{money(facts?.netAssets)}</td>
                    <td>{pct(facts?.concentration)}</td>
                    <td>{facts?.positions?.toLocaleString() ?? "—"}</td>
                    <td>
                      {facts?.asOf || "—"}
                      {facts && (
                        <small>
                          {facts.age ?? "Unknown"} days old
                          <br />
                          Filed {facts.filingDate}
                        </small>
                      )}
                    </td>
                    <td>
                      {controls(fund)}
                      {facts && (
                        <button
                          type="button"
                          className={s.evidenceButton}
                          onClick={() => pin(fund)}
                        >
                          Pin {fund.ticker} snapshot
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={s.cards}>
          {screen.rows.map((fund: any) => {
            const facts = fundSnapshotFacts(fund.state);
            return (
              <article key={fund.ticker}>
                <div className={s.heading}>
                  <span className={s.eyebrow}>{fund.category}</span>
                  {controls(fund)}
                </div>
                <h3>
                  <Link href={`/fund/${fund.ticker}`}>
                    {fund.ticker}
                    <ExternalLink size={16} />
                  </Link>
                </h3>
                <p>{fund.name}</p>
                <p className={s.muted}>
                  {fund.family} · {fund.focus}
                </p>
                <span className={s.statusPill} data-status={fund.state.status}>
                  {status(fund)}
                </span>
                {facts ? (
                  <>
                    <dl>
                      <div>
                        <dt>Net assets</dt>
                        <dd>{money(facts.netAssets)}</dd>
                      </div>
                      <div>
                        <dt>Top 10 / NAV</dt>
                        <dd>{pct(facts.concentration)}</dd>
                      </div>
                      <div>
                        <dt>Reported positions</dt>
                        <dd>{facts.positions?.toLocaleString()}</dd>
                      </div>
                    </dl>
                    <p className={s.muted}>
                      Portfolio {facts.asOf} · filed {facts.filingDate}
                      <br />
                      {facts.knownWeights}/{facts.positions} positions with
                      weights
                    </p>
                    <button type="button" onClick={() => pin(fund)}>
                      Pin {fund.ticker} snapshot
                    </button>
                  </>
                ) : (
                  <p className={s.muted}>
                    {fund.state.error ||
                      "Load its SEC snapshot or open the fund profile to inspect holdings."}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
      {!screen.rows.length && (
        <p className={s.empty}>
          No funds match the current screen. Load matching snapshots to use
          numeric filters, or clear filters to broaden the search.
        </p>
      )}
      <details className={s.method}>
        <summary>What these screening figures do and do not measure</summary>
        <p>
          Net assets belong to the SEC portfolio or series and can combine share
          classes. Top-10 weight adds the ten largest positive reported position
          rows; use the security tools to aggregate duplicate identifiers.
          Holdings may include borrowing, derivatives and missing weights, so
          summed weights need not equal 100%. Coverage and report age are facts
          about the data available here, not fund quality ratings. These tools
          do not estimate fees, returns or real-time holdings.
        </p>
      </details>
    </section>
  );
}
