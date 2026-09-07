"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Bookmark, Layers3, Search, Share2, X } from "lucide-react";
import {
  normalizeFundWorkspaceSettings,
  readFundWorkspaceSettings,
  fundWorkspacePath,
  validFundTicker,
} from "../../utils/fundWorkspaceSettings.js";
import {
  fundUniverse,
  fundSnapshotKey,
  screenFunds,
} from "../../utils/fundScreener.js";
import {
  createFundEvidence,
  fundEvidenceKey,
  FUND_EVIDENCE_LIMIT,
} from "../../utils/fundBoards.js";
import { useFundShelf } from "./fundUi";
import useFundSnapshots from "./useFundSnapshots";
import FundScreener from "./FundScreener";
import base from "./fund.module.css";
import s from "./FundWorkspace.module.css";
const loading = () => (
  <p role="status" className={s.notice}>
    Opening this fund research tool…
  </p>
);
const FundComparison = dynamic(() => import("./FundComparison"), { loading });
const FundSecurityFinder = dynamic(() => import("./FundSecurityFinder"), {
  loading,
});
const GlobalSecurityFinder = dynamic(() => import("./GlobalSecurityFinder"), {
  loading,
});
const FundAllocationLab = dynamic(() => import("./FundAllocationLab"), {
  loading,
});
const FundChanges = dynamic(() => import("./FundChanges"), { loading });
const FundResearchBoards = dynamic(() => import("./FundResearchBoards"), {
  loading,
});
const views = [
  ["discover", "Discover & screen"],
  ["security", "Find a security"],
  ["compare", "Compare portfolios"],
  ["allocation", "Allocation lab"],
  ["changes", "Report changes"],
  ["boards", "Research boards"],
];
export default function FundsWorkspace() {
  const params = useSearchParams();
  const [settings, setSettings] = useState<any>(() =>
    readFundWorkspaceSettings(params.toString()),
  );
  const [tickerDraft, setTickerDraft] = useState("");
  const [message, setMessage] = useState("");
  const [evidence, setEvidence] = useState<any[]>([]);
  const [visited, setVisited] = useState<string[]>([settings.view]);
  const evidenceRef = useRef<any[]>([]);
  const shelf = useFundShelf();
  const snapshots = useFundSnapshots();
  const queryString = params.toString();
  useEffect(() => {
    const read = () =>
      setSettings(readFundWorkspaceSettings(window.location.search));
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  useEffect(() => {
    const path = fundWorkspacePath(settings);
    if (window.location.pathname + window.location.search !== path)
      window.history.replaceState(null, "", path);
  }, [settings]);
  // Same-route links can change the URL without remounting this workspace.
  const lastQuery = useRef(queryString);
  useEffect(() => {
    if (lastQuery.current === queryString) return;
    lastQuery.current = queryString;
    const incoming = readFundWorkspaceSettings(queryString);
    setSettings((current: any) =>
      fundWorkspacePath(current) === fundWorkspacePath(incoming)
        ? current
        : incoming,
    );
  }, [queryString]);
  const patch = useCallback((next: any) => {
    setSettings((current: any) =>
      normalizeFundWorkspaceSettings({ ...current, ...next }),
    );
    return true;
  }, []);
  const universe = useMemo(
    () =>
      fundUniverse(
        shelf.saved,
        settings.tickers,
        snapshots.states,
        settings.reportMap,
      ),
    [shelf.saved, settings.tickers, snapshots.states, settings.reportMap],
  );
  const screen = useMemo(
    () => screenFunds(universe, settings, shelf.saved),
    [universe, settings, shelf.saved],
  );
  const currentSnapshots = settings.tickers
    .map(
      (ticker: string) =>
        snapshots.states[fundSnapshotKey(ticker, settings.reportMap)],
    )
    .filter((state: any) => state?.status === "ready")
    .map((state: any) => state.data);
  const {
    states: snapshotStates,
    load: loadSnapshots,
    progress: snapshotProgress,
  } = snapshots;
  const selectedKey = settings.tickers
    .map((ticker: string) => fundSnapshotKey(ticker, settings.reportMap))
    .join(",");
  useEffect(() => {
    if (settings.view !== "boards" || snapshotProgress.busy) return;
    const missing = settings.tickers.filter(
      (ticker: string) =>
        !snapshotStates[fundSnapshotKey(ticker, settings.reportMap)],
    );
    if (missing.length) void loadSnapshots(missing, settings.reportMap);
  }, [
    settings.view,
    selectedKey,
    settings.tickers,
    settings.reportMap,
    snapshotStates,
    loadSnapshots,
    snapshotProgress.busy,
  ]);
  function toggle(ticker: string) {
    if (settings.tickers.includes(ticker))
      patch({
        tickers: settings.tickers.filter((value: string) => value !== ticker),
      });
    else if (settings.tickers.length < 4)
      patch({ tickers: [...settings.tickers, ticker] });
    else
      setMessage(
        "Choose up to four funds. Remove a selection before adding another.",
      );
  }
  function addTicker() {
    const ticker = tickerDraft.trim().toUpperCase();
    if (!validFundTicker(ticker)) {
      setMessage(
        "Enter one fund ticker, such as VOO or SCHD. Names and strategies can be searched in Discover & screen.",
      );
      return;
    }
    if (settings.tickers.includes(ticker)) {
      setMessage(`${ticker} is already selected.`);
      return;
    }
    if (settings.tickers.length >= 4) {
      setMessage("Four funds are selected. Remove one before adding another.");
      return;
    }
    patch({ tickers: [...settings.tickers, ticker] });
    setTickerDraft("");
    setMessage(
      `${ticker} added. Its portfolio identity and coverage are checked when you load its report.`,
    );
  }
  function pin(input: any) {
    try {
      const item = createFundEvidence(input),
        id = fundEvidenceKey(item);
      if (
        evidenceRef.current.some((entry: any) => fundEvidenceKey(entry) === id)
      ) {
        setMessage("This exact evidence is already pinned.");
        return true;
      }
      if (evidenceRef.current.length >= FUND_EVIDENCE_LIMIT) {
        setMessage(
          "You have 40 pinned evidence items. Remove an item or save a board before starting another collection.",
        );
        return false;
      }
      evidenceRef.current = [...evidenceRef.current, item];
      setEvidence(evidenceRef.current);
      setMessage(
        `Pinned: ${item.title}. Save it in Research boards to retain it after leaving the page.`,
      );
      return true;
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Evidence could not be pinned.",
      );
      return false;
    }
  }
  function restoreEvidence(items: any[]) {
    try {
      if (items.length > FUND_EVIDENCE_LIMIT)
        throw new Error("A board supports at most 40 evidence items.");
      const next = items.map(createFundEvidence);
      evidenceRef.current = next;
      setEvidence(next);
      return true;
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Saved evidence could not be restored.",
      );
      return false;
    }
  }
  function openView(view: string) {
    setVisited((current) =>
      current.includes(view) ? current : [...current, view],
    );
    patch({ view });
    setMessage("");
  }
  const common = {
    tickers: settings.tickers,
    settings,
    onPatch: patch,
    onEvidence: pin,
    onFunds: snapshots.ingest,
  };
  const globalSecurity =
    settings.view === "security" && settings.securityScope !== "selected";
  function addDiscoveredFund(ticker: string, accession: string) {
    if (settings.tickers.includes(ticker)) {
      setMessage(`${ticker} is already in your comparison selection.`);
      return;
    }
    if (settings.tickers.length >= 4) {
      setMessage(
        "Four funds are selected. Open Selected funds to remove one before adding another.",
      );
      return;
    }
    patch({
      tickers: [...settings.tickers, ticker],
      reportMap: { ...settings.reportMap, [ticker]: accession },
    });
    setMessage(
      `${ticker} added to your comparison selection with the report shown.`,
    );
  }
  const panels: any = {
    discover: (
      <>
        <div className={s.discoveryControls}>
          <label className={s.searchLabel}>
            <Search size={17} />
            <input
              aria-label="Search funds by ticker, name, family, or strategy"
              placeholder="Search a name, ticker or strategy…"
              value={settings.query}
              onChange={(e) => patch({ query: e.target.value })}
            />
          </label>
          <div
            className={s.categories}
            role="group"
            aria-label="Fund categories"
          >
            {[
              "All funds",
              "US equity",
              "International",
              "Fixed income",
              "Saved funds",
            ].map((category) => (
              <button
                type="button"
                key={category}
                aria-pressed={settings.category === category}
                onClick={() => patch({ category, family: "" })}
              >
                {category}
                {category === "Saved funds" ? ` (${shelf.saved.length})` : ""}
              </button>
            ))}
          </div>
        </div>
        <FundScreener
          screen={screen}
          settings={settings}
          onPatch={patch}
          shelf={shelf}
          snapshots={snapshots}
          onSelect={toggle}
          onEvidence={pin}
          families={[...new Set(universe.map((fund: any) => fund.family))]}
        />
      </>
    ),
    security: (
      <>
        <div
          className={s.securityScope}
          role="group"
          aria-label="Security search scope"
        >
          <button
            type="button"
            aria-pressed={settings.securityScope !== "selected"}
            onClick={() => patch({ securityScope: "all" })}
          >
            All funds
          </button>
          <button
            type="button"
            aria-pressed={settings.securityScope === "selected"}
            onClick={() => patch({ securityScope: "selected" })}
          >
            Selected funds ({settings.tickers.length})
          </button>
        </div>
        {settings.securityScope === "selected" ? (
          <FundSecurityFinder
            {...common}
            settings={{
              ...settings,
              securityAsset:
                settings.securityAsset === "all" ? "" : settings.securityAsset,
            }}
          />
        ) : (
          <GlobalSecurityFinder
            settings={settings}
            onPatch={patch}
            onAddFund={addDiscoveredFund}
            selectedTickers={settings.tickers}
          />
        )}
      </>
    ),
    compare:
      settings.tickers.length >= 2 ? <FundComparison {...common} /> : null,
    allocation: settings.tickers.length ? (
      <FundAllocationLab {...common} />
    ) : null,
    changes: settings.tickers.length ? <FundChanges {...common} /> : null,
    boards: (
      <FundResearchBoards
        settings={settings}
        onPatch={patch}
        evidence={evidence}
        snapshots={currentSnapshots}
        onRestoreEvidence={restoreEvidence}
        onClearEvidence={() => {
          evidenceRef.current = [];
          setEvidence([]);
        }}
      />
    ),
  };
  return (
    <div className={`${base.page} ${s.workspace}`}>
      <header className={s.hero} hidden={settings.view === "security"}>
        <div>
          <p className={s.eyebrow}>
            <Layers3 size={15} />
            Portfolio research · SEC N-PORT
          </p>
          <h1>
            See beyond
            <br />
            <em>the fund ticker.</em>
          </h1>
          <p className={s.lead}>
            Screen reported portfolios, find shared positions, and understand
            what a fund mix actually holds. Keep the dates, assumptions and
            evidence with your research.
          </p>
        </div>
        <aside>
          <span>One connected research workflow</span>
          <p>
            Find funds → inspect securities → compare or combine → save the
            evidence.
          </p>
          <small>
            Historical SEC disclosures. Portfolio dates and coverage stay
            visible throughout.
          </small>
        </aside>
      </header>
      <section className={s.selection} aria-label="Funds selected for research">
        <div hidden={globalSecurity}>
          <div className={s.heading}>
            <div>
              <p className={s.eyebrow}>
                Your research selection · {settings.tickers.length}/4
              </p>
              <h2>
                {settings.tickers.length
                  ? settings.tickers.join(" / ")
                  : "Start with a few funds."}
              </h2>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addTicker();
              }}
              className={s.addForm}
            >
              <label htmlFor="fund-add-ticker" className={s.srOnly}>
                Add a fund ticker to research
              </label>
              <input
                id="fund-add-ticker"
                value={tickerDraft}
                onChange={(e) => setTickerDraft(e.target.value)}
                placeholder="Any fund ticker"
                maxLength={15}
              />
              <button type="submit">
                Add ticker <ArrowRight size={14} />
              </button>
            </form>
          </div>
          <div className={s.selectionDetail}>
            {settings.tickers.map((ticker: string) => (
              <div className={s.selectedFund} key={ticker}>
                <Link
                  href={`/fund/${ticker}${settings.reportMap[ticker] ? `?accession=${settings.reportMap[ticker]}` : ""}`}
                >
                  {ticker}
                </Link>
                <small>
                  {settings.reportMap[ticker]
                    ? `Report ${settings.reportMap[ticker]}`
                    : "Latest available report"}
                </small>
                <button
                  type="button"
                  aria-label={`Remove ${ticker} from research selection`}
                  onClick={() => toggle(ticker)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className={s.toolbar}>
            <button
              type="button"
              disabled={!settings.tickers.length || snapshots.progress.busy}
              onClick={() =>
                snapshots.load(settings.tickers, settings.reportMap, true)
              }
            >
              Load selected snapshots
            </button>
            <button
              type="button"
              disabled={
                snapshots.progress.busy ||
                (!Object.keys(settings.reportMap).length &&
                  !settings.changeAfter &&
                  !settings.changeBefore)
              }
              onClick={() => {
                patch({ reportMap: {}, changeAfter: "", changeBefore: "" });
                void snapshots.load(settings.tickers, {}, true);
                setMessage(
                  "Report choices cleared. Refreshing selected snapshots and resolving the latest available filings.",
                );
              }}
            >
              Use latest reports
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(window.location.href);
                  setMessage(
                    "Fund view copied. Notes and pinned evidence stay private until you export or save a board.",
                  );
                } catch {
                  setMessage("Copy failed. You can share the address bar URL.");
                }
              }}
            >
              <Share2 size={14} />
              Share research view
            </button>
            <button type="button" onClick={() => openView("boards")}>
              <Bookmark size={14} />
              {evidence.length} pinned evidence
            </button>
          </div>
        </div>
        <nav className={s.nav} aria-label="Fund workspace tools">
          {views.map(([view, label]) => (
            <button
              type="button"
              key={view}
              aria-current={settings.view === view ? "page" : undefined}
              aria-pressed={settings.view === view}
              onClick={() => openView(view)}
            >
              {label}
            </button>
          ))}
        </nav>
        {globalSecurity && settings.tickers.length > 0 && (
          <div className={s.optionalComparison}>
            <span>Optional comparison: {settings.tickers.join(" / ")}</span>
            <button
              type="button"
              disabled={settings.tickers.length < 2}
              onClick={() => openView("compare")}
            >
              Compare selected funds
            </button>
          </div>
        )}
      </section>
      {shelf.saved.length > 0 && (
        <div className={s.shelf} aria-label="Saved fund shelf">
          <Bookmark size={14} />
          <strong>Saved funds</strong>
          {shelf.saved.map((ticker) => (
            <button
              type="button"
              key={ticker}
              onClick={() => {
                if (!settings.tickers.includes(ticker)) toggle(ticker);
                else openView("discover");
              }}
              aria-label={`Research saved ${ticker}`}
            >
              {ticker}
            </button>
          ))}
          <small>Saved in this browser</small>
        </div>
      )}
      {(message || shelf.storageError) && (
        <p role="status" className={s.notice}>
          {shelf.storageError || message}
        </p>
      )}
      {views.map(
        ([view]) =>
          (visited.includes(view) || view === settings.view) && (
            <div key={view} hidden={settings.view !== view} className={s.panel}>
              {panels[view] || (
                <section className={s.empty}>
                  <h2>
                    {view === "compare"
                      ? "Choose at least two funds to compare."
                      : "Choose a fund to begin."}
                  </h2>
                  <p>
                    Add any fund ticker above, or select funds from the
                    screener.
                  </p>
                  <button type="button" onClick={() => openView("discover")}>
                    Browse funds
                  </button>
                </section>
              )}
            </div>
          ),
      )}
    </div>
  );
}
