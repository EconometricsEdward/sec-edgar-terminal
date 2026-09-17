"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Clock3 } from "lucide-react";
import { useWorkspace } from "../research/WorkspaceProvider";
import { readResearchTrail } from "../../utils/researchTrail.js";
import {
  isCftcPositioningPath,
  MARKET_SAVED_KEY,
  parseMarketSaved,
} from "../../utils/marketResearch.js";
import {
  consolidatedWatchlist,
  FUND_SHELF_KEY,
  parseFundShelf,
} from "../../utils/workspaceReview.js";
import styles from "../../app/home.module.css";
export default function HomeResearch({ cftcEnabled = true }: { cftcEnabled?: boolean }) {
  const { data, ready } = useWorkspace();
  const [recent, setRecent] = useState<any[]>([]);
  const [market, setMarket] = useState<any>({ watchlist: [] });
  const [funds, setFunds] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const read = () => {
      let failure = false;
      try {
        const seenPaths = new Set<string>();
        const seenTitles = new Set<string>();
        setRecent(
          readResearchTrail(localStorage)
            .filter((item) => cftcEnabled || !isCftcPositioningPath(item.href))
            .filter((item) => {
              if (seenPaths.has(item.href) || seenTitles.has(item.title)) return false;
              seenPaths.add(item.href);
              seenTitles.add(item.title);
              return true;
            })
            .slice(0, 4),
        );
      } catch {
        failure = true;
      }
      try {
        setMarket(parseMarketSaved(localStorage.getItem(MARKET_SAVED_KEY)));
      } catch {
        failure = true;
      }
      try {
        setFunds(parseFundShelf(localStorage.getItem(FUND_SHELF_KEY)));
      } catch {
        failure = true;
      }
      setNotice(
        failure
          ? "Some browser-saved research could not be read. Reload the page to try again."
          : "",
      );
    };
    read();
    window.addEventListener("storage", read);
    window.addEventListener("focus", read);
    window.addEventListener("research-storage", read);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener("focus", read);
      window.removeEventListener("research-storage", read);
    };
  }, [cftcEnabled]);
  const saved = useMemo(
    () => consolidatedWatchlist(data, market, funds),
    [data, market, funds],
  );
  return (
    <section className={styles.resume} aria-labelledby="resume-title">
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>Your workspace</p>
          <h2 id="resume-title">Continue your research.</h2>
        </div>
        <Link href="/workspace" prefetch={false}>
          Open Portfolio <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </div>
      <div className={styles.resumeGrid}>
        <div>
          <h3>
            <Clock3 size={15} aria-hidden="true" /> Recent research
          </h3>
          {!ready ? (
            <p role="status">Loading your research…</p>
          ) : recent.length ? (
            <ul>
              {recent.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} prefetch={false}>
                    <span>{item.title}</span>
                    <small>
                      {item.at.slice(0, 10)}
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>
              Your recent companies and research tools will appear here.
            </p>
          )}
        </div>
        <div>
          <h3>
            Saved companies & funds <span>{ready ? saved.length : "—"}</span>
          </h3>
          {saved.length ? (
            <div className={styles.savedTickers}>
              {saved.slice(0, 10).map((row) => (
                <Link
                  href={`/${row.kind === "fund" ? "fund" : "analysis"}/${row.ticker}`}
                  key={`${row.kind}:${row.ticker}`}
                  prefetch={false}
                >
                  <strong>{row.ticker}</strong>
                  <small>
                    {row.kind === "fund"
                      ? "Fund"
                      : row.review.reviewedAt
                        ? `Reviewed ${row.review.reviewedAt.slice(0, 10)}`
                        : "Company"}
                  </small>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              ))}
            </div>
          ) : (
            <p className={styles.empty}>
              Save a company or fund while you research to return to it here.
            </p>
          )}
          <p className={styles.localNote}>
            Saved in this browser. Export your research before switching devices.
          </p>
        </div>
      </div>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
