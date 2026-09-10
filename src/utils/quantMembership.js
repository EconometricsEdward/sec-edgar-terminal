import { QUANT_GROUPS, QUANT_BATCHES } from './quantGroups.js';

export const MEMBERSHIP_SOURCES = [
  { fund: 'IVV', label: 'Large cap', min: 475, max: 550, url: 'https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv' },
  { fund: 'IJH', label: 'Mid cap', min: 375, max: 450, url: 'https://www.ishares.com/us/products/239763/ishares-core-s-p-mid-cap-etf/latest-holdings.csv' },
  { fund: 'IJR', label: 'Small cap', min: 575, max: 650, url: 'https://www.ishares.com/us/products/239774/ishares-core-s-p-small-cap-etf/latest-holdings.csv' },
];

export function parseHoldingsCsv(text, source, now = Date.now()) {
  // CSV quoted cells can contain commas and doubled quotes, including issuer names.
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) { row.push(cell.replace(/\r$/, '')); cell = ''; if (c === '\n') { rows.push(row); row = []; } }
    else cell += c;
  }
  if (quoted) throw new Error(`${source.fund}: incomplete holdings CSV.`);
  if (cell || row.length) rows.push([...row, cell]);
  const dated = rows.find(r => r[0]?.includes('Fund Holdings as of'));
  const date = Date.parse(dated?.[1]);
  if (!Number.isFinite(date) || date > now || now - date > 14 * 86400000) throw new Error(`${source.fund}: missing or stale holdings date.`);
  const asOf = new Date(date).toISOString().slice(0, 10);
  const header = rows.findIndex(r => r[0] === 'Ticker' && r.includes('Asset Class'));
  if (header < 0) throw new Error(`${source.fund}: holdings header missing.`);
  const names = rows[header], index = key => names.indexOf(key), found = new Map();
  const last=rows.slice(header+1).filter(r=>r.length===names.length).at(-1);
  if(!last||last[index('Asset Class')]==='Equity')throw new Error(`${source.fund}: holdings tail is incomplete.`);
  for (const r of rows.slice(header + 1)) {
    if (r[index('Asset Class')] !== 'Equity' || !r[index('Exchange')] || /^(NO MARKET|-$)/i.test(r[index('Exchange')])) continue;
    const ticker = r[0]?.trim().toUpperCase().replace(/[ .]/g, '-');
    if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(ticker)) continue;
    if (found.has(ticker)) continue;
    const sector = r[index('Sector')], group = QUANT_GROUPS.find(g => g.label === sector);
    if (!group) throw new Error(`${source.fund}: unsupported sector ${sector}.`);
    found.set(ticker, { ticker, name: r[index('Name')], sector, fund: source.fund, as_of: asOf });
  }
  if (found.size < source.min || found.size > source.max) throw new Error(`${source.fund}: unexpected listed-equity count ${found.size}.`);
  return { fund: source.fund, as_of: asOf, url: source.url, securities: found.size, rows: [...found.values()] };
}

export function buildMembership(holdings, directory, preferred = [], now = new Date()) {
  const issuers = new Map(), unresolved = [];
  for (const source of holdings) for (const row of source.rows) {
    const entry = directory[row.ticker];
    if (!entry?.cik) { unresolved.push(row.ticker); continue; }
    const cik = String(entry.cik).padStart(10, '0');
    const existing = issuers.get(cik);
    if (existing) {
      existing.aliases.push(row.ticker);
      if (preferred.includes(row.ticker) && !preferred.includes(existing.ticker)) existing.ticker = row.ticker;
    } else issuers.set(cik, { ticker: row.ticker, cik, name: entry.name || row.name, sector: row.sector, fund: row.fund, aliases: [row.ticker] });
  }
  if (unresolved.length) throw new Error(`Unresolved SEC mappings: ${unresolved.join(', ')}. Prior membership retained.`);
  const rows = [...issuers.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (rows.length < 1450 || rows.length > 1600) throw new Error('Coverage membership is incomplete.');
  const sources = holdings.map(({ fund, as_of, url, securities }) => ({ fund, as_of, url, securities }));
  return { version: 'fund-holdings-1', checked_at: now.toISOString(), sources, securities: sources.reduce((n, s) => n + s.securities, 0), issuers: rows.length, batches: QUANT_BATCHES, rows };
}
