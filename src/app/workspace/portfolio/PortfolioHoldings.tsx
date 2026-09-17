"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Building2, ListFilter, Rows3 } from "lucide-react";
import styles from "./PortfolioHoldings.module.css";

const PortfolioHoldingsScreen = dynamic(() => import("./PortfolioHoldingsScreen"), {
  loading: () => <p role="status">Opening holding filters…</p>,
});

export default function PortfolioHoldings({
  rows, settings, companies, capturedAt, mode, onModeChange,
  onInspectCompany, onDisclosure, children,
}: {
  rows: any[];
  settings: any;
  companies: any[];
  capturedAt?: string | null;
  mode: "all" | "screen";
  onModeChange: (mode: "all" | "screen") => void;
  onInspectCompany: (rowId: string) => void;
  onDisclosure?: (query: string, ciks: string[]) => void;
  children: ReactNode;
}) {
  const id = useId();
  const [screenVisited, setScreenVisited] = useState(mode === "screen");
  useEffect(() => {
    if (mode === "screen") setScreenVisited(true);
  }, [mode]);
  const included = rows.filter((row) => !row.excluded && !row.mergedInto && row.duplicateChoice !== "remove").length;
  return (
    <section className={styles.root} aria-labelledby={`${id}-heading`}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.icon} aria-hidden="true"><Building2 size={23} /></span>
          <div>
            <p className={styles.eyebrow}>Your portfolio, holding by holding</p>
            <h2 id={`${id}-heading`}>Holdings</h2>
            <p>What do I own, and which holdings meet my criteria?</p>
          </div>
        </div>
        <div className={styles.count}><strong>{included}</strong><span>included {included === 1 ? "position" : "positions"}</span></div>
      </header>
      <div className={styles.modeBar}>
        <div className={styles.modes} role="group" aria-label="Holdings view">
          <button type="button" aria-pressed={mode === "all"} aria-controls={`${id}-all`} onClick={() => onModeChange("all")}>
            <Rows3 size={16} aria-hidden="true" /> All holdings
          </button>
          <button type="button" aria-pressed={mode === "screen"} aria-controls={`${id}-screen`} onClick={() => onModeChange("screen")}>
            <ListFilter size={16} aria-hidden="true" /> Screen holdings
          </button>
        </div>
        <p>{mode === "all" ? "Explore positions and inspect the evidence behind each value." : "Combine financial criteria to find matches within this portfolio."}</p>
      </div>
      <div id={`${id}-all`} hidden={mode !== "all"} className={styles.content}>{children}</div>
      <div id={`${id}-screen`} hidden={mode !== "screen"} className={styles.content}>
        {(screenVisited || mode === "screen") && (
          <PortfolioHoldingsScreen rows={rows} settings={settings} companies={companies} capturedAt={capturedAt} onInspectCompany={onInspectCompany} onDisclosure={onDisclosure} />
        )}
      </div>
    </section>
  );
}
