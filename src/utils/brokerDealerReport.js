import { BROKER_DEALER_METRICS } from './brokerDealerAnalytics.js';
import { isBrokerDealerAnnualForm } from './brokerDealerForms.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const cikOf = value => /^\d{1,10}$/.test(String(value || '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const text = (value, max = 1600) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '';
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
const fail = message => Object.assign(new Error(message), { status: 422 });
const capital = new Set(['netCapital', 'minimumNetCapital', 'excessNetCapital', 'haircuts']);
const income = new Set(['totalRevenue', 'netRevenue', 'netIncome']);
const cashflow = new Set(['operatingCashFlow', 'investingCashFlow', 'financingCashFlow', 'changeInCash']);

function sourceUrl(source, cik, accession) {
  if (!Number.isInteger(source?.page) || source.page < 1 || !text(source.text)) return null;
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || !['sec.gov', 'www.sec.gov', 'archives.sec.gov'].includes(url.hostname)
      || url.username || url.password || url.port || url.search
      || !url.pathname.startsWith(`/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/`)) return null;
    url.hash = `page=${source.page}`;
    return url.href;
  } catch { return null; }
}

/** PDF-only broker-dealers share Reports' export schema without inventing XBRL
 * facts, parent-company identities, missing income or quarterly observations. */
