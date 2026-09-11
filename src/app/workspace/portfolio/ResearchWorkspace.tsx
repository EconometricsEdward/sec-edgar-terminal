"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import {
  BarChart3,
  Building2,
  ClipboardList,
  FileText,
  Layers3,
  ListFilter,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Download,
  History,
  type LucideIcon,
} from "lucide-react";
import s from "./ResearchWorkspace.module.css";

const analysis = [
  ["analytics:overview", "Portfolio overview", ClipboardList],
  ["companies", "Companies", Building2],
  ["analytics:metrics", "Metrics & rankings", BarChart3],
  ["analytics:concentration", "Concentration", Layers3],
  ["analytics:financial", "Financial profile", BarChart3],
  ["analytics:screener", "Company screener", ListFilter],
  ["analytics:scenario", "Scenarios", SlidersHorizontal],
] as const;
const evidence = [
  ["filings", "Filing library", FileText],
  ["disclosures", "Disclosure search", Search],
  ["ownership", "Fund ownership", Building2],
  ["analytics:coverage", "Evidence coverage", ShieldCheck],
] as const;

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
  const groups: {
    label: string;
    items: readonly (readonly [string, string, LucideIcon])[];
  }[] = [
    { label: "Portfolio", items: analysis },
    {
      label: "Evidence",
      items: [
        ...evidence,
        [
          demo ? "followups" : "changes",
          demo ? "Research prompts" : "What changed",
          demo ? Sparkles : History,
        ] as const,
      ],
    },
    ...(!demo
      ? [
          {
            label: "Manage",
            items: [
              ["allocation", "Allocation settings", SlidersHorizontal],
              ["exports", "Export & AI context", Download],
            ] as const,
          },
        ]
      : []),
  ];
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
  const label =
    groups
      .flatMap((group) => group.items)
      .find((item) => item[0] === selected)?.[1] || "Portfolio research";
  return (
    <div className={s.workspace}>
      <aside className={s.sidebar}>
        <label className={s.mobileView}>
          Research view
          <select
            value={selected}
            onChange={(event) => onSelect(event.target.value)}
          >
            {groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <nav className={s.navigation} aria-label="Portfolio research views">
          {groups.map((group) => (
            <div className={s.group} key={group.label}>
              <p>{group.label}</p>
              {group.items.map(([id, name, Icon]) => (
                <button
                  key={id}
                  type="button"
                  ref={id === "companies" ? companyRef : undefined}
                  aria-current={selected === id ? "page" : undefined}
                  onClick={() => onSelect(id)}
                >
                  <Icon size={18} aria-hidden="true" />
                  {name}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div
        ref={content}
        tabIndex={-1}
        className={s.content}
        data-portfolio-view
        role="region"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}
