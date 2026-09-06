"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  ChartNoAxesCombined,
  FileText,
  Pin,
  Search,
  X,
} from "lucide-react";
import { analysisValue } from "../../utils/analysisNotebook.js";
import { evidenceSources } from "../../utils/researchEvidence.js";
import { analysisSourceState } from "../../utils/analysisSources.js";
import styles from "./AnalysisMetricFinder.module.css";

const tools = [
  {
    key: "overview",
    label: "Overview",
    intent: "Find the largest financial movements and start a review.",
  },
  {
    key: "statements",
    label: "Statements",
    intent: "Read income, balance sheet and cash flow figures across periods.",
  },
  {
    key: "changes",
    label: "Changes",
    intent: "Compare financial statements against a reporting baseline.",
  },
  {
    key: "trends",
    label: "Growth & trends",
    intent: "Chart a metric, inspect CAGR and compare fiscal seasonality.",
  },
  {
    key: "cash",
    label: "Cash quality",
    intent: "Follow earnings into cash flow and working capital cycles.",
  },
  {
    key: "capital",
    label: "Capital & funding",
    intent: "Examine assets, debt, equity and industry funding ratios.",
  },
  {
    key: "drivers",
    label: "Return drivers",
    intent: "Explain return on equity using profitability and leverage.",
  },
  {
    key: "scenarios",
    label: "Scenarios",
    intent:
      "Test hypothetical revenue, margin, asset loss and deposit assumptions.",
  },
  {
    key: "formula",
    label: "Custom ratios",
    intent: "Build a ratio or formula from compatible reported inputs.",
  },
  {
    key: "checks",
    label: "Sources & checks",
    intent: "Audit source coverage, SEC tags, revisions and reconciliation.",
  },
  {
    key: "notebook",
    label: "Notebook",
    intent:
      "Review collected evidence, save views and export a research brief.",
  },
  {
    key: "extended",
    label: "More research",
    intent:
      "Explore valuation, geographic exposure and additional research tools.",
  },
];

const categories: Record<string, string> = {
  income: "Income statement",
  balance: "Balance sheet",
  cashflow: "Cash flow",
  ratios: "Industry ratios",
  drivers: "Return drivers",
  checks: "Reconciliation inputs",
};

