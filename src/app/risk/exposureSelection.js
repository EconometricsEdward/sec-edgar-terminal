/** A benchmark's proof must remain in the evidence currently shown to the user. */
export function selectExposureEvidence(rows, role = 'all') {
  return (rows || []).flatMap(row => {
    const evidence = (row.evidence || []).filter(item => role === 'all' || item.role === role).sort((a, b) => (b.filed || '').localeCompare(a.filed || ''));
    if (!evidence.length) return [];
    const proof = evidence.find(item => item.benchmark?.fit === 'named-reference') || evidence.find(item => item.benchmark);
    return [{
      ...row, evidence, benchmark: proof?.benchmark || null,
      qualifyingEvidenceIds: evidence.filter(item => item.disclosureDirection === 'qualifying-or-negative').map(item => item.id),
      benchmarkEvidenceIds: proof ? evidence.filter(item => item.benchmark?.fit === proof.benchmark.fit && item.benchmark?.family === proof.benchmark.family && item.benchmark?.contract === proof.benchmark.contract).map(item => item.id) : [],
      benchmarkUnavailableReason: proof ? null : row.benchmarkUnavailableReason || 'No supported CFTC benchmark was established from the passages in this filing selection.',
    }];
  });
}

export function matchesExposureRequest(body, ticker, asOf = '') {
  return body?.ticker === ticker && (body?.asOf || '') === asOf;
}
