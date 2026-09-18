import { selectFinancialFact } from './xbrlPeriods.js';

// These concepts have an explicit current/noncurrent meaning in the SEC
// taxonomy. LongTermDebt is an including-current total, not noncurrent debt.
const DEBT_FAMILIES = [
  { label: 'Long-term debt and reported lease obligations', lease: true,
    current: 'LongTermDebtAndCapitalLeaseObligationsCurrent',
    noncurrent: 'LongTermDebtAndCapitalLeaseObligations',
    total: 'LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities' },
  { label: 'Long-term debt', lease: false, current: 'LongTermDebtCurrent',
    noncurrent: 'LongTermDebtNoncurrent', total: 'LongTermDebt' },
];

const unavailable = (label) => ({ value: null, label, source: null, sources: [], classification: 'unavailable' });
function instant(facts, tags, period, label) {
  for (const tag of tags) {
    const point = selectFinancialFact(facts, [tag], period, 'USD');
    if (!Number.isFinite(point?.value) || point.value < 0 || point.source?.start || point.source?.end !== period.end) continue;
    return { ...point, label };
  }
  return unavailable(label);
}
function sameContext(points, period) {
  return points.every((point) => Number.isFinite(point?.value) && point.value >= 0
    && point.source?.end === period.end && !point.source?.start && point.source?.unit === 'USD');
}
function commonFilingSources(facts, sources, period) {
  const candidates = sources.map((source) => {
    const entries = facts?.[source.taxonomy]?.[source.tag]?.units?.USD || [];
    return entries.filter((entry) => entry.val === source.value && entry.end === period.end && !entry.start
      && /^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(entry.form || '')
      && /^\d{10}-\d{2}-\d{6}$/.test(entry.accn || '') && (!period.asOf || entry.filed <= period.asOf)
      && (!source.balanceClassification || entry.balanceClassification === source.balanceClassification
        && entry.classificationEvidence?.method === 'balance-sheet-section'
        && typeof entry.classificationEvidence.documentUrl === 'string'
        && entry.classificationEvidence.documentUrl.includes(`/${entry.accn.replaceAll('-', '')}/`)
        && (!source.debtScope || entry.debtScope === source.debtScope && entry.classificationEvidence.separateCurrentMaturitiesFactId)));
  });
  const common = candidates[0]?.filter((entry) => candidates.every((entries) => entries.some((other) => other.accn === entry.accn)))
    .sort((a, b) => (b.filed || '').localeCompare(a.filed || '') || b.accn.localeCompare(a.accn))[0]?.accn;
  if (!common) return null;
  return sources.map((source, index) => {
    const entry = candidates[index].find((candidate) => candidate.accn === common);
    const selected = selectFinancialFact({ [source.taxonomy]: { [source.tag]: { units: { USD: [entry] } } } }, [source.tag], period, 'USD');
    return { ...selected.source, label: source.label,
      ...(source.scopeNote ? { scopeNote: source.scopeNote } : {}),
      ...(source.balanceClassification ? { balanceClassification: entry.balanceClassification,
        classificationEvidence: entry.classificationEvidence, ...(entry.debtScope ? { debtScope: entry.debtScope } : {}) } : {}) };
  });
}
function calculate(facts, points, period, label, formula, operation) {
  if (!sameContext(points, period)) return unavailable(label);
  // A derived balance must be reconciled within one filing, not assembled
  // from an older disclosure and a later revised component.
  let sources = points.flatMap((point) => point.sources.map((source) => ({ ...source, label: source.label || point.label })));
  if (!sources.length || sources.some((source) => !/^\d{10}-\d{2}-\d{6}$/.test(source.accession || ''))) return unavailable(label);
  const accessions = new Set(sources.map((source) => source.accession));
  if (accessions.size !== 1) {
    // Later filings often repeat one historical component but not another.
    // Use an earlier common filing only when it contains every exact selected
    // amount. Never revert a revised amount simply to fill a ratio.
    sources = commonFilingSources(facts, sources, period);
    if (!sources) return unavailable(label);
  }
  const value = operation(...points.map((point) => point.value));
  if (!Number.isFinite(value) || value < 0) return unavailable(label);
  return { value, label, sources, source: { ...sources[0], value, classification: 'calculated', formula },
    classification: 'calculated', formula, observationPeriod: { kind: 'instant', start: null, end: period.end },
    calculations: points.flatMap((point) => [...(point.calculations || []), ...(point.formula
      ? [{ label: point.label, formula: point.formula, value: point.value, end: period.end, start: null, unit: 'USD' }] : [])]),
  };
}

// A generic concept is accepted only when the exact observation has been
// located in the filing's balance-sheet section. A tag name, description,
// company identity, or an investment's contractual maturity is not enough.
export function classifiedRiskBalance(facts, tags, period, classification, label) {
  for (const tag of tags) {
    const point = instant(facts, [tag], period, label);
    if (point.value == null) continue;
    const source = point.source;
    if (!/^\d{10}-\d{2}-\d{6}$/.test(source.accession || '')) continue;
    const raw = facts?.[source.taxonomy]?.[tag]?.units?.USD?.find((entry) =>
      entry.accn === source.accession && entry.end === source.end && !entry.start && entry.val === point.value
      && entry.balanceClassification === classification
      && entry.classificationEvidence?.method === 'balance-sheet-section'
      && typeof entry.classificationEvidence.documentUrl === 'string'
      && new RegExp(`^https://www\\.sec\\.gov/Archives/edgar/data/\\d+/${source.accession.replaceAll('-', '')}/`).test(entry.classificationEvidence.documentUrl));
    if (!raw) continue;
    const verified = { ...source, balanceClassification: classification, classificationEvidence: raw.classificationEvidence,
      ...(raw.debtScope ? { debtScope: raw.debtScope } : {}) };
    return { ...point, source: verified, sources: [verified],
      note: `Classified as ${classification} in the cited filing's balance sheet.` };
  }
  return unavailable(label);
}

