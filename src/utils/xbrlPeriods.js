// Context-aware SEC facts. A filing's fp/fy describe the filing, not necessarily
// the observation (comparative and YTD facts share those fields).
const DAY = 86400000;
const REPORT = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;
const ANNUAL = /^(10-K|20-F|40-F)(\/A)?$/;
const ANCHORS = ['Assets', 'NetIncomeLoss', 'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'StockholdersEquity', 'Liabilities', 'ProfitLoss', 'Revenue', 'Equity'];
export const FINANCIAL_DATA_VERSION = 'context-v3';

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

// Opt-in revenue safeguard for a specific contradictory SEC context: a 10-Q
// repeats its shorter YTD revenue as a full year, disagrees with that year's
// annual report, and would make Q4 negative against the reported nine months.
// Keep genuine revisions (including 10-K/A and ordinary 10-Q comparatives).
// No value is capped or guessed; the annual report remains the cited input.
function guardAnnualRevenueObservations(entries) {
  const shorterByAccession = new Map();
  for (const entry of entries) {
    const days = duration(entry);
    if (entry.accn && days >= 60 && days < 300) {
      const key = `${entry.accn}:${entry.taxonomy}:${entry.start}:${entry.val}`;
      shorterByAccession.set(key, true);
    }
  }
  const conflicts = new Map();
  for (const entry of entries) {
    const days = duration(entry);
    if (!/^10-Q(\/A)?$/.test(entry.form) || days < 300 || days > 400 ||
        !shorterByAccession.has(`${entry.accn}:${entry.taxonomy}:${entry.start}:${entry.val}`)) continue;
    const prior = entries.find((e) => e.taxonomy === entry.taxonomy && e.start === entry.start &&
      e.filed <= entry.filed && daysBetween(e.end, entry.end) >= 60 && daysBetween(e.end, entry.end) <= 120);
    if (!prior || prior.val <= entry.val) continue;
    const annual = entries.find((e) => ANNUAL.test(e.form) && e.taxonomy === entry.taxonomy &&
      e.start === entry.start && e.end === entry.end && e.filed <= entry.filed);
    if (!annual || annual.val < prior.val || annual.val === entry.val) continue;
    conflicts.set(entry, {
      code: 'annual-revenue-context-conflict',
      accession: entry.accn, filed: entry.filed, value: entry.val,
    });
  }
  if (!conflicts.size) return entries;
  return entries.filter((entry) => !conflicts.has(entry)).map((entry) => {
    if (!ANNUAL.test(entry.form)) return entry;
    const contextWarnings = [...conflicts].filter(([rejected]) => rejected.taxonomy === entry.taxonomy &&
      rejected.start === entry.start && rejected.end === entry.end).map(([, warning]) => warning);
    return contextWarnings.length ? { ...entry, contextWarnings } : entry;
  });
}

function reported(entry, peers) {
  const sameContext = peers.filter((e) => e.start === entry.start && e.end === entry.end && e.unit === entry.unit);
  const revised = new Set(sameContext.map((e) => e.val)).size > 1 || Boolean(entry.contextWarnings?.length);
  const source = {
    tag: entry.tag, taxonomy: entry.taxonomy, unit: entry.unit,
    accession: entry.accn, filed: entry.filed, start: entry.start || null,
    end: entry.end, form: entry.form, value: entry.val,
    ...(entry.sourceCik ? { sourceCik: entry.sourceCik } : {}),
    ...(entry.documentUrl ? { documentUrl: entry.documentUrl } : {}),
    ...(entry.factId ? { factId: entry.factId } : {}),
    ...(entry.sourceType ? { sourceType: entry.sourceType } : {}),
    ...(entry.balanceClassification ? { balanceClassification: entry.balanceClassification, classificationEvidence: entry.classificationEvidence } : {}),
    durationDays: duration(entry), classification: 'reported', revised,
    revisionNote: entry.contextWarnings?.length
      ? 'Annual-report revenue used: a conflicting quarterly-filing annual context repeats a shorter-period value and would imply negative fourth-quarter revenue. Inspect both filings.'
      : revised ? 'Different values were filed for this exact context. Inspect the filings to determine the reason.' : null,
    ...(entry.contextWarnings?.length ? { contextWarnings: entry.contextWarnings } : {}),
  };
  return {
    value: entry.val, source, sources: [source], classification: 'reported',
    observationPeriod: { kind: entry.start ? 'duration' : 'instant', start: entry.start || null, end: entry.end },
  };
}

function calculated(value, inputs, formula, note, period) {
  const sources = inputs.flatMap((p) => p.sources || [p.source]);
  return {
    value, sources, calculations: inputs.flatMap((p) => [...(p.calculations || []), ...(p.formula ? [{ value: p.value, formula: p.formula, start: p.source.start, end: p.source.end, unit: p.source.unit }] : [])]), classification: 'calculated', formula, note,
    observationPeriod: { kind: period.start ? 'duration' : 'instant', start: period.start || null, end: period.end },
    source: { ...sources[0], value, start: period.start, end: period.end, classification: 'calculated', formula, inputSources: sources, note },
  };
}

/** Sum separately reported duration concepts only when their actual contexts agree. */
export function sumCompatibleFinancialFacts(inputs, formula, period) {
  if (inputs.length < 2 || inputs.some(p => !Number.isFinite(p?.value) ||
      !p.source?.start || !p.source?.end || !p.source?.unit)) return null;
  const first = inputs[0].source;
  const expectedStart = period?.kind === 'ttm' ? period.ttmStart || period.start : period?.start;
  if (!period?.end || first.end !== period.end || (expectedStart && first.start !== expectedStart)) return null;
  if (inputs.some(p => p.source.start !== first.start || p.source.end !== first.end || p.source.unit !== first.unit)) return null;
  const value = inputs.reduce((sum, p) => sum + p.value, 0);
  if (!Number.isFinite(value)) return null;
  return calculated(value, inputs, formula,
    'Both separately reported components are required in the same currency and actual reporting period.',
    { start: first.start, end: first.end });
}

/** No currency substitution or same-year fallback. Unknown means unavailable. */
export function selectFinancialFact(facts, tags, period, unit = 'USD', { additive = true, guardAnnualRevenueContext = false } = {}) {
  const kind = period.kind || (period.fp === 'FY' ? 'annual' : 'quarter');
  for (const tag of tags) {
    const observationsForTag = observations(facts, tag, unit, period.asOf);
    const all = guardAnnualRevenueContext ? guardAnnualRevenueObservations(observationsForTag) : observationsForTag;
    const ending = all.filter((e) => e.end === period.end);
    if (!ending.length) continue;
    const instants = ending.filter((e) => !e.start);
    if (instants.length) return reported(instants[0], all);

    const direct = ending.filter((e) => {
      const d = duration(e);
      if (kind === 'annual' || kind === 'ttm') {
        const expectedStart = kind === 'ttm'
          ? period.ttmStart || period.start
          : period.start || period.fiscalStart;
        // A year-like duration is not enough: transition periods and other
        // contexts can end together while covering different financial flows.
        // Keep the same small boundary tolerance used for reported quarters.
        return d >= 300 && d <= 400 && (!expectedStart || Math.abs(daysBetween(expectedStart, e.start)) <= 3);
      }
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
      const points = quarters.map((p) => selectFinancialFact(facts, [tag], { ...p, kind: 'quarter' }, unit, { additive, guardAnnualRevenueContext }));
      if (points.every(Boolean)) return calculated(points.reduce((sum, p) => sum + p.value, 0), points,
        'Sum of four consecutive standalone quarters', 'Trailing twelve months; all four quarters are required.', { ...period, start: quarters[3].start });
    }
  }
  return null;
}

export function sourceDocumentUrl(cik, source) {
  const sourceCik = source?.sourceCik ?? cik;
  if (!/^\d{1,10}$/.test(String(sourceCik)) || !/^\d{10}-\d{2}-\d{6}$/.test(source?.accession || '')) return null;
  const path = `/Archives/edgar/data/${Number(sourceCik)}/${source.accession.replaceAll('-', '')}/`;
  if (source.documentUrl) {
    try {
      const url = new URL(source.documentUrl);
      if (url.protocol === 'https:' && ['www.sec.gov', 'sec.gov'].includes(url.hostname)
        && !url.username && !url.password && !url.port && !url.search
        && url.pathname.startsWith(path) && /^[\w.-]+$/.test(url.pathname.slice(path.length))) {
        if (!url.hash && /^[\w.:-]+$/.test(source.factId || '')) url.hash = source.factId;
        return url.href;
      }
    } catch { /* Use the verified accession directory when an exact link is invalid. */ }
  }
  return `https://www.sec.gov${path}`;
}

export function contextKey(e) {
  return [e.start || 'instant', e.end, e.unit || 'USD'].join(':');
}
