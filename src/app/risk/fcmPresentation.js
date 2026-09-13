export function fcmMoney(value, compact = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 2 : 0,
  }).format(value);
}

export function fcmRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}×` : 'Unavailable';
}

export function fcmChange(value, ratio = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'No prior comparison';
  return `${value > 0 ? '+' : ''}${ratio ? `${value.toFixed(2)}×` : fcmMoney(value, true)}`;
}

export function fcmSignals(firm) {
  const signals = [];
  if (typeof firm.excessNetCapital === 'number' && firm.excessNetCapital < 0) signals.push({
    id: 'capital-deficit', level: 'high', title: 'Reported capital deficit',
    detail: `Reported excess net capital is ${fcmMoney(firm.excessNetCapital, true)}. Inspect the official report and subsequent disclosures.`,
  });
  if (typeof firm.changes?.excessNetCapital === 'number' && firm.changes.excessNetCapital < 0) signals.push({
    id: 'cushion-decline', level: firm.changes.excessNetCapitalPct <= -10 ? 'moderate' : 'info', title: 'Capital cushion declined',
    detail: `Excess net capital fell ${fcmMoney(Math.abs(firm.changes.excessNetCapital), true)}${typeof firm.changes.excessNetCapitalPct === 'number' ? ` (${Math.abs(firm.changes.excessNetCapitalPct).toFixed(1)}%)` : ''} from the prior report. Compare the movement in capital with the change in its requirement.`,
  });
  if (typeof firm.capitalCoverage === 'number' && firm.capitalCoverage >= 1 && firm.capitalCoverage < 1.25) signals.push({
    id: 'coverage', level: 'moderate', title: 'Limited headroom over the requirement',
    detail: `Adjusted net capital covers the requirement ${fcmRatio(firm.capitalCoverage)}. The 1.25× review threshold is a site screening convention.`,
  });
  if (typeof firm.customerSegregationExcess === 'number' && firm.customerSegregationExcess < 0) signals.push({
    id: 'segregation-deficit', level: 'high', title: 'Reported customer segregation shortfall',
    detail: `Reported customer assets in segregation are ${fcmMoney(Math.abs(firm.customerSegregationExcess), true)} below the segregation requirement.`,
  });
  if (typeof firm.part30Excess === 'number' && firm.part30Excess < 0) signals.push({
    id: 'part30-deficit', level: 'high', title: 'Reported foreign futures funds shortfall',
    detail: `Section 30.7 customer accounts show a reported deficit of ${fcmMoney(Math.abs(firm.part30Excess), true)}. Review this account category separately from domestic futures and cleared swaps customer accounts.`,
  });
  if (typeof firm.clearedSwapsExcess === 'number' && firm.clearedSwapsExcess < 0) signals.push({
    id: 'cleared-swaps-deficit', level: 'high', title: 'Reported cleared swaps funds shortfall',
    detail: `Cleared swaps customer accounts show a reported deficit of ${fcmMoney(Math.abs(firm.clearedSwapsExcess), true)}. Review this account category separately from domestic and foreign futures customer accounts.`,
  });
  return signals;
}

export function filterFcmFirms(firms, query = '', reviewOnly = false, sort = 'name') {
  const needle = query.trim().toLowerCase();
  return firms.filter(firm => firm.legalName.toLowerCase().includes(needle) && (!reviewOnly || fcmSignals(firm).length > 0))
    .sort((a, b) => {
      if (sort === 'coverage') return compareAvailable(a.capitalCoverage, b.capitalCoverage) || a.legalName.localeCompare(b.legalName);
      if (sort === 'decline') return compareAvailable(a.changes?.excessNetCapitalPct, b.changes?.excessNetCapitalPct) || a.legalName.localeCompare(b.legalName);
      return a.legalName.localeCompare(b.legalName);
    });
}

function compareAvailable(a, b) {
  const availableA = typeof a === 'number' && Number.isFinite(a);
  const availableB = typeof b === 'number' && Number.isFinite(b);
  return availableA && availableB ? a - b : availableA ? -1 : availableB ? 1 : 0;
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  // Spreadsheet applications must not interpret published names as formulas.
  return `"${text.replace(/^[=+@\-]/, match => `'${match}`).replaceAll('"', '""')}"`;
}

export function fcmComparisonCsv(firms, metadata) {
  const customerFields = [
    ['customerSegregationRequired', 'Customer segregation required USD'], ['customerAssetsInSegregation', 'Customer assets in segregation USD'], ['customerSegregationExcess', 'Customer segregation excess USD'],
    ['targetResidualInterest', 'Target residual interest in segregation USD'],
    ['part30Required', 'Section 30.7 customer requirement USD'], ['part30Assets', 'Section 30.7 account funds USD'], ['part30Excess', 'Section 30.7 account excess USD'],
    ['clearedSwapsRequired', 'Cleared swaps customer requirement USD'], ['clearedSwapsAssets', 'Cleared swaps account funds USD'], ['clearedSwapsExcess', 'Cleared swaps account excess USD'],
    ['retailForexObligation', 'Retail forex obligation USD'],
  ];
  const columns = ['Legal entity', 'Report date', 'Prior report date', 'Adjusted net capital USD', 'Requirement USD', 'Excess net capital USD', 'Capital coverage x', 'Prior adjusted net capital USD', 'Prior requirement USD', 'Prior excess net capital USD', 'Prior capital coverage x', 'Excess net capital change USD', 'Excess net capital change %', ...customerFields.map(([, label]) => label), ...customerFields.map(([, label]) => `Prior ${label}`), 'Comparison status', 'Current official source', 'Prior official source', 'Retrieved at'];
  const rows = firms.map(firm => [firm.legalName, firm.reportDate, firm.previous?.reportDate, firm.adjustedNetCapital, firm.netCapitalRequirement, firm.excessNetCapital, firm.capitalCoverage, firm.previous?.adjustedNetCapital, firm.previous?.netCapitalRequirement, firm.previous?.excessNetCapital, firm.previous?.capitalCoverage, firm.changes?.excessNetCapital, firm.changes?.excessNetCapitalPct, ...customerFields.map(([field]) => firm[field]), ...customerFields.map(([field]) => firm.previous?.[field]), firm.comparisonStatus, firm.sourceUrl, firm.previous?.sourceUrl || metadata.source?.reports?.find(report => report.reportDate === firm.previous?.reportDate)?.url, metadata.retrievedAt]);
  return [columns, ...rows].map(row => row.map(value => typeof value === 'number' && Number.isFinite(value) ? String(value) : csvCell(value)).join(',')).join('\r\n');
}
