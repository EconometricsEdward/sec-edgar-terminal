import { QUANT_GROUPS, QUANT_BATCHES, QUANT_TARGET_ISSUERS } from './quantGroups.js';

export const EXPANDED_MEMBERSHIP_VERSION = 'fund-sec-directory-2';
export const SEC_MEMBERSHIP_URL = 'https://www.sec.gov/files/company_tickers.json';
const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

/** Directory membership is a candidate list, not proof of usable financial data. */
export function isQuantMembership(value) {
  if (!value || !['fund-holdings-1', EXPANDED_MEMBERSHIP_VERSION].includes(value.version)
    || !Number.isFinite(Date.parse(value.checked_at)) || !Array.isArray(value.rows)
    || value.rows.length < 1450 || value.rows.length > QUANT_TARGET_ISSUERS || value.issuers !== value.rows.length
    || value.version === 'fund-holdings-1' && value.rows.length > 1600
    || value.batches !== QUANT_BATCHES || !Number.isSafeInteger(value.securities) || value.securities < value.issuers
    || !Array.isArray(value.sources) || !value.sources.length
    || !value.sources.every(source => typeof source.fund === 'string' && Number.isFinite(Date.parse(source.as_of))
      && typeof source.url === 'string' && source.url.startsWith('https://') && Number.isSafeInteger(source.securities) && source.securities >= (source.fund === 'SEC' ? 0 : 1))) return false;
  if (value.excluded_candidates !== undefined && (!Array.isArray(value.excluded_candidates) || value.excluded_candidates.length > 10000
    || new Set(value.excluded_candidates.map(row => row?.cik)).size !== value.excluded_candidates.length
    || value.excluded_candidates.some(row => !/^\d{10}$/.test(row?.cik) || Number(row.cik) === 0
      || !Number.isFinite(Date.parse(row.checked_at)) || typeof row.reason !== 'string' || row.reason.length > 240))) return false;
  const ciks = new Set(), aliases = new Set();
  for (const row of value.rows) {
    if (!TICKER.test(row.ticker) || !/^\d{10}$/.test(row.cik) || Number(row.cik) === 0 || ciks.has(row.cik)
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 1000
      || !QUANT_GROUPS.some(group => group.label === row.sector) || !['IVV', 'IJH', 'IJR', 'SEC'].includes(row.fund)
      || !Array.isArray(row.aliases) || !row.aliases.includes(row.ticker) || !row.aliases.length
      || new Set(row.aliases).size !== row.aliases.length
      || row.aliases.some(alias => !TICKER.test(alias) || aliases.has(alias))) return false;
    ciks.add(row.cik);
    for (const alias of row.aliases) aliases.add(alias);
  }
  const baseline = value.rows.filter(row => row.fund !== 'SEC').length;
  const expectedSources = new Map(MEMBERSHIP_SOURCES.map(source => [source.fund, source.url]));
  if (value.version === EXPANDED_MEMBERSHIP_VERSION) expectedSources.set('SEC', SEC_MEMBERSHIP_URL);
  return value.securities === aliases.size && baseline >= 1450 && baseline <= 1600
    && value.sources.length === expectedSources.size
    && new Set(value.sources.map(source => source.fund)).size === expectedSources.size
    && value.sources.every(source => expectedSources.get(source.fund) === source.url);
}

