/** A common zero-based scale for the overview. Missing or rejected observations
 * never become zero-length bars, and a paused benchmark never becomes a guide. */
export function comparisonOverviewScale(comparison) {
  const plotted = comparison.cells.filter(
    (cell) => cell.status === "reviewed" && cell.quality?.valid && Number.isFinite(cell.point?.value),
  );
  const guide = !comparison.reason && Number.isFinite(comparison.reference)
    ? comparison.reference : null;
  const values = plotted.map((cell) => cell.point.value);
  if (guide != null) values.push(guide);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  // Equal zero observations still get a visible, centered marker.
  const span = high - low || 1;
  const position = (value) => high === low ? 50 : 3 + ((value - low) / span) * 94;
  return {
    low, high, guide, position, zero: position(0),
    plottedTickers: new Set(plotted.map((cell) => cell.ticker)),
  };
}
