const finite = value => typeof value === 'number' && Number.isFinite(value);
const DAY = 86400000;

/** A common scale for every plotted series, retaining missing reports as gaps. */
export function positioningHistoryChart(points = [], display = 'net') {
  const rows = points.filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.reportDate || '') && Number.isFinite(Date.parse(point.reportDate)))
    .slice().sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  const fields = display === 'sides' ? ['long', 'short'] : display === 'interest' ? ['openInterest'] : ['netPctOi'];
  const read = (row, field) => display === 'sides'
    ? finite(row[field]) && row[field] >= 0 && finite(row.openInterest) && row.openInterest > 0 ? 100 * row[field] / row.openInterest : null
    : finite(row[field]) ? row[field] : null;
  const numeric = rows.flatMap(row => fields.map(field => read(row, field))).filter(finite);
  if (rows.length < 2 || numeric.length < 2) return null;
  const start = Date.parse(rows[0].reportDate), end = Date.parse(rows.at(-1).reportDate);
  if (end <= start) return null;
  const min = Math.min(0, ...numeric), max = Math.max(0, ...numeric);
  const span = max - min || 1;
  const x = date => 68 + 724 * (Date.parse(date) - start) / (end - start);
  const y = value => 218 - 182 * (value - min) / span;
  const series = fields.map(field => {
    const paths = [], dots = [];
    let path = '', previous = null;
    for (const row of rows) {
      const value = read(row, field);
      if (!finite(value)) { if (path) paths.push(path); path = ''; previous = null; continue; }
      if (previous && Date.parse(row.reportDate) - previous > 7 * DAY) { if (path) paths.push(path); path = ''; }
      const px = x(row.reportDate), py = y(value);
      path += `${path ? ' L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`;
      dots.push({ x: px, y: py, date: row.reportDate, value });
      previous = Date.parse(row.reportDate);
    }
    if (path) paths.push(path);
    return { field, paths, dots };
  });
  return { rows, series, min, max, zeroY: y(0), ticks: [0, 1, 2, 3, 4].map(index => ({ value: min + span * index / 4, y: y(min + span * index / 4) })), positions: rows.map(row => ({ ...row, x: x(row.reportDate) })), start: rows[0].reportDate, end: rows.at(-1).reportDate };
}

export function positioningGroups(selected) {
  return Object.values(selected?.groups || {}).map(group => ({ id: group.id, label: group.label, net: group.net, value: finite(group.netPctOi) ? group.netPctOi : null }));
}

export function signedPlotExtent(values) {
  return Math.max(5, Math.ceil(Math.max(0, ...values.filter(finite).map(Math.abs)) / 5) * 5);
}
