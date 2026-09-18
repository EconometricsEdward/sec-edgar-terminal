/** Presentation only: keep every SEC note measure and its denominator separate. */
export const EXPOSURE_INSTRUMENT_GROUPS = [
  { id: 'interest_rate', label: 'Interest rates', description: 'Rate contracts and their reported designations.' },
  { id: 'foreign_exchange', label: 'Currencies', description: 'Currency contracts and their reported designations.' },
  { id: 'cross_currency', label: 'Currency & rates', description: 'Cross-currency interest-rate contracts carry both currency and rate terms. Each reported amount appears once.' },
  { id: 'credit', label: 'Credit derivatives', description: 'Credit derivatives, including purchased and sold protection.' },
  { id: 'commodity', label: 'Commodities', description: 'Commodity-linked swaps, options, futures and forwards.' },
  { id: 'other', label: 'Other & aggregate', description: 'Other instrument types and amounts reported without an instrument-class breakdown.' },
];

const finite = value => typeof value === 'number' && Number.isFinite(value);
const validValue = fact => finite(fact?.value) && fact.value >= 0;
const validSignedValue = fact => finite(fact?.value);
const hierarchyValue = row => (row.dimensions || []).some(d => /:FairValueByFairValueHierarchyLevelAxis$/.test(d.axis));
const fairValueOrder = row => {
  const members = (row.dimensions || []).map(d => d.member.split(':').at(-1));
  if (members.includes('FairValueDisclosureItemAmountsDomain')) return 0;
  if (members.includes('EffectOfCounterpartyNettingMember')) return 1;
  if (members.includes('EffectOfCollateralNettingMember')) return 2;
  if (members.includes('CarryingReportedAmountFairValueDisclosureMember')) return 3;
  return 4;
};
const instrumentClass = row => {
  // Classify the reported instrument itself, not a customer's name or credit grade.
  const identity = (row.dimensions || [])
    .filter(dimension => /DerivativeInstrument(?:Risk|Type)Axis$/.test(dimension.axis || ''))
    .map(dimension => `${dimension.member} ${dimension.label}`).join(' ').replace(/[^a-z]/gi, '').toLowerCase();
  if (/crosscurrencyinterestrate/.test(identity)) return 'cross_currency';
  if (row.category === 'interest_rate' || row.category === 'foreign_exchange') return row.category;
  if (/foreignexchange|currency(?:contract|swap|forward|option)/.test(identity)) return 'foreign_exchange';
  if (/interestrate/.test(identity)) return 'interest_rate';
  if (/creditdefault|creditderivative|credit(?:risk)?contract/.test(identity)) return 'credit';
  if (/commodit/.test(identity)) return 'commodity';
  return 'other';
};

/** Compact typography, without dropping dimensions that distinguish measures. */
export function compactInstrumentLabel(row) {
  const pieces = String(row.label || 'Reported measure').split(' · ').map(piece => piece.trim()).filter(Boolean);
  const unique = pieces.filter((piece, index) => !pieces.slice(0, index).includes(piece));
  return unique.map(piece => piece
    .replace(/^Fair Value Disclosure Item Amounts Domain$/, 'Total fair value')
    .replace(/^Carrying Reported Amount Fair Value Disclosure$/, 'Reported carrying value')
    .replace(/^Effect Of Counterparty Netting$/, 'Counterparty netting')
    .replace(/^Effect Of Collateral Netting$/, 'Collateral netting')
    .replace(/^Fair Value Inputs Level\s*([123])$/, 'Level $1')
    .replace(/^Credit Default Swap\s*(?:·\s*)?/i, 'CDS ')
    .replace(/\bCredit Default Swap\b/gi, 'CDS')
    .replace(/\bBuying Protection\b/gi, 'Protection bought')
    .replace(/\bSelling Protection\b/gi, 'Protection sold')
    .replace(/\bNot designated as accounting hedges\b/gi, 'No hedge-accounting designation')
    .replace(/\bFuture And Forward\b/gi, 'Futures & forwards')
    .replace(/\bInternal Noninvestment Grade\b/gi, 'Internal non-investment grade')
    .replace(/\bInternal Investment Grade\b/gi, 'Internal investment grade').trim())
    .join(' · ').replace(/^CDS · CDS /, 'CDS · ');
}

