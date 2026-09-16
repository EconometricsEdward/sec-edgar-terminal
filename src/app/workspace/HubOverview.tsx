"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Activity, ArrowRight, BarChart3, Building2, Download, FileUp, FolderOpen, History, Layers3, ListPlus, Plus, SlidersHorizontal, X } from "lucide-react";
import s from "./HubOverview.module.css";

type Props = {
  onNavigate: (view: string, options?: { action?: "new" | "paste" }) => void;
};

const researchViews = [
  { id: "companies", label: "Companies", Icon: Building2, title: "Get to know every holding.", description: "Review the companies in your portfolio and open the SEC evidence behind their financials.", features: ["Company details", "Financial statements", "SEC evidence"] },
  { id: "metrics", label: "Metrics & rankings", Icon: BarChart3, title: "Put the numbers in perspective.", description: "Compare company metrics, explore rankings, and trace the figures back to their sources.", features: ["Company rankings", "Metric definitions", "Source links"] },
  { id: "concentration", label: "Concentration", Icon: Layers3, title: "See where your exposure sits.", description: "Explore your portfolio by sector, industry, and company to understand what drives its concentration.", features: ["Sectors", "Industries", "Largest holdings"] },
  { id: "financial", label: "Financial profile", Icon: Activity, title: "Understand the businesses behind it.", description: "Explore revenue, profitability, and leverage across the companies you hold or want to research.", features: ["Revenue", "Profitability", "Leverage"] },
  { id: "scenario", label: "Scenarios", Icon: SlidersHorizontal, title: "Ask what could change.", description: "Adjust assumptions and explore potential portfolio effects with company financials and market context.", features: ["What-if inputs", "Portfolio effects", "Market context"] },
  { id: "changes", label: "What changed", Icon: History, title: "Focus on what is new.", description: "Review recent SEC filings, financial changes, and relevant CFTC positioning in one place.", features: ["SEC filings", "Financial changes", "CFTC positioning"] },
] as const;

export default function HubOverview({ onNavigate }: Props) {
  const [importOpen, setImportOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [selectedView, setSelectedView] = useState(2);
  const viewButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const view = researchViews[selectedView];
  const ViewIcon = view.Icon;

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

        <section className={`${s.card} ${s.demoCard}`} aria-labelledby="demo-portfolio-title">
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

      <section className={s.explorer} aria-labelledby="research-explorer-title" data-view={view.id}>
        <header className={s.explorerHeading}>
          <h2 id="research-explorer-title">Inside Portfolio Research</h2>
          <p>Select a view to see what you can explore.</p>
        </header>
        <div className={s.viewTabs} role="tablist" aria-label="Preview Portfolio Research views">
          {researchViews.map(({ id, label, Icon }, index) => (
            <button
              key={id}
              ref={(element) => { viewButtons.current[index] = element; }}
              id={`portfolio-preview-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={selectedView === index}
              aria-controls="portfolio-view-preview"
              tabIndex={selectedView === index ? 0 : -1}
              onClick={() => setSelectedView(index)}
              onKeyDown={(event) => {
                let next = index;
                if (event.key === "ArrowRight") next = (index + 1) % researchViews.length;
                else if (event.key === "ArrowLeft") next = (index + researchViews.length - 1) % researchViews.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = researchViews.length - 1;
                else return;
                event.preventDefault();
                setSelectedView(next);
                viewButtons.current[next]?.focus();
              }}
            >
              <Icon size={21} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className={s.viewPanel} id="portfolio-view-preview" role="tabpanel" aria-labelledby={`portfolio-preview-tab-${view.id}`} tabIndex={0}>
          <div key={view.id} className={s.viewDetail}>
            <div className={s.viewIcon} aria-hidden="true"><ViewIcon size={34} strokeWidth={1.5} /></div>
            <div className={s.viewCopy}>
              <h3>{view.title}</h3>
              <p>{view.description}</p>
            </div>
            <ul className={s.viewFeatures} aria-label={`${view.label} tools`}>
              {view.features.map((feature) => <li key={feature}>{feature}</li>)}
            </ul>
          </div>
        </div>
      </section>

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