export function buildBrokerDealerReport(research, { id = research?.company?.cik, basis = 'annual', generatedAt = new Date().toISOString() } = {}) {
  const analysis = research?.analysis, filing = research?.filing, cik = cikOf(research?.company?.cik);
  const accession = filing?.accessionNumber || filing?.accession;
  const end = date(analysis?.periodEnd), filed = date(filing?.filingDate);
  if (basis !== 'annual') throw fail('X-17A-5 public annual reports support only the annual reporting basis. Quarter and TTM figures are unavailable.');
  if (!cik || cikOf(id) !== cik || !text(research?.company?.name) || !isBrokerDealerAnnualForm(filing?.form)
    || !/^\d{10}-\d{2}-\d{6}$/.test(accession || '') || !filed || !end || !Number.isFinite(Date.parse(generatedAt))
    || cikOf(analysis?.cik) !== cik || analysis?.accession !== accession || !isBrokerDealerAnnualForm(analysis?.form))
    throw fail('The broker-dealer annual report needs a verified SEC registrant, filing, statement period and readable financial figures. Open the original annual-report document.');
  const sources = [], rows = [], byId = new Map();
  for (const metric of analysis.metrics || []) {
    const url = sourceUrl(metric.source, cik, accession);
    if (!BROKER_DEALER_METRICS[metric.id] || byId.has(metric.id) || !finite(metric.value)
      || metric.unit !== 'USD' || metric.periodEnd !== end || metric.basis !== 'reported' || !url) continue;
    const sourceId = `S${String(sources.length + 1).padStart(4, '0')}`;
    sources.push({ id: sourceId, label: `${text(metric.label)} · page ${metric.source.page}`, url,
      form: filing.form, periodEnd: end, filed, accession, concept: `X-17A-5:${metric.id}`, unit: 'USD', value: metric.value,
      note: `Page ${metric.source.page}. ${text(metric.source.text)}${metric.extraction?.unitEvidence ? ` Units: ${text(metric.extraction.unitEvidence)}` : ''}` });
    const row = { key: metric.id, metric: BROKER_DEALER_METRICS[metric.id], p0: metric.value, value: metric.value, unit: 'usd',
      classification: 'reported', period: end, basis: 'annual', formula: '', sourceIds: [sourceId], sourceRefs: sourceId,
      page: metric.source.page, reportedLabel: text(metric.extraction?.reportedLabel || metric.label), evidence: text(metric.source.text),
      confidence: text(metric.confidence, 20), reason: '' };
    rows.push(row); byId.set(metric.id, row);
  }
  if (!rows.length) throw fail('No financial amounts with a verified period and page-level SEC evidence could be extracted from this public X-17A-5 report. Open the original statement; scanned documents may require manual review.');
  const ratios = [];
  for (const ratio of analysis.ratios || []) {
    if (!finite(ratio.value) || ratio.periodEnd !== end || ratio.basis !== 'calculated' || !ratio.metricIds?.length
      || ratio.metricIds.some(id => !byId.has(id)) || !text(ratio.formula)) continue;
    const sourceIds = [...new Set(ratio.metricIds.flatMap(id => byId.get(id).sourceIds))];
    ratios.push({ key: ratio.id, metric: text(ratio.label), p0: ratio.value, value: ratio.value,
      unit: ratio.format === 'percent' ? 'percent' : 'ratio', classification: 'calculated', period: end, basis: 'annual',
      formula: text(ratio.formula), sourceIds, sourceRefs: sourceIds.join(', '), reason: '' });
  }
  const columns = [{ key: 'metric', label: 'Measure', format: 'text', width: 2.6 }, { key: 'p0', label: end, format: 'number', formatKey: 'unit' }];
  const sections = [
    { id: 'balance', title: 'Statement of financial condition', description: 'Reported assets, liabilities and equity for the selected broker-dealer legal entity.', rows: rows.filter(row => !capital.has(row.key) && !income.has(row.key) && !cashflow.has(row.key)) },
    { id: 'capital', title: 'Regulatory capital', description: 'Only the net-capital figures disclosed in the public attachment are included. Accounting equity is a different measure.', rows: rows.filter(row => capital.has(row.key)) },
    { id: 'income', title: 'Income statement', description: 'Annual income figures are included only when explicitly disclosed and mapped in the selected public attachment.', rows: rows.filter(row => income.has(row.key)) },
    { id: 'cashflow', title: 'Cash flow statement', description: 'Annual cash-flow totals explicitly disclosed in the selected public attachment.', rows: rows.filter(row => cashflow.has(row.key)) },
    { id: 'ratios', title: 'Ratios', description: 'Calculations use compatible, disclosed period-end inputs. Percentages are fractions in the underlying workbook.', rows: ratios },
  ].filter(section => section.rows.length).map(section => ({ ...section, columns,
    footnote: section.id === 'ratios' ? 'Accounting leverage is not adjusted for collateral netting or asset liquidation values. Ratios are research measures, not a regulatory compliance determination.' : 'USD amounts are normalized to whole dollars. Missing amounts are unavailable, not zero.' }));
  sections.push({ id: 'evidence', title: 'Statement evidence', description: 'Extracted page references and reported wording for manual review.',
    columns: [{ key: 'metric', label: 'Measure', format: 'text' }, { key: 'page', label: 'PDF page', format: 'number' },
      { key: 'reportedLabel', label: 'Reported label', format: 'text' }, { key: 'evidence', label: 'Statement extract', format: 'text', width: 3.5 }], rows });
  sections.push({ id: 'observations', title: 'Metric methodology and source references', pdfRowLimit: 0,
    columns: [{ key: 'metric', label: 'Measure', format: 'text' }, { key: 'period', label: 'Period end', format: 'date' },
      { key: 'value', label: 'Value', format: 'number', formatKey: 'unit' }, { key: 'classification', label: 'Status', format: 'text' },
      { key: 'formula', label: 'Formula', format: 'text' }, { key: 'sourceRefs', label: 'Source IDs', format: 'text' }], rows: [...rows, ...ratios] });
  const headline = ['totalAssets', 'totalLiabilities', 'totalEquity', 'netCapital', 'excessNetCapital'];
  const summary = headline.map(key => byId.get(key)).filter(Boolean).concat(ratios.filter(row => row.key === 'assetsToEquity')).slice(0, 6)
    .map(row => ({ label: row.metric, value: row.value, unit: row.unit, detail: `${end} · ${row.classification}`, sourceIds: row.sourceIds }));
  if (!summary.length) summary.push(...rows.slice(0, 6).map(row => ({ label: row.metric, value: row.value, unit: row.unit, detail: `${end} · reported`, sourceIds: row.sourceIds })));
  const highlights = (analysis.findings || []).filter(finding => !finding.metricIds?.length || finding.metricIds.every(id => byId.has(id)))
    .map(finding => ({ title: text(finding.title), text: text(finding.text, 2400) })).filter(finding => finding.title && finding.text);
  const missing = Object.keys(BROKER_DEALER_METRICS).filter(key => !byId.has(key));
  const notes = [...new Set([
    'Public X-17A-5 annual-report extraction for the exact SEC registrant. The report does not substitute listed-parent financial data or confidential FOCUS submissions.',
    'Financial condition and regulatory capital are period-end observations. Income is included only when the annual public attachment discloses it. Missing income and cash-flow statements are not estimated.',
    'Only the selected attachment and annual reporting period are included. No quarterly or trailing-twelve-month figures are inferred.',
    ...(analysis.limitations || []).map(value => text(value)),
    ...(missing.length ? [`Measures unavailable in this extract: ${missing.map(key => BROKER_DEALER_METRICS[key]).join('; ')}.`] : []),
    ...(research.coverage?.complete === false ? ['Filing discovery checked a bounded SEC submission history. Older public annual reports may exist outside the checked history.'] : []),
    'Statement extracts and PDF page references are included in the workbook. Original SEC document links are listed in the PDF source register.',
  ])];
  return { schema: 'edgar.report.v1', kind: 'company', generatedAt: new Date(generatedAt).toISOString(),
    entity: { id: String(id), name: text(research.company.name, 240), cik }, title: `${text(research.company.name, 240)} — Broker-dealer annual report`,
    subtitle: `SEC X-17A-5 annual financial analysis · CIK ${cik}`,
    period: { label: `Public annual report ending ${end}`, asOf: end, filingDate: filed, basis: 'annual' },
    summary, highlights, sections, sources, notes,
    coverage: { status: missing.length || analysis.status !== 'ready' || research.coverage?.complete === false ? 'partial' : 'ready',
      message: `${rows.length} of ${Object.keys(BROKER_DEALER_METRICS).length} supported broker-dealer measures have page-level evidence for ${end}. ${ratios.length} compatible ratios are calculated. Public-attachment coverage may be incomplete.`,
      recordCount: rows.length + ratios.length, availableMetrics: rows.length, totalMetrics: Object.keys(BROKER_DEALER_METRICS).length } };
}
