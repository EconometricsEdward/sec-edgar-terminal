// Geographic allocations in the original atlas are hand-authored assumptions.
// Keep them available only as scenarios; never present scaled values as history.
export function illustrativeGeography(regions) {
  return regions.map((region) => ({
    ...region,
    classification: 'illustrative',
    confidence: 'Illustrative',
    sourceBasis: `Scenario assumption, not a reported geographic allocation. ${region.sourceBasis || ''}`,
    timeSeries: [{ label: 'Scenario', period: 'Scenario', note: 'Illustrative allocation of current cohort data. No historical observations are available for this geographic scenario.', metricByMode: region.metricByMode }],
  }));
}

export function marketSnapshot(payload) {
  return {
    observedAt: payload.generatedAt,
    latestFiled: payload.universe.latestFiled,
    companies: payload.universe.loadedCompanies,
    totalAssets: payload.aggregateUniverse.totalAssets,
    totalLiabilities: payload.aggregateUniverse.totalLiabilities,
    lenses: payload.lenses.map((lens) => ({ id: lens.id, score: lens.score, loadedTickers: lens.loadedTickers })),
    classification: 'calculated',
    note: 'Snapshot of the covered cohort when this calculation ran; not a point-in-time reconstruction of the entire SEC universe.',
  };
}

export function appendSnapshot(history, snapshot) {
  const rows = Array.isArray(history) ? history.filter((row) => row?.observedAt && row.observedAt.slice(0, 10) !== snapshot.observedAt.slice(0, 10)) : [];
  return [...rows, snapshot].sort((a, b) => a.observedAt.localeCompare(b.observedAt)).slice(-30);
}
