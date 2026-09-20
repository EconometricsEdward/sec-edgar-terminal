import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoopAgent, isStepCount, jsonSchema, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createChatResearch } from '../src/utils/chatResearch.js';
import { createChatAgent, handleChatPost, chatInstructions, CHAT_MAX_PROMPT_BYTES } from '../src/utils/chatServer.js';
import { createChatGrounding } from '../src/utils/chatGrounding.js';
import { normalizeChatContext } from '../src/utils/chatContext.js';
import { normalizeSharedChatContext } from '../src/utils/chatSharedContext.js';
import { buildCompareCompany } from '../src/utils/compareResearch.js';
import { packAnalysisCompany } from '../src/utils/analysisResearch.js';
import { buildMarketSectorCompanies, pageMarketSectorCompanies, MARKET_SECTOR_COMPANY_METRICS } from '../src/utils/marketSectorCompanies.js';
import { QUANT_GROUPS } from '../src/utils/quantGroups.js';
import { extractCompanyExposureMap } from '../src/utils/companyExposure.js';

const EXPECTED_TOOLS = ['search_entities', 'company_financials', 'market_summary', 'cftc_positioning', 'fund_portfolio', 'disclosure_passages',
  'sector_companies', 'cftc_history', 'company_comparison', 'company_risk', 'fund_holdings', 'fund_changes', 'fund_overlap',
  'filings_list', 'filing_document', 'shared_context', 'company_exposures'].sort();

const identities = Object.fromEntries(['AAA', 'BBB', 'CCC'].map((ticker, index) => [ticker,
  { kind: 'company', id: ticker, ticker, cik: String(index + 1).padStart(10, '0'), name: `Company ${ticker}` }]));
const MANAGER = '0001747057', quarter = '2026-06-30';
const filing = { accession: '0000000001-26-000001', form: '10-K', filingDate: '2026-02-15', reportDate: '2025-12-31', primaryDoc: 'annual.htm' };
const oldFiling = { accession: '0000000001-25-000001', form: '10-K', filingDate: '2025-02-15', reportDate: '2024-12-31', primaryDoc: 'prior.htm' };
const sectorInput = { sector: 'Information Technology', basis: 'ttm', metric: 'revenueGrowth', direction: 'desc', query: '', page: '1' };
const comparisonInput = { first: 'AAA', second: 'BBB', basis: 'annual', asOf: '', metric: 'operatingCashFlow', alignment: 'common', period: '' };
const holdingsInput = { identifier: MANAGER, kind: '13f', selection: '', query: '' };
const documentInput = { identifier: 'AAA', accession: '', form: '', section: '', query: '', page: '', view: 'document', prior: '', filed: '', priorFiled: '', archive: '', priorArchive: '' };
const listInput = { identifier: 'AAA', form: '', start: '', end: '', archive: '' };
const portfolio = { kind: 'portfolio', holdings: [{ ticker: 'AAA', weight: 0.6 }, { ticker: 'BBB', weight: 0.4 }], totalHoldings: 2, coverageWeight: 1 };

function company(ticker, settings = {}) {
  const cik = identities[ticker].cik, multiplier = ticker === 'BBB' ? 2 : 1;
  const flows = new Set(['Revenues', 'NetIncomeLoss', 'NetCashProvidedByUsedInOperatingActivities']);
  const facts = { 'us-gaap': Object.fromEntries(Object.entries({ Assets: [1000, 1100], StockholdersEquity: [350, 400], Revenues: [500, 600],
    NetIncomeLoss: [50, 65], NetCashProvidedByUsedInOperatingActivities: [75, 90] }).map(([tag, values]) => [tag, { units: { USD: values.map((val, i) => ({
    val: val * multiplier, fy: 2024 + i, fp: 'FY', form: '10-K', end: `${2024 + i}-12-31`,
    ...(flows.has(tag) ? { start: `${2024 + i}-01-01` } : {}), filed: `${2025 + i}-02-15`, accn: `${cik}-${25 + i}-000001`,
  })) } }])) };
  return packAnalysisCompany(buildCompareCompany({ ticker, cik, companyName: identities[ticker].name, sic: '3571', facts, filings: [] },
    { basis: settings.basis || 'annual', asOf: settings.asOf || '' }));
}

