import { extractCompanyInlineFacts } from './riskNoteFacts.js';

export const COMPANY_CONCENTRATIONS_VERSION = 'company-concentrations-v1';
const REVENUE = ['RevenuesNetOfInterestExpense', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'Revenues', 'SalesRevenueNet'];
const LOANS = ['FinancingReceivableExcludingAccruedInterestBeforeAllowanceForCreditLoss', 'FinancingReceivableRecordedInvestmentExcludingAccruedInterestBeforeAllowanceForCreditLoss', 'FinancingReceivableRecordedInvestmentBeforeAllowanceForCreditLoss', 'LoansAndLeasesReceivableNetReportedAmount', 'FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss', 'LoansAndLeasesReceivableNetOfDeferredIncome'];
const FUNDING = ['Liabilities', 'Deposits', 'DepositsDomestic', 'DepositsForeign', 'NoninterestBearingDepositLiabilities', 'InterestBearingDepositLiabilities', 'DebtCurrent', 'LongTermDebtCurrent', 'LongTermDebtNoncurrent', 'LongTermDebt', 'LongTermDebtAndFinanceLeaseObligationsCurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent', 'ShortTermBorrowings', 'OtherShortTermBorrowings', 'CommercialPaper', 'SecuritiesSoldUnderAgreementsToRepurchase', 'FederalFundsPurchasedAndSecuritiesSoldUnderAgreementsToRepurchase', 'PayablesToBrokerDealersAndClearingOrganizations', 'PayablesToCustomers', 'SecuritiesSoldNotYetPurchasedAtFairValue'];
export const CONCENTRATION_CONCEPTS = new Set([...REVENUE, ...LOANS, ...FUNDING]);
const local = tag => String(tag || '').split(':').at(-1);
const days = (start, end) => start ? (Date.parse(end) - Date.parse(start)) / 86400000 + 1 : 0;
const tolerance = value => Math.max(Math.abs(value) * 0.001, 1);
const cleanLabel = label => String(label).replace(/ Segment$/, '').replace(/I Phone/g, 'iPhone').replace(/I Pad/g, 'iPad').replace(/Homeand/g, 'Home and').replace(/^Service$/, 'Services').replace(/^Non Us$/, 'Outside the U.S.').replace(/^US$/, 'United States').replace(/Noninterest/g, 'Noninterest').replace(/ Of /g, ' of ').replace(/ And /g, ' and ');
const periodLabel = fact => fact.start ? `${days(fact.start, fact.end) < 115 ? 'Quarter' : days(fact.start, fact.end) < 330 ? 'Year to date' : 'Fiscal year'} ended ${fact.end}` : `At ${fact.end}`;
const rankDuration = (fact, basis) => basis === 'annual' ? (days(fact.start, fact.end) >= 330 && days(fact.start, fact.end) <= 400 ? 0 : 9)
  : days(fact.start, fact.end) >= 70 && days(fact.start, fact.end) <= 115 ? 0 : days(fact.start, fact.end) < 330 ? 1 : 2;
const samePeriod = (a, b) => a.start === b.start && a.end === b.end;
const factRow = (fact, label, denominator = null) => ({ id: fact.id, label: cleanLabel(label), value: fact.value, share: denominator?.value > 0 && fact.value >= 0 && fact.value <= denominator.value ? fact.value / denominator.value : null, fact });

/** Each displayed series varies one dimension; every additional dimension is
 * fixed within its own group. Consolidated percentages require an exact tag,
 * period and unit match. No differently scoped observations are added. */
