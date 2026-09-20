import { unpackAnalysisCompany } from './analysisResearch.js';
import { buildAnalysisScenario } from './analysisScenarios.js';
import { evidenceSources } from './researchEvidence.js';
import { normalizeSharedChatContext } from './chatSharedContext.js';

const ORIGIN = 'https://secedgarterminal.com';
const cikOf = value => /^\d{1,10}$/.test(String(value)) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const round = value => Math.round(value * 1e10) / 1e10;
const originalFilingUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.sec.gov', 'sec.gov'].includes(url.hostname)
      && !url.username && !url.password && !url.port && /^\/Archives\/edgar\/data\/\d+\//.test(url.pathname);
  } catch { return false; }
};
const METHODS = {
  operating: 'The selected margin or cost model changes revenue and operating income under the shared assumptions. In independent mode this does not establish net income, cash flow, or balance-sheet effects.',
  balance: 'An independent noncash asset loss reduces assets and equity equally with no tax benefit. Bank withdrawals reduce cash and deposits; explicit replacement borrowing adds cash and debt. Funding access and regulatory capital are not established. Operating effects are separate.',
  connected: 'Same-period hypothetical sensitivity, not a forecast. Only incremental cash effects adjust reported ending cash; full reported operating cash flow is never added again. Positive incremental pretax earnings are taxed, with no tax relief for a decline. Extra working capital, capital spending, borrowing and repayment use the explicit assumptions. New borrowing is outstanding for the selected duration. Negative cash is an unfunded shortfall; no additional funding is assumed. Other cash flows and noncontrolling interests are unchanged. Independent asset loss is excluded.',
};

/** Only the explicit, validated attachment can enter this tool. It does not read
 * browser storage, accept model-created holdings, or persist private snapshots. */