function fixtures() {
  const reads = [];
  const sector = buildMarketSectorCompanies({ generatedAt: '2026-09-18T12:00:00Z', cohorts: QUANT_GROUPS,
    companies: Array.from({ length: 30 }, (_, index) => ({ ticker: `T${String(index).padStart(3, '0')}`, cik: String(100 + index),
      name: `Technology company ${index}`, sic: '3571', sector: 'Information Technology', cohorts: ['sector-technology'],
      metrics: Object.fromEntries(['annual', 'ttm'].map(basis => [basis, Object.fromEntries(MARKET_SECTOR_COMPANY_METRICS.map(metric => [metric, index]))])),
      reports: Object.fromEntries(['annual', 'ttm'].map(basis => [basis, { end: basis === 'annual' ? '2025-12-31' : '2026-06-30', filed: '2026-08-01', form: '10-Q', accession: null }])),
    })) });
  return { reads, dependencies: {
    cftcEnabled: () => true,
    search: async ({ query, kind }) => ({ results: kind === '13f' ? [{ kind, id: MANAGER, cik: MANAGER, name: 'Selected institutional manager' }]
      : identities[query] ? [identities[query]] : [] }),
    companyComparison: async settings => { reads.push(['compare', settings]); return { payload: company(settings.ticker, settings) }; },
    companyExposures: async settings => {
      reads.push(['exposures', settings]);
      const source = { url: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/annual.htm',
        accession: filing.accession, form: filing.form, filed: filing.filingDate, reportDate: filing.reportDate };
      return { cik: identities.AAA.cik, ticker: 'AAA', asOf: settings.asOf || null, status: 'ready',
        rows: extractCompanyExposureMap([{ text: 'Our SOFR-linked borrowings expose us to changes in funding costs.', filing: source, role: 'annual' }]).rows,
        sources: [{ ...source, role: 'annual', status: 'ready' }], coverage: { filingsScanned: 1 } };
    },
    sectorCompanies: async settings => { reads.push(['sector', settings]); return pageMarketSectorCompanies(sector, settings); },
    fund13f: async settings => {
      reads.push(['fund', settings]);
      const selected = settings.period || quarter, accession = `${MANAGER}-26-000001`;
      return { status: 'ready', manager: { cik: MANAGER, name: 'Selected institutional manager' }, selectedPeriod: selected,
        observedAt: '2026-09-18T00:00:00Z', reports: [{ period: selected }], coverage: { selectedPeriodComplete: true },
        portfolio: { cik: MANAGER, period: selected, complete: true, comparable: true, confidentialOmitted: false,
          reportType: '13F HOLDINGS REPORT', totalValueUsd: 100, positionCount: 1, entryCount: 1, amendmentCount: 0, issues: [],
          holdings: [{ issuer: 'An issuer', classTitle: 'COM', cusip: '037833100', putCall: null, quantityType: 'SH', quantity: 10, valueUsd: 100, weightPct: 100, key: '037833100|SECURITY|SH' }],
          filings: [{ accession, form: '13F-HR', filingDate: '2026-08-01', indexUrl: `https://www.sec.gov/Archives/edgar/data/${Number(MANAGER)}/${accession.replaceAll('-', '')}/${accession}-index.html`, tableUrls: [] }],
        } };
    },
    filingsCompany: async ticker => { reads.push(['filings', ticker]); return { ticker, cik: identities[ticker].cik, kind: 'operating',
      filings: [filing, oldFiling], archives: [], sourceObservedAt: '2026-09-18T00:00:00Z', omittedRecords: 0, omittedArchives: 0 }; },
    filingDocument: async settings => { reads.push(['document', settings]); return { cik: identities.AAA.cik,
      filing: settings.accession === oldFiling.accession ? oldFiling : filing, prior: null,
      paragraphs: [{ text: 'The company disclosed a revolving credit facility. No default occurred during this reporting period.', index: 7, sectionId: 'mda', section: 'Management discussion and analysis', parts: 1 }],
      coverage: { totalParagraphs: 300, matchedParagraphs: 1, page: settings.page, pageSize: 8, extraction: 'Heading-based text extraction' },
      comparison: { status: 'not-requested', changes: [], coverage: [] } }; },
  } };
}

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };
const stream = values => new ReadableStream({ start(controller) { values.forEach(value => controller.enqueue(value)); controller.close(); } });
const step = (parts, reason = 'stop') => ({ stream: stream([{ type: 'stream-start', warnings: [] }, ...parts,
  { type: 'finish', finishReason: { unified: reason, raw: reason }, usage }]) });
