import { evidenceSources } from './researchEvidence.js';
import { financialSourceScopeIssue } from './financialComparisonScope.js';
import { analysisCashLabel, analysisCashScopeNote } from './analysisMappingPresentation.js';

export const RISK_CAPITAL_PURCHASE_TAGS = ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'];
export const RISK_CAPITAL_PURCHASE_NOTE = 'Cash capital purchases follow the cited concept. Productive-asset purchases may include intangible assets; PP&E purchases may exclude separately reported investment categories. This is not complete investment spending, maintenance capex or the issuer’s own free-cash-flow definition.';
export const RISK_DEBT_SCOPE_NOTE = 'Selected reported borrowing balances, not proof of every debt obligation. Separately reported subordinated debt, secured financing and other obligations may be outside these concepts; components are not added without evidence that they do not overlap.';

export function riskCashLabel(point) {
  const sources = evidenceSources(point);
  if (point?.formula?.includes('restricted cash')) return 'Cash excluding tagged restrictions';
  return sources.length ? analysisCashLabel(sources.map(source => source.tag)) : 'Cash & equivalents';
}

export function riskCashPoint(point) {
  if (point?.value == null) return point;
  const label = riskCashLabel(point);
  const reconstructed = point.formula?.includes('restricted cash');
  // A reconstructed balance has two different raw inputs. Keep “including
  // restricted cash” and “restricted cash” on those inputs, not the net label.
  const sources = evidenceSources(point).map(source => ({ ...source, label: reconstructed ? source.label || source.tag : label,
    scopeNote: reconstructed
      ? 'Reported cash including restricted cash less explicitly tagged restrictions at the same balance date. Availability for use still requires the filing disclosures.'
      : analysisCashScopeNote(source.tag) }));
  return { ...point, label, sources, source: point.source ? { ...point.source,
    label: reconstructed ? point.source.label || point.source.tag : label, scopeNote: sources[0]?.scopeNote } : point.source };
}

/** Known accounting-scope switches cannot be presented as economic changes. */
export function riskComparisonIssue(current, before) {
  const issue = financialSourceScopeIssue(current, before);
  if (issue) return issue;
  const capitalScopes = [current, before].map(point => [...new Set(evidenceSources(point)
    .filter(source => RISK_CAPITAL_PURCHASE_TAGS.includes(source.tag)).map(source => source.tag))].sort().join('|'));
  if (capitalScopes.every(Boolean) && capitalScopes[0] !== capitalScopes[1])
    return 'The reported capital-purchase scopes differ between periods; comparable change cannot be established.';
  return null;
}
