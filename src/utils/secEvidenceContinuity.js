/** Individually verified SEC registrant transitions, never ticker/name guesses.
 * A relationship does not merge issuers or establish security/CUSIP continuity.
 * Consumers must retain source identity and apply their own period/cutoff gates.
 */
export const SEC_EVIDENCE_CONTINUITY = Object.freeze({
  '0002115436': Object.freeze({
    predecessorCiks: Object.freeze(['0000034088']),
    predecessorName: 'Exxon Mobil Corporation',
    relationship: 'predecessor-and-joint-filer',
    effectiveDate: '2026-07-01',
    oneForOneCommonStockExchange: true,
    description: 'ExxonMobil registrant succession and joint-filer transition',
    source: Object.freeze({
      url: 'https://www.sec.gov/Archives/edgar/data/2115436/000003408826000093/xom-20260630.htm',
      accession: '0000034088-26-000093',
      filed: '2026-08-03',
      reportDate: '2026-06-30',
    }),
  }),
});
