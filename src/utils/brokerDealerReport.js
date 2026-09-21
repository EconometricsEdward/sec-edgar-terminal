import { BROKER_DEALER_METRICS, brokerDealerMetricGroup } from './brokerDealerAnalytics.js';
import { isBrokerDealerForm } from './brokerDealerForms.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const cikOf = value => /^\d{1,10}$/.test(String(value || '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const text = (value, max = 1600) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '';
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
const fail = message => Object.assign(new Error(message), { status: 422 });
const ADJUSTED_LIABILITY_INPUTS = ['totalAssets', 'totalLiabilities', 'subordinatedDebt', 'totalEquity'];

function validatedCalculatedInputs(metric, byId, rawById) {
  // A calculated total needs the filed inputs and the balance-sheet proof. It
  // must not acquire a fabricated "reported" source of its own in an export.
  if (metric.id !== 'adjustedTotalLiabilities' || metric.basis !== 'calculated'
    || metric.validation?.id !== 'balance-sheet-with-subordinated-debt' || metric.validation.status !== 'consistent'
    || !Array.isArray(metric.metricIds) || metric.metricIds.length !== 2
    || !['totalLiabilities', 'subordinatedDebt'].every(id => metric.metricIds.includes(id))
    || !ADJUSTED_LIABILITY_INPUTS.every(id => byId.has(id)) || !text(metric.formula)) return null;
  const inputs = ADJUSTED_LIABILITY_INPUTS.map(id => rawById.get(id));
  if (inputs.some(input => input.basis !== 'reported' || input.currency !== 'USD')
    || new Set(inputs.map(input => `${input.periodEnd}:${input.source.url.split('#')[0]}:${input.source.page}`)).size !== 1) return null;
  const [assets, liabilities, debt, equity] = inputs;
  const tolerance = Math.max(1, ...inputs.map(input => finite(input.extraction?.scale) && input.extraction.scale > 0 ? input.extraction.scale : 1)) * 1.5;
  const calculated = liabilities.value + debt.value;
  if (debt.value <= tolerance || Math.abs(metric.value - calculated) > 0.000001
    || Math.abs(assets.value - calculated - equity.value) > tolerance) return null;
  return ADJUSTED_LIABILITY_INPUTS.map(id => byId.get(id));
}

function unavailableStatementNotes(rows, analysis) {
  const mapped = new Set(rows.map(row => brokerDealerMetricGroup(row.key)));
  const disclosed = new Set(analysis.coverage?.disclosedStatements || []);
  const notes = [];
  if (!mapped.has('income')) notes.push(disclosed.has('income')
    ? 'An income statement was identified, but no income amounts could be mapped with verified period and page evidence. Profitability is unavailable; inspect the original statement.'
    : 'No income statement amounts were mapped from the selected public attachment. Public filings may omit this statement; revenue, earnings and profitability are unavailable, not zero.');
  if (!mapped.has('cashflow')) notes.push(disclosed.has('cash-flows')
    ? 'A cash-flow statement was identified, but no cash-flow amounts could be mapped with verified period and page evidence. Inspect the original statement.'
    : 'No cash-flow statement amounts were mapped from the selected public attachment. Cash flows are unavailable and are not inferred from balance-sheet movements.');
  if (!mapped.has('capital')) notes.push('No verified regulatory-capital amounts were mapped from the selected public attachment. Accounting equity is not substituted for regulatory net capital.');
  return notes;
}

function sourceUrl(source, cik, accession, documentUrl) {
  if (!Number.isInteger(source?.page) || source.page < 1 || !text(source.text)) return null;
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || !['sec.gov', 'www.sec.gov', 'archives.sec.gov'].includes(url.hostname)
      || url.username || url.password || url.port || url.search
      || !url.pathname.startsWith(`/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/`)) return null;
    if (documentUrl && url.pathname !== new URL(documentUrl).pathname) return null;
    url.hash = `page=${source.page}`;
    return url.href;
  } catch { return null; }
}