export function buildExposureInstrumentGroups(input) {
  const rows = (Array.isArray(input) ? input : []).filter(row => {
    const valid = row?.kind === 'derivative_fair_value' ? validSignedValue : validValue;
    return row && valid(row.current) && (!row.prior || valid(row.prior));
  });
  const derivatives = rows.filter(row => row.kind === 'derivative_notional' && row.unit === 'USD');
  const groups = EXPOSURE_INSTRUMENT_GROUPS.map(group => ({ ...group, kind: 'derivative', rows: derivatives.filter(row => instrumentClass(row) === group.id) }))
    .filter(group => group.rows.length);
  const fairValues = rows.filter(row => row.kind === 'derivative_fair_value' && row.unit === 'USD'
    && ['derivative_asset', 'derivative_liability'].includes(row.category));
  if (fairValues.length) groups.push({ id: 'fair-values', label: 'Fair values & netting',
    description: 'Reported derivative values and the adjustments used in their balance-sheet presentation.', kind: 'fair_value', rows: fairValues,
    balances: [false, true].flatMap(hierarchy => [['derivative_asset', 'Derivative assets'], ['derivative_liability', 'Derivative liabilities']]
      .map(([category, label]) => ({ id: `${category}:${hierarchy ? 'hierarchy' : 'reported'}`, label: `${label}${hierarchy ? ' · Valuation hierarchy' : ''}`,
        rows: fairValues.filter(row => row.category === category && hierarchyValue(row) === hierarchy)
          .sort((a, b) => fairValueOrder(a) - fairValueOrder(b) || Math.abs(b.current.value) - Math.abs(a.current.value)) })))
      .filter(balance => balance.rows.length) });
  const concentrations = rows.filter(row => row.kind === 'credit_concentration' && row.unit === 'pure' && row.current.value <= 1 && (!row.prior || row.prior.value <= 1));
  const balances = new Map();
  for (const row of concentrations) {
    const benchmark = (row.dimensions || []).find(dimension => /ConcentrationRiskByBenchmarkAxis$/.test(dimension.axis || ''));
    const id = `concentration:${benchmark?.member || row.id}`;
    if (!balances.has(id)) balances.set(id, { id, label: benchmark?.label || 'Reported credit balance', rows: [] });
    balances.get(id).rows.push(row);
  }
  if (concentrations.length) groups.push({ id: 'concentrations', label: 'Credit concentrations', description: 'Counterparty shares of the reported credit balance.', kind: 'concentration', rows: concentrations, balances: [...balances.values()] });
  // Sorting changes display order only. Totals and components are never combined.
  for (const group of groups) group.rows = group.rows.slice().sort((a, b) => Math.abs(b.current.value) - Math.abs(a.current.value) || String(a.label).localeCompare(String(b.label)));
  for (const balance of balances.values()) balance.rows = balance.rows.slice().sort((a, b) => b.current.value - a.current.value || String(a.label).localeCompare(String(b.label)));
  return groups;
}

/** Signed fair-value offsets extend left of zero; notionals and shares stay nonnegative. */
export function instrumentComparisonScale(rows, concentration = false) {
  const values = rows.flatMap(row => [row.current.value, row.prior?.value ?? 0]);
  const minimum = concentration ? 0 : Math.min(0, ...values);
  const maximum = concentration ? 1 : Math.max(0, ...values);
  const span = maximum - minimum || 1;
  const position = value => (value - minimum) / span * 100;
  return { minimum, maximum, zero: position(0),
    bar: value => ({ left: `${position(Math.min(0, value))}%`, width: `${Math.abs(value) / span * 100}%` }) };
}