export function createSharedChatTools(api) {
  const { tool, enumeration, read, resolve, rememberCompany, addSource, fail, unavailable,
    txt, finite, dependencies = {}, preview = false, publicJson } = api;
  const shared = normalizeSharedChatContext(api.sharedContext);
  const loadAnalysis = dependencies.sharedAnalysis || (async (selection, signal) => {
    const { loadChatAnalysis } = await import('./chatAnalysisSelection.js');
    return loadChatAnalysis(selection, signal, { preview, publicJson });
  });

  function portfolio() {
    const weighted = shared.holdings.every(row => finite(row.weight) !== null);
    const rows = shared.holdings.map(row => ({ ticker: row.ticker, weight: finite(row.weight) }));
    if (weighted) rows.sort((a, b) => b.weight - a.weight || a.ticker.localeCompare(b.ticker));
    const sum = weighted ? rows.reduce((total, row) => total + row.weight, 0) : null;
    // Defensive consistency check: coverage comes from the shared rows, never
    // from a client-supplied result or an assumption that missing weights are zero.
    if (weighted && (sum > 1 + 1e-6 || finite(shared.coverageWeight) === null || Math.abs(sum - shared.coverageWeight) > 1e-6)) {
      return unavailable('The shared weights do not match their stated coverage. Share the portfolio again.', 'SHARED_CONTEXT_INVALID');
    }
    const complete = shared.totalHoldings === rows.length;
    const fullWeights = weighted && complete && Math.abs(sum - 1) <= 1e-6;
    const squares = weighted ? rows.reduce((total, row) => total + row.weight ** 2, 0) : null;
    return {
      status: 'ready', kind: 'portfolio', evidenceType: 'user-provided',
      totalHoldings: shared.totalHoldings, sharedHoldings: rows.length, complete,
      coverageWeight: sum === null ? null : round(sum), holdings: rows,
      concentration: weighted ? {
        largestSharedWeight: rows[0]?.weight ?? null,
        topFiveSharedWeight: round(rows.slice(0, 5).reduce((total, row) => total + row.weight, 0)),
        fullPortfolioHHI: fullWeights ? round(squares) : null,
        effectiveHoldings: fullWeights && squares > 0 ? round(1 / squares) : null,
      } : null,
      units: 'Weights are fractions of the user-provided portfolio (0.125 = 12.5%). Rankings and top-five concentration cover only the shared holdings. Full-portfolio HHI is sum(weight²); effective holdings is 1 / HHI and requires all holdings with weights totaling one.',
      limitations: [
        'These holdings and weights were explicitly shared by the user. They are not SEC-verified positions, current market prices, returns, or evidence of the user’s account balances.',
        ...(!complete ? ['Only part of the portfolio is shared. Do not generalize these results to omitted holdings.'] : []),
        ...(!weighted ? ['A complete set of weights was not shared. Concentration, allocation and weighted exposures cannot be calculated for the whole shared set.'] : []),
        ...(weighted && !fullWeights ? ['Full-portfolio concentration is unavailable because the shared weights do not establish the complete portfolio.'] : []),
      ], sourceIds: [],
    };
  }

  async function scenario() {
    const resolved = await resolve(shared.ticker, 'company');
    if (!resolved.identity) return resolved;
    const identity = rememberCompany(resolved.identity);
    const selection = { ticker: shared.ticker, basis: shared.basis, asOf: shared.asOf || '' };
    const loaded = await read(`shared-scenario:${selection.ticker}:${selection.basis}:${selection.asOf}`,
      signal => loadAnalysis(selection, signal));
    const payload = loaded?.payload || loaded;
    if (!payload || cikOf(payload.cik) !== identity.cik || payload.ticker !== selection.ticker
      || payload.basis !== selection.basis || (payload.asOf || '') !== selection.asOf) {
      throw fail('The scenario baseline did not match the shared company, reporting basis and filing cutoff.', 'SOURCE_IDENTITY_MISMATCH');
    }
    const index = Array.isArray(payload.periods) ? payload.periods.findIndex(period => period.end === shared.end && period.kind === shared.basis) : -1;
    if (index < 0) return unavailable('The exact shared reporting period is unavailable. No newer or different period was substituted.', 'SOURCE_BASIS_UNAVAILABLE',
      { requestedEnd: shared.end, requestedBasis: shared.basis });
    const data = unpackAnalysisCompany(payload);
    const calculated = buildAnalysisScenario(data, shared.assumptions, index);
    const params = new URLSearchParams({ view: 'scenarios', basis: shared.basis, end: shared.end });
    if (shared.asOf) params.set('asOf', shared.asOf);
    const pageSource = addSource(`${identity.name} · Analysis scenario baseline`, `${ORIGIN}/analysis/${encodeURIComponent(shared.ticker)}?${params}`, shared.end);
    const sourceMetadata = {};
    let citationGap = false;
    const register = point => {
      const inputs = evidenceSources(point);
      if (!inputs.length || inputs.some(source => !originalFilingUrl(source.documentUrl))) {
        citationGap = true;
        return { ids: [], reason: 'Original filing evidence is unavailable for these inputs.' };
      }
      if (shared.asOf && inputs.some(source => !day(source.filed) || source.filed > shared.asOf)) {
        citationGap = true;
        return { ids: [], reason: 'An input cannot be verified within the selected filing cutoff.' };
      }
      const ids = inputs.map(source => {
      const id = addSource(`${identity.name} · ${txt(source.form, 20) || 'SEC filing'}${source.filed ? ` · filed ${txt(source.filed, 10)}` : ''}`,
        source.documentUrl, source.end);
      if (id) sourceMetadata[id] ||= { form: txt(source.form, 20) || null, filed: day(source.filed) ? source.filed : null };
        return id;
      });
      if (ids.some(id => !id)) citationGap = true;
      return { ids: [...new Set(ids.filter(Boolean))], reason: ids.some(id => !id) ? 'An input has no permitted original filing citation.' : null };
    };
    const row = item => {
      const point = item.selection?.point;
      const evidence = register(point), sourceIds = evidence.ids;
      const value = !evidence.reason && !point?.reason && point?.classification === 'calculated' && sourceIds.length ? finite(point.value) : null;
      return { key: txt(item.key, 80), label: txt(item.label, 100), unit: item.format === 'percent' ? 'percentage points' : 'USD',
        baseline: !evidence.reason && sourceIds.length ? finite(item.baseline) : null, hypothetical: value,
        change: value !== null && finite(item.baseline) !== null ? finite(value - item.baseline) : null,
        status: value === null ? 'unavailable' : 'hypothetical', formula: txt(point?.formula, 450),
        ...(value === null ? { reason: evidence.reason || txt(point?.reason, 400) || 'Compatible verified inputs unavailable; not assumed zero.' } : {}), sourceIds };
    };
    const section = (name, value) => {
      const rows = (value?.rows || []).map(row), available = rows.some(item => item.hypothetical !== null);
      return { model: name, available, reason: txt(value?.reason, 400) || (!available ? 'Compatible inputs with original filing citations are unavailable.' : null),
        method: METHODS[name], rows, ...(name === 'operating' ? { drivers: (value?.bridge || []).map(row) } : {}) };
    };
    const sections = [
      ...(calculated.operating ? [section('operating', calculated.operating)] : []),
      section(calculated.connected.enabled ? 'connected' : 'balance', calculated.connected.enabled ? calculated.connected : calculated.balance),
    ];
    // Sources and diagnostics stay attached to the precise result they qualify.
    const diagnostics = citationGap
      ? [{ status: 'warning', message: 'Some inputs lack valid original filing citations or fall outside the selected cutoff. Affected results are unavailable; inspect each row’s reason.' }]
      : (calculated.diagnostics || []).map(item => ({ status: txt(item.status, 20), message: txt(item.message, 500) }));
    const hasValues = sections.some(group => group.rows.some(item => item.hypothetical !== null));
    return {
      status: hasValues ? 'ready' : 'unavailable', kind: 'analysis-scenario', evidenceType: 'verified-baseline-with-user-assumptions',
      entity: { ticker: shared.ticker, cik: identity.cik, name: identity.name }, basis: shared.basis,
      period: { start: data.periods[index].start || null, end: shared.end }, filingCutoff: shared.asOf || null,
      assumptions: calculated.settings, assumptionOrigin: 'Explicitly shared user assumptions; recomputed by the site’s existing scenario calculator.',
      lens: txt(data.lens, 40), sections, diagnostics, sourceMetadata, sourceIds: [pageSource].filter(Boolean),
      units: 'Amounts are whole USD. Result percentages are percentage points (12.5 means 12.5%). Assumption values retain the units of the Analysis scenario controls.',
      limitations: 'Hypothetical static sensitivity, not reported results, a forecast, default probability or regulatory capital assessment. A fiscal period end is not a filing date. Latest filed values within the stated filing cutoff can revise earlier periods. Missing inputs remain unavailable.',
      ...(hasValues ? {} : { reason: 'No compatible scenario result is available for the shared assumptions and exact baseline.' }),
    };
  }

  return {
    shared_context: tool('Analyze only the portfolio or applied Analysis scenario the user explicitly attached to this conversation. Portfolio statistics use user-provided weights, not verified SEC positions. Scenarios are recomputed from verified data for the exact selected period; never invent or alter assumptions.',
      { kind: enumeration(['portfolio', 'analysis-scenario']) }, 'Reviewing the shared research view', async ({ kind }) => {
        if (!shared) return unavailable('No portfolio or scenario has been explicitly shared. Ask the user to use “Share this view” in chat before analyzing private holdings or applied assumptions.', 'SHARED_CONTEXT_REQUIRED');
        if (kind !== shared.kind) return unavailable('The requested type does not match the view explicitly shared by the user.', 'SHARED_CONTEXT_MISMATCH');
        return kind === 'portfolio' ? portfolio() : scenario();
      }),
  };
}
