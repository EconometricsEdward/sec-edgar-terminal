import { validFinancialPeriodDates } from './financialPeriodDates.js';
import { extractRefinancingProfile, MATURITY_BUCKETS } from './refinancing/maturities.js';
import { compactRefinancingProfile, isRefinancingProfile } from './refinancing/projection.js';

export const RISK_MATURITY_HISTORY_LIMIT = 3;
const annualForms = new Set(['10-K', '20-F', '40-F']);
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
const normalizeCik = value => /^\d{1,10}$/.test(String(value ?? '')) && Number(value) > 0
  ? String(value).padStart(10, '0') : null;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const prefix = 'LongTermDebtMaturitiesRepaymentsOfPrincipal';
const concepts = new Set([
  ...MATURITY_BUCKETS.flatMap(bucket => [prefix + bucket.suffix, prefix + bucket.rollingSuffix]),
  'CashAndCashEquivalentsAtCarryingValue', 'NetCashProvidedByUsedInOperatingActivities',
  'OperatingIncomeLoss', 'InterestExpense', 'InterestExpenseNonoperating',
]);

/** The additive timeline projection is reusable only in the current issuer's
 * existing cache slot. An empty supported projection is valid coverage, while
 * absent, oversized, amended or temporally conflicting history is not. */
export function hasRiskMaturityHistory(data) {
  const cik = normalizeCik(data?.cik), history = data?.refinancingHistory;
  if (!cik || !Array.isArray(history) || history.length > RISK_MATURITY_HISTORY_LIMIT) return false;
  const accessions = new Set();
  return history.every((profile, index) => {
    if (!isRefinancingProfile(profile, cik) || profile.status !== 'ready' || !annualForms.has(profile.form)
      || !validFinancialPeriodDates({ end: profile.asOf, filed: profile.filedAt })
      || accessions.has(profile.accession)) return false;
    accessions.add(profile.accession);
    const previous = history[index - 1];
    return !previous || previous.asOf < profile.asOf && previous.filedAt <= profile.filedAt;
  });
}

function originalAnnualFilings(submissions, cik, cutoff) {
  const recent = submissions?.filings?.recent;
  if (normalizeCik(submissions?.cik) !== cik || !Array.isArray(recent?.accessionNumber)
    || !['form', 'filingDate', 'reportDate', 'primaryDocument'].every(key => Array.isArray(recent[key])
      && recent[key].length === recent.accessionNumber.length)) return [];
  const filings = new Map(), conflicts = new Set();
  recent.accessionNumber.forEach((accession, index) => {
    const form = recent.form[index], filed = recent.filingDate[index], end = recent.reportDate[index];
    const primaryDoc = recent.primaryDocument[index];
    if (!annualForms.has(form) || !accessionPattern.test(accession || '')
      || !validFinancialPeriodDates({ end, filed }) || !filed || filed > cutoff
      || typeof primaryDoc !== 'string' || primaryDoc.length > 240
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(primaryDoc)) return;
    const filing = { accession, form, filed, end, primaryDoc,
      documentUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${primaryDoc}` };
    const previous = filings.get(accession);
    if (previous && (previous.form !== form || previous.filed !== filed || previous.end !== end
      || previous.primaryDoc !== primaryDoc)) conflicts.add(accession);
    else filings.set(accession, filing);
  });
  // An original report repeated in the manifest is harmless. If multiple
  // original reports claim the same year, retain its earliest available report;
  // later originals and amendments cannot silently restate the comparison.
  const years = new Map();
  [...filings.values()].filter(filing => !conflicts.has(filing.accession))
    .sort((a, b) => a.filed.localeCompare(b.filed) || a.accession.localeCompare(b.accession))
    .forEach(filing => { if (!years.has(filing.end)) years.set(filing.end, filing); });
  return [...years.values()].sort((a, b) => b.end.localeCompare(a.end));
}

function exactFilingFacts(companyfacts, filing, cik) {
  const taxonomy = companyfacts.facts['us-gaap'], facts = {};
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.accession.replaceAll('-', '')}/${filing.accession}-index.html`;
  for (const tag of concepts) {
    const rows = taxonomy[tag]?.units?.USD;
    if (!Array.isArray(rows)) continue;
    const selected = rows.filter(row => record(row) && row.accn === filing.accession
      && row.end === filing.end && row.filed === filing.filed && row.form === filing.form
      && (row.sourceCik == null || normalizeCik(row.sourceCik) === cik)
      && (row.cik == null || normalizeCik(row.cik) === cik)
      && ['documentUrl', 'sourceUrl', 'url'].every(key => row[key] == null || typeof row[key] === 'string'
        && [filing.documentUrl, indexUrl].includes(row[key].split('#')[0])));
    if (selected.length) facts[tag] = { units: { USD: selected } };
  }
  return { cik, facts: { 'us-gaap': facts } };
}

/** A bounded projection of original registrant schedules already in companyfacts.
 * The SEC recent manifest verifies the report identity before each extraction.
 * A historical cutoff alone is insufficient: later reports can contain old
 * comparative schedules. Exact accession, form, filing date and report end are
 * required, and no missing bucket is backfilled from a different report.
 *
 * No network, archive expansion, predecessor join or durable history is added.
 * Each result is the existing compact six-bucket USD refinancing schema.
 */
export function buildRiskMaturityHistory(companyfacts, submissions, options = {}) {
  const cik = normalizeCik(options.cik ?? companyfacts?.cik);
  const cutoff = options.asOf || new Date().toISOString().slice(0, 10);
  const maxAgeDays = options.maxAgeDays ?? 730;
  if (!cik || normalizeCik(companyfacts?.cik) !== cik || normalizeCik(submissions?.cik) !== cik
    || !record(companyfacts?.facts?.['us-gaap']) || !validFinancialPeriodDates({ end: cutoff })
    || !Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 730) return [];
  const history = [];
  for (const filing of originalAnnualFilings(submissions, cik, cutoff)) {
    const profile = compactRefinancingProfile(extractRefinancingProfile(exactFilingFacts(companyfacts, filing, cik), {
      cik, sic: options.sic ?? submissions.sic, financialInstitution: options.financialInstitution,
      sector: options.sector, asOf: filing.filed, maxAgeDays,
    }));
    if (profile?.status !== 'ready' || profile.asOf !== filing.end || profile.accession !== filing.accession
      || profile.filedAt !== filing.filed || profile.form !== filing.form || !isRefinancingProfile(profile, cik)) continue;
    // A delayed earlier-year report filed after a newer year's report is not
    // before-and-after evidence of what was available at those filing dates.
    if (history.length && profile.filedAt > history.at(-1).filedAt) continue;
    history.push(profile);
    if (history.length === RISK_MATURITY_HISTORY_LIMIT) break;
  }
  return history.reverse();
}
