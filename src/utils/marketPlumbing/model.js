import { ASSETS, MEASURES } from './catalog.js';

export function parsePlumbingView(search = '', kind = 'funding') {
  const p = new URLSearchParams(search);
  return { kind, range: ['1m', '3m', '1y'].includes(p.get('range')) ? p.get('range') : '3m',
    asset: Object.hasOwn(ASSETS, p.get('asset')) ? p.get('asset') : 'rates',
    measure: Object.hasOwn(MEASURES, p.get('measure')) ? p.get('measure') : 'volume',
    product: (p.get('product') || 'TOTAL').slice(0, 80), date: /^\d{4}-\d{2}-\d{2}$/.test(p.get('date') || '') ? p.get('date') : '' };
}
export function plumbingPath(view) {
  const p = new URLSearchParams();
  if (view.kind === 'funding') { if (view.range !== '3m') p.set('range', view.range); }
  else { if (view.asset !== 'rates') p.set('asset', view.asset); if (view.measure !== 'volume') p.set('measure', view.measure); if (view.product !== 'TOTAL') p.set('product', view.product); if (view.date) p.set('date', view.date); }
  return `/market/${view.kind}${p.size ? `?${p}` : ''}`;
}
export function fundingSeries(snapshot, range = '3m') {
  const grouped = new Map();
  for (const r of snapshot.rates) {
    const row = grouped.get(r.date) || { date: r.date };
    row[r.series] = r.value;
    if (r.series === 'SOFR') Object.assign(row, { volume: r.volume, p1: r.p1, p25: r.p25, p75: r.p75, p99: r.p99 });
    grouped.set(r.date, row);
  }
  const all = [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
  const last = all.at(-1);
  const cutoff = Date.parse(last?.date) - ({ '1m': 31, '3m': 93, '1y': 366 }[range] || 93) * 86400000;
  return { rates: all.filter(r => Date.parse(r.date) >= cutoff).map(r => ({ ...r, spread: r.SOFR != null && r.TGCR != null ? Math.round((r.SOFR - r.TGCR) * 10000) / 100 : null })),
    fails: snapshot.fails.filter(r => Date.parse(r.date) >= cutoff), latest: last, prior: all.at(-2) };
}
export function swapView(snapshot, view) {
  const rows = snapshot.observations.filter(r => r.asset === view.asset && r.measure === view.measure);
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const date = dates.includes(view.date) ? view.date : dates.at(-1);
  const period = rows.filter(r => r.date === date);
  const products = [...new Set(period.filter(r => r.dimension === 'clearing').map(r => r.product))].filter(p => p !== 'TOTAL');
  const product = products.includes(view.product) ? view.product : 'TOTAL';
  const selected = period.filter(r => r.product === product);
  const number = (dimension, bucket) => selected.find(r => r.dimension === dimension && r.bucket === bucket)?.value ?? null;
  const total = number('clearing', 'Total'), cleared = number('clearing', 'Cleared'), uncleared = number('clearing', 'Uncleared');
  const buckets = dimension => selected.filter(r => r.dimension === dimension && r.bucket !== 'Total').map(r => ({ name: r.bucket, value: r.value }));
  const trend = dates.map(d => ({ date: d, value: rows.find(r => r.date === d && r.product === product && r.dimension === 'clearing' && r.bucket === 'Total')?.value ?? null }));
  const composition = products.map(p => ({ name: p, value: period.find(r => r.dimension === 'clearing' && r.product === p && r.bucket === 'Total')?.value ?? null }));
  const previous = trend.filter(r => r.date < date && r.value !== null).at(-1);
  return { date, dates, products, product, total, cleared, uncleared, share: total > 0 && cleared !== null ? cleared / total * 100 : null,
    currency: buckets('currency'), tenor: buckets('tenor'), grade: buckets('grade'), composition, trend,
    change: previous?.value > 0 && total !== null ? (total / previous.value - 1) * 100 : null, previousDate: previous?.date || null };
}
export function compactNumber(value, measure = 'volume', digits = 2) {
  if (value == null || !Number.isFinite(value)) return '—';
  const dollars = measure !== 'tickets';
  const n = dollars ? value * 1e6 : value;
  const abs = Math.abs(n), scale = abs >= 1e12 ? 1e12 : abs >= 1e9 ? 1e9 : abs >= 1e6 ? 1e6 : abs >= 1e3 ? 1e3 : 1;
  const suffix = { 1: '', 1000: 'K', 1000000: 'M', 1000000000: 'B', 1000000000000: 'T' }[scale];
  return `${dollars ? '$' : ''}${(n / scale).toLocaleString('en-US', { maximumFractionDigits: digits })}${suffix}`;
}
export function snapshotAge(snapshot, now = Date.now()) {
  // Swaps have an intentional publication lag of about 2.5 weeks. Freshness
  // refers to successful source checks; the reporting period stays separate.
  return now - Date.parse(snapshot.generatedAt) > 48 * 3600000;
}