/** Preserve fund-defined coverage, then stable SEC issuer identities up to 5,000. */
export function buildExpandedMembership(baseline, directory, previous = baseline, now = new Date(), {
  excludedCandidates = previous.excluded_candidates || [], directoryFetchedAt = now.toISOString(),
} = {}) {
  if (!isQuantMembership(baseline) || !directory || typeof directory !== 'object') throw new Error('Coverage inputs are incomplete.');
  const directoryAge = now.getTime() - Date.parse(directoryFetchedAt);
  if (!Number.isFinite(directoryAge) || directoryAge < 0 || directoryAge >= 7 * 86400000) throw new Error('SEC directory source timestamp is unavailable or expired.');
  const excluded = new Set(excludedCandidates.map(row => row.cik));
  const byCik = new Map();
  for (const [ticker, company] of Object.entries(directory)) {
    if (!TICKER.test(ticker) || !/^\d{1,10}$/.test(String(company?.cik)) || Number(company.cik) <= 0
      || typeof company.name !== 'string' || !company.name.trim()) continue;
    const cik = String(company.cik).padStart(10, '0');
    if (!byCik.has(cik)) byCik.set(cik, { cik, name: company.name, aliases: [] });
    byCik.get(cik).aliases.push(ticker);
  }
  if (byCik.size < QUANT_TARGET_ISSUERS) throw new Error('SEC directory is incomplete; prior membership retained.');
  const selected = new Map(), preferredByCik = new Map(previous.rows.map(row => [row.cik, row.ticker]));
  for (const row of baseline.rows.filter(row => row.fund !== 'SEC')) {
    const aliases = row.aliases.filter(alias => String(directory[alias]?.cik).padStart(10, '0') === row.cik);
    if (!aliases.length)
      throw new Error(`SEC identity for ${row.ticker} could not be revalidated; prior membership retained.`);
    selected.set(row.cik, { ...row, ticker: aliases.includes(row.ticker) ? row.ticker : aliases[0], aliases });
  }
  const add = candidate => {
    if (!candidate || excluded.has(candidate.cik) || selected.has(candidate.cik) || selected.size >= QUANT_TARGET_ISSUERS) return;
    const preferred = preferredByCik.get(candidate.cik);
    const aliases = [...candidate.aliases].sort((a, b) => a.length - b.length || a.localeCompare(b));
    selected.set(candidate.cik, { ticker: aliases.includes(preferred) ? preferred : aliases[0], cik: candidate.cik,
      name: candidate.name, aliases, sector: 'Unclassified', fund: 'SEC' });
  };
  // Existing supplemental members retain their place; new entries follow SEC
  // directory order. No inferred market-cap ranking or index membership.
  for (const row of previous.rows) add(byCik.get(row.cik));
  for (const candidate of byCik.values()) add(candidate);
  const rows = [...selected.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const supplemental = rows.filter(row => row.fund === 'SEC').reduce((sum, row) => sum + row.aliases.length, 0);
  const sources = [...baseline.sources.filter(source => source.fund !== 'SEC'),
    { fund: 'SEC', label: 'SEC directory candidates; financial eligibility checked separately', as_of: directoryFetchedAt.slice(0, 10), retrieved_at: directoryFetchedAt, url: SEC_MEMBERSHIP_URL, securities: supplemental }];
  const result = { version: EXPANDED_MEMBERSHIP_VERSION, checked_at: now.toISOString(), sources,
    securities: rows.reduce((sum, row) => sum + row.aliases.length, 0), issuers: rows.length, batches: QUANT_BATCHES, rows,
    ...(excludedCandidates.length ? { excluded_candidates: excludedCandidates } : {}) };
  if (!isQuantMembership(result)) throw new Error('Expanded membership failed SEC identity validation.');
  return result;
}

/** Unsupported candidates leave room for new identities, with a bounded 30-day memory. */
export function quantExcludedCandidates(previous, entries, records, now = Date.now()) {
  const baseline = new Set(previous.rows.filter(row => row.fund !== 'SEC').map(row => row.cik));
  const excluded = new Map();
  const retain = row => {
    const age = now - Date.parse(row?.checked_at);
    if (!row || baseline.has(row.cik) || !Number.isFinite(age) || age < 0 || age >= 30 * 86400000) return;
    excluded.set(row.cik, row);
  };
  for (const row of previous.excluded_candidates || []) retain(row);
  entries.forEach((entry, index) => {
    const record = records[index];
    // A transient error or an old failed request never evicts a valid company.
    if (entry.fund === 'SEC' && !record?.company && record?.eligibility === 'unsupported')
      retain({ cik: entry.cik, checked_at: record.checkedAt, reason: String(record.reason || 'Unsupported SEC financial reporting data.').slice(0, 240) });
  });
  return [...excluded.values()].sort((a, b) => b.checked_at.localeCompare(a.checked_at) || a.cik.localeCompare(b.cik)).slice(0, 10000);
}

/** Source outages may retain dated classifications, never make them look new. */
export function retainedQuantBaseline(previous, now = Date.now()) {
  if (!isQuantMembership(previous)) throw new Error('Prior membership is not a valid fallback.');
  const sources = previous.sources.filter(source => source.fund !== 'SEC');
  if (sources.some(source => now - Date.parse(source.as_of) < 0 || now - Date.parse(source.as_of) > 30 * 86400000))
    throw new Error('Prior fund classifications exceed their retention window.');
  const rows = previous.rows.filter(row => row.fund !== 'SEC');
  return { version: 'fund-holdings-1', checked_at: previous.checked_at, sources, issuers: rows.length,
    securities: rows.reduce((sum, row) => sum + row.aliases.length, 0), batches: QUANT_BATCHES, rows };
}

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