const call = (name, input, id = name) => ({ type: 'tool-call', toolName: name, toolCallId: id, input: JSON.stringify(input) });
const text = value => [{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: value }, { type: 'text-end', id: 'answer' }];
async function run({ steps, context = { path: '/about', query: '' }, sharedContext, dependencyOverrides = {}, messages, mode = 'fast' }) {
  const model = new MockLanguageModelV4({ doStream: steps }), fixture = fixtures(), outputs = [], state = { reservations: 0, releases: 0 };
  let research;
  const request = new Request('https://secedgarterminal.com/api/chat', { method: 'POST', headers: { origin: 'https://secedgarterminal.com', 'content-type': 'application/json' },
    body: JSON.stringify({ messages: messages || [{ role: 'user', content: 'Summarize the selected financial evidence.' }], context, mode,
      ...(sharedContext === undefined ? {} : { sharedContext }) }) });
  const response = await handleChatPost(request, {
    reserve: async () => { state.reservations++; return { allowed: true, release: async () => { state.releases++; } }; }, verifyPrice: async () => {},
    research: options => {
      research = createChatResearch({ ...options, dependencies: { ...fixture.dependencies, ...dependencyOverrides } });
      for (const [name, spec] of Object.entries(research.tools)) {
        const execute = spec.execute;
        spec.execute = async input => { const output = await execute(input); outputs.push({ name, output }); return output; };
      }
      return research;
    },
    agent: options => createChatAgent({ ...options, sdk: { ToolLoopAgent, gateway: () => model, isStepCount, jsonSchema, tool } }),
  });
  const body = await response.text(), frames = response.ok ? body.trim().split('\n').map(JSON.parse) : [];
  return { response, frames, body, text: frames.filter(frame => frame.type === 'text').map(frame => frame.text).join(''),
    model, research, outputs, reads: fixture.reads, state };
}

for (const [name, input, answer] of [
  ['sector_companies', sectorInput, 'The prepared sector ranking places T029 first at 29% revenue growth [S1].'],
  ['company_comparison', comparisonInput, 'Operating cash flow was $90 for AAA and $180 for BBB for 2025 [S1].'],
  ['fund_holdings', holdingsInput, 'The manager disclosed one reported holding worth $100 at the selected quarter end [S1].'],
  ['filing_document', { ...documentInput, accession: filing.accession, section: 'mda' }, 'The filing says no default occurred during the reporting period [S1].'],
  ['company_exposures', { identifier: 'AAA', asOf: '', category: 'all' }, 'The company discloses SOFR-linked funding costs. This does not establish its own futures positions [S1].'],
]) {
  test(`real SDK reaches ${name} from About and unlocks a cited response only after source retrieval`, async t => {
    t.mock.method(console, 'info', () => {});
    const result = await run({ steps: [step([...text('UNVERIFIED PREAMBLE 999.'), call(name, input)], 'tool-calls'), step(text(answer))] });
    assert.equal(result.response.status, 200); assert.equal(result.model.doStreamCalls.length, 2);
    assert.equal(result.outputs[0].output.status, 'ready'); assert.equal(result.text, answer); assert.equal(result.frames.at(-1).type, 'done');
    assert.doesNotMatch(result.text, /999|UNVERIFIED/); assert.ok(result.research.getSources().length > 0);
    assert.deepEqual(result.model.doStreamCalls[0].tools.map(spec => spec.name).sort(), EXPECTED_TOOLS);
    assert.ok(result.model.doStreamCalls[0].tools.some(spec => spec.name === name));
    assert.equal(result.state.reservations, 1); assert.equal(result.state.releases, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(result.outputs[0].output)) <= 12000);
    assert.ok(Buffer.byteLength(JSON.stringify({ prompt: result.model.doStreamCalls[1].prompt, tools: result.model.doStreamCalls[1].tools })) < CHAT_MAX_PROMPT_BYTES);
  });
}

