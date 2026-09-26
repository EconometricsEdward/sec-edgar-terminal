import { isoDate, PLUMBING_VERSION, allowedSource } from './catalog.js';

const finite = value => value !== null && value !== '' && Number.isFinite(Number(value));
const productName = value => /^total$/i.test(value) ? 'TOTAL' : /^other$/i.test(value) ? 'Other' : value;
export function normalizeRates(data) {
  if (!Array.isArray(data?.refRates) || !data.refRates.length || data.refRates.length > 1600) throw new Error('Invalid reference-rate response');
  const rows = new Map();
  for (const item of data.refRates) {
    if (!['SOFR', 'TGCR', 'BGCR'].includes(item.type)) continue;
    if (!isoDate(item.effectiveDate) || !finite(item.percentRate) || Number(item.percentRate) < -10 || Number(item.percentRate) > 100) throw new Error('Invalid reference-rate observation');
    const row = { date: item.effectiveDate, series: item.type, value: Number(item.percentRate), volume: finite(item.volumeInBillions) ? Number(item.volumeInBillions) : null,
      p1: finite(item.percentPercentile1) ? Number(item.percentPercentile1) : null, p25: finite(item.percentPercentile25) ? Number(item.percentPercentile25) : null,
      p75: finite(item.percentPercentile75) ? Number(item.percentPercentile75) : null, p99: finite(item.percentPercentile99) ? Number(item.percentPercentile99) : null,
      revised: Boolean(item.revisionIndicator) };
    if (row.volume !== null && row.volume < 0) throw new Error('Invalid rate volume');
    const key = `${row.date}:${row.series}`;
    if (rows.has(key)) throw new Error('Duplicate reference-rate observation');
    rows.set(key, row);
  }
  if (!rows.size || !['SOFR', 'BGCR', 'TGCR'].every(s => [...rows.values()].some(r => r.series === s))) throw new Error('Incomplete reference-rate response');
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.series.localeCompare(b.series));
}

