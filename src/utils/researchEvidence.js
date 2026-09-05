// Keep raw reported inputs distinct from intermediate calculated values.
export function evidenceSources(point) {
  const roots = point?.sources?.length ? point.sources : point?.source ? [point.source] : [];
  const flatten = (source) => source.inputSources?.length
    ? source.inputSources.flatMap((input) => flatten({ ...input, label: input.label || source.label }))
    : [source];
  const seen = new Set();
  return roots.flatMap(flatten).filter((source) => {
    const key = [source.taxonomy, source.tag, source.unit, source.start, source.end, source.accession, source.value, source.label].join(':');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function evidenceCalculations(point) {
  const roots = point?.sources?.length ? point.sources : [];
  return [...(point?.calculations || []), ...roots.flatMap((s) => [
    ...(s.calculations || []), ...(s.formula ? [{ value: s.value, formula: s.formula, label: s.label, start: s.start, end: s.end, unit: s.unit }] : []),
  ])];
}
