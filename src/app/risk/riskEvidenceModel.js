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
    const latest = metric.series?.find(p => p.end === current.end);
    const prior = metric.series?.find(p => p.end === previous.end);
    if (!finite(latest?.value) || !finite(prior?.value) || !finite(metric.value) || metric.value !== latest.value) return [];
    return [{ id: metric.id, label: metric.label, pillar: metric.pillar, format: metric.format,
      deltaFormat: ['pct', 'pp'].includes(metric.format) ? 'pp' : metric.format,
      value: latest.value, prior: prior.value, delta: latest.value - prior.value,
      end: current.end, priorEnd: previous.end }];
  });
}

/** Read only validated report metrics for the selected RSSD/date. Percent
 * observations are percentages already, not decimal fractions. */
export function regulatoryBankView(state, rssd, period) {
  const report = state?.reports?.find(r => String(r.id_rssd) === String(rssd) && r.report_date === period);
  const sourceUrl = report && /^[a-f0-9]{64}$/.test(report.source_sha256 || '')
    ? `/api/banks/source?rssd=${rssd}&period=${period}&hash=${report.source_sha256}` : null;
  const get = key => {
    const row = report?.validation?.passed ? report.metrics?.find(m => m.key === key && String(m.rssd) === String(rssd) && m.reportDate === period) : null;
    return row && finite(row.value) ? row.value : null;
  };
  const ratio = (n, d) => finite(n) && finite(d) && d > 0 ? n / d * 100 : null;
  const cards = [
    { key: 'cet1_ratio', label: 'CET1 ratio', value: get('cet1_ratio'), unit: 'percent', formula: 'Reported CET1 capital / risk-weighted assets' },
    { key: 'leverage_ratio', label: 'Tier 1 leverage', value: get('leverage_ratio'), unit: 'percent', formula: 'Reported Tier 1 capital / adjusted average assets' },
    { key: 'nonaccrual', label: 'Nonaccrual / loans', value: ratio(get('nonaccrual'), get('loans')), unit: 'percent', formula: 'Nonaccrual loans / total loans before allowance' },
    { key: 'brokered_deposits', label: 'Brokered / domestic deposits', value: ratio(get('brokered_deposits'), get('domestic_deposits')), unit: 'percent', formula: 'Domestic brokered deposits / domestic deposits' },
    { key: 'allowance', label: 'Allowance / HFI loans', value: ratio(get('allowance'), get('loans_hfi')), unit: 'percent', formula: 'Loan allowance / loans held for investment before allowance' },
    { key: 'fhlb_advances', label: 'FHLB advances', value: get('fhlb_advances'), unit: 'USD', formula: 'Reported FHLB advance maturity / repricing buckets; no overlapping subtotals' },
  ];
  return { report, sourceUrl, cards,
    funding: ['domestic_deposits', 'foreign_deposits', 'fhlb_advances'].map(key => ({ key, value: get(key) })),
    valid: report?.validation?.passed === true };
}
