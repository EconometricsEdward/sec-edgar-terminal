"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Building2,
  ChevronDown,
  Download,
  FileText,
  History,
  Layers3,
  LayoutDashboard,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import s from "./ResearchWorkspace.module.css";

const analysis = [
  {
    id: "analytics:overview",
    name: "Summary",
    question: "What should I notice?",
    icon: LayoutDashboard,
  },
  {
    id: "companies",
    name: "Holdings",
    question: "What do I own, and what meets my criteria?",
    icon: Building2,
  },
  {
    id: "analytics:financial",
    name: "Financials",
    question: "What does my allocation represent?",
    icon: BarChart3,
  },
  {
    id: "analytics:concentration",
    name: "Concentration & Exposure",
    question: "Where do my holdings connect?",
    icon: Layers3,
  },
  {
    id: "changes",
    name: "What Changed",
    question: "What new information matters?",
    icon: History,
  },
] as const;

const evidence: readonly (readonly [string, string, LucideIcon])[] = [
  ["filings", "Filing library", FileText],
  ["disclosures", "Disclosure search", Search],
  ["ownership", "Fund ownership", Building2],
  ["analytics:coverage", "Data coverage", ShieldCheck],
];

const management: readonly (readonly [string, string, LucideIcon])[] = [
  ["allocation", "Allocation settings", SlidersHorizontal],
  ["exports", "Export & AI context", Download],
];

export default function ResearchWorkspace({
  selected,
  onSelect,
  children,
  demo = false,
  companyRef,
}: {
  selected: string;
  onSelect: (view: string) => void;
  children: ReactNode;
  demo?: boolean;
  companyRef?: RefObject<HTMLButtonElement | null>;
}) {
  const content = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const tools = useRef<HTMLDetailsElement>(null);
  const questionId = useId();
  const toolItems = demo ? evidence : [...evidence, ...management];
  const activeTool = toolItems.find(([id]) => id === selected);
  const primarySelection =
    selected === "analytics:metrics"
      ? "analytics:financial"
      : selected === "analytics:screener"
        ? "companies"
        : activeTool
          ? "analytics:overview"
          : selected;
  const activePage = analysis.find(({ id }) => id === primarySelection);
  const label = activeTool?.[1] || activePage?.name || "Portfolio research";

  useEffect(() => {
    const header = document.querySelector("[data-site-header]");
    if (!header) return;
    const measure = () =>
      workspace.current?.style.setProperty(
        "--site-header-height",
        `${header.getBoundingClientRect().height}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // A single paint per frame follows the pointer without re-rendering the views.
  useEffect(() => {
    const rail = sidebar.current;
    if (!rail) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let x = 0;
    let y = 0;
    const move = (event: PointerEvent) => {
      const preference = document.documentElement.dataset.readingMotion;
      if (
        event.pointerType !== "mouse" ||
        preference === "reduced" ||
        (motion.matches && preference !== "full")
      )
        return;
      x = event.clientX;
      y = event.clientY;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        const bounds = rail.getBoundingClientRect();
        rail.style.setProperty("--pointer-x", `${x - bounds.left}px`);
        rail.style.setProperty("--pointer-y", `${y - bounds.top}px`);
        frame = 0;
      });
    };
    rail.addEventListener("pointermove", move, { passive: true });
    return () => {
      rail.removeEventListener("pointermove", move);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const previousView = useRef(selected);
  useEffect(() => {
    if (previousView.current === selected) return;
    previousView.current = selected;
    const region = content.current;
    if (!region) return;
    region.focus({ preventScroll: true });
    const header =
      document.querySelector("[data-site-header]")?.getBoundingClientRect()
        .bottom || 0;
    const top = region.getBoundingClientRect().top;
    if (top < header || top > window.innerHeight * 0.65)
      window.scrollBy({ top: top - header - 20 });
  }, [selected]);

  useEffect(() => {
    const nav = navigation.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    const navBounds = nav.getBoundingClientRect();
    const activeBounds = active.getBoundingClientRect();
    if (activeBounds.left < navBounds.left)
      nav.scrollLeft -= navBounds.left - activeBounds.left + 4;
    else if (activeBounds.right > navBounds.right)
      nav.scrollLeft += activeBounds.right - navBounds.right + 4;
  }, [primarySelection]);

  const selectView = (view: string) => {
    if (tools.current) tools.current.open = false;
    onSelect(view);
    if (selected === view) content.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const menu = tools.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target))
        menu.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  return (
    <div ref={workspace} className={s.workspace}>
      <aside ref={sidebar} className={s.sidebar} aria-label="Portfolio navigation">
        <div className={s.railHeading}>
          <span className={s.eyebrow}>Portfolio research</span>
          <span className={s.sourceLabel}>SEC filings <span aria-hidden="true">/</span> CFTC positioning</span>
        </div>
        <nav ref={navigation} className={s.navigation} aria-label="Portfolio research views">
          {analysis.map(({ id, name, question, icon: Icon }, index) => (
            <button
              key={id}
              type="button"
              ref={id === "companies" ? companyRef : undefined}
              aria-label={name}
              aria-describedby={`${questionId}-${index}`}
              aria-current={primarySelection === id ? "page" : undefined}
              onClick={() => selectView(id)}
            >
              <span className={s.viewIcon}><Icon size={18} aria-hidden="true" /></span>
              <span className={s.viewCopy}>
                <span className={s.viewName}>{name}</span>
                <span id={`${questionId}-${index}`} className={s.viewQuestion}>{question}</span>
              </span>
              <span className={s.viewNumber} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            </button>
          ))}
        </nav>
        <details
          ref={tools}
          className={s.tools}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !event.currentTarget.open) return;
            event.preventDefault();
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }}
        >
          <summary>
            <Wrench size={15} aria-hidden="true" />
            <span>Tools & sources</span>
            <ChevronDown size={15} className={s.toolsChevron} aria-hidden="true" />
          </summary>
          <div className={s.toolList}>
            {toolItems.map(([id, name, Icon], index) => (
              <button
                key={id}
                type="button"
                aria-current={selected === id ? "page" : undefined}
                className={index === evidence.length ? s.managementStart : undefined}
                onClick={() => selectView(id)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{name}</span>
                <ArrowUpRight size={13} className={s.toolArrow} aria-hidden="true" />
              </button>
            ))}
          </div>
        </details>
      </aside>
      <div
        ref={content}
        tabIndex={-1}
        className={s.content}
        data-portfolio-view
        role="region"
        aria-label={label}
      >
        {activeTool && (
          <div className={s.utilityContext}>
            <span><Wrench size={14} aria-hidden="true" /> Tools & sources <span aria-hidden="true">/</span> <strong>{activeTool[1]}</strong></span>
            <button type="button" onClick={() => selectView("analytics:overview")}>Back to Summary <ArrowUpRight size={14} aria-hidden="true" /></button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
