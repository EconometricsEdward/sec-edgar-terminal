'use client';

import { useId, useRef } from 'react';
import s from './ChartPeriodOverlay.module.css';

type Point = { id: string; label: string; x: number };
type Props = {
  points: Point[];
  activeId: string;
  onInspect: (id: string | null) => void;
  left: number;
  right: number;
  top: number;
  bottom: number;
  label: string;
  describePoint?: (id: string) => string;
};

/** SVG hit areas use chart coordinates, so resizing never changes date selection. */
export default function ChartPeriodOverlay({ points, activeId, onInspect, left, right, top, bottom, label, describePoint }: Props) {
  const helpId = useId();
  const keyboard = useRef(false);
  const ordered = points.filter(point => Number.isFinite(point.x)).slice().sort((a, b) => a.x - b.x);
  if (!ordered.length) return null;
  const current = Math.max(0, ordered.findIndex(point => point.id === activeId));
  return <g className={s.control} role="slider" tabIndex={0}
    aria-label={`${label}: inspect period`} aria-describedby={helpId}
    aria-valuemin={0} aria-valuemax={ordered.length - 1} aria-valuenow={current}
    aria-valuetext={describePoint?.(ordered[current].id) || ordered[current].label}
    onBlur={() => { keyboard.current = false; onInspect(null); }}
    onPointerDown={() => { keyboard.current = false; }}
    onPointerLeave={event => { if (event.pointerType === 'mouse' && !keyboard.current) onInspect(null); }}
    onKeyDown={event => {
      let next = current;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(ordered.length - 1, current + 1);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, current - 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = ordered.length - 1;
      else if (event.key === 'Escape') { event.preventDefault(); keyboard.current = false; onInspect(null); return; }
      else return;
      event.preventDefault(); keyboard.current = true; onInspect(ordered[next].id);
    }}>
    <desc id={helpId}>Hover or tap a period to inspect every plotted value. Use arrow keys, Home or End to move through periods. Escape restores the selected reporting date.</desc>
    <rect className={s.focusRing} x={left} y={top} width={right - left} height={bottom - top} />
    {ordered.map((point, index) => {
      const start = index ? (ordered[index - 1].x + point.x) / 2 : left;
      const end = index === ordered.length - 1 ? right : (point.x + ordered[index + 1].x) / 2;
      return <rect key={point.id} x={Math.max(left, start)} y={top} width={Math.max(0, Math.min(right, end) - Math.max(left, start))} height={bottom - top}
        className={s.hitArea} data-period={point.id}
        onPointerMove={event => { if (event.pointerType === 'mouse') keyboard.current = false; if (point.id !== activeId) onInspect(point.id); }}
        onPointerDown={() => onInspect(point.id)}>
        <title>{describePoint?.(point.id) || point.label}</title>
      </rect>;
    })}
  </g>;
}