export function cleanText(text) {
  return String(text).replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\^\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
}
export function normalizeFails(data) {
  const items = data?.pd?.timeseries;
  if (!Array.isArray(items) || !items.length || items.length > 5000) throw new Error('Invalid primary-dealer response');
  const dates = new Map(), seen = new Set();
  for (const item of items) {
    if (!['PDFTD-USTET', 'PDFTD-UST', 'PDFTR-USTET', 'PDFTR-UST'].includes(item.keyid)) throw new Error('Unexpected primary-dealer series');
    if (!isoDate(item.asofdate)) throw new Error('Invalid primary-dealer date');
    const key = `${item.asofdate}:${item.keyid}`;
    if (seen.has(key)) throw new Error('Duplicate primary-dealer observation');
    seen.add(key);
    const row = dates.get(item.asofdate) || { date: item.asofdate };
    row[item.keyid] = reportedNumber(item.value); dates.set(item.asofdate, row);
  }
  const total = (a, b) => a != null && b != null ? a + b : null;
  return [...dates.values()].map(r => ({ date: r.date, deliver: total(r['PDFTD-USTET'], r['PDFTD-UST']), receive: total(r['PDFTR-USTET'], r['PDFTR-UST']),
    nominalDeliver: r['PDFTD-USTET'] ?? null, tipsDeliver: r['PDFTD-UST'] ?? null, nominalReceive: r['PDFTR-USTET'] ?? null, tipsReceive: r['PDFTR-UST'] ?? null }))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-104);
}
export function reportedNumber(text) {
  const value = cleanText(text).replaceAll(',', '').trim();
  if (!value || ['—', '–', '-', 'N/A', 'NA', '*'].includes(value)) return null;
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`Unrecognized report value: ${value.slice(0, 30)}`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 1e15) throw new Error('Invalid report magnitude');
  return result;
}
/** HTML is treated as inert text. No upstream markup reaches the browser. */
export function reportTables(html) {
  return [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => [...match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => cleanText(cell[1])))
    .filter(row => row.some(Boolean))).filter(table => table.length > 1);
}
export function reportDate(text) {
  const match = cleanText(text).match(/(?:Outstanding|Volume)[\s\S]{0,180}?-\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  const date = match && `${match[3]}-${match[1]}-${match[2]}`;
  if (!isoDate(date)) throw new Error('Missing report period');
  return date;
}
export function normalizeSwapTables({ date, tables, asset, measure }) {
  if (!isoDate(date) || !['rates', 'credit', 'fx'].includes(asset) || !['outstanding', 'volume', 'tickets'].includes(measure)) throw new Error('Invalid swaps identity');
  const observations = [];
  for (const table of tables) {
    const fxHeader = asset === 'fx' && table.find(row => /^Currency Pair\b/i.test(row[0] || ''));
    if (fxHeader) {
      const rows = table.slice(table.indexOf(fxHeader) + 1).filter(row => row.length === fxHeader.length);
      // Hierarchical rows overlap: only these three disjoint top-level groups
      // enter the chart. Regional subtotals and individual pairs are excluded.
      const other = rows.filter(row => /^OTHER$/i.test(row[0])).at(-1);
      for (const row of rows.filter(row => row[0] === 'USD/' || row[0] === 'EUR/non-USD' || row === other)) {
        const bucket = row[0] === 'USD/' ? 'USD pairs' : row[0] === 'EUR/non-USD' ? 'EUR / non-USD' : 'Other pairs';
        fxHeader.slice(1).forEach((product, i) => observations.push({ date, asset, measure, dimension: 'currency', product: productName(product), bucket, value: reportedNumber(row[i + 1]) }));
      }
      continue;
    }
    const header = table.find(row => /^Product\b/i.test(row[0] || ''));
    if (!header) continue;
    const columns = header.slice(1).map(x => cleanText(x));
    // Participant tables contain two cleared/uncleared pairs and double-count
    // counterparties. They must never enter market totals or cleared shares.
    if (new Set(columns).size !== columns.length || !columns.some(x => /^Total$/i.test(x))) continue;
    let dimension;
    if (columns.includes('Cleared') && columns.includes('Uncleared')) dimension = 'clearing';
    else if (columns.includes('USD')) dimension = 'currency';
    else if (columns.some(x => /^0\s*[-–]\s*\d+$/.test(x))) dimension = 'tenor';
    else if (columns.includes('HY') && columns.includes('IG')) dimension = 'grade';
    else continue;
    for (const row of table.slice(table.indexOf(header) + 1)) {
      if (!row[0] || row.length !== header.length || /^\*|includes/i.test(row[0])) continue;
      const product = row[0].replace(/\*+$/, '').trim();
      if (/^product/i.test(product)) continue;
      // Credit tables indent geographic children beneath a product subtotal.
      // HTML/text extraction loses indentation; these are not extra products.
      if (asset === 'credit' && ['Asia','Europe','North America','Other Regions'].includes(product)) continue;
      columns.forEach((bucket, i) => observations.push({ date, asset, measure, dimension, product: productName(product), bucket, value: reportedNumber(row[i + 1]) }));
    }
  }
  const totals = observations.filter(r => r.product === 'TOTAL' && /^total$/i.test(r.bucket));
  if (!totals.some(r => r.dimension === 'clearing') || totals.some(r => r.value === null)) throw new Error('Incomplete swaps tables');
  if (new Set(observations.map(r => `${r.dimension}|${r.product}|${r.bucket}`)).size !== observations.length) throw new Error('Duplicate swaps cells');
  // Preserve small discrepancies in the published tables, including counts.
  const tolerance = 20;
  if (totals.some(r => Math.abs(r.value - totals[0].value) > tolerance)) throw new Error('Inconsistent swaps table totals');
  for (const total of totals) {
    const values = observations.filter(r => r.dimension === total.dimension && r.product === 'TOTAL' && !/^total$/i.test(r.bucket));
    if (values.every(r => r.value !== null) && Math.abs(values.reduce((sum, r) => sum + r.value, 0) - total.value) > tolerance) throw new Error('Swaps breakdown does not reconcile');
  }
  for (const dimension of ['clearing','grade']) {
    const total = totals.find(r => r.dimension === dimension);
    const products = observations.filter(r => r.dimension === dimension && r.product !== 'TOTAL' && r.bucket === 'Total');
    if (total && products.length && products.every(r => r.value !== null) && Math.abs(products.reduce((sum,r) => sum+r.value,0) - total.value) > tolerance) throw new Error('Swaps products do not reconcile');
  }
  return observations;
}
export function parseSwapReport(html, identity) {
  return normalizeSwapTables({ ...identity, date: reportDate(html), tables: reportTables(html) });
}
export function normalizeSwapHistory({ date, tables, measure }) {
  const observations = [];
  for (const table of tables) {
    const header = table.find(row => row.slice(1).length >= 2 && row.slice(1).every(x => /^[A-Za-z]+ \d{1,2}$/.test(x)));
    if (!header) continue;
    const dates = header.slice(1).map(label => {
      let year = Number(date.slice(0, 4)); let d = new Date(`${label} ${year} 12:00:00 GMT`);
      if (d.toISOString().slice(0, 10) > date) d = new Date(`${label} ${--year} 12:00:00 GMT`);
      if (Date.parse(date) - d.getTime() > 45 * 86400000) throw new Error('Invalid history period');
      return d.toISOString().slice(0, 10);
    });
    let asset;
    for (const row of table.slice(table.indexOf(header) + 1)) {
      if (row.length !== header.length || !row[0]) continue;
      const label = row[0].replaceAll('*', '').trim();
      if (/^Total Interest Rate$/i.test(label)) asset = 'rates';
      else if (/^Total Credit$/i.test(label)) asset = 'credit';
      else if (/^Total FX$/i.test(label)) asset = 'fx';
      else if (!['Cleared', 'Uncleared'].includes(label)) { asset = null; continue; }
      if (!asset) continue;
      dates.forEach((d, i) => observations.push({ date: d, asset, measure, dimension: 'clearing', product: 'TOTAL', bucket: /^Total/.test(label) ? 'Total' : label, value: reportedNumber(row[i + 1]) }));
    }
  }
  if (observations.length < 18) throw new Error('Incomplete swaps history');
  if (new Set(observations.map(r => `${r.date}|${r.asset}|${r.bucket}`)).size !== observations.length) throw new Error('Duplicate history observations');
  return observations;
}
export function mergeSwapObservations(previous, reports) {
  const key = r => [r.date, r.asset, r.measure, r.dimension, r.product, r.bucket].join('|');
  const rows = new Map((previous || []).map(r => [key(r), r]));
  const detailed = reports.flat().filter(r => r.product !== 'TOTAL');
  const replaced = new Set(detailed.map(r => [r.date, r.asset, r.measure].join('|')));
  for (const [k, r] of rows) if (replaced.has([r.date, r.asset, r.measure].join('|'))) rows.delete(k);
  for (const list of reports) for (const row of list) rows.set(key(row), row);
  const result = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  const dates = [...new Set(result.map(r => r.date))].slice(-104);
  const detailedDates = dates.slice(-12);
  // Keep two years of aggregate trends and twelve detailed releases. Originals
  // remain archived separately; the browser payload and serving tables are bounded.
  return result.filter(r => dates.includes(r.date) && (detailedDates.includes(r.date) || (r.product === 'TOTAL' && r.dimension === 'clearing')));
}
export function validSnapshot(value, kind) {
  const numeric = v => v === null || (typeof v === 'number' && Number.isFinite(v));
  if (value?.version !== PLUMBING_VERSION || value.kind !== kind || !Number.isFinite(Date.parse(value.generatedAt)) || !Array.isArray(value.sources) || !value.sources.length
    || value.sources.length > 20 || value.sources.some(s => !allowedSource(s.url) || !/^[a-f0-9]{64}$/.test(s.hash) || !Number.isFinite(Date.parse(s.retrievedAt)))) return false;
  if (kind === 'funding') return Array.isArray(value.rates) && value.rates.length >= 3 && value.rates.length <= 1600 && value.rates.every(r => isoDate(r.date) && ['SOFR','TGCR','BGCR'].includes(r.series) && typeof r.value === 'number' && numeric(r.value) && numeric(r.volume))
    && Array.isArray(value.fails) && value.fails.length <= 104 && value.fails.every(r => isoDate(r.date) && numeric(r.deliver) && numeric(r.receive));
  return kind === 'derivatives' && Array.isArray(value.observations) && value.observations.length > 0 && value.observations.length <= 12000 && value.observations.every(r => isoDate(r.date) && ['rates','credit','fx'].includes(r.asset) && ['outstanding','volume','tickets'].includes(r.measure)
    && ['clearing','currency','tenor','grade'].includes(r.dimension) && typeof r.product === 'string' && r.product.length <= 80 && typeof r.bucket === 'string' && r.bucket.length <= 80 && numeric(r.value) && (r.value === null || r.value >= 0) && /^[a-f0-9]{64}$/.test(r.sourceHash))
    && ['rates','credit','fx'].every(asset => ['outstanding','volume','tickets'].every(measure => value.observations.some(r => r.asset === asset && r.measure === measure && r.product === 'TOTAL' && r.dimension === 'clearing' && r.bucket === 'Total' && r.value !== null)));
}
