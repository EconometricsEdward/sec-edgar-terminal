'use client';

// Placeholder rendered while a lazy-loaded chart bundle streams in.
// Matches the terminal palette; the pulse is subtle on purpose.
export default function ChartSkeleton({ height = 300 }) {
  return (
    <div
      className="border-2 border-stone-800 bg-stone-900/40 animate-pulse flex items-end gap-1.5 p-6"
      style={{ height }}
      aria-hidden="true"
    >
      {[40, 65, 30, 80, 55, 70, 45, 90, 60, 35, 75, 50].map((h, i) => (
        <div key={i} className="flex-1 bg-stone-800" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}