test('failed cross-page identity does not unlock an answer, even with a fabricated tool-step preamble', async t => {
  t.mock.method(console, 'info', () => {});
  const result = await run({ dependencyOverrides: { companyComparison: async settings => ({ payload: { ...company(settings.ticker, settings), cik: '0000000999' } }) },
    steps: [step([...text('Fabricated figure 777.'), call('company_comparison', comparisonInput)], 'tool-calls')] });
  assert.equal(result.model.doStreamCalls.length, 1); assert.equal(result.outputs[0].output.status, 'unavailable');
  assert.equal(result.outputs[0].output.code, 'SOURCE_IDENTITY_MISMATCH'); assert.equal(result.research.getSources().length, 0);
  assert.match(result.text, /could not retrieve verified source data/); assert.doesNotMatch(result.text, /777|Fabricated/);
  assert.equal(result.frames.at(-1).type, 'done'); assert.equal(result.state.releases, 1);
});

test('new tool names require ready substantive results and registered citations to satisfy grounding', () => {
  for (const name of ['sector_companies', 'company_comparison', 'company_risk', 'fund_holdings', 'fund_changes', 'fund_overlap', 'filings_list', 'filing_document', 'cftc_history', 'company_exposures']) {
    for (const output of [{ status: 'unavailable', sourceIds: ['S1'] }, { status: 'ready', sourceIds: ['FORGED'] }, { status: 'ready', value: 999 }]) {
      const policy = createChatGrounding([{ role: 'user', content: 'Analyze the latest data.' }]);
      policy.observe(name, output, [{ id: 'S1', url: 'https://www.sec.gov/Archives/edgar/data/1/example.htm' }]);
      assert.equal(policy.hasEvidence(), false, name);
    }
    const policy = createChatGrounding([{ role: 'user', content: 'Analyze the latest data.' }]);
    policy.observe(name, { status: 'ready', rows: [{ sourceIds: ['S1'] }] }, [{ id: 'S1', url: 'https://www.sec.gov/Archives/edgar/data/1/example.htm' }]);
    assert.equal(policy.hasEvidence(), true, name);
  }
});

test('explicit validated portfolio unlocks only labeled user-provided analysis with no public-source citation', async t => {
  t.mock.method(console, 'info', () => {});
  const answer = 'In your shared portfolio, AAA is 60% and BBB is 40%. These are user-provided weights.';
  const result = await run({ context: { path: '/workspace', query: 'view=portfolios' }, sharedContext: portfolio,
    steps: [step([call('shared_context', { kind: 'portfolio' })], 'tool-calls'), step(text(answer))] });
  assert.equal(result.response.status, 200); assert.equal(result.text, answer); assert.equal(result.outputs[0].output.evidenceType, 'user-provided');
  assert.equal(result.outputs[0].output.concentration.fullPortfolioHHI, 0.52); assert.equal(result.research.getSources().length, 0);
  assert.deepEqual(result.outputs[0].output.sourceIds, []); assert.equal(result.reads.length, 0);
  const instructions = JSON.stringify(result.model.doStreamCalls[0].prompt);
  assert.match(instructions, /user-provided, not SEC-verified/); assert.doesNotMatch(result.text, /\[S\d+\]/);
});

test('unshared or model-forged portfolio holdings cannot unlock private research', async t => {
  t.mock.method(console, 'info', () => {});
  const absent = await run({ context: { path: '/workspace', query: '' }, steps: [step([call('shared_context', { kind: 'portfolio' })], 'tool-calls')] });
  assert.equal(absent.outputs[0].output.code, 'SHARED_CONTEXT_REQUIRED'); assert.equal(absent.model.doStreamCalls.length, 1);
  assert.match(absent.text, /could not retrieve verified source data/);
  const registry = createChatResearch({ sharedContext: portfolio });
  const forged = await registry.tools.shared_context.execute({ kind: 'portfolio', holdings: [{ ticker: 'CCC', weight: 1 }] });
  assert.equal(forged.code, 'TOOL_INVALID_INPUT'); assert.equal(registry.getSources().length, 0);
  const policy = createChatGrounding([{ role: 'user', content: 'Analyze my portfolio.' }]);
  policy.observe('shared_context', { status: 'ready', evidenceType: 'user-provided', holdings: [{ ticker: 'CCC', weight: 1 }] }, []);
  assert.equal(policy.hasEvidence(), false);
});

