import { SEC_EVIDENCE_CONTINUITY } from './secEvidenceContinuity.js';
import { extractCompanyInlineFacts, extractInlineFilingIdentity, verifiesJointRegistrantFacts, RISK_NOTE_MAX_BYTES } from './riskNoteFacts.js';
import { reportingPeriods } from './xbrlPeriods.js';

const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const normalizeCik = value => /^\d{1,10}$/.test(String(value || '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const key = row => JSON.stringify([row.start || null, row.end, row.accn, row.filed, row.form]);
// Existing company-facts concepts are also accepted. These additional standard
// concepts cover fields that may first appear in a newly filed primary document.
const CORE_CONCEPTS = new Set(`Assets Liabilities LiabilitiesCurrent LiabilitiesNoncurrent LiabilitiesAndStockholdersEquity StockholdersEquity StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest RetainedEarningsAccumulatedDeficit AssetsCurrent CashAndCashEquivalentsAtCarryingValue Cash CashAndDueFromBanks RestrictedCashAndCashEquivalents CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents MarketableSecurities MarketableSecuritiesCurrent MarketableSecuritiesNoncurrent AvailableForSaleSecuritiesCurrent AvailableForSaleSecuritiesNoncurrent AvailableForSaleDebtSecuritiesCurrent AvailableForSaleDebtSecuritiesNoncurrent TradingSecuritiesCurrent TradingSecuritiesNoncurrent ShortTermInvestments OtherShortTermInvestments DebtCurrent LongTermDebtCurrent LongTermDebtNoncurrent LongTermDebt ShortTermBorrowings CommercialPaper NotesAndLoansPayable LongTermDebtAndFinanceLeaseObligationsCurrent LongTermDebtAndFinanceLeaseObligationsNoncurrent LongTermDebtAndCapitalLeaseObligationsCurrent LongTermDebtAndCapitalLeaseObligations LongTermDebtAndFinanceLeaseObligations Revenues RevenueFromContractWithCustomerExcludingAssessedTax RevenueFromContractWithCustomerIncludingAssessedTax SalesRevenueNet SalesRevenueGoodsNet RevenuesNetOfInterestExpense OperatingLeaseLeaseIncome InterestIncomeExpenseNet NoninterestIncome OperatingIncomeLoss InterestExpense InterestAndDebtExpense InterestExpenseDebt IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments IncomeTaxExpenseBenefit NetIncomeLoss ProfitLoss NetCashProvidedByUsedInOperatingActivities NetCashProvidedByUsedInInvestingActivities NetCashProvidedByUsedInFinancingActivities PaymentsToAcquirePropertyPlantAndEquipment PaymentsOfDividends InterestPaidNet InterestPaid AccountsReceivableNetCurrent ReceivablesNetCurrent InventoryNet PropertyPlantAndEquipmentNet Goodwill IntangibleAssetsNetExcludingGoodwill CostOfRevenue CostOfGoodsAndServicesSold CostOfGoodsSold CostOfServices SellingGeneralAndAdministrativeExpense DepreciationDepletionAndAmortization DepreciationAmortizationAndAccretionNet DepreciationAndAmortization Depreciation Deposits LoansAndLeasesReceivableNetReportedAmount FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss`.split(' '));

export function latestRiskProfileFiling(submissions, cik, today) {
  const recent = submissions?.filings?.recent;
  if (normalizeCik(submissions?.cik) !== cik || !Array.isArray(recent?.accessionNumber)
    || !['form', 'filingDate', 'reportDate', 'primaryDocument'].every(name => Array.isArray(recent[name]) && recent[name].length === recent.accessionNumber.length)) return null;
  return recent.accessionNumber.flatMap((accession, index) => {
    const form = recent.form[index], filed = recent.filingDate[index], reportDate = recent.reportDate[index], primaryDoc = recent.primaryDocument[index];
    if (!['10-K', '10-Q'].includes(form) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)
      || !date(filed) || !date(reportDate) || filed > today || reportDate > filed
      || !/^[\w][\w.-]*\.html?$/i.test(primaryDoc || '')) return [];
    return [{ accession, form, filed, reportDate, primaryDoc, url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${primaryDoc}` }];
  }).sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.filed.localeCompare(a.filed))[0] || null;
}

/** Preserve the current legal identity and exact values; join only the reviewed
 * registry's pre-transition history. No ticker/name matching or value rebasing. */
export function mergeRiskProfileCompanyFacts(sources, { cik, today }) {
  const transition = SEC_EVIDENCE_CONTINUITY[cik], merged = {};
  for (const source of sources) {
    const sourceCik = normalizeCik(source?.cik);
    const current = sourceCik === cik;
    if (!sourceCik || (!current && (!transition || transition.source.filed > today || !transition.predecessorCiks.includes(sourceCik)))) continue;
    for (const [taxonomy, concepts] of Object.entries(source.facts || {})) {
      if (!['us-gaap', 'ifrs-full', 'srt'].includes(taxonomy) || !concepts || typeof concepts !== 'object') continue;
      const target = (merged[taxonomy] ||= {});
      for (const [tag, concept] of Object.entries(concepts)) {
        if (!concept?.units || typeof concept.units !== 'object') continue;
        const prior = target[tag], units = { ...(prior?.units || {}) };
        for (const [unit, values] of Object.entries(concept.units)) {
          const observations = new Map((units[unit] || []).map(row => [JSON.stringify([key(row), row.val]), row]));
          for (const row of Array.isArray(values) ? values : []) {
            if (!date(row.end) || !date(row.filed) || row.filed > today || !Number.isFinite(row.val)
              || (!current && row.end >= transition.effectiveDate)) continue;
            const identity = JSON.stringify([key(row), row.val]);
            if (!observations.has(identity)) observations.set(identity, { ...row, sourceCik });
          }
          units[unit] = [...observations.values()];
        }
        target[tag] = { ...concept, ...prior, units };
      }
    }
  }
  return merged;
}

const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/&#(?:160|x0*a0);|&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Generic concepts do not encode maturity. Annotate only visible facts inside
 * an explicitly headed balance-sheet section bounded by its tagged subtotal.
 * The amount, context, issuer and namespace were already verified by the parser.
 * Nested tables, hidden rows and ambiguous IDs are deliberately excluded. */
export function classifyInlineBalanceFacts(html, rows) {
  const result = new Map(), tables = [], stack = [];
  for (const match of html.matchAll(/<\/?table\b[^>]*>/gi)) {
    if (/^<\//.test(match[0])) {
      const top = stack.pop();
      if (top && !top.nested) tables.push(html.slice(top.start, match.index + match[0].length));
    } else { if (stack.length) stack.at(-1).nested = true; stack.push({ start: match.index, nested: false }); }
  }
  const classifiedConcepts = new Set(['MarketableSecurities', 'NotesAndLoansPayable', 'Assets', 'Liabilities', 'LiabilitiesAndStockholdersEquity',
    'AssetsCurrent', 'LiabilitiesCurrent', 'LongTermDebtCurrent', 'LongTermDebtAndFinanceLeaseObligationsCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent']);
  const counts = new Map();
  for (const match of html.matchAll(/<[A-Za-z][^>]*\bid\s*=\s*["']([\w.-]+)["'][^>]*>/g)) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  const selected = rows.filter(row => classifiedConcepts.has(row.concept) && !row.dimensions.length && !row.start && row.factId
    && /^[\w.-]+$/.test(row.factId) && counts.get(row.factId) === 1);
  for (const table of tables) {
    if (!selected.some(row => ['MarketableSecurities', 'NotesAndLoansPayable'].includes(row.concept) && new RegExp(`\\bid\\s*=\\s*["']${escape(row.factId)}["']`).test(table))) continue;
    if (/display\s*:\s*none|visibility\s*:\s*hidden|<ix:hidden\b|\shidden(?:\s|=|>)/i.test(table)) continue;
    const tableRows = [...table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi)].map(match => match[0]);
    const positions = new Map();
    for (const fact of selected) {
      const id = new RegExp(`\\bid\\s*=\\s*["']${escape(fact.factId)}["']`, 'g');
      const hits = tableRows.flatMap((row, index) => [...row.matchAll(id)].map(() => index));
      if (hits.length === 1) positions.set(fact.factId, hits[0]);
    }
    if (!selected.some(row => row.concept === 'Assets' && positions.has(row.factId))
      || !selected.some(row => ['LiabilitiesAndStockholdersEquity', 'Liabilities'].includes(row.concept) && positions.has(row.factId))) continue;
    for (const fact of selected.filter(row => ['MarketableSecurities', 'NotesAndLoansPayable'].includes(row.concept))) {
      const index = positions.get(fact.factId);
      if (index == null) continue;
      const section = fact.concept === 'MarketableSecurities' ? 'assets' : 'liabilities';
      for (const classification of ['current', 'noncurrent']) {
        const heading = classification === 'current' ? new RegExp(`^current ${section}\\s*:?$`, 'i') : new RegExp(`^non[ -]?current ${section}\\s*:?$`, 'i');
        const prior = tableRows.slice(0, index).findLastIndex(row => heading.test(plain(row)));
        if (prior < 0) continue;
        const subtotal = classification === 'current' ? section === 'assets' ? 'AssetsCurrent' : 'LiabilitiesCurrent' : section === 'assets' ? 'Assets' : 'Liabilities';
        const end = selected.find(row => row.concept === subtotal && row.end === fact.end && positions.get(row.factId) > index);
        if (!end) continue;
        const boundary = tableRows.slice(prior + 1, index).some(row => /^(?:total\s+)?(?:non[ -]?)?current (?:assets|liabilities)\s*:?$/i.test(plain(row)));
        if (boundary) continue;
        const evidence = { balanceClassification: classification, classificationEvidence: { documentUrl: fact.sourceUrl, method: 'balance-sheet-section', factId: fact.factId, section: `${classification} ${section}`, subtotalFactId: end.factId } };
        // Generic notes payable may include current maturities. Treat it as
        // the separate short-term component only when a distinct current-term
        // debt row is reported inside this same classified liability section.
        if (fact.concept === 'NotesAndLoansPayable' && classification === 'current') {
          const maturities = selected.find(row => ['LongTermDebtCurrent', 'LongTermDebtAndFinanceLeaseObligationsCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent'].includes(row.concept)
            && row.end === fact.end && positions.get(row.factId) > prior && positions.get(row.factId) < positions.get(end.factId)
            && positions.get(row.factId) !== index && !/\b(?:including|of which|included in)\b/i.test(plain(tableRows[positions.get(row.factId)])));
          if (maturities) { evidence.debtScope = 'short-term-component'; evidence.classificationEvidence.separateCurrentMaturitiesFactId = maturities.factId; }
        }
        if (result.has(fact.id) && result.get(fact.id)?.balanceClassification !== classification) result.set(fact.id, null);
        else result.set(fact.id, evidence);
      }
    }
  }
  return result;
}

export function supplementRiskProfileFacts(facts, html, { cik, filing, factCik = cik }) {
  if (html.length > RISK_NOTE_MAX_BYTES) throw new Error('Filing exceeds bounded parser size.');
  const identity = extractInlineFilingIdentity(html, { cik: factCik, filing });
  if (!identity || (filing.form === '10-K' ? identity.fiscalPeriod !== 'FY' : !['Q1', 'Q2', 'Q3'].includes(identity.fiscalPeriod)))
    throw new Error('The filing identity and fiscal period could not be verified.');
  const concepts = new Set([...CORE_CONCEPTS, ...Object.keys(facts?.['us-gaap'] || {})]);
  const parsed = extractCompanyInlineFacts(html, { cik: factCik, filing, concepts, reconcilePrecision: true });
  const rows = parsed.rows.filter(row => !row.dimensions.length);
  const classifications = classifyInlineBalanceFacts(html, rows);
  const target = { ...facts, 'us-gaap': { ...(facts['us-gaap'] || {}) } };
  let addedFacts = 0, classifiedFacts = 0;
  for (const row of rows) {
    const concept = target['us-gaap'][row.concept] || {};
    const observations = [...(concept.units?.USD || [])];
    const observation = { ...(row.start ? { start: row.start } : {}), end: row.end, val: row.value, accn: filing.accession, filed: filing.filed, form: filing.form,
      fy: identity.fiscalYear, fp: identity.fiscalPeriod, sourceCik: cik, sourceType: 'inline-filing', documentUrl: row.sourceUrl, factId: row.factId,
      ...(classifications.get(row.id) || {}) };
    const existing = observations.findIndex(value => key(value) === key(observation));
    if (existing >= 0) {
      // SEC companyfacts is authoritative if its same-filing amount disagrees.
      if (observations[existing].val !== observation.val) continue;
      observations[existing] = { ...observations[existing], ...(classifications.get(row.id) || {}), sourceCik: cik, sourceType: 'inline-filing', documentUrl: row.sourceUrl, factId: row.factId };
    } else { observations.push(observation); addedFacts++; }
    if (classifications.get(row.id)) classifiedFacts++;
    target['us-gaap'][row.concept] = { ...concept, units: { ...concept.units, USD: observations } };
  }
  const latestPeriod = reportingPeriods(target, filing.form === '10-K' ? 'annual' : 'quarter')
    .some(period => period.end === filing.reportDate && period.accession === filing.accession);
  if (!latestPeriod) throw new Error('No consolidated financial reporting anchor matched the filing period.');
  return { facts: target, addedFacts, classifiedFacts, rows: rows.length };
}

/** One latest primary document at most. Failure retains valid company-facts
 * evidence and exposes the gap; it never replaces the latest date with a guess. */
export async function prepareRiskProfileSources({ cik, company, submissions, now = new Date(), signal }, { loadCompanyFacts, loadFiling }) {
  cik = normalizeCik(cik);
  if (!cik || normalizeCik(company?.cik) !== cik || normalizeCik(submissions?.cik) !== cik) throw new Error('The risk profile issuer identity could not be verified.');
  const today = new Date(now).toISOString().slice(0, 10), transition = SEC_EVIDENCE_CONTINUITY[cik];
  const continuity = { status: 'not-applicable', currentCik: cik, predecessorCiks: [], sourceUrl: null, effectiveDate: null };
  const sources = [company], notices = [];
  if (transition && transition.source.filed <= today) {
    Object.assign(continuity, { status: 'partial', predecessorCiks: [...transition.predecessorCiks], sourceUrl: transition.source.url, effectiveDate: transition.effectiveDate });
    const results = await Promise.allSettled(transition.predecessorCiks.map(id => loadCompanyFacts(id, signal)));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && normalizeCik(result.value?.cik) === transition.predecessorCiks[i] && result.value?.facts) sources.push(result.value);
    }
    if (sources.length === transition.predecessorCiks.length + 1) continuity.status = 'applied';
    notices.push(continuity.status === 'applied' ? 'The current registrant profile includes verified predecessor history. Each source retains its original SEC registrant.' : 'Some verified predecessor history could not be loaded; historical comparisons may be incomplete.');
  }
  let facts = mergeRiskProfileCompanyFacts(sources, { cik, today });
  const companyFactsThrough = reportingPeriods(facts, 'quarter')[0]?.end || reportingPeriods(facts, 'annual')[0]?.end || null;
  const filing = latestRiskProfileFiling(submissions, cik, today);
  const newer = filing && (!companyFactsThrough || filing.reportDate > companyFactsThrough);
  const classificationNeeded = filing && ['MarketableSecurities', 'NotesAndLoansPayable'].some(tag => (facts['us-gaap']?.[tag]?.units?.USD || []).some(row => row.end === companyFactsThrough && !row.balanceClassification));
  const filingFallback = { status: 'not-needed', reason: newer ? 'newer-filing' : classificationNeeded ? 'classification' : null,
    reportDate: filing?.reportDate || null, accession: filing?.accession || null, documentUrl: filing?.url || null, addedFacts: 0, classifiedFacts: 0 };
  if (filing && (newer || classificationNeeded)) {
    try {
      const html = await loadFiling(filing, signal);
      let factCik = cik;
      if (transition?.predecessorCiks.length === 1 && filing.accession === transition.source.accession && filing.reportDate === transition.source.reportDate
        && filing.reportDate < transition.effectiveDate && verifiesJointRegistrantFacts(html, { cik, predecessorCik: transition.predecessorCiks[0], filing })) factCik = transition.predecessorCiks[0];
      const supplemented = supplementRiskProfileFacts(facts, html, { cik, filing, factCik });
      facts = supplemented.facts;
      const improved = supplemented.addedFacts > 0 || supplemented.classifiedFacts > 0;
      Object.assign(filingFallback, { status: improved ? 'applied' : 'no-supported-facts', addedFacts: supplemented.addedFacts, classifiedFacts: supplemented.classifiedFacts });
      if (newer) notices.push(improved ? 'The newest SEC filing supplements company facts while the aggregated feed catches up. Only verified consolidated standard USD facts are included.' : 'A newer SEC filing exists, but its supported consolidated facts could not be extracted.');
    } catch {
      filingFallback.status = 'unavailable';
      notices.push(newer ? 'A newer SEC filing exists, but its facts could not be verified within this request. Values retain their displayed reporting dates.' : 'Some balance-sheet classifications could not be verified from the latest filing. Related metrics remain unavailable.');
    }
  }
  return { facts, sourceCoverage: { companyFactsThrough, latestFilingReportDate: filing?.reportDate || null, filingFallback, continuity, notices } };
}
