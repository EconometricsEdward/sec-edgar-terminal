import { buildMetricRow, extractAnnualPeriods, extractQuarterlyPeriods, formatValue, periodLabel } from './xbrlParser.js';
import { evidenceSources, evidenceCalculations } from './researchEvidence.js';
import { FINANCIAL_DATA_VERSION, sourceDocumentUrl } from './xbrlPeriods.js';
import { classifyIndustry, INDUSTRY_GROUPS } from './industry.js';

export const WORKSPACE_KEY = 'edgar:research-workspace:v1';
export const emptyWorkspace = () => ({ version: 1, companies: {}, peerGroups: [] });
export const RESEARCH_FORMS = /^(10-K|10-Q|20-F|40-F|8-K|6-K)(\/A)?$/;
export function normalizeTicker(ticker) { return String(ticker || '').trim().toUpperCase(); }
export function validTicker(ticker) { return /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker); }

export function parseWorkspace(raw) {
  if (!raw) return emptyWorkspace();
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !parsed.companies || typeof parsed.companies !== 'object' || Array.isArray(parsed.companies)) throw new Error('Saved workspace format is not supported. Export or restore your existing data before replacing it.');
  return { ...parsed, peerGroups: Array.isArray(parsed.peerGroups) ? parsed.peerGroups : [] };
}

export function writeWorkspace(storage, update) {
  const current = parseWorkspace(storage.getItem(WORKSPACE_KEY));
  const next = update(current);
  storage.setItem(WORKSPACE_KEY, JSON.stringify(next));
  return next;
}

export function metricDefinitions(sic) {
  return classifyIndustry(sic) === INDUSTRY_GROUPS.BANKING
    ? [['netInterestIncome', 'Net interest income'], ['netIncome', 'Net income'], ['deposits', 'Deposits'], ['loans', 'Net loans'], ['stockholdersEquity', 'Equity'], ['totalAssets', 'Total assets']]
    : [['revenue', 'Revenue'], ['netIncome', 'Net income'], ['operatingCashFlow', 'Operating cash flow'], ['cash', 'Cash'], ['totalAssets', 'Total assets'], ['stockholdersEquity', 'Equity']];
}

export function companySnapshot(facts, sic, filings = [], selectedPeriod = null) {
  const annual = extractAnnualPeriods(facts)[0];
  const quarter = extractQuarterlyPeriods(facts)[0];
  const period = selectedPeriod || (quarter && (!annual || quarter.end >= annual.end) ? quarter : annual);
  const metrics = period ? metricDefinitions(sic).map(([key, label]) => ({
    key, label, format: 'currency', ...buildMetricRow(facts, key, label, [period], 'currency', sic).values[0],
  })) : [];
  const reports = filings.filter((f) => RESEARCH_FORMS.test(f.form)).sort((a, b) => (b.filingDate || '').localeCompare(a.filingDate || ''));
  const report = reports.find((f) => /^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(f.form));
  return {
    dataVersion: FINANCIAL_DATA_VERSION, period: period || null, metrics,
    accessions: reports.map((f) => f.accession || f.accessionNumber),
    reportAccession: report?.accession || report?.accessionNumber || null,
    observedAt: new Date().toISOString(),
  };
}

export function snapshotChanges(baseline, current) {
  if (!baseline || baseline.dataVersion !== current.dataVersion) return [];
  return current.metrics.flatMap((metric) => {
    const before = baseline.metrics?.find((m) => m.key === metric.key);
    if (before?.value == null || metric.value == null || before.value === metric.value) return [];
    if (before.source?.unit !== metric.source?.unit || before.period?.kind !== metric.period?.kind) return [];
    return [{ key: metric.key, label: metric.label, before, after: metric,
      delta: metric.value - before.value,
      percentChange: before.value > 0 ? (metric.value - before.value) / before.value * 100 : null,
      reason: before.period?.end === metric.period?.end ? 'Value changed for the previously reviewed period' : 'A newer reporting period is available',
    }];
  });
}

/** @param {any} options */
export function exportResearchBrief({ ticker, name, cik, notes, snapshot, evidence = [], peerGroups = [], changes = [] }) {
  const clean = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const sources = (point) => evidenceSources(point)
    .map((source) => `${source.tag}: ${source.value} (${source.start || 'instant'} to ${source.end}, ${source.unit}, filed ${source.filed}) — ${sourceDocumentUrl(cik, source) || 'Source unavailable'}`).join('; ');
  return [
    `# ${name || ticker} (${ticker}) — Research brief`,
    `Exported ${new Date().toISOString()}. Data observed ${snapshot.observedAt}.`,
    `Reporting period: ${snapshot.period ? periodLabel(snapshot.period) : 'Unavailable'}.`,
    '## Financial snapshot',
    '| Metric | Value | Basis | Source evidence |', '| --- | ---: | --- | --- |',
    ...snapshot.metrics.map((m) => `| ${clean(m.label)} | ${formatValue(m.value, m.format)} | ${clean(m.classification)}${m.formula ? `: ${clean(m.formula)}` : ''} | ${clean(sources(m))} |`),
    '\n## Analyst notes', notes || 'No notes saved.',
    '\n## Selected evidence',
    ...evidence.map((e) => `### ${e.label}\n${e.text || ''}\n${e.point ? `${formatValue(e.point.value, e.format || 'currency')} — ${e.point.formula || e.point.source?.formula || ''}\n${evidenceCalculations(e.point).map((c) => `${c.start} to ${c.end}: ${c.value} ${c.unit} = ${c.formula}`).join('; ')}\n${sources(e.point)}` : ''}\n${e.url || ''}`),
    '\n## Changes since review',
    ...changes.map((c) => `- ${c.label}: ${formatValue(c.before.value, 'currency')} → ${formatValue(c.after.value, 'currency')}. ${c.reason}. ${sources(c.after)}`),
    '\n## Saved peers', ...peerGroups.map((g) => `- ${g.name}: ${g.tickers.join(', ')}`),
    '\nFigures are SEC reported values or transparent calculations. Missing compatible contexts remain unavailable. Geographic scenarios are excluded. Notes are the analyst’s own interpretation.',
  ].join('\n\n');
}
