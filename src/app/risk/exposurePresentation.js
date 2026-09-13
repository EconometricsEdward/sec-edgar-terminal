export const EXPOSURE_CATEGORY_LABELS = Object.freeze({
  revenue: 'Revenue', 'input-costs': 'Input costs', borrowing: 'Borrowing',
  investments: 'Investments', currencies: 'Currencies',
});

export const EXPOSURE_AMOUNT_LABELS = Object.freeze({
  balance: 'Reported balance', notional: 'Derivative notional', sensitivity: 'Disclosed sensitivity',
  'historical-activity': 'Reported activity', volume: 'Reported volume',
});

export function exposureAmountLabel(kind) { return EXPOSURE_AMOUNT_LABELS[kind] || 'Amount in the disclosure'; }

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** One record per cited passage, not a company-wide exposure total. */
export function companyExposureMapCsv(data) {
  const headers = ['Ticker', 'Company', 'CIK', 'SEC filing cutoff', 'Map checked at', 'Map status', 'Evidence id', 'Business channel', 'Market topic', 'Channel explanation', 'CFTC benchmark', 'Report family', 'Contract code', 'Benchmark fit', 'Benchmark limitation', 'Disclosure direction', 'Source role', 'SEC form', 'Filed date', 'Fiscal period ended', 'SEC source', 'Passage', 'Reported amounts and purpose', 'Amount context', 'Interpretation'];
  const records = [];
  for (const row of data?.rows || []) {
    for (const evidence of row.evidence || []) {
      const amounts = evidence.amounts || [];
      const benchmark = evidence.benchmark;
      records.push([
        data.ticker, data.companyName, data.cik, data.asOf || 'Latest eligible filings', data.checkedAt || data.generatedAt, data.status,
        evidence.id, EXPOSURE_CATEGORY_LABELS[row.category] || row.categoryLabel, row.marketLabel, row.channelExplanation,
        benchmark?.label || 'No supported benchmark established in this passage', benchmark?.family || '', benchmark?.contract || '',
        benchmark?.fit || 'unmapped', benchmark?.basisLimit || row.benchmarkUnavailableReason || '', evidence.disclosureDirection || 'connection', evidence.role, evidence.form, evidence.filed,
        evidence.reportDate || 'Not supplied', evidence.url, evidence.text,
        amounts.length ? amounts.map(amount => `${exposureAmountLabel(amount.kind)}: ${amount.text}`).join(' | ') : 'No amount safely extracted; review the source for amounts',
        amounts.map(amount => amount.context || '').join(' | '),
        'Automated evidence classification requires review. Amounts retain their own scope and dates; do not add across passages, channels, periods, or currencies. CFTC positions are aggregate market context, not company holdings.',
      ]);
    }
  }
  return [headers, ...records].map(record => record.map(csvCell).join(',')).join('\r\n');
}

const plain = value => String(value ?? '').replace(/[\r\n]+/g, ' ');
const quote = value => String(value ?? '').split(/\r?\n/).map(line => `> ${line}`).join('\n');

export function companyExposureEvidenceMarkdown(data, row) {
  if (!data || !row) return '';
  return [
    `# ${plain(data.ticker)} — ${plain(EXPOSURE_CATEGORY_LABELS[row.category] || row.categoryLabel)} / ${plain(row.marketLabel)}`,
    '', `${plain(data.companyName)} · SEC CIK ${plain(data.cik)}`,
    `SEC filing cutoff: ${plain(data.asOf || 'Latest eligible filings')}. Map checked: ${plain(data.checkedAt || data.generatedAt)}. Coverage status: ${plain(data.status)}.`,
    '', '## Business connection', '', plain(row.channelExplanation),
    'The channel classification is a reading aid based on the cited passages. It does not establish materiality or the company’s complete exposure.',
    '', '## CFTC market connection', '',
    row.benchmark ? `${plain(row.benchmark.label)} · ${plain(row.benchmark.family)} · contract ${plain(row.benchmark.contract)} · ${row.benchmark.fit === 'named-reference' ? 'Named benchmark reference' : 'Suggested proxy'}. ${plain(row.benchmark.basisLimit)}` : 'No supported CFTC benchmark has been established for this disclosure.',
    ...(row.benchmark ? [`Explore the market: https://secedgarterminal.com/market?${new URLSearchParams({ tab: 'positioning', family: row.benchmark.family, contract: row.benchmark.contract, group: row.benchmark.group, history: '1y', display: 'net-oi' })}`, 'This market link opens the latest available report; this company evidence export does not contain a CFTC observation snapshot.'] : []),
    '', '## Source evidence', '',
    ...(row.evidence || []).flatMap(evidence => [
      `### ${plain(evidence.form)} · Filed ${plain(evidence.filed)} · Fiscal period ended ${plain(evidence.reportDate || 'not supplied')}`,
      '', `Source role: ${plain(evidence.role)}. Accession: ${plain(evidence.accession)}.`, evidence.url, '', quote(evidence.text), '',
      ...(evidence.disclosureDirection === 'qualifying-or-negative' ? ['This passage qualifies or denies an exposure. Read it alongside the other dated evidence; it does not establish the company’s complete current position.', ''] : []),
      evidence.benchmark ? `Benchmark support in this passage: ${plain(evidence.benchmark.label)} — ${evidence.benchmark.fit === 'named-reference' ? 'named reference' : 'suggested proxy'}. ${plain(evidence.benchmark.basisLimit)}` : 'No supported benchmark is established by this passage.', '',
      ...(evidence.amounts?.length ? evidence.amounts.flatMap(amount => [
        `${exposureAmountLabel(amount.kind)}: ${plain(amount.text)}`, `Context: ${plain(amount.context || evidence.text)}`, '',
      ]) : ['No amount was safely associated with the exposure in this matched passage.', '']),
    ]),
    '## Interpretation and coverage', '',
    'Amounts are source observations, not an estimated loss or an aggregate exposure. Balances, derivative notionals, sensitivities, and activity volumes are different measures. Each retains the dates, currency, qualifiers, and scope of its source passage. A fiscal period ended date does not date every amount quoted in that filing.',
    'Repeated or related passages across periods and channels must not be added. A missing passage does not establish that an exposure is absent or has disappeared. CFTC positions describe market-wide trader categories, not the company’s own positions.',
    ...(data.limitations || []).map(plain),
    '', `Open this company’s exposure map: https://secedgarterminal.com/risk?${new URLSearchParams({ ticker: data.ticker, view: 'exposures', ...(data.asOf ? { asOf: data.asOf } : {}) })}`,
  ].join('\n');
}