function annualClassification(research, cik, accession, end, documentUrl) {
  // Filing-envelope metadata can remain unknown even after its selected PDF is
  // classified. Only the attachment-level classifications establish its scope.
  const classifications = [research.classification, research.analysis?.classification].filter(Boolean);
  const classification = research.analysis?.classification || research.classification;
  if (!classification || classification.version !== 1 || classification.family !== 'annual-report'
    || classifications.some(item => item.version !== 1 || item.family !== classification.family))
    throw fail('This export requires a document classified as an annual report. Periodic FOCUS (Part II, Part IIA or Schedule I) and unclassified X-17A-5 documents cannot be exported on an annual basis. Open Analysis to inspect the selected filing or choose an annual-report attachment.');
  if (classification.period?.end && classification.period.end !== end)
    throw fail('The classified document period does not match the financial statement period. Review the original attachment before exporting.');
  const evidence = (classification.evidence || []).flatMap(item => {
    const url = sourceUrl({ ...item, text: item.excerpt }, cik, accession, documentUrl);
    return url ? [{ kind: text(item.kind, 80), page: item.page, url, excerpt: text(item.excerpt) }] : [];
  });
  const annualEvidence = evidence.some(item => item.kind === 'annual-heading' || item.kind === 'part' && /\bpart\s+III\b/i.test(item.excerpt))
    || classification.period?.frequency === 'annual' && evidence.some(item => item.kind === 'auditor-report') && evidence.some(item => item.kind === 'reporting-period');
  if (!annualEvidence) throw fail('The annual-report classification needs page-level evidence from the selected SEC attachment before it can be exported. Review the original report.');
  const auditStatus = classification.audit?.status;
  const audit = auditStatus === 'auditor-report-present' && evidence.some(item => item.kind === 'auditor-report')
    ? { status: auditStatus, scope: text(classification.audit.scope, 160) || null }
    : auditStatus === 'explicitly-unaudited' && evidence.some(item => item.kind === 'unaudited')
      ? { status: auditStatus, scope: text(classification.audit.scope, 160) || null }
      : { status: 'not-established', scope: null };
  const start = date(classification.period?.start);
  return { version: 1, family: 'annual-report', label: 'Annual report',
    parts: [...new Set((classification.parts || []).map(value => text(value, 80)).filter(Boolean))], audit,
    period: { start: start && start <= end ? start : null, end,
      frequency: ['annual', 'quarterly', 'monthly', 'other'].includes(classification.period?.frequency) ? classification.period.frequency : 'unknown' },
    components: [...new Set((classification.components || []).map(value => text(value, 100)).filter(Boolean))], evidence,
    limitations: (classification.limitations || []).map(value => text(value)).filter(Boolean) };
}

function auditDescription(audit) {
  if (audit.status === 'auditor-report-present') return `Auditor report identified${audit.scope === 'financial-condition' ? ' for the statement of financial condition' : audit.scope === 'financial-statements' ? ' for the financial statements' : ''}. Read the original opinion for its scope and conclusion.`;
  if (audit.status === 'explicitly-unaudited') return 'The selected document explicitly identifies unaudited material. The annual-report family does not establish audit assurance.';
  return 'Audit status not established from the selected attachment. A Part III or annual-report label alone does not establish an auditor opinion.';
}

function metricReportingPeriod(metric, end) {
  const duration = ['income', 'cashflow'].includes(brokerDealerMetricGroup(metric.id)) || metric.id === 'dividendsPaid';
  if (!duration) return { periodType: 'instant', start: null, basis: 'instant', reportedPeriod: `As of ${end}` };
  const start = date(metric.periodStart), validStart = start && start <= end ? start : null;
  const days = validStart ? (Date.parse(end) - Date.parse(validStart)) / 86400000 + 1 : null;
  const months = validStart ? null : metric.durationMonths;
  const basis = months === 12 || days >= 365 && days <= 366 ? 'annual'
    : months === 3 || days >= 89 && days <= 92 ? 'quarter'
      : months === 1 || days >= 28 && days <= 31 ? 'month' : 'duration';
  return { periodType: 'duration', start: validStart, basis,
    reportedPeriod: validStart ? `${validStart} to ${end}` : `Ending ${end}; start not established` };
}

