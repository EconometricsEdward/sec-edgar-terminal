/**
 * Browser-facing Market atlas projection.
 *
 * Factor-score filing comparisons are intentionally retained only in the
 * server-side warm atlas. No current Market panel reads them in the browser,
 * and removing them avoids serializing hundreds of kilobytes into the RSC
 * payload while preserving all visible company, cohort, screen, and evidence
 * navigation fields.
 */
export function projectMarketAtlasForClient(atlas) {
  if (!atlas || !Array.isArray(atlas.companies)) return atlas;
  return {
    ...atlas,
    companies: atlas.companies.map((company) => {
      const { filingComparisons: _serverOnlyFilingComparisons, ...clientCompany } = company;
      return clientCompany;
    }),
  };
}
