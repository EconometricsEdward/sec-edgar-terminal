const overlaps = (a, b, gap = 4) =>
  a.left < b.right + gap && a.right + gap > b.left &&
  a.top < b.bottom + gap && a.bottom + gap > b.top;

/** Place only text, in chart pixels; the financial point coordinates are immutable. */
export function layoutCompareMapLabels(points, plot) {
  const placed = [];
  const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const obstacles = valid.map((point) => ({
    left: point.x - 8, right: point.x + 8, top: point.y - 8, bottom: point.y + 8,
  }));
  for (const point of [...valid].sort((a, b) => a.y - b.y || a.x - b.x || a.ticker.localeCompare(b.ticker))) {
    // Labels use 12px monospace; 8px per character leaves a conservative gutter.
    const width = Math.max(18, point.ticker.length * 8);
    const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
    let best;
    for (let ring = 0; ring < 8; ring += 1) {
      const vertical = 20 + ring * 20;
      const horizontal = width / 2 + 14 + ring * 16;
      for (const [dx, dy] of [[0, -vertical], [0, vertical], [horizontal, 0], [-horizontal, 0], [horizontal, -vertical], [-horizontal, -vertical], [horizontal, vertical], [-horizontal, vertical]]) {
        const x = clamp(point.x + dx, plot.x + width / 2, plot.x + plot.width - width / 2);
        const y = clamp(point.y + dy, plot.y - 20, plot.y + plot.height - 8);
        const candidate = {
          ticker: point.ticker, x, y, pointX: point.x, pointY: point.y,
          left: x - width / 2, right: x + width / 2, top: y - 7, bottom: y + 7,
        };
        const collisions = [...placed, ...obstacles].filter((other) => overlaps(candidate, other)).length;
        const score = collisions * 10000 + Math.hypot(x - point.x, y - point.y);
        if (!best || score < best.score) best = { ...candidate, score };
      }
      if (best.score < 10000) break;
    }
    if (best) placed.push(best);
  }
  return placed;
}
