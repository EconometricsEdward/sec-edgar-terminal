import { CFTC_FAMILIES, CFTC_REPORT_BASIS, cftcDate } from './cftc.js';

// A fixed selection avoids presenting whichever contracts happen to load as the
// macro universe. These are distinct contract/group observations, never a basket.
export const MARKET_MACRO_CONTRACTS = Object.freeze([
  { id: 'rates', category: 'Rates', family: 'tff', code: '043602', group: 'leveraged-funds', label: 'U.S. Treasury 10-Year Note', lens: 'Rates & financing', context: 'Treasury futures positioning provides context for rates and financing conditions.' },
  { id: 'currencies', category: 'Currencies', family: 'tff', code: '099741', group: 'leveraged-funds', label: 'Euro FX', lens: 'Trade & translation', context: 'Currency conditions matter for trade and translated overseas earnings. Euro futures positioning supplies one lens, not a broad dollar measure or exchange-rate forecast.' },
  { id: 'equities', category: 'Equity indices', family: 'tff', code: '13874A', group: 'leveraged-funds', label: 'E-mini S&P 500', lens: 'Broad equity exposure', context: 'Index futures show reported derivatives exposure, including possible hedges.' },
  { id: 'energy', category: 'Energy', family: 'disaggregated', code: '067651', group: 'managed-money', label: 'WTI Physical Crude Oil', lens: 'Energy costs', context: 'Crude oil is relevant to transport, production costs, and energy-sector conditions.' },
  { id: 'metals', category: 'Metals', family: 'disaggregated', code: '088691', group: 'managed-money', label: 'Gold', lens: 'Precious-metals exposure', context: 'Gold positioning adds a precious-metals lens; it is not a measure of inflation expectations.' },
  { id: 'agriculture', category: 'Agriculture', family: 'disaggregated', code: '002602', group: 'managed-money', label: 'Corn', lens: 'Food and feed costs', context: 'Corn is relevant to food, feed, and agricultural costs; one contract is not a food-price index.' },
]);

export const MARKET_MACRO_FAMILIES = Object.freeze(['tff', 'disaggregated']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? value : null;
const decimal = value => value.toLocaleString('en-US', { maximumFractionDigits: 1 });

function reportMatches(snapshot, family) {
  return snapshot?.report_family === family && snapshot.report_basis === CFTC_REPORT_BASIS
    && cftcDate(snapshot.report_date) === snapshot.report_date && Array.isArray(snapshot.latest);
}

function observationSource(family, code, reportDate) {
  if (!reportDate) return null;
  const url = new URL(CFTC_FAMILIES[family].sourceUrl);
  url.searchParams.set('$where', `cftc_contract_market_code = '${code}' AND report_date_as_yyyy_mm_dd = '${reportDate}T00:00:00.000' AND futonly_or_combined = 'FutOnly'`);
  url.searchParams.set('$limit', '10');
  return url.toString();
}

function snapshotMeta(snapshot, family) {
  const valid = reportMatches(snapshot, family);
  const freshness = valid ? snapshot.freshness : null;
  return {
    family, label: CFTC_FAMILIES[family].shortLabel,
    valid, reportDate: valid ? snapshot.report_date : null,
    retrievedAt: valid && typeof snapshot.retrieved_at === 'string' ? snapshot.retrieved_at : null,
    sourceAgeDays: number(freshness?.source_report_age_days),
    aged: freshness?.source_currency === 'aged',
    stale: valid && (snapshot.status === 'stale' || String(freshness?.cache_status || '').startsWith('stale')),
    partial: valid && snapshot.status === 'partial',
    warning: valid && typeof snapshot.refresh_warning === 'string' ? snapshot.refresh_warning : '',
    documentationUrl: CFTC_FAMILIES[family].documentationUrl,
  };
}

export function macroPositioningDescription(netPctOi, weeklyChange) {
  if (!finite(netPctOi)) return 'Positioning unavailable in this report.';
  const position = netPctOi > 0 ? 'Net long' : netPctOi < 0 ? 'Net short' : 'Long and short positions are balanced';
  if (!finite(weeklyChange)) return `${position}. Comparable weekly change unavailable.`;
  if (weeklyChange === 0) return `${position}; net share was unchanged over one week.`;
  return `${position}; net share ${weeklyChange > 0 ? 'rose' : 'fell'} ${decimal(Math.abs(weeklyChange))} pp over one week.`;
}

/** Build a dated display model using only the two already prepared COT snapshots. */
export function buildMarketMacroPositioning(snapshots = {}) {
  const families = MARKET_MACRO_FAMILIES.map(family => snapshotMeta(snapshots[family], family));
  const cards = MARKET_MACRO_CONTRACTS.map(definition => {
    const meta = families.find(item => item.family === definition.family);
    const snapshot = snapshots[definition.family];
    const matches = meta.valid ? snapshot.latest.filter(row => row?.code === definition.code
      && row.family === definition.family && row.reportBasis === CFTC_REPORT_BASIS && row.reportDate === meta.reportDate) : [];
    const row = matches.length === 1 ? matches[0] : null;
    const participant = row?.groups?.[definition.group];
    const openInterest = number(row?.openInterest);
    const groupDefinition = CFTC_FAMILIES[definition.family].groups.find(group => group.id === definition.group);
    const net = number(participant?.net);
    const netPctOi = openInterest > 0 && net !== null ? number(participant?.netPctOi) : null;
    const weeklyChange = netPctOi !== null ? number(participant?.oneWeekNetPctChange) : null;
    return {
      ...definition,
      familyLabel: meta.label,
      groupLabel: groupDefinition.label,
      available: netPctOi !== null,
      hasObservation: Boolean(row),
      reportDate: meta.reportDate,
      aged: meta.aged,
      stale: meta.stale,
      exchange: row?.exchange || null,
      units: row?.units || null,
      net, netPctOi, weeklyChange, openInterest,
      long: number(participant?.long), short: number(participant?.short),
      weeklyNetChange: netPctOi !== null ? number(participant?.oneWeekChange) : null,
      sourceUrl: observationSource(definition.family, definition.code, row?.reportDate),
      description: macroPositioningDescription(netPctOi, weeklyChange),
      view: { tab: 'positioning', cftcFamily: definition.family, cftcContract: definition.code, cftcGroup: definition.group, cftcDate: meta.reportDate || 'latest', cftcDisplay: 'net-oi' },
    };
  });
  const available = cards.filter(card => card.available);
  const comparable = available.filter(card => card.weeklyChange !== null);
  const reportDates = [...new Set(comparable.map(card => card.reportDate))];
  // Different report weeks must never compete for one "weekly move" headline.
  const largestMove = reportDates.length === 1 && comparable.length >= 2
    ? comparable.reduce((largest, card) => Math.abs(card.weeklyChange) > Math.abs(largest.weeklyChange) ? card : largest)
    : null;
  return { cards, families, availableCount: available.length, comparableCount: comparable.length,
    differentReportDates: new Set(families.filter(item => item.valid).map(item => item.reportDate)).size > 1,
    largestMove: largestMove && largestMove.weeklyChange !== 0 ? largestMove : null };
}
