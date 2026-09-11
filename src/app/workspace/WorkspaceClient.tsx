"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import styles from "./workspace.module.css";
import {
  HUB_VIEWS,
  hubDestination,
  parseHubLocation,
} from "../../utils/researchHubNavigation.js";

const PortfolioResearch = dynamic(
  () => import("./portfolio/PortfolioResearch"),
  { loading: () => <p role="status">Opening Portfolio Research…</p> },
);
const HubOverview = dynamic(() => import("./HubOverview"), {
  loading: () => <p role="status">Opening your research overview…</p>,
});

export default function WorkspaceClient() {
  const [hubView, setHubView] = useState("overview");
  const [portfolioVisited, setPortfolioVisited] = useState(false);
  const [portfolioRequest, setPortfolioRequest] = useState<any>(null);
  const navigationSequence = useRef(0);

  useEffect(() => {
    const restoreRoute = () => {
      const url = new URL(window.location.href);
      const requested = parseHubLocation(url.href);
      setHubView(requested.view);
      if (requested.view === "portfolios") {
        setPortfolioVisited(true);
        setPortfolioRequest({
          ...requested,
          nonce: ++navigationSequence.current,
        });
      }
      // Old bookmarks open a supported view without reviving retired screens.
      if (
        (url.searchParams.has("view") &&
          !HUB_VIEWS.some(([view]) => view === url.searchParams.get("view"))) ||
        url.searchParams.has("brief") ||
        url.hash === "#research-vault"
      )
        window.history.replaceState(null, "", hubDestination(requested.view, requested));
    };
    restoreRoute();
    window.addEventListener("popstate", restoreRoute);
    window.addEventListener("hashchange", restoreRoute);
    return () => {
      window.removeEventListener("popstate", restoreRoute);
      window.removeEventListener("hashchange", restoreRoute);
    };
  }, []);

  function navigate(view: string, options: any = {}) {
    const href = hubDestination(view, options);
    const destination = parseHubLocation(href).view;
    if (`${window.location.pathname}${window.location.search}` !== href)
      window.history.pushState(null, "", href);
    setHubView(destination);
    if (destination === "portfolios") {
      setPortfolioVisited(true);
      if (Object.keys(options).length)
        setPortfolioRequest({ ...options, nonce: ++navigationSequence.current });
    }
  }

  return (
    <div
      className={styles.page}
      data-research-workspace
      onClickCapture={(event) => {
        if (
          event.defaultPrevented || event.button !== 0 || event.metaKey ||
          event.ctrlKey || event.shiftKey || event.altKey
        ) return;
        const anchor = (event.target as Element).closest?.("a");
        if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
        const destination = new URL(anchor.href, window.location.href);
        if (destination.origin !== window.location.origin || destination.pathname !== "/workspace") return;
        event.preventDefault();
        const route = parseHubLocation(destination.href);
        navigate(route.view, route);
      }}
    >
      <div className={styles.heading}>
        <h1>Research Hub</h1>
        <nav className={styles.hubTabs} aria-label="Research Hub sections">
          {HUB_VIEWS.map(([view, label]) => (
            <button
              key={view}
              type="button"
              aria-pressed={hubView === view}
              onClick={() => navigate(view)}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div hidden={hubView !== "overview"}>
        <HubOverview onNavigate={navigate} />
      </div>
      <div hidden={hubView !== "portfolios"}>
        {portfolioVisited && (
          <PortfolioResearch
            active={hubView === "portfolios"}
            navigationRequest={portfolioRequest}
          />
        )}
      </div>
    </div>
  );
}
