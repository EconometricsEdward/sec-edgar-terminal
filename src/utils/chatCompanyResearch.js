import { comparisonSelection, defaultMetrics, historicGrowth, inferLens, metricComparison, METRIC_BY_KEY } from './compareResearch.js';
import { unpackAnalysisCompany } from './analysisResearch.js';
import { evidenceSources } from './researchEvidence.js';
import { RISK_VERSION } from './riskWorkspace.js';
import { buildRiskProfilePresentation } from '../app/risk/riskProfilePresentation.js';

const ORIGIN = 'https://secedgarterminal.com';
const cikOf = value => /^\d{1,10}$/.test(String(value || '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const currentDay = () => new Date().toISOString().slice(0, 10);
const period = value => value ? { end: value.end, start: value.start || null, basis: value.kind || null } : null;
const blank = (description, maxLength = 80) => ({ type: 'string', maxLength, description });

/** Reuse the Risk page's cache and exact financial pipeline, without its
 * optional long filing-language scan or an additional chatbot cache. A cold
 * lookup is cancelled by the turn's shared research deadline. */
export async function loadChatCompanyRisk({ ticker, cik }, signal, dependencies = {}) {
  signal?.throwIfAborted();
  const read = dependencies.read || (await import('./warmCache.js')).warmGet;
  let cached;
  try { cached = await read(RISK_VERSION, ticker); } catch { /* Optional cache outage leaves the source reader available. */ }
  signal?.throwIfAborted();
  if (cached && cached.version === RISK_VERSION && cached.ticker === ticker && cikOf(cached.cik) === cikOf(cik)) return cached;
  const source = dependencies.source || (await import('./secResearchData.js')).secResearchJson;
  const [submissions, company] = await Promise.all([
    source(`/submissions/CIK${cik}.json`, signal), source(`/api/xbrl/companyfacts/CIK${cik}.json`, signal),
  ]);
  signal?.throwIfAborted();
  if (cikOf(submissions?.cik) !== cikOf(cik) || cikOf(company?.cik) !== cikOf(cik) || !submissions?.sic || !company?.facts)
    throw new Error('The SEC risk identity, industry classification or company facts could not be verified.');
  const prepare = dependencies.prepare || (await import('./riskProfileSources.js')).prepareRiskProfileSources;
  const loadFiling = dependencies.loadFiling || (await import('./analysisResearchSources.js')).loadAnalysisFiling;
  const prepared = await prepare({ cik, company, submissions, signal }, {
    loadCompanyFacts: (sourceCik, sourceSignal) => source(`/api/xbrl/companyfacts/CIK${sourceCik}.json`, sourceSignal), loadFiling,
  });
  signal?.throwIfAborted();
  const [{ assessRisk }, { decorateRiskProfile }] = await Promise.all([import('./riskAnalysis.js'), import('./riskWorkspace.js')]);
  const annual = decorateRiskProfile(assessRisk(prepared.facts, submissions.sic, cik));
  signal?.throwIfAborted();
  const current = decorateRiskProfile(assessRisk(prepared.facts, submissions.sic, cik, { basis: 'ttm' }));
  signal?.throwIfAborted();
  return { ticker, cik, companyName: submissions.name, sic: submissions.sic, sicDescription: submissions.sicDescription,
    annual, current, sourceCoverage: prepared.sourceCoverage, version: RISK_VERSION, generatedAt: new Date().toISOString() };
}

/** All reads, entity counts, sources and output sizes remain owned by the
 * request-scoped chat research layer. No arbitrary URL or SQL access. */
export function createCompanyChatTools(api) {
  const { tool, stringSchema, enumeration, read, resolve, rememberCompany, addSource, fail, unavailable, txt, finite,
    dependencies = {}, context = {}, publicJson, preview } = api;
  const compareRead = dependencies.companyComparison || (async (settings, signal) => preview
    ? publicJson('/api/compare-research', { ticker: settings.ticker, basis: settings.basis, asOf: settings.asOf, format: 'packed' }, signal)
    : (await import('./compareResearchServer.js')).loadCompareResearch(settings, signal));
  const riskRead = dependencies.companyRisk || (async (settings, signal) => preview
    ? (await publicJson('/api/risk', { ticker: settings.ticker, v: RISK_VERSION }, signal)).payload
    : loadChatCompanyRisk(settings, signal));
  function citations(inputs, name) {
    return [...new Set(inputs.map(source => addSource(`${name} · ${txt(source.form, 15) || 'SEC filing'}${day(source.filed) ? ` · filed ${source.filed}` : ''}`,
      source.documentUrl || source.url, source.end)).filter(Boolean))];
  }
  function verifiedPoint(point, name) {
    const sources = evidenceSources(point), ids = citations(sources, name);
    return { value: ids.length ? finite(point?.value) : null, sourceIds: ids,
      ...(sources.length ? { filedThrough: sources.map(s => s.filed).filter(day).sort().at(-1) || null } : {}) };
  }
  function validCutoff(asOf) {
    if (asOf && (!day(asOf) || asOf > currentDay())) throw fail('Use a valid filing cutoff date no later than today.');
  }
  const matches = (value, identity) => typeof value === 'string' && [identity.id, identity.ticker, identity.cik]
    .filter(Boolean).some(id => id.toUpperCase() === value.toUpperCase() || cikOf(value) && cikOf(value) === cikOf(id));
  return {
    company_comparison: tool('Compare two verified companies using the Compare page calculations. Date/source compatibility, metric definitions and year-over-year changes are calculated in code. Annual/quarter/TTM and filing cutoff supported. Use exact page selections. Values are whole USD, percentages in percentage units (12.5 = 12.5%), or multiples. No market-wide percentile is inferred.', {
      first: stringSchema('First company name, ticker or CIK.'), second: stringSchema('Second company name, ticker or CIK.'),
      basis: enumeration(['annual', 'quarter', 'ttm']), asOf: blank('Filing cutoff YYYY-MM-DD; empty inherits a matching Compare page cutoff, otherwise latest available filings.', 10),
      metric: blank('One Compare metric key such as operatingCashFlow, freeCashFlow, currentRatio, equityAssets, revenue or bankRevenue; empty for industry defaults.', 40),
      alignment: enumeration(['common', 'latest']), period: blank('Selected Compare calendar bucket YYYY for annual, YYYY-Q1..Q4 otherwise; empty for latest.', 7),
    }, 'Comparing company evidence', async ({ first, second, basis, asOf, metric, alignment, period: selectedPeriod }) => {
      validCutoff(asOf);
      if (metric && !Object.hasOwn(METRIC_BY_KEY, metric)) return unavailable('Use a supported Compare metric key.', 'TOOL_INVALID_INPUT', { choices: Object.keys(METRIC_BY_KEY) });
      if (selectedPeriod && !(basis === 'annual' ? /^(19|20)\d{2}$/ : /^(19|20)\d{2}-Q[1-4]$/).test(selectedPeriod))
        throw fail('The selected comparison bucket must match its annual or quarterly basis.');
      const resolved = await Promise.all([resolve(first, 'company'), resolve(second, 'company')]);
      for (let i = 0; i < resolved.length; i++) if (!resolved[i].identity) return { ...resolved[i], requestedCompany: i ? second : first };
      const identities = resolved.map(item => rememberCompany(item.identity));
      if (identities[0].cik === identities[1].cik) return unavailable('These identifiers resolve to the same SEC issuer. Choose two distinct companies.', 'TOOL_INVALID_INPUT');
      const samePage = context.compareTickers?.length === 2 && identities.every(identity => context.compareTickers.some(value => matches(value, identity)));
      if (samePage) {
        if (!asOf && context.asOf) asOf = context.asOf;
        if (!selectedPeriod && context.period && context.period !== 'latest') selectedPeriod = context.period;
      }
      validCutoff(asOf);
      if (selectedPeriod && !(basis === 'annual' ? /^(19|20)\d{2}$/ : /^(19|20)\d{2}-Q[1-4]$/).test(selectedPeriod))
        throw fail('The selected comparison bucket must match its annual or quarterly basis.');
      if (identities.some(identity => !identity.ticker && /^\d+$/.test(identity.id)))
        return unavailable('The Compare reader requires a verified operating-company ticker. Use company financials for this CIK.');
      const companies = await Promise.all(identities.map(async identity => {
        const ticker = identity.ticker || identity.id;
        const result = await read(`company:comparison:${identity.cik}:${basis}:${asOf}`, s => compareRead({ ticker, basis, asOf }, s));
        const payload = result?.payload || result;
        if (cikOf(payload?.cik) !== identity.cik || payload?.ticker !== ticker || payload?.basis !== basis || (payload.asOf || '') !== asOf
          || !Array.isArray(payload?.periods) || !payload.metrics || typeof payload.metrics !== 'object')
          throw fail('The comparison source did not match the selected company, reporting basis and filing cutoff.', 'SOURCE_IDENTITY_MISMATCH');
        const data = unpackAnalysisCompany(payload);
        // The Compare UI can inspect legacy observations. Chat cannot treat a
        // numerical value without original evidence as a verified benchmark.
        data.metrics = Object.fromEntries(Object.entries(data.metrics).map(([key, points]) => [key, points.map(point => {
          const sources = evidenceSources(point), afterCutoff = asOf && sources.some(source => !day(source.filed) || source.filed > asOf);
          return (!sources.length || afterCutoff) && finite(point?.value) !== null
            ? { ...point, value: null, sources: [], source: undefined, classification: 'unavailable',
              reason: afterCutoff ? 'Original source inputs were not verified as filed by the selected cutoff.' : 'Original source evidence is unavailable.' } : point;
        })]));
        return { ticker, data, identity };
      }));
      const selection = comparisonSelection(companies, { basis, alignment, period: selectedPeriod || 'latest' });
      if (selection.entries.some(entry => !entry.period)) return unavailable(selectedPeriod
        ? 'Both issuers do not have the requested calendar bucket. No newer period was substituted.'
        : 'No common reporting bucket is available for both issuers. Choose latest alignment to inspect their different dates.', 'SOURCE_BASIS_UNAVAILABLE',
      { requestedBucket: selectedPeriod || null, filingCutoff: asOf || null, choices: selection.shared.slice(0, 6) });
      const keys = metric ? [metric] : [...new Set([...defaultMetrics(inferLens(companies)), 'operatingCashFlow'])].slice(0, 11);
      const sourceId = addSource('EDGAR Terminal · Company comparison', `${ORIGIN}/compare/${companies.map(c => encodeURIComponent(c.ticker)).join(',')}?${new URLSearchParams({ basis, alignment, ...(asOf ? { asOf } : {}), ...(selectedPeriod ? { period: selectedPeriod } : {}) })}`);
      const metrics = keys.map(key => {
        const compared = metricComparison(selection.entries, key);
        const points = compared.cells.map((cell, index) => {
          const verified = verifiedPoint(cell.point, companies[index].identity.name), growth = historicGrowth(companies[index].data, key, selection.entries[index].index);
          const prior = verifiedPoint(growth.prior, companies[index].identity.name);
          return { ticker: cell.ticker, period: period(cell.period), ...verified,
            status: verified.value === null ? 'unavailable' : cell.point.classification || 'reported',
            comparable: cell.quality.valid && verified.value !== null,
            reason: txt(cell.quality.reason, 240) || (verified.value === null ? 'Compatible source-linked inputs are unavailable.' : null),
            yearOverYear: { value: prior.value !== null && verified.value !== null ? finite(growth.yoy.value) : null,
              unit: growth.yoy.unit || (compared.metric.format === 'percent' ? 'pp' : compared.metric.format === 'decimal' ? 'x' : '%'),
              priorPeriod: period(growth.prior?.period), priorValue: prior.value, sourceIds: prior.sourceIds,
              reason: txt(growth.yoy.reason, 240) || (prior.value === null ? 'Comparable prior-year evidence is unavailable.' : null) },
          };
        });
        const comparable = !compared.reason && points.every(point => point.comparable);
        return { key, label: compared.metric.label, unit: compared.metric.format === 'currency' ? 'USD' : compared.metric.format === 'percent' ? '%' : 'x',
          formula: compared.metric.formula || 'Reported SEC amount', points, comparable,
          firstMinusSecond: comparable ? finite(points[0].value - points[1].value) : null,
          differenceUnit: compared.metric.format === 'percent' ? 'pp' : compared.metric.format === 'currency' ? 'USD' : 'x',
          comparisonReason: compared.reason || (!comparable ? 'Compatible source-linked inputs are unavailable.' : null), definitionNote: compared.definitionNote };
      });
      return { status: 'ready', basis, filingCutoff: asOf || null, alignment, selectedBucket: selection.bucket || null,
        reportingEndSpanDays: selection.span, companies: companies.map(c => ({ ticker: c.ticker, cik: c.identity.cik, name: c.identity.name,
          lens: c.data.lens, observedAt: c.data.observedAt || null, notices: (c.data.sourceCoverage?.notices || []).slice(0, 3).map(note => txt(note, 250)) })),
        metrics, sourceIds: [sourceId].filter(Boolean),
        notes: ['Calendar buckets do not guarantee matching fiscal periods. Actual period dates, source definitions and comparability are shown for each metric.',
          'firstMinusSecond is calculated only for compatible values; a larger number does not by itself mean stronger credit quality.',
          'Comparison percentages use percentage units (12.5 = 12.5%). Year-over-year percentage growth is unavailable for zero or negative currency bases. Missing values are never zero.'] };
    }),
    company_risk: tool('Read one company’s Risk page financial profile, including its industry-specific risk dimensions, supported strengths and watch items, dated ratios and source citations. Uses annual or TTM evidence; historical filing cutoffs are not supported by this reader. These are public-filing analytical screens, not supervisory ratings or probabilities of default.', {
      identifier: stringSchema('Company name, ticker or CIK.'), basis: enumeration(['annual', 'ttm']),
      asOf: blank('Empty for the current Risk profile. Preserve a requested historical cutoff so unsupported history is disclosed rather than silently replaced.', 10),
    }, 'Reading the company risk profile', async ({ identifier, basis, asOf }) => {
      validCutoff(asOf);
      if (asOf) return unavailable('The Risk profile reader does not support historical filing cutoffs. Use company_comparison for dated financial evidence or explicitly request the current Risk profile.', 'SOURCE_BASIS_UNAVAILABLE', { requestedCutoff: asOf });
      const resolved = await resolve(identifier, 'company'); if (!resolved.identity) return resolved;
      const identity = rememberCompany(resolved.identity), ticker = identity.ticker || identity.id;
      if (!asOf && context.asOf && matches(context.company, identity)) return unavailable('The current page has a historical filing cutoff, which the Risk profile reader cannot reproduce. Use company_comparison for dated financial evidence.',
        'SOURCE_BASIS_UNAVAILABLE', { requestedCutoff: context.asOf });
      if (/^\d+$/.test(ticker)) return unavailable('The Risk page requires a verified operating-company ticker. Use company financials for this CIK.');
      const data = await read(`company:risk:${identity.cik}`, s => riskRead({ ticker, cik: identity.cik }, s));
      if (cikOf(data?.cik) !== identity.cik || data?.ticker !== ticker || data?.version !== RISK_VERSION)
        throw fail('The Risk source did not match this SEC company and supported profile version.', 'SOURCE_IDENTITY_MISMATCH');
      const profile = basis === 'ttm' ? data.current : data.annual;
      if (profile?.basis !== basis || !Array.isArray(profile?.periods) || !Array.isArray(profile?.metrics))
        throw fail('The Risk source did not match the requested reporting basis.', 'SOURCE_BASIS_UNAVAILABLE');
      const view = buildRiskProfilePresentation(profile, data), latest = profile.periods[0];
      const page = addSource(`${identity.name} · Risk profile`, `${ORIGIN}/risk/${encodeURIComponent(ticker)}?basis=${basis}`, latest?.end);
      const compact = metric => {
        const current = verifiedPoint(metric, identity.name);
        return { key: metric.id, label: txt(metric.label, 120), periodEnd: metric.end || latest?.end || null, ...current,
          unit: ['pct', 'pp'].includes(metric.format) ? 'fraction' : metric.format === 'usd' ? 'USD' : metric.format === 'count' ? 'count' : 'x',
          classification: current.value === null ? 'unavailable' : metric.classification || 'calculated',
          formula: txt(metric.formula, 350), interpretation: txt(metric.why, 450), note: txt(metric.note, 300) || null,
          history: (metric.series || []).slice(-3).map(point => ({ end: point.end || point.period?.end || null,
            start: point.start || point.period?.start || null, ...verifiedPoint(point, identity.name) })) };
      };
      const allowed = [...new Map(view.dimensions.flatMap(d => d.metrics).map(metric => [metric.id, metric])).values()];
      const observations = items => items.slice(0, 3).flatMap(item => {
        const value = verifiedPoint(item, identity.name);
        return value.value === null ? [] : [{ key: item.id, label: txt(item.label, 120), text: txt(item.text || item.reason, 500),
          unit: ['pct', 'pp'].includes(item.format) ? 'fraction' : item.format === 'usd' ? 'USD' : item.format === 'count' ? 'count' : 'x', ...value }];
      });
      return { status: latest ? 'ready' : 'unavailable', entity: identity, basis, period: period(latest), generatedAt: data.generatedAt,
        lens: view.lens, coverage: view.coverage, dimensions: view.dimensions.map(d => ({ label: d.label, question: d.question, metricKeys: d.metrics.map(m => m.id) })),
        metrics: allowed.slice(0, 18).map(compact), strengths: observations(view.strengths), watchItems: observations(view.watchItems),
        notes: [...view.limitations, ...(data.sourceCoverage?.notices || []), ...(profile.notes || [])].slice(0, 8).map(note => txt(note, 500)),
        units: 'USD amounts are whole dollars. Fraction means 0.125 = 12.5%; a difference of 0.01 is one percentage point. Dates belong to each observation. Missing inputs are not zero.',
        interpretation: 'These are the Risk page’s public-filing financial dimensions. They do not establish a credit rating, regulatory capital adequacy or probability of default. Read strengths with watch items and missing coverage.',
        sourceIds: [page].filter(Boolean), warning: resolved.warning };
    }),
  };
}