const searchable = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export default function AnalysisMetricFinder({
  data,
  settings,
  index,
  onInspect,
  onPatch,
}: any) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const titleId = useId();
  const helpId = useId();
  const pins: string[] = settings.pins || [];
  const period = data.periods?.[index];

  const open = useCallback(() => {
    if (!dialog.current || dialog.current.open) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : trigger.current;
    setQuery("");
    setAnnouncement("");
    dialog.current.showModal();
    input.current?.focus();
  }, []);

  const close = () => {
    dialog.current?.close();
    const target = returnFocus.current;
    if (target?.isConnected) target.focus();
    else trigger.current?.focus();
  };

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [role='textbox']"))
      )
        return;
      if (document.querySelector("dialog[open], [aria-modal='true']")) return;
      event.preventDefault();
      open();
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [open]);

  const metrics = useMemo(
    () =>
      (data.definitions || []).map((definition: any) => {
        const tags = [
          ...new Set(
            (data.metrics[definition.key] || []).flatMap((point: any) =>
              evidenceSources(point).map((source: any) => source.tag || ""),
            ),
          ),
        ];
        const haystack = `${definition.label} ${definition.key} ${categories[definition.category] || definition.category} ${tags.join(" ")}`;
        return {
          definition,
          haystack: searchable(haystack),
          compact: haystack.toLowerCase().replace(/[^a-z0-9]/g, ""),
        };
      }),
    [data],
  );

  const terms = searchable(query).split(" ").filter(Boolean);
  const matches = (text: string, compact: string) =>
    terms.every((term) => text.includes(term) || compact.includes(term));
  const matchedMetrics = metrics
    .filter((metric: any) => matches(metric.haystack, metric.compact))
    .sort((a: any, b: any) => {
      const pinDifference =
        Number(pins.includes(b.definition.key)) -
        Number(pins.includes(a.definition.key));
      if (pinDifference) return pinDifference;
      if (!terms.length) {
        const highlightDifference =
          Number((data.highlights || []).includes(b.definition.key)) -
          Number((data.highlights || []).includes(a.definition.key));
        if (highlightDifference) return highlightDifference;
      }
      return a.definition.label.localeCompare(b.definition.label);
    });
  const visibleMetrics = matchedMetrics.slice(0, terms.length ? 10 : 6);
  const matchedTools = tools.filter((tool) => {
    const text = searchable(`${tool.label} ${tool.intent}`);
    return matches(text, text.replaceAll(" ", ""));
  });
  const currentPins = metrics.filter((metric: any) =>
    pins.includes(metric.definition.key),
  );
  const run = (action: () => void) => {
    close();
    action();
  };

  return (
    <>
      <button
        ref={trigger}
        className={styles.trigger}
        type="button"
        onClick={open}
        aria-haspopup="dialog"
      >
        <Search size={16} aria-hidden="true" /> Find metric or tool{" "}
        <kbd aria-hidden="true">/</kbd>
      </button>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={helpId}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <div className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Move directly to the evidence</p>
            <h2 id={titleId}>Find a metric or research tool</h2>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close metric finder"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        <p id={helpId} className={styles.help}>
          Search financial metrics, SEC tags, or a research task. Values use the
          selected period ending {period?.end || "—"} and your current units.
        </p>
        <label className={styles.search}>
          <span>Metric, SEC tag, or task</span>
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={100}
            placeholder="Free cash flow, NetIncomeLoss, deposit scenario…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className={styles.count} role="status" aria-live="polite">
          {matchedMetrics.length} metrics and {matchedTools.length} tools match.
          {matchedMetrics.length > visibleMetrics.length
            ? ` Showing ${visibleMetrics.length} metrics; refine the search to find more.`
            : ""}
        </div>
        <div className={styles.body}>
          {!terms.length && currentPins.length > 0 && (
            <section
              className={styles.pinSection}
              aria-label="Currently pinned metrics"
            >
              <h3>
                Your pinned metrics <span>{pins.length}/12</span>
              </h3>
              <div className={styles.pins}>
                {currentPins.map(({ definition }: any) => (
                  <button
                    key={definition.key}
                    type="button"
                    onClick={() =>
                      run(() =>
                        onInspect({
                          definition,
                          point: data.metrics[definition.key]?.[index],
                        }),
                      )
                    }
                    aria-label={`Inspect pinned ${definition.label}`}
                  >
                    <Pin size={12} aria-hidden="true" />
                    {definition.label}
                  </button>
                ))}
              </div>
            </section>
          )}
          {visibleMetrics.length > 0 && (
            <section aria-label="Matching financial metrics">
              <h3>
                {terms.length ? "Matching metrics" : "Metrics to explore"}
              </h3>
              <ul className={styles.metrics}>
                {visibleMetrics.map(({ definition }: any) => {
                  const point = data.metrics[definition.key]?.[index];
                  const state = analysisSourceState(point);
                  const pinned = pins.includes(definition.key);
                  const status =
                    state.kind === "missing"
                      ? "Unavailable"
                      : state.kind === "calculated"
                        ? "Calculated"
                        : "Reported";
                  return (
                    <li key={definition.key}>
                      <div className={styles.metricHeading}>
                        <div>
                          <strong>{definition.label}</strong>
                          <span>
                            {categories[definition.category] ||
                              definition.category}
                          </span>
                        </div>
                        <div className={styles.value}>
                          <strong>
                            {analysisValue(
                              point?.value,
                              definition.format,
                              settings.units,
                            )}
                          </strong>
                          <span data-kind={state.kind}>
                            {status}
                            {pinned ? " · Pinned" : ""}
                          </span>
                        </div>
                      </div>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          aria-label={`Inspect ${definition.label}`}
                          onClick={() =>
                            run(() => onInspect({ definition, point }))
                          }
                        >
                          <ArrowUpRight size={13} aria-hidden="true" /> Inspect
                        </button>
                        <button
                          type="button"
                          aria-label={`Chart ${definition.label}`}
                          onClick={() =>
                            run(() =>
                              onPatch({
                                view: "trends",
                                chart: [definition.key],
                                growthMetric: definition.key,
                              }),
                            )
                          }
                        >
                          <ChartNoAxesCombined size={13} aria-hidden="true" />{" "}
                          Chart
                        </button>
                        <button
                          type="button"
                          aria-label={`Read ${definition.label}`}
                          onClick={() =>
                            run(() =>
                              onPatch({
                                view: "statements",
                                search: definition.key,
                                rowScope: "all",
                              }),
                            )
                          }
                        >
                          <FileText size={13} aria-hidden="true" /> Read
                        </button>
                        <button
                          type="button"
                          aria-label={`${pinned ? "Unpin" : "Pin"} ${definition.label}`}
                          aria-pressed={pinned}
                          disabled={!pinned && pins.length >= 12}
                          title={
                            !pinned && pins.length >= 12
                              ? "Unpin a metric to make room. Maximum 12 pins."
                              : undefined
                          }
                          onClick={() => {
                            onPatch({
                              pins: pinned
                                ? pins.filter((key) => key !== definition.key)
                                : [...pins, definition.key],
                            });
                            setAnnouncement(
                              `${definition.label} ${pinned ? "unpinned" : "pinned"}.`,
                            );
                          }}
                        >
                          <Pin size={13} aria-hidden="true" />{" "}
                          {pinned ? "Unpin" : "Pin"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {matchedTools.length > 0 && (
            <section
              className={styles.toolSection}
              aria-label="Matching research tools"
            >
              <h3>Research tools</h3>
              <div className={styles.tools}>
                {matchedTools.map((tool) => (
                  <button
                    type="button"
                    key={tool.key}
                    aria-label={`Open ${tool.label}`}
                    aria-current={
                      settings.view === tool.key ? "page" : undefined
                    }
                    onClick={() => run(() => onPatch({ view: tool.key }))}
                  >
                    <strong>
                      {tool.label}
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </strong>
                    <span>{tool.intent}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {!matchedMetrics.length && !matchedTools.length && (
            <div className={styles.empty}>
              <Search size={24} aria-hidden="true" />
              <h3>No matching metric or tool</h3>
              <p>
                Try a shorter financial term such as “cash”, “equity”, or a
                source tag. This search covers metrics available in this
                company’s Analysis workspace.
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  input.current?.focus();
                }}
              >
                Clear search
              </button>
            </div>
          )}
        </div>
        <div className={styles.footer}>
          <span role="status" aria-live="polite">
            {announcement ||
              `${pins.length}/12 metrics pinned. Pins stay with your current view.`}
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </div>
      </dialog>
    </>
  );
}
