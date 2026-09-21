/**
 * Conservative, deterministic extraction of public X-17A-5 financial statements.
 * This is a source-reading aid, not an audit or a reconstruction of confidential
 * FOCUS schedules. Values need an identifiable row, currency basis and period.
 */
export const BROKER_DEALER_ANALYTICS_VERSION = 2;

export const BROKER_DEALER_METRICS = {
  totalAssets: 'Total assets',
  totalLiabilities: 'Reported liabilities total / subtotal',
  adjustedTotalLiabilities: 'Liabilities including separately presented subordinated debt',
  totalEquity: 'Total equity / member capital',
  subordinatedDebt: 'Subordinated debt',
  cashAndEquivalents: 'Cash and cash equivalents',
  segregatedCash: 'Segregated cash',
  securitiesOwned: 'Securities / financial instruments owned',
  securitiesSoldShort: 'Securities / financial instruments sold short',
  reverseRepos: 'Securities purchased under agreements to resell',
  repos: 'Securities sold under agreements to repurchase',
  brokerReceivables: 'Receivables from brokers and clearing organizations',
  brokerPayables: 'Payables to brokers and clearing organizations',
  customerReceivables: 'Receivables from customers',
  customerPayables: 'Payables to customers',
  securitiesBorrowed: 'Securities borrowed',
  securitiesLoaned: 'Securities loaned',
  fixedAssets: 'Furniture, equipment and other fixed assets, net',
  otherAssets: 'Other assets',
  parentReceivables: 'Receivables from parent',
  parentPayables: 'Payables to parent',
  accountsPayableAndAccruedExpenses: 'Accounts payable, accrued expenses and other liabilities',
  netRevenue: 'Net revenue',
  totalRevenue: 'Total revenue',
  interestIncome: 'Interest income',
  interestExpense: 'Interest expense',
  totalExpenses: 'Total expenses',
  pretaxIncome: 'Income / loss before income taxes',
  netIncome: 'Net income / loss',
  operatingCashFlow: 'Net cash from operating activities',
  investingCashFlow: 'Net cash from investing activities',
  financingCashFlow: 'Net cash from financing activities',
  changeInCash: 'Net change in cash',
  netCapital: 'Regulatory net capital',
  minimumNetCapital: 'Required minimum net capital',
  excessNetCapital: 'Excess net capital',
  haircuts: 'Net capital haircuts',
  ficcReceivables: 'Amounts due from FICC',
  cmeReceivables: 'Amounts due from CME',
  treasurySecuritiesOwned: 'U.S. Treasury securities owned',
  gseSecuritiesOwned: 'U.S. GSE securities owned',
  treasurySecuritiesSoldShort: 'U.S. Treasury securities sold short',
  collateralReceivedReusable: 'Collateral received eligible for sale or repledging',
  forwardReverseRepos: 'Forward-starting reverse repo commitments',
  forwardRepos: 'Forward-starting repo commitments',
  dividendsPaid: 'Dividends paid during the year',
};

const ALIASES = [
  ['totalAssets', /^(?:total )?assets$/],
  ['totalLiabilities', /^total liabilities$/],
  ['totalEquity', /^(?:total )?(?:(?:members?|partners?|stockholders?|shareholders?|owners?) (?:equity|capital|deficit)|equity|capital and (?:retained earnings|members equity))(?: \(deficit\))?$/],
  ['subordinatedDebt', /^(?:subordinated (?:debt|borrowings?|loans?)(?: from related part(?:y|ies))?|liabilities subordinated to (?:the )?claims of general creditors)$/],
  ['cashAndEquivalents', /^cash(?: and cash equivalents| and equivalents)?$/],
  ['segregatedCash', /^(?:cash (?:and (?:cash equivalents|securities) )?(?:segregated|held in segregation)(?: under (?:federal|regulatory) regulations?)?|segregated cash(?: and cash equivalents)?|cash segregated under federal and other regulations)$/],
  ['reverseRepos', /^(?:securities purchased under (?:agreements? to resell|resale agreements?)|reverse repurchase agreements?|reverse repos)(?: net)?$/],
  ['repos', /^(?:(?:securities|securities and reverse mortgage loans) sold under (?:agreements? to repurchase|repurchase agreements?)|repurchase agreements?|repos)(?: at fair value)?(?: net)?$/],
  ['securitiesOwned', /^(?:(?:securities|financial instruments|securities and (?:other )?financial instruments) owned|long positions)(?: (?:at|in) fair value)?(?: \(pledged as collateral with clearing organization\))?(?: net)?$/],
  ['securitiesSoldShort', /^(?:(?:securities|financial instruments|securities and (?:other )?financial instruments) sold(?: but)? not yet purchased|securities sold short|short positions)(?: (?:at|in) fair value)?(?: net)?$/],
  ['brokerReceivables', /^(?:receivables? from|due from) (?:brokers? (?:and )?dealers?(?: (?:and )?clearing (?:organizations?|brokers?)(?: and others)?)?|brokers?(?: and clearing (?:organizations?|brokers?))?|clearing (?:organizations?|brokers?))(?: net)?$/],
  ['brokerPayables', /^(?:payables? to|due to) (?:brokers? (?:and )?dealers?(?: (?:and )?clearing (?:organizations?|brokers?)(?: and others)?)?|brokers?(?: and clearing (?:organizations?|brokers?))?|clearing (?:organizations?|brokers?))(?: net)?$/],
  ['customerReceivables', /^(?:receivables? from|due from) customers?(?: net)?$/],
  ['customerPayables', /^(?:payables? to|due to) customers?(?: net)?$/],
  ['securitiesBorrowed', /^securities borrowed(?: at fair value| net)?$/],
  ['securitiesLoaned', /^securities (?:loaned|lent)(?: at fair value| net)?$/],
  ['fixedAssets', /^(?:(?:furniture (?:and )?)?equipment(?: (?:and )?leasehold improvements)?(?: and software)?|property (?:and )?equipment|fixed assets)(?: net)?$/],
  ['otherAssets', /^(?:total )?other assets(?: net)?$/],
  ['parentReceivables', /^(?:receivables? from|due from) (?:the )?parent(?: net)?$/],
  ['parentPayables', /^(?:payables? to|due to) (?:the )?parent(?: net)?$/],
  ['accountsPayableAndAccruedExpenses', /^(?:accounts payable (?:and )?accrued (?:expenses|liabilities)(?: and other liabilities)?|accrued expenses and other liabilities)$/],
  ['interestIncome', /^(?:total )?interest (?:income|revenues?)$/],
  ['interestExpense', /^(?:total )?interest expenses?$/],
  ['totalExpenses', /^total (?:operating )?expenses?$/],
  ['pretaxIncome', /^(?:net )?(?:income|loss)(?: \(loss\))? before (?:provision for )?income taxes?$/],
  ['netRevenue', /^(?:total )?net revenues?$/],
  ['totalRevenue', /^total revenues?$/],
  ['netIncome', /^net (?:income|loss)(?: \((?:income|loss)\))?(?: for the year)?$/],
  ['operatingCashFlow', /^(?:net )?cash (?:provided by(?: used in)?|used in(?: provided by)?|from) operating activities$/],
  ['investingCashFlow', /^(?:net )?cash (?:provided by(?: used in)?|used in(?: provided by)?|from) investing activities$/],
  ['financingCashFlow', /^(?:net )?cash (?:provided by(?: used in)?|used in(?: provided by)?|from) financing activities$/],
  ['changeInCash', /^net (?:change|increase|decrease|increase \(decrease\)|decrease \(increase\)) in cash(?: and cash equivalents)?$/],
  ['minimumNetCapital', /^(?:(?:minimum|required|minimum required|required minimum) net capital(?: requirement| required)?|net capital requirement)$/],
  ['excessNetCapital', /^(?:excess net capital|net capital in excess of (?:minimum|required|minimum required|required minimum) (?:net capital|requirement))$/],
  ['netCapital', /^(?:total )?net capital$/],
  ['haircuts', /^(?:total )?(?:haircuts(?: on (?:securities|positions))?|securities haircuts)$/],
];

