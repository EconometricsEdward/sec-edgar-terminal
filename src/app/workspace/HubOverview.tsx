"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Download, FileUp, FolderOpen, Layers3, ListPlus, Plus, X } from "lucide-react";
import s from "./HubOverview.module.css";

type Props = {
  onNavigate: (view: string, options?: { action?: "new" | "paste" }) => void;
};

export default function HubOverview({ onNavigate }: Props) {
  const [importOpen, setImportOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!importOpen) return;
    const modal = dialog.current;
    const previousOverflow = document.body.style.overflow;
    modal?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      modal?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [importOpen]);

  function startImport(action: "new" | "paste") {
    dialog.current?.close();
    setImportOpen(false);
    onNavigate("portfolios", { action });
  }

  return (
    <section className={s.root} aria-label="Choose a portfolio">
      <div className={s.choices}>
        <section className={`${s.card} ${s.customCard}`} aria-labelledby="custom-portfolio-title">
          <div className={s.icon}><FolderOpen size={26} aria-hidden="true" /></div>
          <h2 id="custom-portfolio-title">Your portfolio</h2>
          <p>Upload your holdings or build a list of companies you want to research.</p>
          <p className={s.note}>A ticker list is enough. Weights are optional.</p>
          <div className={s.actions}>
            <button type="button" className={s.primary} onClick={() => setImportOpen(true)} aria-haspopup="dialog">
              <Plus size={18} aria-hidden="true" /> Add custom portfolio
            </button>
            <button type="button" className={s.textButton} onClick={() => onNavigate("portfolios")}>
              Open saved portfolios <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
          <span className={s.footnote}>Your portfolios are saved in this browser.</span>
        </section>

        <section className={s.card} aria-labelledby="demo-portfolio-title">
          <div className={`${s.icon} ${s.demoIcon}`}><Layers3 size={26} aria-hidden="true" /></div>
          <h2 id="demo-portfolio-title">Explore the demo</h2>
          <p>See portfolio research in action with 100 companies from the S&amp;P 500.</p>
          <p className={s.note}>A ready-made example. No upload needed.</p>
          <div className={s.actions}>
            <Link href="/workspace/demo" className={s.secondary} prefetch={false}>
              View demo <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <span className={s.footnote}>SEC financials, concentration, and recent changes.</span>
        </section>
      </div>

      <dialog
        ref={dialog}
        className={s.dialog}
        aria-labelledby="portfolio-import-title"
        aria-describedby="portfolio-import-description"
        onCancel={() => setImportOpen(false)}
        onClose={() => setImportOpen(false)}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)
            setImportOpen(false);
        }}
      >
        <header className={s.dialogHeader}>
          <div>
            <h2 id="portfolio-import-title">Add custom portfolio</h2>
            <p id="portfolio-import-description">Choose how to add your holdings or company list.</p>
          </div>
          <button type="button" className={s.close} aria-label="Close upload options" onClick={() => setImportOpen(false)}>
            <X size={21} aria-hidden="true" />
          </button>
        </header>
        <div className={s.methods}>
          <button type="button" className={s.method} onClick={() => startImport("new")}>
            <FileUp size={24} aria-hidden="true" />
            <span><strong>Upload a file</strong><span>Import an Excel (.xlsx), CSV, or JSON file.</span></span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
          <button type="button" className={s.method} onClick={() => startImport("paste")}>
            <ListPlus size={24} aria-hidden="true" />
            <span><strong>Paste tickers</strong><span>Type or paste a list, such as AAPL, MSFT, JPM.</span></span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
        <div className={s.templates}>
          <span>Need a template?</span>
          <a href="/portfolio/portfolio-template.xlsx" download><Download size={15} aria-hidden="true" /> Excel</a>
          <a href="/portfolio/portfolio-template.csv" download><Download size={15} aria-hidden="true" /> CSV</a>
          <Link href="/workspace/portfolio-guide" prefetch={false}>Import guide</Link>
        </div>
      </dialog>
    </section>
  );
}
