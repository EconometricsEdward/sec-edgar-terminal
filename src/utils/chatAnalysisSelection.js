/** The same prepared/interactive models used by Analysis, with exact filing
 * cutoff validation. No separate chat cache or stored model is introduced. */
export async function loadChatAnalysis({ ticker, basis, asOf = '' }, signal, { preview = false, publicJson } = {}) {
  signal.throwIfAborted();
  let result;
  if (preview && !/^\d+$/.test(ticker)) {
    result = await publicJson('/api/analysis-research', { ticker, basis, ...(asOf ? { asOf } : {}) }, signal);
  } else if (/^\d+$/.test(ticker)) {
    if (basis === 'ytd') throw new Error('CIK-only year-to-date research is unavailable.');
    const [{ createInteractiveAnalysisLoader }, { createReportCikCompanyLoader }] = await Promise.all([
      import('./analysisResearchServer.js'), import('./companyReport.js'),
    ]);
    cikLoader ||= createInteractiveAnalysisLoader({ load: createReportCikCompanyLoader() });
    result = await cikLoader({ ticker, basis, asOf }, signal);
  } else {
    const { readPreparedAnalysis } = await import('./preparedFinancialData.js');
    try { result = await readPreparedAnalysis({ ticker, basis, asOf }); }
    catch (error) { if (error.name !== 'PreparedSecUnavailableError') throw error; }
    signal.throwIfAborted();
    if (!result) result = await (await import('./analysisResearchServer.js')).loadInteractiveAnalysis({ ticker, basis, asOf }, signal);
  }
  signal.throwIfAborted();
  if (result?.payload?.ticker !== ticker || result.payload.basis !== basis || (result.payload.asOf || '') !== asOf)
    throw Object.assign(new Error('The financial source did not match the selected company, basis and filing cutoff.'), { researchCode: 'SOURCE_IDENTITY_MISMATCH' });
  return result;
}
let cikLoader;

/** Keep original point indices and provenance while choosing an exact period.
 * A missing date must never silently fall back to the latest period. */
export function selectChatAnalysisPeriod(analysis, end = '') {
  if (!end || end === 'latest') return analysis;
  if (!analysis.periods?.some(period => period?.end === end && period.kind === analysis.basis))
    throw Object.assign(new Error('The selected financial period is not available in this model.'), {
      safeMessage: 'The selected financial period is not available. Open Analysis to inspect the available periods.', researchCode: 'SOURCE_BASIS_UNAVAILABLE',
    });
  return { ...analysis, periods: analysis.periods.map(period => period?.end <= end ? period : null) };
}
