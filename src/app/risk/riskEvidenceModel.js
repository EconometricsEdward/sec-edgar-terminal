const finite = value => typeof value === 'number' && Number.isFinite(value);

export function maturityView(profile, today) {
  const buckets = (profile?.buckets || []).map(bucket => ({ ...bucket,
    elapsed: !!bucket.endDate && bucket.endDate < today,
    shortLabel: bucket.calendarYear ? String(bucket.calendarYear) : bucket.key === 'after5' ? 'Thereafter' : bucket.label,
  }));
  const comparable = buckets.slice(0, 5).filter(bucket => finite(bucket.value));
  const peak = comparable.reduce((best, bucket) => !best || bucket.value > best.value ? bucket : best, null);
  // A partial schedule has no total-based concentration percentage.
  const near = buckets.slice(0, 2);
  const nearShare = profile?.coverage?.complete && profile.totalScheduled > 0 && near.length === 2 && near.every(b => finite(b.value))
    ? near.reduce((sum, b) => sum + b.value, 0) / profile.totalScheduled : null;
  return { buckets, peak, nearShare, hasElapsed: buckets.some(b => b.elapsed),
    max: Math.max(1, ...buckets.map(b => finite(b.value) ? b.value : 0)) };
}

export function comparableRiskChanges(profile) {
  const periods = [...(profile?.periods || [])].sort((a, b) => b.end.localeCompare(a.end));
  const [current, previous] = periods;
  if (!current || !previous) return [];
  const gap = (Date.parse(current.end) - Date.parse(previous.end)) / 86400000;
  if (profile.basis === 'annual' ? gap < 300 || gap > 400 : gap < 60 || gap > 120) return [];
  return (profile.metrics || []).flatMap(metric => {
    // This summary counts loss windows; its series contains individual 0/1 flags.
    if (metric.id === 'loss_years') return [];
    const latest = metric.series?.find(p => p.end === current.end);
    const prior = metric.series?.find(p => p.end === previous.end);
    if (!finite(latest?.value) || !finite(prior?.value) || !finite(metric.value) || metric.value !== latest.value) return [];
    return [{ id: metric.id, label: metric.label, pillar: metric.pillar, format: metric.format,
      deltaFormat: ['pct', 'pp'].includes(metric.format) ? 'pp' : metric.format,
      value: latest.value, prior: prior.value, delta: latest.value - prior.value,
      end: current.end, priorEnd: previous.end }];
  });
}
