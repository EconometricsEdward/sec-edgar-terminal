import { discoverRiskNoteFacts } from './riskNoteFactsServer.js';
import { buildCompanyConcentrations, extractConcentrationFacts, COMPANY_CONCENTRATIONS_VERSION } from './companyConcentrations.js';
import { warmGet, warmSet } from './warmCache.js';

export async function discoverCompanyConcentrations(selection, dependencies = {}) {
  const evidence = await discoverRiskNoteFacts(selection, { ...dependencies, extractFacts: extractConcentrationFacts });
  const { rows, limitations: _limitations, ...metadata } = evidence;
  const groups = buildCompanyConcentrations(rows, evidence);
  return { ...metadata, ...groups, schemaVersion: COMPANY_CONCENTRATIONS_VERSION,
    status: groups.revenue.length || groups.funding || groups.credit.length ? 'ready' : 'no_matches',
    message: groups.revenue.length || groups.funding || groups.credit.length ? null : 'This filing has no supported tagged concentration breakdown. Open the SEC source for the complete disclosures.',
    limitations: [
      ...(_limitations || []).filter(note => note.startsWith('This verified joint filing')),
      'Figures come from standard USD inline facts in one verified SEC primary filing. Custom concepts, typed dimensions and untagged tables are not included.',
      'Revenue retains its actual quarter, year-to-date or fiscal-year duration; latest-quarter disclosures are not labeled trailing twelve months.',
      'Every percentage uses a matching reported total and reporting period. Disclosed categories may overlap; balances are not automatically summed.',
      'Loan categories describe the reported balances, not default probabilities or losses. Funding shares use total liabilities, not a contractual maturity schedule.',
    ] };
}

export async function loadCompanyConcentrations(selection, { signal } = {}) {
  const key = `${selection.ticker}:${selection.basis}:${selection.asOf || 'latest'}`;
  const saved = await warmGet(COMPANY_CONCENTRATIONS_VERSION, key);
  if (saved) return saved;
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45_000)]);
  const result = await discoverCompanyConcentrations(selection, { signal: requestSignal });
  if (!result.coverage.historyLimited) await warmSet(COMPANY_CONCENTRATIONS_VERSION, key, result, result.status === 'ready' ? 3600 : 600);
  return result;
}
