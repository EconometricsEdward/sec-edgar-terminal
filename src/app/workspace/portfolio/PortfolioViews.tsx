"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_PORTFOLIO_VIEW,
  PORTFOLIO_VIEWS_KEY,
  PORTFOLIO_VIEW_PRESETS,
  readPortfolioViews,
  writePortfolioView,
} from "../../../utils/portfolioViews.js";
import s from "./PortfolioViews.module.css";

type ViewValue = {
  query: string;
  filter: string;
  industryFilter: string;
  sort: string;
  direction: string;
  columns: string[];
  preset: string;
};
type Props = {
  value: ViewValue;
  onChange: (value: ViewValue) => void;
  portfolioId: string;
  requestedViewId?: string;
  requestNonce?: number;
  onRequestHandled?: () => void;
};
const copy = (value: any) => JSON.parse(JSON.stringify(value));
function clearViewRequest() {
  const url = new URL(window.location.href);
  if (url.searchParams.has("portfolioView")) {
    url.searchParams.delete("portfolioView");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
}

export default function PortfolioViews({
  value,
  onChange,
  portfolioId,
  requestedViewId = "",
  requestNonce = 0,
  onRequestHandled,
}: Props) {
  const [store, setStore] = useState<any>({
    version: 1,
    views: [],
    current: [],
  });
  const [loadedId, setLoadedId] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const onChangeRef = useRef(onChange);
  const onRequestHandledRef = useRef(onRequestHandled);
  const requestRef = useRef({ requestedViewId, requestNonce });
  const handledRequest = useRef("");
  const restoring = useRef<string | null>(null);
  const valueJson = JSON.stringify(value);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onRequestHandledRef.current = onRequestHandled;
  }, [onRequestHandled]);
  useEffect(() => {
    requestRef.current = { requestedViewId, requestNonce };
  }, [requestedViewId, requestNonce]);

  useEffect(() => {
    let initialize = true;
    const read = () => {
      try {
        const saved = readPortfolioViews(
          localStorage.getItem(PORTFOLIO_VIEWS_KEY),
        );
        setStore(saved);
        if (initialize) {
          const requested =
            new URLSearchParams(window.location.search).get("portfolioView") ||
            requestRef.current.requestedViewId;
          const linked =
            requested &&
            saved.views.find((entry: any) => entry.id === requested);
          const current = saved.current.find(
            (entry: any) => entry.portfolioId === portfolioId,
          );
          const next = copy(
            linked?.value || current?.value || DEFAULT_PORTFOLIO_VIEW,
          );
          restoring.current = JSON.stringify(next);
          onChangeRef.current(next);
          setLoadedId(portfolioId);
          setName("");
          setMessage(linked ? `Loaded ${linked.name}.` : "");
          if (requested) {
            handledRequest.current = `${portfolioId}:${requestRef.current.requestNonce}:${requested}`;
            clearViewRequest();
            onRequestHandledRef.current?.();
            if (!linked)
              setMessage(
                "This saved view is no longer available. Your current portfolio view was restored.",
              );
          }
          initialize = false;
        }
        setError("");
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Saved views could not be read.",
        );
      }
    };
    read();
    const sync = (event: StorageEvent) => {
      if (!event.key || event.key === PORTFOLIO_VIEWS_KEY) read();
    };
    window.addEventListener("storage", sync);
    window.addEventListener("research-storage", read);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("research-storage", read);
    };
  }, [portfolioId]);

  useEffect(() => {
    if (!requestedViewId || loadedId !== portfolioId) return;
    const key = `${portfolioId}:${requestNonce}:${requestedViewId}`;
    if (handledRequest.current === key) return;
    handledRequest.current = key;
    try {
      const saved = readPortfolioViews(
        localStorage.getItem(PORTFOLIO_VIEWS_KEY),
      );
      const view = saved.views.find(
        (entry: any) => entry.id === requestedViewId,
      );
      if (view) {
        const next = copy(view.value);
        restoring.current = JSON.stringify(next);
        onChangeRef.current(next);
        setMessage(`Loaded ${view.name}.`);
        setError("");
      } else
        setMessage(
          "This saved view is no longer available. Your current view is unchanged.",
        );
      clearViewRequest();
      onRequestHandledRef.current?.();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The requested view could not be read.",
      );
    }
  }, [requestedViewId, requestNonce, portfolioId, loadedId]);

  useEffect(() => {
    if (!portfolioId || loadedId !== portfolioId) return;
    if (restoring.current !== null) {
      if (valueJson !== restoring.current) return;
      restoring.current = null;
    }
    const timer = window.setTimeout(() => {
      try {
        const next = JSON.parse(valueJson);
        const latest = readPortfolioViews(
          localStorage.getItem(PORTFOLIO_VIEWS_KEY),
        );
        if (
          JSON.stringify(
            latest.current.find(
              (entry: any) => entry.portfolioId === portfolioId,
            )?.value,
          ) === valueJson
        )
          return;
        setStore(
          writePortfolioView(localStorage, {
            mode: "current",
            portfolioId,
            value: next,
          }),
        );
        window.dispatchEvent(new Event("research-storage"));
        setError("");
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : "This view could not be remembered.",
        );
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [portfolioId, loadedId, valueJson]);

  const selected = store.views.find(
    (entry: any) => JSON.stringify(entry.value) === valueJson,
  );
  const preset = PORTFOLIO_VIEW_PRESETS.find(
    (entry) => entry.id === value.preset,
  );
  const write = (operation: any, success: string) => {
    try {
      setStore(writePortfolioView(localStorage, operation));
      window.dispatchEvent(new Event("research-storage"));
      setMessage(success);
      setError("");
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The view could not be saved.",
      );
      return false;
    }
  };

  return (
    <section className={s.root} aria-label="Research table views">
      <div className={s.heading}>
        <div>
          <p className={s.eyebrow}>A clearer view of your companies</p>
          <h3>Choose your research lens</h3>
        </div>
        <span className={s.local}>Remembered on this browser</span>
      </div>
      <div
        className={s.presets}
        role="group"
        aria-label="Built-in research views"
      >
        {PORTFOLIO_VIEW_PRESETS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={value.preset === entry.id}
            onClick={() => {
              onChange({
                ...copy(DEFAULT_PORTFOLIO_VIEW),
                preset: entry.id,
                columns: [...entry.columns],
              });
              setMessage(
                `${entry.name} applied. Search and filters reset; customize them below.`,
              );
            }}
          >
            {entry.name}
          </button>
        ))}
      </div>
      <p className={s.description}>
        {preset?.description} Your search and coverage filters also apply.
      </p>
      <div className={s.saved}>
        <label>
          Saved views
          <select
            value={selected?.id || ""}
            onChange={(event) => {
              const view = store.views.find(
                (entry: any) => entry.id === event.target.value,
              );
              if (view) {
                onChange(copy(view.value));
                setMessage(`Loaded ${view.name}.`);
              }
            }}
          >
            <option value="">
              {store.views.length
                ? "Choose a saved view"
                : "No saved views yet"}
            </option>
            {store.views.map((entry: any) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <details className={s.manage}>
          <summary>Save or manage views</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (write({ mode: "save", name, value }, `Saved ${name.trim()}.`))
                setName("");
            }}
          >
            <label>
              View name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                placeholder="e.g. Cash generation review"
                required
              />
            </label>
            <button type="submit" disabled={!name.trim()}>
              Save current view
            </button>
          </form>
          <p>
            Save the current search, filters, sorting and columns. Saved views
            work across your portfolios.
          </p>
          {store.views.length > 0 && (
            <ul className={s.list}>
              {store.views.map((entry: any) => (
                <li key={entry.id}>
                  <span>{entry.name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      write(
                        { mode: "save", id: entry.id, name: entry.name, value },
                        `Updated ${entry.name} with the current view.`,
                      )
                    }
                    aria-label={`Update ${entry.name} with current settings`}
                  >
                    Update
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      write(
                        { mode: "delete", id: entry.id },
                        `Removed saved view ${entry.name}.`,
                      )
                    }
                    aria-label={`Remove saved view ${entry.name}`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
      <p className={s.status} role="status">
        {message}
      </p>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