test('the installed SDK cannot replace an attached portfolio with holdings invented in tool arguments', async t => {
  t.mock.method(console, 'info', () => {});
  const result = await run({ context: { path: '/workspace', query: '' }, sharedContext: portfolio,
    steps: [step([call('shared_context', { kind: 'portfolio', holdings: [{ ticker: 'CCC', weight: 1 }] })], 'tool-calls'),
      step(text('FORGED PORTFOLIO: CCC is your entire account.'))] });
  assert.ok(result.outputs.every(({ output }) => output.status !== 'ready'));
  assert.equal(result.research.getSources().length, 0); assert.match(result.text, /could not retrieve verified source data/);
  assert.doesNotMatch(result.text, /FORGED PORTFOLIO|entire account/); assert.equal(result.state.releases, 1);
});

test('malformed attachments and wrong-page private context fail before model usage or a reservation', async () => {
  for (const [sharedContext, context] of [[{ ...portfolio, coverageWeight: 0.9 }, { path: '/workspace', query: '' }],
    [{ ...portfolio, accountNumber: 'PRIVATE_ACCOUNT' }, { path: '/workspace', query: '' }],
    [portfolio, { path: '/market', query: '' }]]) {
    const result = await run({ sharedContext, context, steps: [] });
    assert.equal(result.response.status, 400); assert.match(result.body, /CHAT_INVALID_SHARED_CONTEXT/);
    assert.equal(result.state.reservations, 0); assert.equal(result.model.doStreamCalls.length, 0);
  }
  assert.equal(normalizeSharedChatContext({ ...portfolio, holdings: [{ ticker: 'AAA', weight: 1.2 }] }), null);
});

test('normalized current Compare, Fund, Market and Filings selectors reach the actual cross-page readers', async () => {
  const fixture = fixtures();
  const compare = createChatResearch({ context: normalizeChatContext({ path: '/compare/AAA,BBB', query: 'basis=annual&period=2024&asOf=2025-06-01&alignment=common' }), dependencies: fixture.dependencies });
  const compared = await compare.tools.company_comparison.execute(comparisonInput);
  assert.equal(compared.selectedBucket, '2024'); assert.equal(compared.filingCutoff, '2025-06-01');
  assert.ok(compared.metrics[0].points.every(p => p.period.end === '2024-12-31'));
  const fund = createChatResearch({ context: normalizeChatContext({ path: '/fund', query: `view=13f&managerCik=${MANAGER}&managerPeriod=2026-03-31` }), dependencies: fixture.dependencies });
  assert.equal((await fund.tools.fund_holdings.execute(holdingsInput)).period, '2026-03-31');
  const market = createChatResearch({ context: normalizeChatContext({ path: '/market', query: 'tab=sectors&cohort=sector-technology&basis=annual&companyMetric=currentRatio&companyDirection=asc&companyPage=2' }), dependencies: fixture.dependencies });
  const ranked = await market.tools.sector_companies.execute(Object.fromEntries(Object.keys(sectorInput).map(key => [key, ''])));
  assert.equal(ranked.selection.basis, 'annual'); assert.equal(ranked.selection.sort, 'currentRatio'); assert.equal(ranked.page, 2);
  assert.equal(ranked.companies[0].report.end, '2025-12-31');
  const filings = createChatResearch({ context: normalizeChatContext({ path: '/filings/AAA', query: `accession=${oldFiling.accession}&section=mda&filed=${oldFiling.filingDate}` }), dependencies: fixture.dependencies });
  const selected = await filings.tools.filing_document.execute(documentInput);
  assert.equal(selected.filing.accession, oldFiling.accession); assert.equal(selected.filing.reportDate, '2024-12-31');
  const documentRead = fixture.reads.findLast(([name]) => name === 'document')[1];
  assert.equal(documentRead.accession, oldFiling.accession); assert.equal(documentRead.section, 'mda');
});

