import { createChatResearch } from './chatResearch.js';
import { normalizeChatContext } from './chatContext.js';
import { normalizeSharedChatContext } from './chatSharedContext.js';
import { QUANT_GROUPS } from './quantGroups.js';

// This module deliberately has no model client. The browser receives a small,
// reproducible research answer which remains useful if local inference fails.
export const BROWSER_RESEARCH_MAX_CHARS = 6500;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\[\]<>`*|]/g, '').trim() : '';
const number = value => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'Unavailable';
const refs = ids => [...new Set((ids || []).flat(2).filter(id => /^S\d+$/.test(id)))].map(id => `[${id}]`).join(' ');
function valueText(value, unit = '') {
  if (!finite(value)) return 'Unavailable';
  if (['percent', 'fraction'].includes(unit)) return `${number(value * 100)}%`;
  if (['%', 'pp'].includes(unit)) return `${number(value)}${unit === 'pp' ? ' pp' : '%'}`;
  if (unit.toLowerCase() === 'usd') return `$${number(value)}`;
  if (['ratio', 'multiple', 'x'].includes(unit)) return `${number(value)}×`;
  return `${number(value)}${unit && !['number', 'count'].includes(unit) ? ` ${text(unit)}` : ''}`;
}

const DEFINITIONS = [
  [/\bfree cash flow\b/i, 'Free cash flow', 'The site calculates free cash flow from compatible operating cash flow and capital spending inputs. It helps describe cash remaining after that investment, but it is not a standardized GAAP subtotal or cash freely available for every purpose. Check the selected period and the metric definition in Analysis.'],
  [/\boperating cash flow\b/i, 'Operating cash flow', 'Cash generated or used by operating activities over the labeled reporting period. It differs from net income because of noncash items and changes in working capital. Quarterly, year-to-date, and annual flows cover different durations.'],
  [/\bcurrent ratio\b/i, 'Current ratio', 'Current assets divided by current liabilities using compatible period-end amounts. A higher value describes more reported current assets per dollar of current liabilities; the quality and timing of those assets still matter. This ratio is not equally useful for every industry.'],
  [/\bnet margin\b/i, 'Net margin', 'Net income divided by the compatible revenue measure for the same duration. Revenue definitions can differ for banks, insurers, and other businesses. The site reports missing or incompatible inputs as unavailable.'],
  [/\boperating margin\b/i, 'Operating margin', 'Operating income divided by compatible revenue for the same period. It describes reported operating profitability before items outside operating income. It does not establish liquidity or cash generation.'],
  [/\b(?:ttm|trailing twelve months)\b/i, 'Trailing twelve months (TTM)', 'A rolling twelve-month flow period assembled from compatible SEC financial evidence. It is different from a company’s fiscal year. Balance-sheet figures are point-in-time observations, so check their period-end dates separately.'],
  [/\b(?:n[ -]?port)\b/i, 'N-PORT portfolios', 'N-PORT shows a historical registered fund-series portfolio. Several share classes can share one portfolio. Net assets and position weights are series-level measures; holdings are not live positions, and derivative exposure cannot be inferred from position value alone.'],
  [/\b13[ -]?f\b/i, '13F portfolios', '13F reports disclose specified securities held by an institutional investment manager at a historical quarter end. Reported holdings value is not total assets under management, a complete portfolio, or investment performance. Filing delays, amendments, and confidential treatment can limit interpretation.'],
  [/\b(?:cftc|net\/oi|open interest|futures positioning)\b/i, 'CFTC positioning', 'The Market page uses historical CFTC futures-only positions by trader group. Net/Open Interest expresses net contracts as a percentage of open interest; a weekly change in that percentage is measured in percentage points. Positions can reflect hedging, and these aggregate reports do not establish an individual company’s holdings or predict prices.'],
];
const PAGE_HELP = {
  analysis: 'Analysis organizes SEC financial statements, ratios, changes, cash generation, and scenarios for the selected company. Reporting basis, period end, and filing cutoff control the evidence. Scenarios are hypothetical sensitivities, not forecasts. Ask for a company summary, liquidity, debt, or cash flow.',
  market: 'Market Briefing summarizes business conditions across the prepared SEC company universe. Sector Performance compares filing-based financial fundamentals, not stock returns. CFTC Positioning adds dated futures-only exposure by trader group. Ask for the briefing, a sector, or CFTC positioning.',
  fund: 'Funds supports historical N-PORT fund-series portfolios and 13F institutional managers. Select a fund or manager and a filing period to inspect disclosed holdings. Ask for its portfolio summary or concentration. Reported holdings value is not investment performance.',
  risk: 'Risk organizes public-filing financial evidence into industry-specific dimensions, supported strengths, and watch items. These are analytical screens, not regulatory ratings or probabilities of default. The basic assistant can summarize the selected company’s financial evidence.',
  compare: 'Compare aligns selected companies and reporting periods while showing differences in definitions and coverage. Fiscal periods can differ even within the same calendar bucket. Ask to compare two named companies; exact dates and missing data remain attached to each value.',
  filings: 'Filings lets you inspect original SEC documents and their filing and reporting dates. A filing date is different from the period described by its financial statements. The basic assistant can summarize a named company’s normalized financial evidence; use the document reader for exact filing text.',
  disclosures: 'Disclosures searches retained original SEC filing passages by company and topic. Index coverage can be incomplete: no result does not prove that a company lacks an exposure. Open a matching filing to inspect its full context. The basic assistant can also explain metrics or summarize a named company.',
  reports: 'Reports prepares downloadable company, fund, and market research in PDF and Excel. Company reporting periods and historical fund snapshots should be checked before comparing results. Ask this assistant for a company, a named 13F manager, an N-PORT fund, or the market briefing.',
  workspace: 'The Research Hub organizes portfolio research using the site’s public data. Your private holdings are not automatically sent to chat. Explicitly share a view to discuss its available holdings or a scenario. You can also ask about a named company, fund, sector, or CFTC positioning.',
};
const SUGGESTIONS = ['Summarize a company by ticker.', 'Summarize the market briefing.', 'What does CFTC positioning mean?'];
const STOP_TICKERS = new Set(['I', 'A', 'AI', 'SEC', 'CFTC', 'USD', 'TTM', 'YTD', 'NPORT', 'N-PORT', 'PORT', 'ETF', 'ETFS', 'PDF', 'CIK', 'CEO', 'CFO', 'GAAP', 'OI', 'ROE', 'ROA', 'EBITDA', 'EPS', 'US', 'USA', 'AND', 'OR', 'THE', 'FOR', 'WHAT', 'HOW']);
const FINANCIAL = /\b(?:financials?|results?|revenue|income|assets?|liabilities|equity|cash|liquidity|debt|margins?|profit|balance|growth|trends?|ratios?|earnings|performance|business|fundamentals|summar\w*|overview)\b/i;
const GENERIC_ENTITY = /^(?:(?:the|this|that|selected|current|a|an|its|their|it|these|those)\s+)*(?:company|fund|manager|portfolio|market|page|results?|financials?|financial results?|latest financial results?|business|holdings?|sector|view|data|them|it)?$/i;
const INSTANT_KEYS = new Set(['totalAssets', 'totalLiabilities', 'stockholdersEquity', 'cash', 'totalDebt', 'deposits', 'loans', 'currentRatio', 'equityAssets', 'reportedDebtEquity']);

function cleanIdentifier(raw) {
  let value = String(raw || '').replace(/[’‘]/g, "'").trim();
  value = value.replace(/^(?:please\s+)?(?:the\s+)?(?:13[ -]?f\s+(?:manager\s+)?|n[ -]?port\s+(?:fund\s+)?|company\s+|ticker\s+|fund\s+|manager\s+)/i, '')
    .replace(/s'(?=\s|$).*$/i, 's').replace(/'s(?=\s|$).*$/i, '')
    .replace(/\s+(?:(?:latest|recent|current|annual|quarterly|ttm)\s+)?(?:financial(?:\s+results)?|financials|results|statements|balance sheet|cash flow|earnings|revenue|income|liquidity|debt|trends|ratios|margins|performance|portfolio|holdings|fundamentals|business|using|with|on|in|for)\b.*$/i, '')
    .replace(/\s+(?:13[ -]?f(?:\s+(?:fund|manager))?|n[ -]?port(?:\s+fund)?|fund|manager)$/i, '')
    .replace(/^["'$\s]+|["'?!.\s]+$/g, '').trim();
  if (!value || value.length > 100 || GENERIC_ENTITY.test(value) || /^(?:its|their|they|this|that|my|our|your|selected|current)$/i.test(value)
    || /[<>\\:{}[\]|]/.test(value) || /\b(?:https?|ignore|instructions|system|prompt)\b/i.test(value)) return '';
  return value;
}

/** A deliberately conservative grammar. Unknown subjects are never replaced by
 * the selected company, and prior assistant text is never trusted as evidence. */
function explicitIdentifiers(question) {
  const q = question.replace(/[’‘]/g, "'");
  const compare = q.match(/\b(?:compare\s+)?(.+?)\s+(?:versus|vs\.?|compared (?:with|to))\s+(.+?)[?!.]?$/i)
    || q.match(/\bcompare\s+(.+?)\s+(?:and|with|to)\s+(.+?)[?!.]?$/i);
  if (compare) {
    const pair = compare.slice(1).map(cleanIdentifier);
    if (pair.every(Boolean)) return pair;
  }
  const quoted = [...q.matchAll(/"([^"\n]{1,100})"/g)].map(match => cleanIdentifier(match[1])).filter(Boolean);
  if (quoted.length) return [...new Set(quoted)];
  const possessive = q.match(/\b(?:what (?:are|is)|how (?:are|is)|explain|summarize|review|analyze|analyse|show(?: me)?)?\s*([A-Za-z][A-Za-z0-9 .&-]{0,80}?)'s\s/i);
  if (possessive) {
    const name = cleanIdentifier(possessive[1].replace(/^(?:tell me about|what (?:are|is)|how (?:are|is)|explain|summarize|review|analyze|analyse|show(?: me)?)\s+/i, ''));
    if (name) return [name];
  }
  const tickers = [...q.matchAll(/(?:\$([A-Za-z][A-Za-z0-9.-]{0,14})\b|\b([A-Z][A-Z0-9.-]{0,14})\b|\b(\d{10})\b)/g)]
    .map(match => match[1] || match[2] || match[3]).filter(value => !STOP_TICKERS.has(value) && !/^\d{4}$/.test(value));
  if (tickers.length) return [...new Set(tickers)];
  const after = q.match(/\b(?:for|about|of)\s+(.+?)[?!.]?$/i)
    || q.match(/^(?:please\s+)?(?:summarize|analyse|analyze|research|review|explain|look up|what about|how is|show(?: me)?(?:\s+(?:the\s+)?(?:financial results|financials|portfolio|holdings)\s+for)?)\s+(.+?)[?!.]?$/i);
  if (after) {
    const candidate = cleanIdentifier(after[1]);
    // Common task descriptions are not entity names. Unknown names still go
    // through the existing authoritative SEC resolver before any data read.
    if (candidate && !/^(?:a |the |its |their |my |this |how |what |which |why |latest |recent |main |liquidity\b|debt\b|cash\b|financial\b)/i.test(candidate)
      && !/^(?:market briefing|cftc positioning|sector performance)$/i.test(candidate)) return [candidate];
  }
  if (/^[A-Za-z0-9][A-Za-z0-9 .&-]{0,80}$/.test(q) && !FINANCIAL.test(q) && !/\b(?:explain|help|hello|hi|thanks|thank|page|market|fund|portfolio|sector|cftc|definition|mean|its|their|they|selected)\b/i.test(q)) return [cleanIdentifier(q)].filter(Boolean);
  return [];
}

function pageFinancialQuestion(question) {
  // Only a bounded vocabulary of subject-free requests can inherit the page
  // company. A missed name such as "Microsoft" must never become page AAPL.
  const rest = question.toLowerCase().replace(/\b(?:please|explain|summarize|summarise|review|show|tell|me|what|how|are|is|does|do|can|you|the|a|an|and|or|its|their|it|this|that|selected|current|company|latest|recent|main|financial|financials|results|revenue|income|assets|liabilities|equity|cash|flow|flows|generation|allocation|liquidity|debt|funding|capital|margin|margins|profit|profitability|balance|sheet|growth|trend|trends|ratio|ratios|earnings|performance|business|fundamentals|overview|annual|quarterly|quarter|standalone|ttm|reporting|basis|period|look|like|of|on|for)\b/g, '').replace(/[^a-z0-9]/g, '');
  return !rest && FINANCIAL.test(question);
}

function basisFor(question, page) {
  if (/\b(?:year.to.date|ytd)\b/i.test(question) || page.basis === 'ytd') return 'ytd';
  if (/\b(?:quarterly|standalone quarter)\b/i.test(question)) return 'quarter';
  if (/\b(?:annual|fiscal year)\b/i.test(question)) return 'annual';
  if (/\b(?:ttm|trailing twelve months|trailing 12 months)\b/i.test(question)) return 'ttm';
  return page.basis || 'annual';
}
const definition = question => /^(?:please\s+)?(?:what (?:is|are|does)|define|explain (?:the (?:meaning|definition) of|what)|how (?:is|are).+calculated)/i.test(question)
  && !/(?:['’]s\s|\b(?:for|of)\s+[A-Z][A-Za-z]*|\b(?:latest|current|reported)\b)/.test(question)
  ? DEFINITIONS.find(([pattern]) => pattern.test(question)) : null;

function selectionMessage(result) {
  if (result.status === 'needs_selection') return [text(result.message) || 'Choose the intended entity before I retrieve financial values.',
    ...(result.choices || []).slice(0, 6).map(choice => `- ${text(choice.name || choice.label)}${choice.id || choice.ticker ? ` (${text(choice.id || choice.ticker)})` : ''}`),
    'Reply with the exact ticker, SEC CIK, fund-series identifier, or a more specific name.'].join('\n');
  if (result.status === 'not_found') return 'No verified SEC entity matched that name. Reply with its ticker, SEC CIK, or N-PORT series identifier.';
  return text(result.reason) || 'This prepared research source is unavailable. Open the relevant page or try a narrower question later.';
}

function companyBlocks(result, question) {
  const blocks = [`**${text(result.entity.name)} · ${text(result.entity.ticker || result.entity.id)}**`,
    `${text(result.basis)} financial evidence · period ending ${text(result.period.asOf)}${result.filingCutoff ? ` · filings through ${text(result.filingCutoff)}` : ''}. ${refs(result.sourceIds)}`,
    'USD amounts are whole dollars. Flow measures cover the dates shown; balance-sheet amounts are at period end. Missing values are unavailable, never zero.'];
  const keys = /\b(?:liquidity|debt|funding|capital)\b/i.test(question)
    ? ['cash', 'currentRatio', 'totalDebt', 'deposits', 'loans', 'stockholdersEquity', 'equityAssets', 'operatingCashFlow', 'freeCashFlow', 'totalAssets', 'totalLiabilities']
    : ['revenue', 'bankRevenue', 'premiumsEarned', 'investmentIncome', 'netIncome', 'operatingIncome', 'netMargin', 'operatingMargin', 'operatingCashFlow', 'freeCashFlow', 'totalAssets', 'stockholdersEquity'];
  const selected = keys.flatMap(key => result.metrics.filter(metric => metric.key === key)).slice(0, 10);
  blocks.push(selected.length ? selected.map(metric => {
    const value = metric.values[0], start = INSTANT_KEYS.has(metric.key) ? null : metric.startDates?.[0];
    const span = start ? `${text(start)} to ${text(result.periods[0])}` : `at ${text(result.periods[0])}`;
    const note = !finite(value) ? ` ${text(metric.missingReasons?.[result.periods[0]])}` : metric.status?.[0] === 'calculated' ? ' Calculated by the site.' : '';
    return `- **${text(metric.label)}:** ${valueText(value, metric.unit)} (${span}).${note} ${refs(metric.sourceIds?.[0])}`;
  }).join('\n') : 'No supported source-linked financial metrics are available in this summary.');
  if (/\b(?:trends?|growth|changed?|prior|previous|history)\b/i.test(question)) {
    const trend = selected.slice(0, 3).filter(() => result.periods.length > 1).map(metric =>
      `- ${text(metric.label)}: ${result.periods.slice(0, 3).map((end, index) => `${text(end)}${!INSTANT_KEYS.has(metric.key) && metric.startDates?.[index] ? ` (from ${text(metric.startDates[index])})` : ''}: ${valueText(metric.values[index], metric.unit)} ${refs(metric.sourceIds?.[index])}`).join('; ')}.`);
    if (trend.length) blocks.push(`**Dated observations**\n${trend.join('\n')}\nThese observations do not establish a comparable growth rate; durations and definitions must match.`);
  }
  if (result.coverage?.message) blocks.push(`Coverage: ${text(result.coverage.message)}`);
  if (result.warning) blocks.push(text(result.warning));
  blocks.push(...(result.notes || []).slice(0, 3).map(text));
  return blocks;
}

function fundBlocks(result) {
  const blocks = [`**${text(result.entity.name)} · ${result.kind === '13f' ? '13F manager' : 'N-PORT fund series'}**`,
    `Portfolio at ${text(result.period.asOf)}. Latest supporting filing: ${text(result.period.latestSourceFilingDate) || 'unavailable'}. Portfolio and filing dates differ. ${refs(result.sourceIds)}`,
    result.kind === '13f' ? 'Reported securities value is not total assets under management, a complete economic portfolio, or investment performance.'
      : 'These are historical fund-series holdings and net assets shared by associated share classes, not a live ticker-specific portfolio. Weights use fund-series net assets.'];
  blocks.push((result.summary || []).slice(0, 6).map(row => `- **${text(row.label)}:** ${row.sourceIds?.length ? valueText(row.value, row.unit) : 'Unavailable'}${row.detail ? ` — ${text(row.detail)}` : ''}. ${refs(row.sourceIds)}`).join('\n'));
  if (result.sourceIds?.length && result.topPositions?.length) blocks.push(`**Largest disclosed positions (selected report)**\n${result.topPositions.slice(0, 5).map(row =>
    `- ${text(row.name)}${row.positionType || row.asset ? ` · ${text(row.positionType || row.asset)}` : ''}: ${valueText(row.value, 'usd')}; weight ${valueText(row.weight, 'fraction')}.`).join('\n')}\n${refs(result.sourceIds)}\nOnly the largest five disclosed positions are shown here. Weights are the report’s stated denominator, not total economic exposure.`);
  if (result.coverage?.message) blocks.push(`Coverage: ${text(result.coverage.message)}`);
  if (result.warning) blocks.push(text(result.warning));
  blocks.push(...(result.notes || []).slice(0, 5).map(text));
  return blocks;
}

function marketBlocks(result) {
  const blocks = ['**Market briefing · SEC business fundamentals**',
    `${text(result.basis)} basis · prepared ${text(result.snapshotAt)}. ${refs(result.sourceIds)}`,
    `${number(result.coverage.companyCount)} companies in the prepared universe; ${number(result.coverage.sectorCount)} sectors. Financial period ends range from ${text(result.reportRange?.earliest) || 'unavailable'} to ${text(result.reportRange?.latest) || 'unavailable'}. Snapshot time is not a common financial period.`,
    'These are filing-based business results, not share-price returns or a complete market census. Percentages below are percentage units; each measure has its own available-company denominator.'];
  if (result.reportRange?.latest && (result.reportRange.latest > String(result.snapshotAt).slice(0, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(result.reportRange.latest)))
    blocks.push('Data-quality warning: the prepared snapshot contains a reported fiscal end later than its snapshot date or an invalid fiscal-end label. The source date is shown as supplied. Do not interpret this range as verified current-period coverage; inspect the Market sources before relying on it.');
  const labels = { revenueGrowth: 'Positive revenue growth', profitable: 'Positive net income', positiveOperatingCashFlowMargin: 'Positive operating cash flow / revenue' };
  blocks.push((result.breadth || []).map(row => `- **${labels[row.metric] || text(row.metric)}:** ${valueText(row.positivePct, '%')} (${number(row.positive)} of ${number(row.count)} companies with available inputs).`).join('\n'));
  const sectors = [...(result.sectors || [])].sort((a, b) => (finite(b.metrics.revenueGrowth?.median) ? b.metrics.revenueGrowth.median : -Infinity) - (finite(a.metrics.revenueGrowth?.median) ? a.metrics.revenueGrowth.median : -Infinity));
  blocks.push(`**Sector medians, ordered by revenue growth**\n${sectors.slice(0, 11).map(row => `- ${text(row.sector)}: revenue growth ${valueText(row.metrics.revenueGrowth?.median, '%')} (${number(row.metrics.revenueGrowth?.count)} available); net margin ${valueText(row.metrics.netMargin?.median, '%')} (${number(row.metrics.netMargin?.count)} available).`).join('\n')}\n${refs(result.sourceIds)}`);
  if (result.coverage.cache?.status) blocks.push(`Snapshot cache status: ${text(result.coverage.cache.status)}. Older report count: ${number(result.coverage.olderReports)}.`);
  return blocks;
}

function sectorBlocks(result) {
  const unit = result.metric.unit === 'pct' ? '%' : result.metric.unit;
  return [`**Sector companies · ${text(result.selection.sector)}**`,
    `${text(result.selection.basis)} basis · ${text(result.metric.label)} · ${text(result.selection.direction)} order · prepared ${text(result.snapshotAt)}. ${refs(result.sourceIds)}`,
    `${number(result.matchedCompanies)} companies match the selected sector and search; ${number(result.availableCount)} have available metric values. Page ${number(result.page)}.${result.selection.query ? ` Search filter: ${text(result.selection.query)}.` : ''}`,
    text(result.scope),
    result.companies.slice(0, 10).map(row => `- **${text(row.ticker)} · ${text(row.name)}:** ${unit === 'text' ? text(row.value) : valueText(row.value, unit)} · fiscal end ${text(row.report?.end) || 'unavailable'}.${row.revenueBasis ? ` ${text(row.revenueBasis)}` : ''} ${refs(row.sourceIds)}`).join('\n'),
    'Up to ten rows from the selected page are shown. This is a view of the prepared sector and search filters, not the entire stock market. Ties can share economic rank; missing values are unavailable, not zero.'];
}

function cftcBlocks(result) {
  const blocks = ['**CFTC futures positioning**', text(result.scope || result.units),
    'Positions are contracts, not dollars. Net/OI is a percentage; changes are percentage points. These are trader-group aggregates, not an individual company’s positions or a price forecast.'];
  if (result.selected) {
    const row = result.selected;
    blocks.push(`${text(result.market.name)} · ${text(result.selection.group)} · report ${text(row.reportDate)} · ${text(result.selection.window)} history. ${refs(result.sourceIds)}`,
      `- Net contracts: ${number(row.net)}.\n- Net/Open Interest: ${valueText(row.netPctOi, '%')}.\n- One-week Net/OI change: ${valueText(row.oneWeekNetPctChange, 'pp')}.\n- Open interest: ${number(row.openInterest)}.`);
    if (result.warning) blocks.push(text(result.warning));
  } else {
    blocks.push((result.cards || []).map(row => `- **${text(row.label)} · ${text(row.groupLabel)}:** ${valueText(row.netPctOi, '%')} net/OI; weekly change ${valueText(row.weeklyChange, 'pp')} · report ${text(row.reportDate) || 'unavailable'}${row.stale || row.aged ? ' · retained/aged data' : ''}. ${refs(row.sourceIds)}`).join('\n'));
    if (result.differentReportDates) blocks.push('Report dates differ across families; do not treat these as a common-week comparison.');
    blocks.push(...(result.failures || []).map(text));
  }
  return blocks;
}

function compareBlocks(result) {
  const blocks = [`**${result.companies.map(company => text(company.name)).join(' / ')}**`,
    `${text(result.basis)} · ${text(result.alignment)} alignment${result.selectedBucket ? ` · bucket ${text(result.selectedBucket)}` : ''}${result.filingCutoff ? ` · filings through ${text(result.filingCutoff)}` : ''}. ${refs(result.sourceIds)}`];
  blocks.push(...result.metrics.slice(0, 6).map(metric => `**${text(metric.label)}**\n${metric.points.map((point, index) =>
    `- ${text(result.companies[index]?.ticker)}: ${valueText(point.value, metric.unit)} · ${point.period?.start ? `${text(point.period.start)} to ` : ''}${text(point.period?.end) || 'period unavailable'}. ${refs(point.sourceIds)}${point.reason ? ` ${text(point.reason)}` : ''}`).join('\n')}${metric.comparisonReason ? `\nComparability: ${text(metric.comparisonReason)}` : ''}`));
  blocks.push(...(result.notes || []).map(text));
  return blocks;
}

function sharedBlocks(result) {
  if (result.kind === 'portfolio') return ['**Explicitly shared portfolio · user-provided holdings**',
    `${number(result.sharedHoldings)} of ${number(result.totalHoldings)} holdings shared. Shared weight coverage: ${valueText(result.coverageWeight, 'fraction')}.`,
    (result.holdings || []).slice(0, 10).map(row => `- ${text(row.ticker)}: ${valueText(row.weight, 'fraction')}.`).join('\n'),
    ...(result.limitations || []).map(text)];
  return ['**Shared scenario · use the Analysis scenario results**', text(result.limitations),
    'The basic summary does not yet present every scenario calculation. Open the shared Analysis scenario to inspect its exact assumptions and dated results. No hypothetical values have been invented here.'];
}

function response(blocks, research, category = 'help', status = 'ready', suggestions = SUGGESTIONS) {
  const kept = [];
  let size = 0;
  for (const block of blocks.filter(Boolean)) {
    if (size + block.length + 2 > BROWSER_RESEARCH_MAX_CHARS - 150) {
      kept.push('This compact summary omits additional detail. Open the supporting research page for the full evidence.');
      break;
    }
    kept.push(block); size += block.length + 2;
  }
  const answer = kept.join('\n\n');
  const used = new Set([...answer.matchAll(/\[(S\d+)\]/g)].map(match => match[1]));
  const sources = research ? research.getSources().filter(source => used.has(source.id)) : [];
  return { answer, evidence: answer, sources, category, status, suggestions };
}

/** Deterministic, source-grounded preparation for both Basic and Browser AI.
 * Dependencies are server/test reader overrides, never browser-supplied tools.
 * The existing research layer enforces 4 tools, 2 companies and 18 active seconds.
 */
export async function prepareBrowserResearch({ messages = [], context = {}, sharedContext = null, signal, dependencies = {} } = {}) {
  signal?.throwIfAborted();
  const page = normalizeChatContext(context), shared = normalizeSharedChatContext(sharedContext);
  const last = Array.isArray(messages) ? messages.at(-1) : null;
  const question = last?.role === 'user' && typeof last.content === 'string' ? last.content.trim().slice(0, 3000) : '';
  if (!question) return response(['Enter a question about EDGAR Terminal, a company, a fund, or the market.'], null, 'help', 'needs_selection');
  const term = definition(question);
  if (term) return response([`**${term[1]}**`, term[2]], null, 'definition');
  if (/\b(?:what (?:this|the) page (?:shows|does)|explain (?:this|the) page|how (?:do|can) i (?:use|research)|what can you do|help me (?:use|navigate))\b/i.test(question))
    return response([`**EDGAR Terminal · ${text(page.label)}**`, PAGE_HELP[page.section] || 'EDGAR Terminal organizes SEC filings, company financials, historical fund portfolios, market fundamentals, and CFTC positioning. Ask for a named company, a named 13F manager or N-PORT fund, a market briefing, or a financial definition.'], null);
  const ids = explicitIdentifiers(question), basis = basisFor(question, page);
  // Natural-language dates need fiscal/calendar and filing-date disambiguation.
  // Never silently substitute latest data for a historical request.
  if (/\b(?:19|20)\d{2}(?:-\d{2}-\d{2})?\b|\b(?:last|previous|prior) (?:year|quarter)|\bQ[1-4]\b/i.test(question))
    return response(['Choose the requested reporting period or filing cutoff on the research page, then ask for “the selected period.” For comparisons, select the calendar bucket on Compare. This avoids substituting a different fiscal period or current filing evidence.'], null, 'help', 'needs_selection');
  if (basis === 'ytd') return response(['The basic/browser research summary supports annual, standalone-quarter, and TTM company data. The selected YTD basis is not supported here. Choose one of the supported bases on Analysis; no different basis has been substituted.'], null, 'company', 'unavailable');
  if (messages.length > 1 && !ids.length && /\b(?:it|its|they|their|that company|same company)\b/i.test(question))
    return response(['Name the company or fund again in this follow-up so the summary uses the intended entity. You can also ask explicitly about “the selected company” or “the selected fund.”'], null, 'help', 'needs_selection');
  const research = createChatResearch({ context: page, sharedContext: shared, signal, dependencies });
  const run = async (tool, input, category, format) => {
    const result = await research.tools[tool].execute(input);
    signal?.throwIfAborted();
    return response(result.status === 'ready' ? format(result) : [selectionMessage(result)], research, category, result.status || 'unavailable');
  };
  if (/\b(?:my|shared|attached) (?:portfolio|holdings|scenario)|\bscenario\b/i.test(question)) {
    const kind = /\bscenario\b/i.test(question) ? 'analysis-scenario' : 'portfolio';
    return run('shared_context', { kind }, 'shared', sharedBlocks);
  }
  if (/\b(?:cftc|positioning|futures|net\/oi|open interest)\b/i.test(question) || page.section === 'market' && page.tab === 'positioning' && /\b(?:summar|selected|show|chart)\w*/i.test(question)) {
    const namedContract = question.match(/\b(?:positioning|futures|cftc)\s+(?:for|in|of)\s+(.+?)[?!.]?$/i)?.[1];
    if (namedContract) {
      const family = /\b(?:gold|silver|copper|crude|oil|corn|wheat|soy|cotton|coffee|cattle|gas)\b/i.test(namedContract) ? 'disaggregated' : page.family || 'tff';
      return run('cftc_history', { family, contract: namedContract, group: '', date: '', window: '' }, 'cftc', cftcBlocks);
    }
    if (page.contract) return run('cftc_history', { family: '', contract: '', group: '', date: '', window: '' }, 'cftc', cftcBlocks);
    if (page.date && page.date !== 'latest') return response(['Choose a CFTC contract on the Market page to summarize its selected historical report. The latest macro snapshot has not been substituted for that date.'], null, 'cftc', 'needs_selection');
    return run('cftc_positioning', { family: page.family || 'all' }, 'cftc', cftcBlocks);
  }
  const sector = QUANT_GROUPS.find(group => new RegExp(`\\b${group.label.replace(/ /g, '\\s+')}\\b`, 'i').test(question));
  if (sector || /\b(?:market (?:briefing|summary|overview)|sectors?|business conditions|market fundamentals)\b/i.test(question) || !ids.length && /\bmarket\b/i.test(question) || page.section === 'market' && !ids.length && /\b(?:summar|overview|explain|performance)\w*/i.test(question)) {
    if (/\b(?:stock|share|price|return)\w*\b/i.test(question)) return response(['The Market data here measures SEC business fundamentals, not stock-price returns. Ask for revenue growth, profitability, cash generation, or CFTC positioning.'], null, 'market', 'needs_selection');
    const marketBasis = /\bannual\b/i.test(question) ? 'annual' : page.section === 'market' && page.basis === 'annual' ? 'annual' : 'ttm';
    if (/\bcompanies\b/i.test(question)) {
      const metric = /\brevenue growth\b/i.test(question) ? 'revenueGrowth' : /\bnet margin\b/i.test(question) ? 'netMargin'
        : /\boperating margin\b/i.test(question) ? 'operatingMargin' : /\b(?:assets|largest)\b/i.test(question) ? 'totalAssets' : '';
      const direction = /\b(?:lowest|weakest|smallest)\b/i.test(question) ? 'asc' : /\b(?:highest|strongest|largest|top)\b/i.test(question) ? 'desc' : '';
      return run('sector_companies', { sector: sector?.label || '', basis: marketBasis, metric, direction, query: '', page: '' }, 'market', sectorBlocks);
    }
    return run('market_summary', { basis: marketBasis, sector: sector?.label || page.sector || '' }, 'market', marketBlocks);
  }
  const explicitCompany = ids.length && /\b(?:company|financials?|financial results|revenue|income|balance sheet|cash flow|liquidity|debt|earnings)\b/i.test(question);
  const kind = /\b13[ -]?f\b/i.test(question) ? '13f' : /\bn[ -]?port\b/i.test(question) ? 'nport' : explicitCompany ? '' : page.managerCik ? '13f' : page.fund ? 'nport' : '';
  if (kind || /\b(?:fund|manager|portfolio|holdings)\b/i.test(question)) {
    if (!kind) return response(['Specify whether you want an N-PORT fund or a 13F manager, and provide its name, ticker, or SEC identifier. You can also select the portfolio on Funds first.'], null, 'fund', 'needs_selection');
    if (ids.length > 1 || /\b(?:compar|overlap|changes?|added|removed)\w*/i.test(question)) return response(['The basic/browser pilot summarizes one fund portfolio at a time. Select a fund and period on Funds, or ask “Summarize 13F manager [name]” or “Summarize N-PORT fund [ticker].” Use the Funds comparison and changes views for those calculations.'], null, 'fund', 'needs_selection');
    const identifier = ids[0] || (kind === '13f' ? page.managerCik : page.fund);
    if (!identifier) return response(['Provide the fund ticker, manager name or SEC identifier, or select a portfolio on Funds first.'], null, 'fund', 'needs_selection');
    return run('fund_portfolio', { identifier, kind }, 'fund', fundBlocks);
  }
  if (ids.length === 2 || /\bcompar(?:e|ison)\b/i.test(question) && page.compareTickers.length === 2) {
    const pair = ids.length === 2 ? ids : page.compareTickers;
    return run('company_comparison', { first: pair[0], second: pair[1], basis, asOf: '', metric: page.section === 'compare' ? page.metric || '' : '', alignment: page.alignment || 'common', period: '' }, 'compare', compareBlocks);
  }
  if (ids.length > 2) return response(['Ask about at most two companies per question. Name one company for a financial summary or two for a comparison.'], null, 'company', 'needs_selection');
  if (/\bcompar(?:e|ison)\b/i.test(question)) return response(['Name two companies to compare, or select both companies on the Compare page. No comparison has been inferred from a single company’s figures.'], null, 'compare', 'needs_selection');
  const identifier = ids[0] || (pageFinancialQuestion(question) ? page.company : '');
  if (identifier) return run('company_financials', { identifier, basis }, 'company', result => companyBlocks(result, question));
  return response(['I can retrieve a dated company summary, compare two companies, summarize a named N-PORT fund or 13F manager, explain a financial metric, or read the Market/CFTC snapshot. Include the entity name or ticker, or ask “Explain what this page shows.”'], null, 'help', 'needs_selection');
}
