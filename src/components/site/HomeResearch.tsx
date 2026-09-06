"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Clock3 } from "lucide-react";
import { useWorkspace } from "../research/WorkspaceProvider";
import { readResearchTrail } from "../../utils/researchTrail.js";
import {
  MARKET_SAVED_KEY,
  parseMarketSaved,
} from "../../utils/marketResearch.js";
import {
  consolidatedWatchlist,
  FUND_SHELF_KEY,
  parseFundShelf,
} from "../../utils/workspaceReview.js";
import styles from "../../app/home.module.css";
export default function HomeResearch() {
  const { data, ready } = useWorkspace();
  const [recent, setRecent] = useState<any[]>([]);
  const [market, setMarket] = useState<any>({ watchlist: [] });
  const [funds, setFunds] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const read = () => {
      let failure = false;
      try {
        setRecent(readResearchTrail(localStorage).slice(0, 4));
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
          ? "Some browser-saved research could not be read. Open Research Hub to inspect your stores."
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
  }, []);
  const saved = useMemo(
    () => consolidatedWatchlist(data, market, funds),
    [data, market, funds],
  );
  return (
    <section className={styles.resume} aria-labelledby="resume-title">
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>Your next session starts here</p>
          <h2 id="resume-title">Pick up where you left off.</h2>
        </div>
        <Link href="/workspace">
          All saved research <ArrowUpRight size={15} />
        </Link>
      </div>
      <div className={styles.resumeGrid}>
        <div>
          <h3>
            <Clock3 size={15} /> Recent research
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
                      <ArrowUpRight size={14} />
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>
              The tools and companies you visit will appear here, with their
              page settings. Start with a workflow above.
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
                  <ArrowUpRight size={14} />
                </Link>
              ))}
            </div>
          ) : (
            <p className={styles.empty}>
              Save companies and funds in the Research Hub, Market, or Funds.
              Your watchlist stays connected across those tools.
            </p>
          )}
          <p className={styles.localNote}>
            Stored in this browser. Use Research Hub to back up evidence and
            notes before changing devices.
          </p>
        </div>
      </div>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