test('expanded registry keeps two-company, four-tool and result byte caps shared across tools', async () => {
  const fixture = fixtures(), research = createChatResearch({ dependencies: fixture.dependencies });
  assert.deepEqual(Object.keys(research.tools).sort(), EXPECTED_TOOLS);
  const results = [await research.tools.company_comparison.execute({ ...comparisonInput, metric: '' })];
  const third = await research.tools.filings_list.execute({ ...listInput, identifier: 'CCC' }); results.push(third);
  assert.equal(third.status, 'unavailable'); assert.match(third.reason, /at most two companies/);
  assert.equal(fixture.reads.filter(([name]) => name === 'filings').length, 0);
  results.push(await research.tools.sector_companies.execute(sectorInput));
  results.push(await research.tools.fund_holdings.execute(holdingsInput));
  const fifth = await research.tools.filings_list.execute(listInput);
  assert.equal(fifth.code, 'TOOL_CALL_LIMIT');
  assert.ok(results.every(result => Buffer.byteLength(JSON.stringify(result)) <= 12000));
  assert.ok(results.reduce((sum, result) => sum + Buffer.byteLength(JSON.stringify(result)), 0) <= 30000);
  const schema = Object.fromEntries(Object.entries(research.tools).map(([name, spec]) => [name, { description: spec.description, inputSchema: spec.inputSchema }]));
  assert.ok(Buffer.byteLength(JSON.stringify(schema)) < 20000);
  assert.ok(Buffer.byteLength(JSON.stringify({ instructions: chatInstructions({}), messages: [{ role: 'user', content: 'Compare these companies.' }], tools: schema })) < CHAT_MAX_PROMPT_BYTES);
});

test('the installed SDK still enforces four executions if a provider emits five cross-page tool calls together', async t => {
  t.mock.method(console, 'info', () => {});
  const result = await run({ steps: [step([call('company_comparison', comparisonInput), call('sector_companies', sectorInput),
    call('fund_holdings', holdingsInput), call('filings_list', listInput, 'allowed-filing'),
    call('filings_list', { ...listInput, identifier: 'CCC' }, 'over-budget')], 'tool-calls'), step(text('Requested source evidence is available [S1].'))] });
  assert.equal(result.outputs.length, 5); assert.equal(result.outputs.filter(({ output }) => output.code === 'TOOL_CALL_LIMIT').length, 1);
  assert.equal(result.reads.some(([name, id]) => name === 'filings' && id === 'CCC'), false);
  assert.equal(result.model.doStreamCalls.length, 2); assert.equal(result.frames.at(-1).type, 'done');
  assert.ok(Buffer.byteLength(JSON.stringify({ prompt: result.model.doStreamCalls[1].prompt, tools: result.model.doStreamCalls[1].tools })) < CHAT_MAX_PROMPT_BYTES);
});

test('64 KiB next-step prompt cap still stops retained model reasoning with all seventeen tools present', async t => {
  t.mock.method(console, 'info', () => {});
  const result = await run({ mode: 'reasoning', steps: [step([
    { type: 'reasoning-start', id: 'private' }, { type: 'reasoning-delta', id: 'private', delta: 'x'.repeat(CHAT_MAX_PROMPT_BYTES) }, { type: 'reasoning-end', id: 'private' },
    call('sector_companies', sectorInput),
  ], 'tool-calls')] });
  assert.equal(result.outputs[0].output.status, 'ready'); assert.equal(result.model.doStreamCalls.length, 1);
  assert.deepEqual(result.model.doStreamCalls[0].tools.map(spec => spec.name).sort(), EXPECTED_TOOLS); assert.equal(result.frames.at(-1).code, 'CHAT_CONTEXT_LIMIT');
  assert.equal(result.text, ''); assert.equal(result.state.releases, 1);
  assert.ok(!result.frames.some(frame => frame.type === 'reasoning' || frame.text?.includes('xxxxxxxx')));
});