export function riskDebtBalances(facts, period) {
  const currentAggregate = instant(facts, ['DebtCurrent'], period, 'Reported current debt');
  const borrowing = instant(facts, ['ShortTermBorrowings'], period, 'Short-term borrowings');
  const notes = classifiedRiskBalance(facts, ['NotesAndLoansPayable'], period, 'current', 'Current notes and loans payable');
  // A current balance could still contain current maturities. Only use it as
  // a separate component when the filing shows a distinct maturities row.
  const classifiedNotes = notes.source?.debtScope === 'short-term-component'
    && notes.source?.classificationEvidence?.separateCurrentMaturitiesFactId
    ? notes : unavailable('Current notes and loans payable');
  const unclassifiedNotes = instant(facts, ['NotesAndLoansPayable'], period, 'Unclassified notes and loans payable');
  const commercialPaper = instant(facts, ['CommercialPaper'], period, 'Commercial paper');
  const otherBorrowings = instant(facts, ['OtherShortTermBorrowings'], period, 'Other short-term borrowings');
  const paperAndOther = calculate(facts, [commercialPaper, otherBorrowings], period, 'Short-term borrowings',
    'Commercial paper + other short-term borrowings', (a, b) => a + b);
  const paperFallback = otherBorrowings.value == null && unclassifiedNotes.value == null
    ? commercialPaper : unavailable('Short-term borrowings');
  const shortTerm = [borrowing, classifiedNotes, paperAndOther, paperFallback].find((point) => point.value != null) || borrowing;
  const families = DEBT_FAMILIES.map((family) => {
    let current = instant(facts, [family.current], period, `Current maturities of ${family.label.toLowerCase()}`);
    let noncurrent = instant(facts, [family.noncurrent], period, `Noncurrent ${family.label.toLowerCase()}`);
    const total = instant(facts, [family.total], period, `${family.label}, including current maturities`);
    const contradictoryTotal = total.value != null && [current, noncurrent].some((point) => point.value != null && point.value > total.value);
    if (noncurrent.value == null) noncurrent = calculate(facts, [total, current], period, `Noncurrent ${family.label.toLowerCase()}`,
      'Long-term amount including current maturities − current maturities', (all, due) => all - due);
    if (current.value == null) current = calculate(facts, [total, noncurrent], period, `Current maturities of ${family.label.toLowerCase()}`,
      'Long-term amount including current maturities − noncurrent amount', (all, later) => all - later);
    const score = noncurrent.value != null && (current.value != null || currentAggregate.value != null) ? 3
      : total.value != null ? 2 : noncurrent.value != null ? 1 : current.value != null ? 0.5 : 0;
    return { ...family, current, noncurrent, total, score, contradictoryTotal };
  }).sort((a, b) => b.score - a.score);
  const family = families[0];
  const current = currentAggregate.value != null ? currentAggregate
    : calculate(facts, [family.current, shortTerm], period, 'Current debt',
      'Current long-term maturities + reported short-term borrowings', (a, b) => a + b);
  const noncurrent = family.noncurrent;
  let total = calculate(facts, [current, noncurrent], period, 'Total debt', 'Current debt + noncurrent debt', (a, b) => a + b);
  if (total.value == null && !family.contradictoryTotal) total = calculate(facts, [family.total, shortTerm], period, 'Total debt',
    'Long-term debt including current maturities + reported short-term borrowings', (a, b) => a + b);
  const scope = family.lease && family.score > 0 ? 'Includes lease obligations within the reported debt concepts.'
    : 'Debt scope follows the reported concepts; current debt may include current lease obligations. Separately reported lease liabilities are not added.';
  return Object.fromEntries(Object.entries({ current, noncurrent, total }).map(([key, point]) => [key,
    { ...point, ...(point.value != null ? { note: scope, sources: point.sources.map((source) => ({ ...source, scopeNote: scope })) } : {}) }]));
}

export function riskMarketableSecurities(facts, period, classification) {
  const tags = classification === 'current'
    ? ['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesCurrent']
    : ['LongTermInvestments', 'MarketableSecuritiesNoncurrent', 'AvailableForSaleSecuritiesNoncurrent'];
  const label = `${classification === 'current' ? 'Current' : 'Noncurrent'} investments`;
  const explicit = instant(facts, tags, period, label);
  const selected = explicit.value != null ? explicit : classifiedRiskBalance(facts, ['MarketableSecurities'], period, classification, label);
  if (selected.value == null) return selected;
  const tag = selected.source.tag;
  const scopeNote = tag === 'ShortTermInvestments' || tag === 'LongTermInvestments'
    ? 'Reported investment total; may include investments other than marketable securities. This is not a cash balance.'
    : 'Reported marketable or available-for-sale securities only; other investments are not inferred or added.';
  return { ...selected, note: scopeNote, sources: selected.sources.map((source) => ({ ...source, scopeNote })) };
}

export function riskLiabilitiesBalance(facts, period) {
  const direct = instant(facts, ['Liabilities'], period, 'Total liabilities');
  if (direct.value != null) return direct;
  // Parent equity excludes NCI; even consolidated permanent equity excludes
  // mezzanine interests. Do not subtract either from assets without a full
  // reconciliation. Explicit current and noncurrent liability totals are safe.
  return calculate(facts, [
    instant(facts, ['LiabilitiesCurrent'], period, 'Current liabilities'),
    instant(facts, ['LiabilitiesNoncurrent'], period, 'Noncurrent liabilities'),
  ], period, 'Total liabilities', 'Current liabilities + noncurrent liabilities', (a, b) => a + b);
}