/** PDF-only broker-dealers share Reports' export schema without inventing XBRL
 * facts, parent-company identities, missing income or quarterly observations. */
export function buildBrokerDealerReport(research, { id = research?.company?.cik, basis = 'annual', generatedAt = new Date().toISOString() } = {}) {
  const analysis = research?.analysis, filing = research?.filing, cik = cikOf(research?.company?.cik);
  const accession = filing?.accessionNumber || filing?.accession;
  const end = date(analysis?.periodEnd), filed = date(filing?.filingDate);
  if (basis !== 'annual') throw fail('X-17A-5 public annual reports support only the annual reporting basis. Quarter and TTM figures are unavailable.');
  if (!cik || cikOf(id) !== cik || !text(research?.company?.name) || !isBrokerDealerForm(filing?.form)
    || !/^\d{10}-\d{2}-\d{6}$/.test(accession || '') || !filed || !end || !Number.isFinite(Date.parse(generatedAt))
    || cikOf(analysis?.cik) !== cik || analysis?.accession !== accession || !isBrokerDealerForm(analysis?.form))
    throw fail('The broker-dealer annual report needs a verified SEC registrant, filing, statement period and readable financial figures. Open the original annual-report document.');
  const documentUrl = sourceUrl({ url: research.selectedDocument?.url || analysis.documentUrl, page: 1, text: 'Selected document' }, cik, accession);
  if (!documentUrl) throw fail('The selected broker-dealer attachment needs a verified SEC source URL before it can be exported.');
  const classification = annualClassification(research, cik, accession, end, documentUrl);
  const sources = [], rows = [], byId = new Map(), rawById = new Map();
  for (const metric of analysis.metrics || []) {
    const url = sourceUrl(metric.source, cik, accession, documentUrl);
    if (!BROKER_DEALER_METRICS[metric.id] || metric.id === 'adjustedTotalLiabilities' || byId.has(metric.id) || !finite(metric.value)
      || metric.unit !== 'USD' || metric.currency !== 'USD' || metric.periodEnd !== end || metric.basis !== 'reported' || !url) continue;
    const sourceId = `S${String(sources.length + 1).padStart(4, '0')}`;
    const reportedLabel = text(metric.extraction?.reportedLabel || metric.label);
    const metricPeriod = metricReportingPeriod(metric, end);
    sources.push({ id: sourceId, label: `${reportedLabel} · ${end} · PDF page ${metric.source.page}`, url,
      form: filing.form, periodEnd: end, start: metricPeriod.start, filed, accession, concept: `X-17A-5:${metric.id}`, unit: 'USD', value: metric.value,
      note: `Page ${metric.source.page}. Reported ${reportedLabel}. ${text(metric.source.text)}${metric.extraction?.unitEvidence ? ` Units: ${text(metric.extraction.unitEvidence)}` : ''}${metric.source.method === 'ocr' ? ' Read through OCR; verify the original page.' : ''}` });
    const row = { key: metric.id, metric: BROKER_DEALER_METRICS[metric.id], p0: metric.value, value: metric.value, unit: 'usd',
      classification: 'reported', period: end, ...metricPeriod, formula: '', sourceIds: [sourceId], sourceRefs: sourceId,
      page: metric.source.page, reportedLabel, evidence: text(metric.source.text),
      confidence: text(metric.confidence, 20), reason: '' };
    rows.push(row); byId.set(metric.id, row); rawById.set(metric.id, metric);
  }
  if (!rows.length) throw fail('No financial amounts with a verified period and page-level SEC evidence could be extracted from this public X-17A-5 report. Open the original statement; scanned documents may require manual review.');
  for (const metric of analysis.metrics || []) {
    if (!BROKER_DEALER_METRICS[metric.id] || byId.has(metric.id) || !finite(metric.value)
      || metric.unit !== 'USD' || metric.currency !== 'USD' || metric.periodEnd !== end) continue;
    const inputs = validatedCalculatedInputs(metric, byId, rawById);
    if (!inputs) continue;
    const sourceIds = [...new Set(inputs.flatMap(input => input.sourceIds))];
    const row = { key: metric.id, metric: `${BROKER_DEALER_METRICS[metric.id]} (calculated)`, p0: metric.value, value: metric.value, unit: 'usd',
      classification: 'calculated', period: end, periodType: 'instant', start: null, basis: 'instant', formula: text(metric.formula), sourceIds, sourceRefs: sourceIds.join(', '),
      page: inputs[0].page, reportedLabel: 'Calculated from reported inputs', reportedPeriod: `As of ${end}`,
      evidence: `${text(metric.formula)}. ${inputs.map(input => `${input.reportedLabel}: ${input.value} USD (PDF page ${input.page})`).join('; ')}.`,
      confidence: inputs.every(input => input.confidence === 'high') ? 'high' : 'medium', reason: '' };
    const subtotalIndex = rows.findIndex(input => input.key === 'totalLiabilities');
    rows.splice(subtotalIndex + 1, 0, row); byId.set(metric.id, row);
  }
  const ratios = [];
  for (const ratio of analysis.ratios || []) {
    if (!finite(ratio.value) || ratio.periodEnd !== end || ratio.basis !== 'calculated' || !ratio.metricIds?.length
      || ratio.metricIds.some(id => !byId.has(id)) || !text(ratio.formula)) continue;
    const sourceIds = [...new Set(ratio.metricIds.flatMap(id => byId.get(id).sourceIds))];
    const durationInputs = ratio.metricIds.map(id => byId.get(id)).filter(row => row.periodType === 'duration');
    const durationStarts = [...new Set(durationInputs.map(row => row.start))];
    const durationBases = [...new Set(durationInputs.map(row => row.basis))];
    ratios.push({ key: ratio.id, metric: text(ratio.label), p0: ratio.value, value: ratio.value,
      unit: ratio.format === 'percent' ? 'percent' : 'ratio', classification: 'calculated', period: end,
      periodType: durationInputs.length ? 'duration' : 'instant', start: durationStarts.length === 1 ? durationStarts[0] : null,
      basis: durationInputs.length ? durationBases.length === 1 ? durationBases[0] : 'duration' : 'instant',
      formula: text(ratio.formula), sourceIds, sourceRefs: sourceIds.join(', '), reason: '' });
  }
  const columns = [{ key: 'metric', label: 'Measure', format: 'text', width: 2.6 }, { key: 'p0', label: end, format: 'number', formatKey: 'unit' }];
  const sections = [
    { id: 'balance', title: 'Statement of financial condition', description: 'Reported assets, liabilities and equity for the selected legal entity. Any calculated liabilities total is separately labeled and retains the reported subtotal.', rows: rows.filter(row => brokerDealerMetricGroup(row.key) === 'balance') },
    { id: 'capital', title: 'Regulatory capital', description: 'Only the net-capital figures disclosed in the public attachment are included. Accounting equity is a different measure.', rows: rows.filter(row => brokerDealerMetricGroup(row.key) === 'capital') },
    { id: 'income', title: 'Income statement', description: 'Income figures explicitly disclosed for the source reporting period. Amounts are not annualized.', rows: rows.filter(row => brokerDealerMetricGroup(row.key) === 'income') },
    { id: 'cashflow', title: 'Cash flow statement', description: 'Cash-flow totals explicitly disclosed for the source reporting period. Amounts are not annualized.', rows: rows.filter(row => brokerDealerMetricGroup(row.key) === 'cashflow') },
    { id: 'statement-notes', title: 'Statement notes', description: 'Disclosed note details and commitments. These can overlap statement balances and must not be added together as balance-sheet totals. Dividends are flows over their disclosed period; they are not annualized.', rows: rows.filter(row => brokerDealerMetricGroup(row.key) === 'notes') },
    { id: 'ratios', title: 'Ratios', description: 'Calculations use compatible, disclosed period-end inputs. Percentages are fractions in the underlying workbook.', rows: ratios },
  ].filter(section => section.rows.length).map(section => ({ ...section, columns,
    footnote: section.id === 'ratios' ? 'Accounting leverage is not adjusted for collateral netting or asset liquidation values. Ratios are research measures, not a regulatory compliance determination.' : 'USD amounts are normalized to whole dollars. Missing amounts are unavailable, not zero.' }));
  sections.push({ id: 'evidence', title: 'Statement evidence', description: 'Extracted page references and reported wording for manual review. Calculated amounts list the underlying reported inputs and reconciliation evidence.',
    columns: [{ key: 'metric', label: 'Measure', format: 'text' }, { key: 'page', label: 'PDF page', format: 'number' },
      { key: 'reportedLabel', label: 'Reported label', format: 'text' }, { key: 'reportedPeriod', label: 'Statement period', format: 'text' }, { key: 'evidence', label: 'Statement extract', format: 'text', width: 3.5 }], rows });
  sections.push({ id: 'observations', title: 'Metric methodology and source references', pdfRowLimit: 0,
    columns: [{ key: 'metric', label: 'Measure', format: 'text' }, { key: 'start', label: 'Period start', format: 'date' }, { key: 'period', label: 'Period end', format: 'date' },
      { key: 'value', label: 'Value', format: 'number', formatKey: 'unit' }, { key: 'classification', label: 'Status', format: 'text' },
      { key: 'formula', label: 'Formula', format: 'text' }, { key: 'sourceRefs', label: 'Source IDs', format: 'text' }], rows: [...rows, ...ratios] });
  const headline = ['totalAssets', byId.has('adjustedTotalLiabilities') ? 'adjustedTotalLiabilities' : 'totalLiabilities', 'totalEquity', 'netCapital', 'excessNetCapital'];
  const summary = headline.map(key => byId.get(key)).filter(Boolean).concat(ratios.filter(row => row.key === 'assetsToEquity')).slice(0, 6)
    .map(row => ({ label: row.metric, value: row.value, unit: row.unit, detail: `${end} · ${row.classification}`, sourceIds: row.sourceIds }));
  if (!summary.length) summary.push(...rows.slice(0, 6).map(row => ({ label: row.metric, value: row.value, unit: row.unit, detail: `${end} · reported`, sourceIds: row.sourceIds })));
  const highlights = (analysis.findings || []).filter(finding => !finding.metricIds?.length || finding.metricIds.every(id => byId.has(id)))
    .map(finding => ({ title: text(finding.title), text: text(finding.text, 2400) })).filter(finding => finding.title && finding.text);
  const missing = Object.keys(BROKER_DEALER_METRICS).filter(key => !byId.has(key));
  const classificationEvidence = classification.evidence.map((item, index) => {
    const sourceId = `C${String(index + 1).padStart(4, '0')}`;
    sources.push({ id: sourceId, label: `Document classification: ${item.kind} · PDF page ${item.page}`, url: item.url,
      form: filing.form, periodEnd: end, filed, accession, note: `Page ${item.page}. ${item.excerpt}` });
    return { ...item, sourceId };
  });
  const auditSummary = auditDescription(classification.audit);
  const periodRange = `${classification.period.start || 'Start not established'} to ${end}`;
  sections.unshift({ id: 'report-scope', title: 'Report scope', description: 'Document family, reporting period and audit evidence are assessed separately. An annual filing can publish only a statement of financial condition and notes.',
    columns: [{ key: 'item', label: 'Item', format: 'text', width: 1 }, { key: 'value', label: 'Document scope', format: 'text', width: 3 }],
    rows: [
      { item: 'SEC form', value: filing.form },
      { item: 'Document family', value: classification.label },
      { item: 'Disclosed parts', value: classification.parts.join(', ') || 'Not established' },
      { item: 'Reporting period', value: `${periodRange}; frequency: ${classification.period.frequency}` },
      { item: 'Audit evidence', value: auditSummary },
      { item: 'Document components', value: classification.components.length ? classification.components.join(', ') : 'Not established' },
      ...classificationEvidence.map(item => ({ item: `${item.kind} · page ${item.page} · ${item.sourceId}`, value: `${item.excerpt}\n${item.url}` })),
    ] });
  const notes = [...new Set([
    'Public X-17A-5 annual-report extraction for the exact SEC registrant. The report does not substitute listed-parent financial data or confidential FOCUS submissions.',
    'Financial condition and regulatory capital are period-end observations. Income is included only when the annual public attachment discloses it. Missing income and cash-flow statements are not estimated.',
    'Only the selected attachment and annual reporting period are included. No quarterly or trailing-twelve-month figures are inferred.',
    'X-17A-5 is a shared SEC form code. This attachment is classified separately as an annual report; periodic Part II, Part IIA and Schedule I FOCUS schedules are not treated as annual financial statements.',
    auditSummary,
    `Source reporting period: ${periodRange}; frequency: ${classification.period.frequency}. Duration amounts retain their reported period and are not annualized.`,
    ...classification.limitations,
    ...unavailableStatementNotes(rows, analysis),
    ...(byId.has('adjustedTotalLiabilities') ? ['Liabilities including separately presented subordinated debt is a calculated amount, not an additional reported row. The original subtotal, subordinated debt and equity remain visible; the calculation is included only when these inputs reconcile to assets within presentation rounding.'] : []),
    ...(rows.some(row => brokerDealerMetricGroup(row.key) === 'notes') ? ['Statement-note details may be components of other balances or off-balance-sheet commitments. They are kept separate from the balance sheet; no additional asset, liability, netting benefit or exposure is inferred.'] : []),
    ...(analysis.limitations || []).map(value => text(value)),
    ...(missing.length ? [`Measures unavailable in this extract: ${missing.map(key => BROKER_DEALER_METRICS[key]).join('; ')}.`] : []),
    ...(research.coverage?.complete === false ? ['Filing discovery checked a bounded SEC submission history. Older public annual reports may exist outside the checked history.'] : []),
    'Statement extracts and PDF page references are included in the workbook. Original SEC document links are listed in the PDF source register.',
  ])];
  return { schema: 'edgar.report.v1', kind: 'company', generatedAt: new Date(generatedAt).toISOString(),
    entity: { id: String(id), name: text(research.company.name, 240), cik }, title: `${text(research.company.name, 240)} — Broker-dealer annual report`,
    subtitle: `SEC X-17A-5 annual financial analysis · CIK ${cik}`,
    period: { label: `Public annual report ending ${end}`, start: classification.period.start, asOf: end, filingDate: filed, basis: 'annual', frequency: classification.period.frequency },
    classification: { ...classification, evidence: classificationEvidence },
    summary, highlights, sections, sources, notes,
    coverage: { status: missing.length || analysis.status !== 'ready' || research.coverage?.complete === false ? 'partial' : 'ready',
      message: `${rows.filter(row => row.classification === 'reported').length} reported broker-dealer measures have page-level evidence for ${end}.${rows.some(row => row.classification === 'calculated') ? ` ${rows.filter(row => row.classification === 'calculated').length} additional amount is calculated from reconciled reported inputs.` : ''} ${ratios.length} compatible ratios are calculated. Public-attachment coverage may be incomplete.`,
      recordCount: rows.length + ratios.length, availableMetrics: rows.length, totalMetrics: Object.keys(BROKER_DEALER_METRICS).length } };
}
