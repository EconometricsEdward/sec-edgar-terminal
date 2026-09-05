// Context-aware SEC facts. A filing's fp/fy describe the filing, not necessarily
// the observation (comparative and YTD facts share those fields).
const DAY = 86400000;
const REPORT = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;
const ANNUAL = /^(10-K|20-F|40-F)(\/A)?$/;
const ANCHORS = ['Assets', 'NetIncomeLoss', 'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'StockholdersEquity', 'Liabilities', 'ProfitLoss', 'Revenue', 'Equity'];
export const FINANCIAL_DATA_VERSION = 'context-v2';

export function daysBetween(start, end) {
  return Math.round((Date.parse(end) - Date.parse(start)) / DAY);
}
const nextDay = (date) => new Date(Date.parse(date) + DAY).toISOString().slice(0, 10);
const duration = (e) => e.start ? daysBetween(e.start, e.end) + 1 : null;
const valid = (e, asOf) => e.end && Number.isFinite(e.val) && REPORT.test(e.form || '') && (!asOf || e.filed <= asOf);
const latest = (a, b) => (b.filed || '').localeCompare(a.filed || '') || (b.accn || '').localeCompare(a.accn || '');

function anchorEntries(facts, asOf) {
  return ['us-gaap', 'ifrs-full'].flatMap((taxonomy) => ANCHORS.flatMap((tag) =>
    Object.values(facts?.[taxonomy]?.[tag]?.units || {}).flat().filter((e) => valid(e, asOf))));
}

export function reportingPeriods(facts, kind = 'annual', asOf) {
  const entries = anchorEntries(facts, asOf);
  const filings = new Map();
  for (const e of entries) {
    const key = e.accn || `${e.filed}:${e.form}`;
    const prior = filings.get(key);
    if (!prior || e.end > prior.end) filings.set(key, e);
  }
  const periods = new Map();
  for (const [key, head] of filings) {
    const annual = ANNUAL.test(head.form);
    if (kind === 'annual' && !annual) continue;
    if (!annual && !/^Q[123]$/.test(head.fp || '')) continue;
    const related = entries.filter((e) => (e.accn || `${e.filed}:${e.form}`) === key && e.end === head.end);
    const starts = related.filter((e) => e.start && duration(e) <= 400).map((e) => e.start).sort();
    const fp = annual ? (kind === 'annual' ? 'FY' : 'Q4') : head.fp;
    const period = {
      fy: head.fy || Number(head.end.slice(0, 4)), fp, end: head.end,
      filed: head.filed, form: head.form, accession: head.accn,
      kind: kind === 'annual' ? 'annual' : 'quarter',
      fiscalStart: starts[0] || null, asOf,
    };
    const old = periods.get(head.end);
    if (!old || head.filed > old.filed) periods.set(head.end, period);
  }
  const sorted = [...periods.values()].sort((a, b) => b.end.localeCompare(a.end));
  const dated = sorted.map((p, i) => {
    const prior = sorted[i + 1];
    const gap = prior ? daysBetween(prior.end, p.end) : null;
    const start = kind === 'annual' ? p.fiscalStart
      : gap >= 60 && gap <= 120 ? nextDay(prior.end)
        : p.fp === 'Q1' ? p.fiscalStart : null;
    return { ...p, start };
  });
  return dated.map((p, i) => {
    const four = dated.slice(i, i + 4);
    const consecutive = four.length === 4 && four.slice(0, 3).every((q, j) => {
      const gap = daysBetween(four[j + 1].end, q.end);
      return gap >= 60 && gap <= 120;
    });
    return { ...p, ttmStart: kind !== 'annual' && consecutive ? four[3].start : null };
  });
}

export function withPeriodKind(periods, kind) {
  return periods.map((p) => ({ ...p, kind, start: kind === 'ytd' ? p.fiscalStart : kind === 'ttm' ? p.ttmStart : p.start }));
}

function observations(facts, tag, unit, asOf) {
  return ['us-gaap', 'ifrs-full'].flatMap((taxonomy) =>
    (facts?.[taxonomy]?.[tag]?.units?.[unit] || [])
      .filter((e) => valid(e, asOf))
      .map((e) => ({ ...e, tag, taxonomy, unit }))).sort(latest);
}

function reported(entry, peers) {
  const sameContext = peers.filter((e) => e.start === entry.start && e.end === entry.end && e.unit === entry.unit);
  const revised = new Set(sameContext.map((e) => e.val)).size > 1;
  const source = {
    tag: entry.tag, taxonomy: entry.taxonomy, unit: entry.unit,
    accession: entry.accn, filed: entry.filed, start: entry.start || null,
    end: entry.end, form: entry.form, value: entry.val,
    durationDays: duration(entry), classification: 'reported', revised,
    revisionNote: revised ? 'Different values were filed for this exact context. Inspect the filings to determine the reason.' : null,
  };
  return { value: entry.val, source, sources: [source], classification: 'reported' };
}

function calculated(value, inputs, formula, note, period) {
  const sources = inputs.flatMap((p) => p.sources || [p.source]);
  return {
    value, sources, calculations: inputs.flatMap((p) => [...(p.calculations || []), ...(p.formula ? [{ value: p.value, formula: p.formula, start: p.source.start, end: p.source.end, unit: p.source.unit }] : [])]), classification: 'calculated', formula, note,
    source: { ...sources[0], value, start: period.start, end: period.end, classification: 'calculated', formula, inputSources: sources, note },
  };
}

/** No currency substitution or same-year fallback. Unknown means unavailable. */
export function selectFinancialFact(facts, tags, period, unit = 'USD', { additive = true } = {}) {
  const kind = period.kind || (period.fp === 'FY' ? 'annual' : 'quarter');
  for (const tag of tags) {
    const all = observations(facts, tag, unit, period.asOf);
    const ending = all.filter((e) => e.end === period.end);
    if (!ending.length) continue;
    const instants = ending.filter((e) => !e.start);
    if (instants.length) return reported(instants[0], all);

    const direct = ending.filter((e) => {
      const d = duration(e);
      if (kind === 'annual' || kind === 'ttm') return d >= 300 && d <= 400;
      if (kind === 'ytd') {
        return period.fiscalStart ? e.start === period.fiscalStart
          : d >= 60 && d <= (Number(period.fp?.slice(1)) || 4) * 100 + 20;
      }
      return d >= 60 && d <= 120 && (!period.start || Math.abs(daysBetween(period.start, e.start)) <= 3);
    });
    // Without an explicit fiscal start, prefer the longest disclosed YTD context.
    if (kind === 'ytd' && !period.fiscalStart) direct.sort((a, b) => duration(b) - duration(a) || latest(a, b));
    if (direct.length) return reported(direct[0], all);

    // EPS and average share counts are not additive. Leave those unavailable
    // unless SEC supplies an observation for the requested duration.
    if (!additive) continue;
    if (kind === 'quarter') {
      const cumulative = ending.filter((e) => duration(e) > 120 && duration(e) <= 400);
      for (const current of cumulative) {
        const prior = all.filter((e) => e.start === current.start && e.end < current.end &&
          daysBetween(e.end, current.end) >= 60 && daysBetween(e.end, current.end) <= 120 &&
          (!period.start || Math.abs(daysBetween(e.end, period.start) - 1) <= 3) && e.filed <= current.filed)
          .sort((a, b) => Number(b.accn === current.accn) - Number(a.accn === current.accn) || latest(a, b));
        if (prior[0]) return calculated(current.val - prior[0].val,
          [reported(current, all), reported(prior[0], all)],
          'Current cumulative value − prior cumulative value',
          'Standalone quarter derived from the same concept, unit, and fiscal-year start. Both source filings are retained.', { ...period, start: nextDay(prior[0].end) });
      }
    }
    if (kind === 'ttm') {
      const quarters = reportingPeriods(facts, 'quarter', period.asOf).filter((p) => p.end <= period.end).slice(0, 4);
      if (quarters.length !== 4 || quarters[0].end !== period.end) continue;
      if (quarters.slice(0, 3).some((p, i) => {
        const gap = daysBetween(quarters[i + 1].end, p.end);
        return gap < 60 || gap > 120;
      })) continue;
      const points = quarters.map((p) => selectFinancialFact(facts, [tag], { ...p, kind: 'quarter' }, unit, { additive }));
      if (points.every(Boolean)) return calculated(points.reduce((sum, p) => sum + p.value, 0), points,
        'Sum of four consecutive standalone quarters', 'Trailing twelve months; all four quarters are required.', { ...period, start: quarters[3].start });
    }
  }
  return null;
}

export function sourceDocumentUrl(cik, source) {
  if (!/^\d{1,10}$/.test(String(cik)) || !/^\d{10}-\d{2}-\d{6}$/.test(source?.accession || '')) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${source.accession.replaceAll('-', '')}/`;
}

export function contextKey(e) {
  return [e.start || 'instant', e.end, e.unit || 'USD'].join(':');
}