function dimensionGroups(facts, concepts, end, basis, kind) {
  const grouped = new Map();
  for (const fact of facts) {
    if (!concepts.includes(fact.concept) || fact.end !== end || !fact.dimensions.length) continue;
    if (kind === 'revenue' && (fact.periodType !== 'duration' || rankDuration(fact, basis) > 2)) continue;
    if (kind === 'credit' && fact.periodType !== 'instant') continue;
    for (const dimension of fact.dimensions) {
      const axis = local(dimension.axis);
      const eligible = kind === 'revenue' ? /^(?:ProductOrService|StatementBusinessSegments|StatementGeographical|Geographical|GeographicAreas|Country|Countries|BusinessSegments|ReportableSegments|OperatingSegments)Axis$/.test(axis)
        : /^(?:FinancingReceivablePortfolioSegment|FinancingReceivableRecordedInvestmentByClassOfFinancingReceivable|GeographicDistribution|Industry|FinancingReceivableIndustry)Axis$/.test(axis);
      if (!eligible) continue;
      // Credit quality (rating, delinquency, impairment) and maturity axes are
      // not portfolio classes; they are intentionally outside this mix view.
      if (kind === 'credit' && /PastDue|CreditQuality|Status|Rating|Year|Maturity|Vintage|Collateral|Impairment/i.test(axis)) continue;
      const fixed = fact.dimensions.filter(d => d !== dimension);
      if (fixed.length && !fixed.every(d => kind === 'credit' ? /^(?:FinancingReceivablePortfolioSegment|FinancingReceivableRecordedInvestmentByClassOfFinancingReceivable)Axis$/.test(local(d.axis)) : local(d.axis) === 'ConsolidationItemsAxis' && local(d.member) === 'OperatingSegmentsMember')) continue;
      const key = JSON.stringify([fact.concept, dimension.axis, fixed.map(d => [d.axis, d.member]), fact.start, fact.end]);
      if (!grouped.has(key)) grouped.set(key, { key, concept: fact.concept, axis: dimension.axis, fixed, start: fact.start, end: fact.end, facts: [] });
      grouped.get(key).facts.push({ fact, dimension });
    }
  }
  const groups = [];
  for (const group of grouped.values()) {
    const requiredDimensions = kind === 'credit' ? group.fixed : [];
    const denominator = facts.find(f => f.concept === group.concept && JSON.stringify(f.dimensions.map(d => [d.axis, d.member])) === JSON.stringify(requiredDimensions.map(d => [d.axis, d.member])) && samePeriod(f, group));
    let members = group.facts;
    // ProductMember is an explicit aggregate. Suppress it only when the
    // detailed product rows reconcile and services plus products match total.
    const products = members.find(({ dimension }) => dimension.member === 'us-gaap:ProductMember');
    const services = members.find(({ dimension }) => dimension.member === 'us-gaap:ServiceMember');
    if (products && services && denominator) {
      const detail = members.filter(member => member !== products && member !== services);
      if (detail.length && Math.abs(detail.reduce((sum, member) => sum + member.fact.value, 0) - products.fact.value) <= tolerance(products.fact.value)
        && Math.abs(products.fact.value + services.fact.value - denominator.value) <= tolerance(denominator.value)) members = members.filter(member => member !== products);
    }
    const nonUs = members.find(({ dimension }) => dimension.member === 'us-gaap:NonUsMember');
    const us = members.find(({ dimension }) => local(dimension.member) === 'US' || local(dimension.member) === 'UnitedStatesMember');
    if (nonUs && us && denominator) {
      const detail = members.filter(member => member !== nonUs && member !== us);
      if (detail.length && Math.abs(detail.reduce((sum, member) => sum + member.fact.value, 0) - nonUs.fact.value) <= tolerance(nonUs.fact.value)
        && Math.abs(nonUs.fact.value + us.fact.value - denominator.value) <= tolerance(denominator.value)) members = members.filter(member => member !== nonUs);
    }
    if (members.length < 2) continue;
    const axis = local(group.axis);
    const label = kind === 'credit' ? /Geograph/.test(axis) ? 'Loan geography' : /Class/.test(axis) ? 'Loan categories' : 'Loan portfolio' : /ProductOrService/.test(axis) ? 'Products & services' : /Geograph|Countr/.test(axis) ? 'Geography' : 'Business segments';
    const rows = members.map(({ fact, dimension }) => factRow(fact, dimension.label, denominator)).sort((a, b) => b.value - a.value);
    const sum = rows.reduce((total, row) => total + row.value, 0);
    const reconciles = denominator?.value > 0 && rows.every(row => row.value >= 0) && Math.abs(sum - denominator.value) <= tolerance(denominator.value);
    groups.push({ id: group.key, concept: group.concept, kind, label, period: periodLabel(members[0].fact), start: group.start, end: group.end, rows, denominator: denominator || null,
      denominatorLabel: kind === 'revenue' ? group.concept === 'RevenuesNetOfInterestExpense' ? 'Revenue, net of interest expense' : 'Reported revenue' : group.fixed.length ? cleanLabel(group.fixed.map(d => d.label).join(' · ')) : 'Reported loan balance',
      reconciles, scope: group.fixed.map(d => d.label).join(' · '), note: reconciles ? 'Displayed amounts reconcile to the reported total.' : 'Reported categories can overlap. Percentages use the named total; categories are not added.' });
  }
  // Prefer broad bank revenue over fee-only contract revenue and a quarter
  // over YTD when the latest filing supplies both. Separate axes stay separate.
  return groups.sort((a, b) => concepts.indexOf(a.concept) - concepts.indexOf(b.concept) || rankDuration(a, basis) - rankDuration(b, basis) || a.scope.length - b.scope.length || b.rows.length - a.rows.length)
    .filter((group, index, sorted) => sorted.findIndex(other => other.label === group.label && other.scope === group.scope) === index)
    .slice(0, 8);
}

