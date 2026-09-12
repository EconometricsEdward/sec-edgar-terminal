"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import s from "./CompanyResearchTable.module.css";

type Props = {
  children: ReactNode;
  label: string;
  className?: string;
  selectionColumn?: boolean;
  resetKey?: string;
};

/** Two native scrollbars share the table's position; the top one stays in reach. */
export default function CompanyResearchTable({
  children,
  label,
  className = "",
  selectionColumn = false,
  resetKey = "",
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const id = useId();
  const [size, setSize] = useState({ content: 0, viewport: 0 });
  const [edges, setEdges] = useState({ start: true, end: false });
  const overflow = size.content > size.viewport + 1;

  function updateEdges() {
    const element = viewport.current;
    if (!element) return;
    const start = element.scrollLeft < 1;
    const end =
      element.scrollLeft >= element.scrollWidth - element.clientWidth - 1;
    setEdges((previous) =>
      previous.start === start && previous.end === end
        ? previous
        : { start, end },
    );
  }

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const next = {
        content: element.scrollWidth,
        viewport: element.clientWidth,
      };
      setSize((previous) =>
        previous.content === next.content && previous.viewport === next.viewport
          ? previous
          : next,
      );
      updateEdges();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const table = element.querySelector("table");
    if (table) observer.observe(table);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (viewport.current) {
      viewport.current.scrollLeft = 0;
      viewport.current.scrollTop = 0;
    }
    if (rail.current) rail.current.scrollLeft = 0;
    updateEdges();
  }, [resetKey]);

  function move(direction: number) {
    const element = viewport.current;
    if (element)
      element.scrollBy({
        left: direction * Math.max(160, element.clientWidth * 0.65),
      });
  }

  return (
    <div
      className={`${s.root} ${className}`}
      data-selection-column={selectionColumn || undefined}
    >
      <div className={s.controls} hidden={!overflow}>
        <span>More columns to explore · company names stay visible</span>
        <div className={s.actions}>
          <button
            type="button"
            aria-label="Scroll company columns left"
            aria-controls={id}
            disabled={edges.start}
            onClick={() => move(-1)}
          >
            <ArrowLeft size={16} aria-hidden="true" /> Left
          </button>
          <button
            type="button"
            aria-label="Scroll company columns right"
            aria-controls={id}
            disabled={edges.end}
            onClick={() => move(1)}
          >
            Right <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        ref={rail}
        className={s.rail}
        hidden={!overflow}
        style={{ width: size.viewport || "100%" }}
        tabIndex={0}
        role="region"
        aria-label="Scroll company table horizontally"
        aria-controls={id}
        onScroll={(event) => {
          if (
            viewport.current &&
            Math.abs(
              viewport.current.scrollLeft - event.currentTarget.scrollLeft,
            ) > 0.5
          )
            viewport.current.scrollLeft = event.currentTarget.scrollLeft;
          updateEdges();
        }}
      >
        <div style={{ width: size.content, height: 1 }} />
      </div>
      <div
        id={id}
        ref={viewport}
        className={s.viewport}
        tabIndex={0}
        role="region"
        aria-label={label}
        onScroll={(event) => {
          if (
            rail.current &&
            Math.abs(rail.current.scrollLeft - event.currentTarget.scrollLeft) >
              0.5
          )
            rail.current.scrollLeft = event.currentTarget.scrollLeft;
          updateEdges();
        }}
      >
        {children}
      </div>
    </div>
  );
}