const CAPITAL_IDS = new Set(['netCapital', 'minimumNetCapital', 'excessNetCapital', 'haircuts']);
const INCOME_IDS = new Set(['netRevenue', 'netIncome', 'totalRevenue', 'interestIncome', 'interestExpense', 'totalExpenses', 'pretaxIncome']);
const NOTE_IDS = new Set(['ficcReceivables', 'cmeReceivables', 'treasurySecuritiesOwned', 'gseSecuritiesOwned', 'treasurySecuritiesSoldShort', 'collateralReceivedReusable', 'forwardReverseRepos', 'forwardRepos', 'dividendsPaid']);
const ASSET_IDS = new Set(['totalAssets', 'cashAndEquivalents', 'segregatedCash', 'securitiesOwned', 'reverseRepos', 'brokerReceivables', 'customerReceivables', 'securitiesBorrowed', 'fixedAssets', 'otherAssets', 'parentReceivables']);
const statementFor = id => CAPITAL_IDS.has(id) ? 'net-capital' : INCOME_IDS.has(id) ? 'income' : CASH_FLOW_IDS.has(id) ? 'cash-flows' : NOTE_IDS.has(id) ? 'notes' : 'financial-condition';
const sectionFor = id => statementFor(id) !== 'financial-condition' ? statementFor(id) : ASSET_IDS.has(id) ? 'assets' : id === 'totalEquity' ? 'equity' : 'liabilities';
const CASH_FLOW_IDS = new Set(['operatingCashFlow', 'investingCashFlow', 'financingCashFlow', 'changeInCash']);
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const MONTH_PATTERN = Object.keys(MONTHS).join('|');
const NUMBER_PATTERN = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const datePattern = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2}),?\\s+((?:19|20)\\d{2})(?:\\s*(?:,?\\s*and\\s*|,\\s*|\\s+)((?:19|20)\\d{2}))?`, 'gi');
const scaleAmount = (value, scale) => Number((value * scale).toFixed(2));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clean = text => String(text || '').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/[‘’]/g, "'").replace(/[‐‑−]/g, '-').trim();
const compact = text => clean(text).replace(/\s+/g, ' ');
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isoDate = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

function datesIn(text) {
  const dates = [];
  for (const match of String(text).matchAll(datePattern)) {
    for (const year of [match[3], match[4]].filter(Boolean)) {
      const date = isoDate(year, MONTHS[match[1].toLowerCase()], match[2]);
      if (validDate(date) && !dates.includes(date)) dates.push(date);
    }
  }
  for (const match of String(text).matchAll(/\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g)) {
    if (validDate(match[0]) && !dates.includes(match[0])) dates.push(match[0]);
  }
  return dates;
}

function statementKind(text) {
  if (/^(?:(?:consolidated |combined |condensed )?statements? of (?:financial condition|financial position)|(?:consolidated |combined |condensed )?balance sheets?)(?: \(continued\))?$/i.test(text)) return 'financial-condition';
  if (/^(?:consolidated |combined |condensed )?statements? of (?:operations|income|earnings|revenues? and expenses?)(?: \(continued\))?$/i.test(text)) return 'income';
  if (/^(?:consolidated |combined |condensed )?statements? of cash flows?(?: \(continued\))?$/i.test(text)) return 'cash-flows';
  if (/^(?:(?:schedule|computation|calculation) of net capital|net capital computation|net capital requirements?)(?: under .*| \(continued\))?$/i.test(text)) return 'net-capital';
  return null;
}

function labelId(label) {
  const normalized = compact(label).toLowerCase()
    .replace(/\(notes?[^)]*\)/g, '')
    .replace(/\(net of accumulated depreciation(?: and amortization)?(?: of \$?[\d,]+)?\)/g, ' net ')
    .replace(/\((?:at )?fair value\)/g, ' at fair value ')
    .replace(/\(net\)/g, ' net ')
    .replace(/\((provided by|used in)\)/g, ' $1 ')
    .replace(/broker-dealers?/g, 'brokers dealers')
    .replace(/'s\b/g, 's').replace(/'/g, '')
    .replace(/[,.:]/g, ' ').replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
  return ALIASES.find(([, pattern]) => pattern.test(normalized))?.[0] || null;
}

function amountTokens(text) {
  const value = clean(text).replace(/\$\s*/g, '').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  const pattern = new RegExp(`\\(?-?${NUMBER_PATTERN}\\)?|[—–-]`, 'g');
  const tokens = [...value.matchAll(pattern)];
  if (!tokens.length || value.replace(pattern, '').trim()) return null;
  const values = [];
  for (const token of tokens) {
    if (/^[—–-]$/.test(token[0])) { values.push(null); continue; }
    if (token[0].startsWith('(') !== token[0].endsWith(')')) return null;
    const numeric = Number(token[0].replace(/[(),]/g, '')) * (token[0].startsWith('(') ? -1 : 1);
    if (!finite(numeric)) return null;
    values.push(numeric);
  }
  return values;
}

function tableRow(text) {
  const normalized = compact(text).replace(/\(notes?[^)]*\)/gi, '').replace(/\.{2,}/g, ' ');
  // Starting at each candidate boundary avoids swallowing numbers in note references.
  for (const match of normalized.matchAll(/\s+(?=\$|\(?-?\d|[—–-](?:\s|$))/g)) {
    const label = normalized.slice(0, match.index).trim();
    const id = labelId(label);
    if (!id) continue;
    const amounts = amountTokens(normalized.slice(match.index).trim());
    if (amounts) return { id, amounts, label, text: compact(text) };
  }
  return null;
}

function unitContext(text, { prose = false } = {}) {
  const normalized = compact(text);
  // A dollar sign alone is accepted only when no foreign currency is identified.
  if (/\b(?:CAD|AUD|HKD|SGD|NZD|EUR|GBP|Canadian dollars?|Australian dollars?|Hong Kong dollars?)\b|[€£]/i.test(normalized)) return { reason: 'Foreign or mixed currency amounts are not normalized to USD.' };
  const scales = [];
  if (/\b(?:in|amounts? in|expressed in|stated in) (?:U\.?S\.? dollars? in )?thousands\b|\$\s*(?:000s|000's)\b/i.test(normalized)) scales.push(1e3);
  if (/\b(?:in|amounts? in|expressed in|stated in) (?:U\.?S\.? dollars? in )?millions\b/i.test(normalized)) scales.push(1e6);
  if (/\b(?:in|amounts? in|expressed in|stated in) (?:U\.?S\.? dollars? in )?billions\b/i.test(normalized)) scales.push(1e9);
  if (new Set(scales).size > 1 || /except (?:as |where )?(?:otherwise )?(?:noted|indicated|stated)/i.test(normalized)) return { reason: 'Conflicting or qualified presentation units require source review.' };
  const explicitUsd = /\b(?:USD|U\.?S\.? dollars?|United States dollars?)\b/i.test(normalized);
  const dollar = normalized.includes('$');
  if (!explicitUsd && !dollar) return { reason: 'The statement has no explicit dollar currency basis.' };
  return { scale: prose ? 1 : scales[0] || 1, evidence: scales.length ? `USD amounts presented in ${scales[0] === 1e3 ? 'thousands' : scales[0] === 1e6 ? 'millions' : 'billions'}` : explicitUsd ? 'U.S. dollars' : 'Dollar-denominated statement ($); no foreign currency identified', explicitUsd };
}

function pageLines(page) {
  const isOcr = page?.method === 'ocr';
  if (isOcr && (!finite(page.ocrConfidence) || page.ocrConfidence < 75)) return [];
  const rows = Array.isArray(page?.lines) && page.lines.length ? page.lines.map(line => {
    const text = typeof line === 'string' ? line : line?.text || '';
    if (isOcr && /\d/.test(text) && (line?.usableForNumbers !== true || (finite(line.numericConfidence) && line.numericConfidence < 80))) return '[Uncertain OCR row withheld]';
    return text;
  }) : isOcr ? [] : String(page?.text || '').split(/\r?\n/);
  return rows.map(clean).filter(Boolean);
}

function periodContext(header, reportDate) {
  let dates = datesIn(header);
  // Common comparative heading: "December 31," on one line, then "2025 2024".
  if (!dates.length) dates = datesIn(compact(header));
  if (!dates.length) return { reason: 'The statement period is not explicit in its heading.' };
  const target = validDate(reportDate) ? reportDate : dates.slice().sort().at(-1);
  if (!dates.includes(target)) return { reason: `The statement heading does not establish the selected reporting date ${target}.` };
  const durationMatch = compact(header).match(/\b(?:(three|six|nine|twelve|3|6|9|12) months?|years?) ended\b/i);
  const durationMonths = durationMatch ? ({ three: 3, six: 6, nine: 9, twelve: 12, 3: 3, 6: 6, 9: 9, 12: 12 })[durationMatch[1]?.toLowerCase()] || 12 : null;
  let periodStart = null;
  if (durationMonths) {
    const start = new Date(`${target}T00:00:00Z`);
    // Move to the first day of the following month before subtracting whole months.
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCMonth(start.getUTCMonth() - durationMonths);
    periodStart = start.toISOString().slice(0, 10);
  }
  return { dates, index: dates.indexOf(target), target, periodStart, durationMonths, evidence: compact(header).slice(0, 360) };
}

function metric({ id, value, page, text, url, period, units, method = 'statement-row', label, confidence = 'high' }) {
  return {
    id, statement: statementFor(id), section: sectionFor(id), label: /reverse mortgage loans|and others/i.test(label || '') ? label : BROKER_DEALER_METRICS[id], value, unit: 'USD', currency: 'USD', basis: 'reported', reported: true,
    periodEnd: period.target, ...(period.periodStart ? { periodStart: period.periodStart, durationMonths: period.durationMonths } : {}), source: { url, page, text: compact(text).slice(0, 1000) }, confidence,
    extraction: { method, reportedLabel: label || BROKER_DEALER_METRICS[id], scale: units.scale, unitEvidence: units.evidence, periodEvidence: period.evidence },
  };
}

/** Labels that unambiguously denote a loss or outflow supply the economic sign.
 * Mixed labels retain the printed numeric sign; parentheses are never inverted.
 */
function signedStatementAmount(id, label, value) {
  const normalized = compact(label).toLowerCase();
  const loss = (id === 'netIncome' || id === 'pretaxIncome') && /\bloss\b/.test(normalized) && !/\bincome\b/.test(normalized.replace(/income taxes?/g, 'tax'));
  const cashUsed = CASH_FLOW_IDS.has(id) && /\bused in\b/.test(normalized) && !/\bprovided by\b/.test(normalized);
  const cashDecrease = id === 'changeInCash' && /\bdecrease\b/.test(normalized) && !/\bincrease\b/.test(normalized);
  if (!loss && !cashUsed && !cashDecrease) return { value };
  return { value: -Math.abs(value), signConvention: loss ? 'Explicit loss label is presented as a negative result.' : 'Explicit cash outflow or decrease label is presented as a negative amount.', numericToken: value };
}

function statementCandidates(lines, pageNumber, metadata, rejected, statements) {
  const candidates = [];
  for (let start = 0; start < lines.length; start++) {
    const kind = statementKind(lines[start]);
    if (!kind || /\.{3,}\s*\d|\s\d{1,3}\s*$/.test(lines[start]) || /contents/i.test(lines.slice(0, start + 1).join(' '))) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (statementKind(lines[i]) || /^(?:notes to|the accompanying notes|see accompanying notes)/i.test(lines[i])) { end = i; break; }
    }
    const block = lines.slice(start, end);
    const firstRow = block.findIndex(line => tableRow(line));
    const header = [...lines.slice(Math.max(0, start - 5), start), ...block.slice(0, firstRow < 0 ? Math.min(block.length, 10) : firstRow)].join('\n');
    const period = periodContext(header, metadata.reportDate);
    const units = unitContext(`${header}\n${block.join('\n')}`);
    const rows = [];
    for (let i = 1; i < block.length; i++) {
      let row = tableRow(block[i]);
      if (!row && i + 1 < block.length && (labelId(block[i]) || !/\d/.test(block[i]))) {
        for (let extra = 1; extra <= 2 && i + extra < block.length; extra++) {
          row = tableRow(block.slice(i, i + extra + 1).join(' '));
          if (row) { i += extra; break; }
        }
      }
      if (row) rows.push(row);
    }
    if (!rows.length) continue;
    statements.add(kind);
    for (const row of rows) {
      if (CAPITAL_IDS.has(row.id) !== (kind === 'net-capital') || INCOME_IDS.has(row.id) !== (kind === 'income') || CASH_FLOW_IDS.has(row.id) !== (kind === 'cash-flows')) continue;
      const reason = period.reason || units.reason || (row.amounts.length !== period.dates?.length ? 'Numeric columns cannot be mapped unambiguously to the statement dates.' : null);
      if (reason) { rejected.push({ id: row.id, page: pageNumber, reason }); continue; }
      const value = row.amounts[period.index];
      if (value === null) { rejected.push({ id: row.id, page: pageNumber, reason: 'A dash is not interpreted as a reported zero.' }); continue; }
      const signed = signedStatementAmount(row.id, row.label, value);
      const candidate = metric({ id: row.id, value: scaleAmount(signed.value, units.scale), page: pageNumber, text: row.text, url: metadata.documentUrl || '', period, units, label: row.label });
      if (signed.signConvention) Object.assign(candidate.extraction, { signConvention: signed.signConvention, numericToken: signed.numericToken });
      candidates.push(candidate);
    }
    start = end - 1;
  }
  return candidates;
}

function capitalProseCandidates(lines, pageNumber, metadata, rejected, statements) {
  const candidates = [];
  const joined = lines.join(' ');
  // Work on bounded paragraphs beginning with an explicit reporting date. Rule
  // floors and percentages in the preceding legal description are not values.
  const dateStart = new RegExp(`\\b(?:as of|at)\\s+(?:${MONTH_PATTERN})\\s+\\d{1,2},?\\s+(?:19|20)\\d{2}`, 'gi');
  for (const start of joined.matchAll(dateStart)) {
    const rest = joined.slice(start.index, start.index + 1000);
    const nextDate = [...rest.matchAll(datePattern)][1];
    const text = (nextDate ? rest.slice(0, nextDate.index) : rest).split(/(?<=\.)\s+(?=[A-Z])/).slice(0, 2).join(' ');
    if (!/net capital/i.test(text)) continue;
    const dates = datesIn(text);
    const target = validDate(metadata.reportDate) ? metadata.reportDate : dates[0];
    if (dates.length !== 1 || dates[0] !== target || /\b(?:CAD|AUD|HKD|EUR|GBP)\b|[€£]/.test(text)) continue;
    statements.add('net-capital');
    const period = { target, evidence: dates[0] };
    const pageUnits = unitContext(`${lines.slice(0, 8).join(' ')} ${text}`);
    if (pageUnits.reason) continue;
    const money = `(?:approximately\\s+)?\\$\\s*(${NUMBER_PATTERN})(?:\\s*(thousand|million|billion))?`;
    const patterns = [
      ['netCapital', new RegExp(`(?<!minimum |required |excess )\\bnet capital(?:,? (?:as defined|calculated in accordance with Rule 15c3-1|under [^,]+),?)? (?:of|was|equal(?:ed)? to|amounted to|total(?:ed|ing))\\s*${money}`, 'gi')],
      ['minimumNetCapital', new RegExp(`\\b(?:minimum (?:required )?net capital(?: requirement)?|required (?:minimum )?net capital|net capital requirement) (?:of|was|equal(?:ed)? to|amounted to|total(?:ed|ing))\\s*${money}`, 'gi')],
      ['excessNetCapital', new RegExp(`\\bexcess net capital (?:of|was|equal(?:ed)? to|amounted to|total(?:ed|ing))\\s*${money}`, 'gi')],
      ['excessNetCapital', new RegExp(`\\bexceeded (?:its |the )?(?:minimum )?(?:required (?:minimum )?net capital|net capital requirement|requirement|minimum requirement) by\\s*${money}`, 'gi')],
      ['excessNetCapital', new RegExp(`${money}\\s+in excess of (?:its |the )?(?:required (?:minimum )?net capital|minimum (?:required )?net capital|net capital requirement)`, 'gi')],
      ['excessNetCapital', new RegExp(`exceeded (?:its |the )?(?:required (?:minimum )?net capital|minimum (?:required )?net capital) of (?:approximately )?\\$\\s*${NUMBER_PATTERN} by\\s*${money}`, 'gi')],
    ];
    for (const [id, pattern] of patterns) for (const match of text.matchAll(pattern)) {
      const clause = text.slice(Math.max(0, match.index - 35), match.index + match[0].length);
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 40);
      if (id === 'minimumNetCapital' && (/greater of|lesser of/i.test(clause) || /^\s*(?:,?\s*or)\s+(?:\d|\$)/i.test(after))) { rejected.push({ id, page: pageNumber, reason: 'A regulatory formula or statutory floor is not the actual period-end minimum requirement.' }); continue; }
      const scale = ({ thousand: 1e3, million: 1e6, billion: 1e9 })[match[2]?.toLowerCase()] || pageUnits.scale;
      candidates.push(metric({ id, value: scaleAmount(Number(match[1].replace(/,/g, '')), scale), page: pageNumber, text, url: metadata.documentUrl || '', period, units: { scale, evidence: match[2] ? `Explicit $ amount in ${match[2]}s` : 'Explicit $ amount in the dated disclosure' }, method: 'dated-capital-disclosure', confidence: 'medium' }));
    }
  }
  return candidates;
}

/** Dated notes remain separate from statement totals and cannot fill omitted statements. */
function noteCandidates(lines, pageNumber, metadata, statements) {
  const candidates = [];
  const sentences = lines.join(' ').split(/\.\s+(?=(?:As of|At |The |In |Additionally|Included|During|Over |There |On |Through |Approximately ))/);
  const money = `(?:approximately\\s+)?\\$\\s*(${NUMBER_PATTERN})(?:\\s*(thousand|million|billion))?`;
  const patterns = [
    ['ficcReceivables', `amounts? (?:due|receivable) from (?:the )?FICC (?:of|total(?:ing|ed))\\s*${money}`],
    ['cmeReceivables', `amounts? (?:due|receivable) from (?:the )?CME (?:of|total(?:ing|ed))\\s*${money}`],
    ['treasurySecuritiesOwned', `(?:total )?long positions in U\\.?S\\.? Treasury securities of\\s*${money}`],
    ['gseSecuritiesOwned', `U\\.?S\\.? GSE securities of\\s*${money}`, /long positions/i],
    ['treasurySecuritiesSoldShort', `(?:total )?short positions in U\\.?S\\.? Treasury securities of\\s*${money}`],
    ['collateralReceivedReusable', `(?:fair value of )?securities received as collateral that could be sold or repledged(?: by the (?:Company|Firm))? (?:was|were|of)\\s*${money}`],
    ['forwardReverseRepos', `(?:forward[- ]starting (?:reverse repos|reverse repurchase agreements)) of\\s*${money}`, /commitments/i],
    ['forwardRepos', `(?:forward[- ]starting (?:repos|repurchase agreements)) of\\s*${money}`, /commitments/i],
    ['dividendsPaid', `(?:declared and paid|paid) dividends (?:of|total(?:ing|ed))\\s*${money}`, /year ended/i],
  ];
  for (const sentence of sentences) {
    const text = compact(sentence);
    if (text.length > 2200 || /\b(?:CAD|AUD|HKD|SGD|NZD|EUR|GBP|Canadian dollars?|Australian dollars?)\b|[€£]/i.test(text)) continue;
    const dates = datesIn(text);
    const target = validDate(metadata.reportDate) ? metadata.reportDate : dates[0];
    if (dates.length !== 1 || dates[0] !== target) continue;
    const pageUnits = unitContext(`${lines.slice(0, 8).join(' ')} ${text}`);
    if (pageUnits.reason) continue;
    for (const [id, pattern, required] of patterns) {
      if (required && !required.test(text)) continue;
      for (const match of text.matchAll(new RegExp(pattern, 'gi'))) {
        const scale = ({ thousand: 1e3, million: 1e6, billion: 1e9 })[match[2]?.toLowerCase()] || pageUnits.scale;
        const value = scaleAmount(Number(match[1].replace(/,/g, '')), scale);
        candidates.push(metric({ id, value, page: pageNumber, text, url: metadata.documentUrl || '', period: { target, evidence: text }, units: { scale, evidence: match[2] ? `Explicit $ amount in ${match[2]}s` : pageUnits.evidence }, method: 'dated-note-disclosure', confidence: 'medium' }));
        statements.add('notes');
      }
    }
  }
  return candidates;
}

export function brokerDealerMetricGroup(id) {
  return ({ 'financial-condition': 'balance', income: 'income', 'cash-flows': 'cashflow', 'net-capital': 'capital', notes: 'notes' })[statementFor(id)];
}

/** Reconcile a clearly separate debt presentation without replacing a reported subtotal. */
function deriveLiabilities(metrics) {
  const m = Object.fromEntries(metrics.map(item => [item.id, item]));
  const inputs = [m.totalAssets, m.totalLiabilities, m.subordinatedDebt, m.totalEquity];
  if (!inputs.every(Boolean) || new Set(inputs.map(item => `${item.periodEnd}:${item.currency}:${item.source.url}:${item.source.page}`)).size !== 1) return null;
  const tolerance = Math.max(1, ...inputs.map(item => item.extraction.scale)) * 1.5;
  const reportedDifference = m.totalAssets.value - m.totalLiabilities.value - m.totalEquity.value;
  if (m.subordinatedDebt.value <= tolerance || Math.abs(reportedDifference - m.subordinatedDebt.value) > tolerance) return null;
  const value = m.totalLiabilities.value + m.subordinatedDebt.value;
  if (value <= 0) return null;
  const proofIds = inputs.map(item => item.id);
  return {
    id: 'adjustedTotalLiabilities', label: BROKER_DEALER_METRICS.adjustedTotalLiabilities, statement: 'financial-condition', section: 'liabilities',
    value, unit: 'USD', currency: 'USD', basis: 'calculated', reported: false,
    formula: 'Reported liabilities subtotal + separately presented subordinated debt',
    metricIds: ['totalLiabilities', 'subordinatedDebt'], periodEnd: m.totalAssets.periodEnd,
    confidence: inputs.every(item => item.confidence === 'high') ? 'high' : 'medium',
    source: m.totalLiabilities.source, sources: inputs.map(item => item.source),
    extraction: { method: 'reconciled-separate-subordinated-debt', scale: Math.max(...inputs.map(item => item.extraction.scale)), unitEvidence: m.totalLiabilities.extraction.unitEvidence, periodEvidence: m.totalLiabilities.extraction.periodEvidence },
    validation: { id: 'balance-sheet-with-subordinated-debt', status: 'consistent', metricIds: proofIds, difference: m.totalAssets.value - value - m.totalEquity.value, reportedDifference, tolerance },
  };
}

function resolveCandidates(candidates, rejected) {
  const metrics = [];
  for (const id of Object.keys(BROKER_DEALER_METRICS)) {
    const rows = candidates.filter(row => row.id === id);
    if (!rows.length) continue;
    const distinct = new Set(rows.map(row => `${row.periodEnd}:${row.value}`));
    if (distinct.size > 1) { rejected.push({ id, reason: 'Conflicting amounts or reporting dates were found; no value was selected.' }); continue; }
    const best = rows.find(row => row.confidence === 'high') || rows[0];
    metrics.push({ ...best, sources: rows.map(row => row.source) });
  }
  return metrics;
}

function makeRatio(id, label, formula, inputs, calculate, format = 'multiple') {
  if (!inputs.every(Boolean) || new Set(inputs.map(input => `${input.periodEnd}:${input.currency}`)).size !== 1) return null;
  const flows = inputs.filter(input => INCOME_IDS.has(input.id) || CASH_FLOW_IDS.has(input.id));
  if (flows.length > 1 && !(flows.every(input => input.periodStart) && new Set(flows.map(input => input.periodStart)).size === 1) && new Set(flows.map(input => `${input.source.page}:${input.extraction.periodEvidence}`)).size !== 1) return null;
  const value = calculate(...inputs.map(input => input.value));
  if (!finite(value)) return null;
  return { id, label, formula, value, unit: 'ratio', format, basis: 'calculated', reported: false, periodEnd: inputs[0].periodEnd, confidence: inputs.every(input => input.confidence === 'high') ? 'high' : 'medium', metricIds: inputs.map(input => input.id), source: inputs[0].source, sources: inputs.flatMap(input => input.sources || [input.source]) };
}

function buildRatios(metrics) {
  const m = Object.fromEntries(metrics.map(item => [item.id, item]));
  const positiveDenominator = (a, b) => b > 0 ? a / b : null;
  const liabilities = m.adjustedTotalLiabilities || m.totalLiabilities;
  const liabilityLabel = m.adjustedTotalLiabilities ? 'Liabilities including separately presented subordinated debt' : 'Total liabilities';
  return [
    makeRatio('assetsToEquity', 'Assets / equity', 'Total assets / total equity', [m.totalAssets, m.totalEquity], positiveDenominator),
    makeRatio('liabilitiesToEquity', 'Liabilities / equity', `${liabilityLabel} / total equity`, [liabilities, m.totalEquity], positiveDenominator),
    makeRatio('equityToAssets', 'Equity / assets', 'Total equity / total assets', [m.totalEquity, m.totalAssets], positiveDenominator, 'percent'),
    makeRatio('cashToLiabilities', 'Cash / liabilities', `Cash and cash equivalents / ${liabilityLabel.toLowerCase()}`, [m.cashAndEquivalents, liabilities], positiveDenominator, 'percent'),
    makeRatio('cashToAssets', 'Cash / assets', 'Cash and cash equivalents / total assets', [m.cashAndEquivalents, m.totalAssets], positiveDenominator, 'percent'),
    makeRatio('reverseReposToAssets', 'Reverse repos / assets', 'Securities purchased under agreements to resell / total assets', [m.reverseRepos, m.totalAssets], positiveDenominator, 'percent'),
    makeRatio('securitiesOwnedToAssets', 'Securities owned / assets', 'Securities and financial instruments owned / total assets', [m.securitiesOwned, m.totalAssets], positiveDenominator, 'percent'),
    makeRatio('brokerReceivablesToAssets', 'Broker and clearing receivables / assets', 'Receivables from brokers and clearing organizations / total assets', [m.brokerReceivables, m.totalAssets], positiveDenominator, 'percent'),
    makeRatio('reposToLiabilities', 'Repo funding / liabilities', `Securities sold under agreements to repurchase / ${liabilityLabel.toLowerCase()}`, [m.repos, liabilities], positiveDenominator, 'percent'),
    makeRatio('netCapitalToEquity', 'Net capital / equity', 'Regulatory net capital / total equity', [m.netCapital, m.totalEquity], positiveDenominator, 'percent'),
    makeRatio('subordinatedDebtToEquity', 'Subordinated debt / equity', 'Reported subordinated debt / total equity', [m.subordinatedDebt, m.totalEquity], positiveDenominator),
    makeRatio('netIncomeToRevenue', 'Net income / total revenue', 'Net income / total revenue', [m.netIncome, m.totalRevenue], positiveDenominator, 'percent'),
    makeRatio('netIncomeToNetRevenue', 'Net income / net revenue', 'Net income / net revenue', [m.netIncome, m.netRevenue], positiveDenominator, 'percent'),
    makeRatio('netCapitalToRequired', 'Net capital / required minimum', 'Regulatory net capital / required minimum net capital', [m.netCapital, m.minimumNetCapital], positiveDenominator),
    makeRatio('excessNetCapitalToRequired', 'Net capital buffer / required minimum', '(Regulatory net capital - required minimum net capital) / required minimum net capital', [m.netCapital, m.minimumNetCapital], (capital, required) => required > 0 ? (capital - required) / required : null),
  ].filter(Boolean);
}

const moneyFormat = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

function conclusions(metrics, ratios, rejected) {
  const findings = [], validations = [];
  const m = Object.fromEntries(metrics.map(item => [item.id, item]));
  const r = Object.fromEntries(ratios.map(item => [item.id, item]));
  const liabilities = m.adjustedTotalLiabilities || m.totalLiabilities;
  const samePeriod = rows => rows.every(Boolean) && new Set(rows.map(row => `${row.periodEnd}:${row.currency}`)).size === 1;
  const add = (id, title, text, metricIds, severity = 'info') => findings.push({ id, title, text, metricIds, severity, source: m[metricIds[0]]?.source });
  if (samePeriod([m.totalAssets, m.totalEquity])) add('balance-sheet', 'Reported balance sheet', `Reported assets are ${moneyFormat(m.totalAssets.value)} and equity / member capital is ${moneyFormat(m.totalEquity.value)} as of ${m.totalAssets.periodEnd}.${r.assetsToEquity ? ` Assets are ${r.assetsToEquity.value.toFixed(2)} times equity; this accounting leverage measure does not adjust for collateral or enforceable netting.` : ''}`, ['totalAssets', 'totalEquity']);
  if (m.totalEquity?.value <= 0) add('nonpositive-equity', 'Nonpositive reported equity', 'Reported equity is zero or negative. Assets/equity and liabilities/equity multiples are withheld because they would not be meaningful measures of a positive equity cushion.', ['totalEquity'], 'warning');
  if (samePeriod([m.repos, liabilities]) && liabilities?.value > 0) add('repo-funding', 'Repurchase funding', `The reported repurchase-agreement balance accounts for ${(m.repos.value / liabilities.value * 100).toFixed(1)}% of ${m.adjustedTotalLiabilities ? 'liabilities including separately presented subordinated debt' : 'reported liabilities'}. Collateral quality, maturity and margin terms require review of the underlying notes.`, ['repos', liabilities.id]);
  if (samePeriod([m.reverseRepos, m.repos])) add('secured-financing', 'Secured financing on both sides of the balance sheet', `Reported reverse repos are ${moneyFormat(m.reverseRepos.value)} and repos are ${moneyFormat(m.repos.value)}. Their separate balances do not establish a matched book, a collateral shortfall or a legally nettable exposure.`, ['reverseRepos', 'repos']);
  if (m.segregatedCash) add('segregated-cash', 'Segregated balances', `The statement reports ${moneyFormat(m.segregatedCash.value)} of segregated cash. This balance is kept separate from cash and cash equivalents in liquidity calculations because regulatory segregation can restrict its use.`, ['segregatedCash']);
  if (r.netCapitalToRequired) add('regulatory-buffer', 'Reported net capital position', `Net capital is ${r.netCapitalToRequired.value.toFixed(2)} times the disclosed period-end minimum; the calculated buffer is ${moneyFormat(m.netCapital.value - m.minimumNetCapital.value)}. Net capital is a regulatory measure and differs from accounting equity.`, ['netCapital', 'minimumNetCapital'], m.netCapital.value < m.minimumNetCapital.value ? 'warning' : 'info');
  if (samePeriod([m.totalAssets, m.totalLiabilities, m.totalEquity])) {
    const difference = m.totalAssets.value - m.totalLiabilities.value - m.totalEquity.value;
    const tolerance = Math.max(1, ...[m.totalAssets, m.totalLiabilities, m.totalEquity].map(item => item.extraction.scale)) * 1.5;
    const balanced = Math.abs(difference) <= tolerance;
    validations.push({ id: 'balance-sheet-tie-out', status: balanced || m.adjustedTotalLiabilities ? 'consistent' : 'mismatch', difference: m.adjustedTotalLiabilities ? m.adjustedTotalLiabilities.validation.difference : difference, reportedDifference: difference, presentation: m.adjustedTotalLiabilities ? 'separately-presented-subordinated-debt' : 'reported-total', tolerance, metricIds: m.adjustedTotalLiabilities ? ['totalAssets', 'totalLiabilities', 'subordinatedDebt', 'totalEquity', 'adjustedTotalLiabilities'] : ['totalAssets', 'totalLiabilities', 'totalEquity'], description: m.adjustedTotalLiabilities ? 'Assets reconcile with the reported liabilities subtotal, separately presented subordinated debt and equity; the reported subtotal is preserved.' : 'Arithmetic comparison of extracted assets with liabilities plus equity; not audit verification.' });
    if (m.adjustedTotalLiabilities) {
      add('separate-subordinated-debt', 'Liabilities reconcile including subordinated debt', `The filing labels ${moneyFormat(m.totalLiabilities.value)} as total liabilities and presents subordinated debt of ${moneyFormat(m.subordinatedDebt.value)} separately. Their sum is ${moneyFormat(m.adjustedTotalLiabilities.value)}, which reconciles with equity to reported assets. The reported subtotal is preserved; liability-based ratios use this explicitly calculated total.`, ['totalLiabilities', 'subordinatedDebt', 'adjustedTotalLiabilities', 'totalEquity', 'totalAssets']);
    } else if (!balanced) {
      const separateDebt = samePeriod([m.subordinatedDebt, m.totalAssets]) && Math.abs(difference - m.subordinatedDebt.value) <= tolerance;
      add('balance-sheet-mismatch', separateDebt ? 'Subordinated debt is separately presented' : 'Extracted totals do not reconcile', `Extracted assets differ from the labeled liabilities total plus equity by ${moneyFormat(difference)}.${separateDebt ? ' The difference equals reported subordinated debt, which may be presented separately from that liabilities subtotal.' : ''} Reported amounts are retained. Ratios using total liabilities are withheld pending source review.`, ['totalAssets', 'totalLiabilities', 'totalEquity', ...(separateDebt ? ['subordinatedDebt'] : [])], 'warning');
    }
  }
  if (samePeriod([m.netCapital, m.minimumNetCapital, m.excessNetCapital])) {
    const difference = m.netCapital.value - m.minimumNetCapital.value - m.excessNetCapital.value;
    const tolerance = Math.max(1, ...[m.netCapital, m.minimumNetCapital, m.excessNetCapital].map(item => item.extraction.scale)) * 1.5;
    validations.push({ id: 'net-capital-tie-out', status: Math.abs(difference) <= tolerance ? 'consistent' : 'mismatch', difference, tolerance, metricIds: ['netCapital', 'minimumNetCapital', 'excessNetCapital'], description: 'Arithmetic comparison of reported net capital, required minimum and excess.' });
    if (Math.abs(difference) > tolerance) add('net-capital-mismatch', 'Net capital amounts do not reconcile', 'Reported net capital less the disclosed minimum does not match reported excess net capital within presentation rounding. No amount has been replaced or corrected.', ['netCapital', 'minimumNetCapital', 'excessNetCapital'], 'warning');
  }
  if (rejected.some(item => /Conflicting/.test(item.reason))) findings.push({ id: 'conflicting-extraction', severity: 'warning', title: 'Conflicting source amounts', text: 'One or more metrics were withheld because the source supplied conflicting amounts or periods. Review the cited annual report.', metricIds: [...new Set(rejected.filter(item => /Conflicting/.test(item.reason)).map(item => item.id))] });
  return { findings, validations };
}

export function analyzeBrokerDealerReport({ pages = [], ...metadata } = {}) {
  const rejected = [], candidates = [], statements = new Set();
  let pagesWithText = 0;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index], lines = pageLines(page);
    if (!lines.some(line => /[A-Za-z]{3}/.test(line))) continue;
    pagesWithText++;
    const pageNumber = Number.isInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : index + 1;
    const pageCandidates = [...statementCandidates(lines, pageNumber, metadata, rejected, statements), ...capitalProseCandidates(lines, pageNumber, metadata, rejected, statements), ...noteCandidates(lines, pageNumber, metadata, statements)];
    if (page.method === 'ocr') for (const candidate of pageCandidates) {
      candidate.source.method = 'ocr';
      candidate.source.ocrConfidence = page.ocrConfidence;
      candidate.confidence = 'medium';
      candidate.extraction.method = `ocr-${candidate.extraction.method}`;
    }
    candidates.push(...pageCandidates);
  }
  const metrics = resolveCandidates(candidates, rejected);
  const adjustedLiabilities = deriveLiabilities(metrics);
  if (adjustedLiabilities) metrics.push(adjustedLiabilities);
  let ratios = buildRatios(metrics);
  const { findings, validations } = conclusions(metrics, ratios, rejected);
  if (validations.some(item => item.id === 'balance-sheet-tie-out' && item.status === 'mismatch')) {
    ratios = ratios.filter(item => !item.metricIds.includes('totalLiabilities'));
    const index = findings.findIndex(item => item.id === 'repo-funding');
    if (index >= 0) findings.splice(index, 1);
  }
  const availableMetrics = metrics.map(item => item.id);
  const missingMetrics = Object.keys(BROKER_DEALER_METRICS).filter(id => id !== 'adjustedTotalLiabilities' && !availableMetrics.includes(id));
  const limitations = ['Automated extraction is a source-reading aid, not an audit or verification of the financial statements. Each value links to its reported page.', 'Only the publicly available attachment is analyzed. Public annual reports may omit the income statement, regulatory capital schedules or other nonpublic material.'];
  if (!pagesWithText) limitations.push('No readable text was found. This report may be scanned; OCR or manual review is required before financial values can be extracted.');
  else if (!metrics.length) limitations.push('No financial amounts could be mapped reliably. Financial tables may be image-only, have damaged text encoding or use an unsupported layout; manual source review or OCR is required.');
  if (pages.some(page => page.method === 'ocr')) limitations.push('Some pages use optical character recognition (OCR). Values from readable OCR rows are marked for review; low-confidence numeric rows are withheld, and OCR is not verification of the original image.');
  if (!metrics.some(item => INCOME_IDS.has(item.id))) limitations.push('No unambiguous income-statement metrics were extracted. Profitability is unavailable and has not been estimated.');
  if (!metrics.some(item => CAPITAL_IDS.has(item.id))) limitations.push('No unambiguous period-end regulatory capital amounts were extracted. Accounting equity is not substituted for net capital.');
  if (!metrics.some(item => CASH_FLOW_IDS.has(item.id))) limitations.push('No unambiguous cash-flow statement totals were extracted. Funding flows are not reconstructed from balance-sheet changes.');
  if (/\/A$/i.test(metadata.form || '')) limitations.push('This is an amended annual report. An amendment may replace only part of an earlier filing; this analysis uses the selected attachment alone and does not merge missing amounts from the original.');
  if (rejected.length) limitations.push('Some candidate amounts were withheld because their label, period, units or comparative columns could not be established unambiguously.');
  limitations.push('Ratios use reported balance-sheet amounts. No collateral netting, asset liquidation values or repo-adjusted leverage is inferred.');
  const coreReady = ['totalAssets', 'totalLiabilities', 'totalEquity'].every(id => availableMetrics.includes(id));
  const hasMismatch = validations.some(item => item.status === 'mismatch');
  const partialExtraction = metadata.extraction?.truncated === true || metadata.extraction?.partial === true || metadata.extraction?.status === 'partial' || (finite(metadata.extraction?.pageCount) && finite(metadata.extraction?.pagesRead) && metadata.extraction.pagesRead < metadata.extraction.pageCount);
  if (partialExtraction) limitations.push('Document extraction covered only part of the attachment. Report coverage remains partial even when the extracted balance sheet reconciles.');
  return {
    version: BROKER_DEALER_ANALYTICS_VERSION,
    status: !metrics.length ? 'unavailable' : coreReady && !hasMismatch && !partialExtraction ? 'ready' : 'partial',
    periodEnd: validDate(metadata.reportDate) ? metadata.reportDate : metrics[0]?.periodEnd || null,
    documentUrl: metadata.documentUrl || '', name: metadata.name || '', cik: metadata.cik || '', form: metadata.form || 'X-17A-5', accession: metadata.accession || '', filingDate: metadata.filingDate || null,
    metrics, ratios, findings, limitations, validations,
    coverage: { disclosedStatements: [...statements], availableMetrics, missingMetrics, extractedMetricCount: metrics.length, totalMetricCount: Object.keys(BROKER_DEALER_METRICS).length, pagesWithText, totalPages: pages.length, rejected: rejected.slice(0, 50), scope: 'public-attachment-only' },
  };
}