function fundingGroup(facts, end) {
  const instant = facts.filter(f => f.end === end && f.periodType === 'instant' && !f.dimensions.length);
  const pick = concepts => concepts.map(concept => instant.find(f => f.concept === concept)).find(Boolean);
  const total = pick(['Liabilities']);
  const deposit = pick(['Deposits']);
  const rows = [];
  const add = (concepts, label) => { const fact = pick(concepts); if (fact && fact.value >= 0) rows.push(factRow(fact, label, total)); return fact; };
  if (deposit) add(['Deposits'], 'Deposits');
  const aggregateCurrent = pick(['DebtCurrent']);
  if (aggregateCurrent) add(['DebtCurrent'], 'Current borrowings');
  else {
    add(['ShortTermBorrowings', 'OtherShortTermBorrowings', 'CommercialPaper'], pick(['ShortTermBorrowings', 'OtherShortTermBorrowings']) ? 'Short-term borrowings' : 'Commercial paper');
    add(['LongTermDebtCurrent', 'LongTermDebtAndFinanceLeaseObligationsCurrent'], 'Current portion of long-term debt');
  }
  add(['LongTermDebtNoncurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent', 'LongTermDebt'], pick(['LongTermDebtNoncurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent']) ? 'Noncurrent long-term debt' : 'Long-term debt, reported total');
  add(['FederalFundsPurchasedAndSecuritiesSoldUnderAgreementsToRepurchase', 'SecuritiesSoldUnderAgreementsToRepurchase'], pick(['FederalFundsPurchasedAndSecuritiesSoldUnderAgreementsToRepurchase']) ? 'Fed funds & repurchase agreements' : 'Repurchase agreements');
  add(['PayablesToCustomers'], 'Customer payables');
  add(['PayablesToBrokerDealersAndClearingOrganizations'], 'Broker & clearing payables');
  if (!rows.length) return null;
  rows.sort((a, b) => b.value - a.value);
  const first = rows[0].fact;
  return { id: 'funding', kind: 'funding', label: deposit ? 'Deposit & borrowing exposure' : 'Borrowing & funding exposure', period: periodLabel(first), start: null, end,
    denominator: total || null, denominatorLabel: 'Total liabilities', rows, reconciles: false,
    note: 'Shares compare each reported funding balance with total liabilities. Balances can overlap and are not summed; this is not a maturity schedule.' };
}

export function buildCompanyConcentrations(facts, { filing, basis = 'ttm' }) {
  if (!filing) return { revenue: [], funding: null, credit: [] };
  return { revenue: dimensionGroups(facts, REVENUE, filing.reportDate, basis, 'revenue'), funding: fundingGroup(facts, filing.reportDate), credit: dimensionGroups(facts, LOANS, filing.reportDate, basis, 'credit') };
}
export const extractConcentrationFacts = (html, options) => extractCompanyInlineFacts(html, { ...options, concepts: CONCENTRATION_CONCEPTS });
