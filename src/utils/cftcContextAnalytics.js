const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'Unavailable';
const signed = value => finite(value) ? `${value > 0 ? '+' : ''}${number(value)}` : 'Unavailable';

/** Compare exact report dates in an already validated, compatible contract history. */
export function cftcPositionChange(history, weeks = 1) {
  if (![1, 4, 13].includes(weeks)) throw new Error('Use one, four or thirteen weeks.');
  const date = history?.selected?.reportDate;
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time)) return { available: false, reason: 'The selected report date is unavailable.' };
  const priorDate = new Date(time - weeks * 7 * 86400000).toISOString().slice(0, 10);
  const current = history.history?.find(point => point.reportDate === date);
  const prior = history.history?.find(point => point.reportDate === priorDate);
  if (!current || !prior || ![current.long, current.short, prior.long, prior.short].every(finite)) {
    return { available: false, priorDate, reportDate: date, reason: `Comparable long and short positions are unavailable for ${priorDate}. A nearby report is not substituted.` };
  }
  const longChange = current.long - prior.long;
  const shortChange = current.short - prior.short;
  const netChange = longChange - shortChange;
  const netPctChange = [current.netPctOi, prior.netPctOi].every(finite) ? current.netPctOi - prior.netPctOi : null;
  const direction = netChange > 0 ? 'increased' : netChange < 0 ? 'decreased' : 'was unchanged';
  const explanation = `Net positioning ${direction}${netChange === 0 ? '' : ` by ${number(Math.abs(netChange))} contracts`}. Reported longs changed by ${signed(longChange)} and reported shorts by ${signed(shortChange)} contracts.`;
  return { available: true, priorDate, reportDate: date, longChange, shortChange, netChange, netPctChange, explanation };
}

/** Preserve gaps and real time spacing rather than drawing across missing weeks. */
export function cftcContextChart(points = []) {
  const rows = points.filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.reportDate || '')).slice().sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  const valid = rows.filter(point => finite(point.netPctOi));
  if (valid.length < 2) return null;
  const start = Date.parse(rows[0].reportDate), end = Date.parse(rows.at(-1).reportDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const min = Math.min(0, ...valid.map(point => point.netPctOi));
  const max = Math.max(0, ...valid.map(point => point.netPctOi));
  const span = max - min || 1;
  const x = date => 48 + 592 * (Date.parse(date) - start) / (end - start);
  const y = value => 170 - 132 * (value - min) / span;
  const paths = [];
  const dots = [];
  let segment = '', previous = null;
  for (const point of rows) {
    if (!finite(point.netPctOi)) { if (segment) paths.push(segment); segment = ''; previous = null; continue; }
    if (previous && Date.parse(point.reportDate) - Date.parse(previous) > 7 * 86400000) { if (segment) paths.push(segment); segment = ''; }
    const px = x(point.reportDate), py = y(point.netPctOi);
    segment += `${segment ? ' L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`;
    dots.push({ x: px, y: py, date: point.reportDate, value: point.netPctOi });
    previous = point.reportDate;
  }
  if (segment) paths.push(segment);
  return { paths, dots, min, max, zeroY: y(0), start: rows[0].reportDate, end: rows.at(-1).reportDate, count: valid.length };
}

export function cftcCompanyResearchNote({ ticker, companyName, candidate, history, asOf = '' }) {
  if (!history?.selected || !history?.selection) return '';
  const selected = history.selected, group = selected.selectedGroup;
  const change = cftcPositionChange(history);
  const percent = value => finite(value) ? `${value.toFixed(2)}%` : 'Unavailable';
  const query = new URLSearchParams({ tab: 'positioning', family: history.report_family, contract: history.selection.contract, group: history.selection.group, date: selected.reportDate, history: history.selection.history_window, display: 'net-oi' });
  return [
    `CFTC market context — ${ticker}${companyName ? ` / ${companyName}` : ''}`,
    `Market: ${selected.contractName} · ${selected.exchange} · code ${history.selection.contract}`,
    `Report: ${selected.reportDate} · Retrieved: ${history.retrieved_at} · ${history.status}`,
    `Report family: ${history.report_family} · Futures only · Trader category: ${group?.label || history.selection.group}`,
    `Reported longs: ${number(group?.long)}; shorts: ${number(group?.short)}; net: ${signed(group?.net)} contracts.`,
    `Open interest: ${number(selected.openInterest)} contracts; net / open interest: ${percent(group?.netPctOi)}.`,
    `${history.percentile?.required || 'Selected'} prior-report percentile: ${percent(history.percentile?.value)}.`,
    change.available ? change.explanation : change.reason,
    candidate ? `Candidate company connection: ${candidate.label}. ${candidate.reason} Review the source before concluding exposure.` : 'User-selected market context. No company connection has been established.',
    ...(candidate?.evidence || []).slice(0, 2).flatMap(item => [`SEC ${item.form} filed ${item.filed}: ${item.url}`, `Excerpt: ${item.text}`]),
    ...(asOf ? [`SEC filing cutoff: ${asOf}. The CFTC observation is current context, not information verified as available at that cutoff.`] : []),
    `CFTC source: ${history.source?.url || ''}`,
    `Positioning workspace: https://secedgarterminal.com/market?${query}`,
    'Scope: aggregate futures positions; not the company’s positions, a price forecast, or a scenario shock. SEC financial calculations remain separate.',
  ].join('\n');
}
