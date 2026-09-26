import { bankRssd } from './catalog.js';

export const ORGANIZATION_VERSION = 'bankscope-organization-1';
export const NIC_ABOUT = 'https://www.ffiec.gov/npw/Home/About';
export const NIC_REPORTS = 'https://www.ffiec.gov/npw/FinancialReport/FinancialDataDownload';
export const FDIC_DEFINITIONS = 'https://api.fdic.gov/banks/docs/institutions_definitions.csv';
export const nicProfile = rssd => `https://www.ffiec.gov/npw/Institution/Profile/${bankRssd(rssd)}`;
const text = value => typeof value === 'string' ? value.trim().slice(0, 300) : '';
const id = value => /^[1-9]\d{0,9}$/.test(String(value)) ? Number(value) : null;
const count = value => value !== '' && value != null && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function organizationDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value));
  const date = match ? `${match[3]}-${match[1]}-${match[2]}` : /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? value : null;
  if (!date || date.startsWith('9999') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return null;
  return date;
}

/** FDIC disseminates the NIC regulatory TOP holder; this is not a direct-parent edge. */
export function organizationProfile(raw, rssd) {
  if (id(raw?.FED_RSSD) !== bankRssd(rssd) || !id(raw?.CERT) || !text(raw?.NAME) || Number(raw.ACTIVE) !== 1) throw new Error('Institution identity mismatch');
  const parentId = id(raw.RSSDHCR), parentName = text(raw.NAMEHCR);
  const parent = parentId && parentId !== Number(rssd) && parentName ? {
    rssd: parentId, name: parentName, city: text(raw.CITYHCR), state: text(raw.STALPHCR),
    relationship: 'regulatory_top_holder', reportedAt: organizationDate(raw.REPDTE), nicUrl: nicProfile(parentId),
  } : null;
  return {
    rssd: Number(rssd), name: text(raw.NAME), cert: id(raw.CERT), city: text(raw.CITY), state: text(raw.STALP),
    active: Number(raw.ACTIVE) === 1, form: ['31', '41', '51'].includes(String(raw.CALLFORM)) ? String(raw.CALLFORM).padStart(3, '0') : null,
    lei: /^[A-Z0-9]{20}$/.test(raw.LEI || '') ? raw.LEI : null,
    established: organizationDate(raw.ESTYMD), insuredSince: organizationDate(raw.INSDATE),
    recordUpdated: organizationDate(raw.DATEUPDT), snapshotDate: organizationDate(raw.RUNDATE),
    offices: { total: count(raw.OFFICES), domestic: count(raw.OFFDOM), foreign: count(raw.OFFFOR) },
    parent, parentStatus: parent ? 'reported' : 'not_reported',
    nicUrl: nicProfile(rssd), fdicUrl: `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${id(raw.CERT)}`,
    formerNames: [...new Set(Array.from({ length: 5 }, (_, i) => text(raw[`PRIORNAME${i + 1}`])).filter(name => name && name.toUpperCase() !== text(raw.NAME).toUpperCase()))],
  };
}

/** Name candidates are discovery aids, never an RSSD-to-CIK crosswalk. */
export function organizationName(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    .replace(/\bBCORP\b/g, 'BANCORP').replace(/\bBSHRS\b/g, 'BANCSHARES').replace(/\bFINL\b/g, 'FINANCIAL').replace(/\bHLDGS\b/g, 'HOLDINGS')
    .replace(/\/[A-Z]{2}\/?$/, '').replace(/&/g, ' AND ').replace(/\bCORPORATION\b/g, 'CORP')
    .replace(/\bCOMPANY\b/g, 'CO').replace(/\bINCORPORATED\b/g, 'INC').replace(/[^A-Z0-9]/g, '');
}
export function parentSecCandidates(parent, directory) {
  if (!parent || directory?.stale || !directory?.data) return [];
  const name = organizationName(parent.name), matches = new Map();
  for (const [ticker, entry] of Object.entries(directory.data)) {
    if (organizationName(entry.name) !== name || !/^(?!0{10})\d{10}$/.test(entry.cik) || !/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(ticker)) continue;
    const match = matches.get(entry.cik) || { cik: entry.cik, name: entry.name, tickers: [] };
    match.tickers.push(ticker); matches.set(entry.cik, match);
  }
  return [...matches.values()].slice(0, 5).map(m => ({ ...m, tickers: m.tickers.sort((a, b) => a.length - b.length || a.localeCompare(b)) }));
}

export function organizationPeers(rows, parentRssd, selectedRssd) {
  const seen = new Set();
  return rows.map(raw => {
    const rssd = id(raw.FED_RSSD);
    if (!rssd || seen.has(rssd) || id(raw.RSSDHCR) !== parentRssd || Number(raw.ACTIVE) !== 1 || !text(raw.NAME)) throw new Error('Invalid related institution');
    seen.add(rssd);
    return { rssd, name: text(raw.NAME), cert: id(raw.CERT), city: text(raw.CITY), state: text(raw.STALP),
      selected: rssd === selectedRssd, eligible: ['31', '41', '51'].includes(String(raw.CALLFORM)),
      reportedAt: organizationDate(raw.REPDTE), nicUrl: nicProfile(rssd) };
  }).sort((a, b) => Number(b.selected) - Number(a.selected) || a.name.localeCompare(b.name));
}

export function organizationOffices(rows, cert) {
  const seen = new Set(), regions = new Map();
  for (const raw of rows) {
    const office = id(raw.UNINUM);
    if (!office || seen.has(office) || id(raw.CERT) !== cert) throw new Error('Invalid office identity');
    seen.add(office);
    const region = /^[A-Z]{2}$/.test(raw.STALP || '') ? raw.STALP : 'Unreported';
    regions.set(region, (regions.get(region) || 0) + 1);
  }
  return { total: rows.length, regions: [...regions].map(([region, offices]) => ({ region, offices })).sort((a, b) => b.offices - a.offices || a.region.localeCompare(b.region)) };
}
