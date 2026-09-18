// Reviewed issuer extensions retain their own reporting basis. Never map a
// similarly named custom tag to GAAP revenue or borrow another issuer's rule.
// Reviewed against BAC's 2025 10-K and 2026 Q2 10-Q, Note 17.
export const BAC_FTE_REVENUE_MAPPING = 'bac-revenue-fte-v1';
export const BAC_FTE_REVENUE_CONCEPT = 'RevenuesNetOfInterestExpenseFullTaxEquivalentBasis';
export const BAC_REVENUE_SEGMENTS = Object.freeze({
  ConsumerBankingSegmentMember: 'Consumer Banking',
  GlobalWealthAndInvestmentManagementSegmentMember: 'Global Wealth & Investment Management',
  GlobalBankingSegmentMember: 'Global Banking',
  GlobalMarketsSegmentMember: 'Global Markets',
});
const local = value => String(value || '').split(':').at(-1);
const ns = (value, namespaces) => namespaces[String(value || '').split(':')[0]];
const standardAxis = (dimension, name, namespaces) => local(dimension.axis) === name
  && /^https?:\/\/(?:fasb\.org\/(?:us-gaap|srt)|xbrl\.sec\.gov\/srt)\/20\d{2}(?:-\d{2}-\d{2})?$/.test(ns(dimension.axis, namespaces) || '');

export function reviewedRevenueMappings(cik, filing) {
  if (String(cik).replace(/^0+/, '') !== '70858' || !/^\d{4}-\d{2}-\d{2}$/.test(filing?.reportDate || '')) return [];
  const namespace = `http://www.bankofamerica.com/${filing.reportDate.replaceAll('-', '')}`;
  return [{ id: BAC_FTE_REVENUE_MAPPING, concept: BAC_FTE_REVENUE_CONCEPT, namespace,
    acceptsDimensions(dimensions, namespaces) {
      if (!dimensions.length) return true;
      const consolidation = dimensions.find(dimension => standardAxis(dimension, 'ConsolidationItemsAxis', namespaces));
      if (!consolidation) return false;
      if (dimensions.length === 1) return local(consolidation.member) === 'CorporateReconcilingItemsAndEliminationsMember' && ns(consolidation.member, namespaces) === namespace;
      const segment = dimensions.find(dimension => standardAxis(dimension, 'StatementBusinessSegmentsAxis', namespaces));
      return dimensions.length === 2 && segment && Object.hasOwn(BAC_REVENUE_SEGMENTS, local(segment.member))
        && ns(segment.member, namespaces) === namespace && local(consolidation.member) === 'OperatingSegmentsMember'
        && /^https?:\/\/fasb\.org\/us-gaap\/20\d{2}(?:-\d{2}-\d{2})?$/.test(ns(consolidation.member, namespaces) || '');
    },
  }];
}
