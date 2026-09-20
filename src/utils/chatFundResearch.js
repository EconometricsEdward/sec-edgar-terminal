import { compare13FPortfolios } from './thirteenF.js';
import { buildFundChanges } from './fundChanges.js';
import { select13FHoldings } from './thirteenFDelivery.js';

const ORIGIN = 'https://secedgarterminal.com';
const QUARTER = /^\d{4}-(?:03-31|06-30|09-30|12-31)$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const ROW_LIMIT = 12;
const SCOPE_13F = 'Public quarter-end 13F holdings value, not manager AUM, net assets, investment performance or current holdings. Options report underlying security value, not premiums or net exposure. Missing and confidential positions are not zero.';
const CHANGE_NOTE = 'Reported holding changes do not establish purchases, sales, investment returns or fund flows. Prices, corporate actions, amendments and reporting scope can affect comparisons.';
const optional = (description, maxLength = 160) => ({ type: 'string', maxLength, description });
const previousQuarter = period => {
  const year = Number(period.slice(0, 4)), month = period.slice(5, 7);
  return month === '03' ? `${year - 1}-12-31` : `${year}-${{ '06': '03-31', '09': '06-30', '12': '09-30' }[month]}`;
};

/** Compact projections of the existing fund research readers. No chat-owned
 * cache, holdings copy, issuer enrichment or market-review job is created. */
export function createFundChatTools(api) {
  const { tool, stringSchema, enumeration, read, resolve, addSource, fail, unavailable, txt, finite, context = {}, dependencies = {}, publicJson, preview } = api;
  const raw13f = dependencies.fund13f || (async ({ cik, period }, signal) => preview
    ? (await publicJson('/api/fund-13f', { cik, period }, signal, 12 * 1024 * 1024)).payload
    : (await import('./thirteenFServer.js')).loadThirteenF(cik, { period, signal }));
  const rawNport = dependencies.fundNport || (async ({ id, accession, query = '' }, signal) => {
    if (preview) return (await publicJson('/api/fund', { ticker: id, accession, ...(query ? { q: query } : {}) }, signal, 2 * 1024 * 1024)).payload;
    if (/^S\d{9}$/.test(id)) return (await import('./reportFundSeriesServer.js')).loadReportSeriesFund(id, accession, { signal });
    const { readPreparedFund, loadFund } = await import('./fundResearchServer.js');
    return await readPreparedFund(id, accession, { signal, allowStale: true }) || loadFund(id, accession, { signal });
  });
  const overlap = dependencies.fundOverlap || (async ({ ciks, period }, signal) => preview
    ? (await publicJson('/api/fund-13f/compare', { ciks: ciks.join(','), period }, signal, 2 * 1024 * 1024)).payload
    : (await import('./thirteenFComparisonServer.js')).loadThirteenFComparison(ciks, { period, signal }));

  function selection(kind, identity, input) {
    let value = input.trim();
    if (value === 'latest') return '';
    const fundIds = [identity.id, identity.ticker, identity.seriesId].filter(Boolean);
    if (!value) value = kind === '13f' && context.managerCik === identity.cik ? context.managerPeriod || ''
      : kind === 'nport' && fundIds.includes(context.fund) ? context.accession || ''
        : kind === 'nport' && context.view === 'changes' && fundIds.includes(context.changeTicker) ? context.changeAfter || '' : '';
    if (value && !(kind === '13f' ? QUARTER : ACCESSION).test(value)) throw fail(kind === '13f' ? 'Choose a 13F calendar quarter end, such as 2026-06-30.' : 'Choose a verified N-PORT filing accession.');
    if (kind === '13f' && value && (Number(value.slice(0, 4)) < 1 || value > new Date().toISOString().slice(0, 10))) throw fail('Choose a reporting quarter that has ended.');
    return value;
  }
  async function load(identity, kind, selected, query = '') {
    const data = await read(`fund:${kind}:detail:${identity.id}:${selected || 'latest'}:${preview && kind === 'nport' ? query : ''}`, s => kind === '13f'
      ? raw13f({ cik: identity.cik, period: selected }, s) : rawNport({ id: identity.id, accession: selected, query }, s));
    if (!data || data.status !== 'ready') return { error: unavailable(txt(data?.reason) || 'This public portfolio could not be loaded. Open Funds to check source coverage.') };
    if (kind === '13f') {
      if (data.manager?.cik !== identity.cik || data.portfolio?.cik !== identity.cik || data.selectedPeriod !== data.portfolio?.period
        || selected && data.selectedPeriod !== selected || !QUARTER.test(data.selectedPeriod || '') || !Array.isArray(data.portfolio?.holdings))
        throw fail('The portfolio did not match the selected manager and quarter.', 'SOURCE_IDENTITY_MISMATCH');
    } else if (data.cik !== identity.cik || data.ticker !== identity.id || identity.seriesId && data.seriesId !== identity.seriesId
      || selected && data.accession !== selected || !ACCESSION.test(data.accession || '') || !/^\d{4}-\d{2}-\d{2}$/.test(data.asOf || '') || !Array.isArray(data.holdings))
      throw fail('The portfolio did not match the selected SEC fund series and filing.', 'SOURCE_IDENTITY_MISMATCH');
    return { data };
  }
  function sources(data, kind, view = 'holdings') {
    const ids = [], filings = kind === '13f' ? data.portfolio.filings || [] : [{ form: data.form, accession: data.accession,
      filingDate: data.filingDate, indexUrl: data.filingUrl, tableUrls: [data.sourceUrl] }];
    const date = kind === '13f' ? data.selectedPeriod : data.asOf;
    const sourceMetadata = []; let pageSource;
    // Cite active source documents first; superseded filings cannot substantiate
    // current holdings. Their accession/treatment remains in metadata.
    for (const filing of filings) {
      const active = filing.superseded !== true;
      const sourceIds = active ? [filing.indexUrl, ...(filing.tableUrls || []).slice(0, 1)].map(url => addSource(
        `${kind === '13f' ? data.manager.name : data.name} · ${filing.form || kind} · filed ${filing.filingDate || 'unknown'}`, url, date)).filter(Boolean) : [];
      if (active && !sourceIds.length) throw fail('Every active source filing needs a verified citation. This message’s source budget or source coverage is insufficient; ask a narrower follow-up.');
      ids.push(...sourceIds);
      if (!pageSource && sourceIds.length) pageSource = addSource(`${kind === '13f' ? data.manager.name : data.name} · Funds · ${date}`,
        page(kind === '13f' ? { cik: data.manager.cik } : { id: data.ticker }, kind, kind === '13f' ? date : data.accession, view), date);
      sourceMetadata.push({ accession: filing.accession, form: filing.form, filed: filing.filingDate, superseded: !active,
        amendmentType: filing.amendmentType || null, sourceIds });
    }
    if (!ids.length) throw fail('Original SEC source links could not be verified for this portfolio.');
    return { sourceIds: [...new Set([...ids, pageSource].filter(Boolean))], filings: sourceMetadata };
  }
  function complete(data, kind) {
    return kind === '13f' ? data.portfolio.complete === true && data.coverage?.selectedPeriodComplete === true
      && data.portfolio.positionCount === data.portfolio.holdings.length && data.delivery?.holdingsComplete !== false
      : data.responseScope !== 'summary' && (!data.pagination || data.pagination.portfolioTotal === data.holdings.length)
        && data.summary?.count === data.holdings.length;
  }
  function page(identity, kind, selected, view = 'holdings') {
    return kind === '13f' ? `${ORIGIN}/fund?${new URLSearchParams({ view: '13f', managerCik: identity.cik, managerView: view, ...(selected ? { managerPeriod: selected } : {}) })}`
      : `${ORIGIN}/fund/${encodeURIComponent(identity.id)}${selected ? `?accession=${selected}` : ''}`;
  }
  function freshness(data) {
    return { checkedAt: data.cache?.checkedAt || data.observedAt || data.retrievedAt || null, stale: data.cache?.stale === true,
      note: data.cache?.stale ? 'Previously verified retained source. A newer filing or amendment may not be included.' : null };
  }

  return {
    fund_holdings: tool('Search all available holdings for a verified N-PORT fund or 13F manager, including a selected historical quarter or filing. Returns at most 12 matches; issuer name/CUSIP for 13F, name/ticker/CUSIP/ISIN for N-PORT. Empty query returns largest reported positions. Never infer an absent holding from partial coverage.',
      { identifier: stringSchema('Fund name, ticker, series ID or manager CIK.'), kind: enumeration(['nport', '13f']),
        selection: optional('13F quarter end YYYY-MM-DD or N-PORT accession. Empty uses this same entity’s page selection; latest explicitly overrides it.', 30),
        query: optional('Holding name or security identifier; empty for largest positions.') }, 'Searching disclosed fund holdings',
      async ({ identifier, kind, selection: requested, query }) => {
        const resolved = await resolve(identifier, kind); if (!resolved.identity) return resolved;
        const identity = resolved.identity, selected = selection(kind, identity, requested);
        const loaded = await load(identity, kind, selected, query); if (loaded.error) return loaded.error;
        const { data } = loaded, evidence = sources(data, kind), all = kind === '13f' ? data.portfolio.holdings : data.holdings;
        const needle = query.trim().toLowerCase();
        const matches = kind === '13f' ? select13FHoldings(all, { query: needle }) : all.filter(row => !needle
          || [row.name, row.title, row.tickerSymbol, row.cusip, row.isin].join(' ').toLowerCase().includes(needle))
          .sort((a, b) => (finite(b.value) ?? -Infinity) - (finite(a.value) ?? -Infinity));
        const full = complete(data, kind), limitedScope = kind === '13f' && (data.portfolio.confidentialOmitted || !data.portfolio.comparable);
        const holdings = matches.slice(0, ROW_LIMIT).map(row => kind === '13f'
          ? { key: row.key, name: txt(row.issuer, 160), title: txt(row.classTitle, 80), cusip: row.cusip, putCall: row.putCall || null,
            quantityUnits: row.quantityType, quantity: finite(row.quantity), valueUsd: finite(row.valueUsd), weightPct: full ? finite(row.weightPct) : null }
          : { name: txt(row.name, 160), ticker: row.tickerSymbol || null, cusip: row.cusip || null, isin: row.isin || null,
            quantityUnits: row.units || null, quantity: finite(row.balance), valueUsd: finite(row.value), weightPct: finite(row.pctOfNav),
            direction: row.payoffProfile || null, assetCategory: row.assetCat || null });
        return { status: 'ready', kind, entity: identity, period: kind === '13f' ? data.selectedPeriod : data.asOf,
          accession: kind === 'nport' ? data.accession : undefined, query, holdings,
          matchCount: full ? matches.length : null, observedMatchCount: matches.length,
          truncated: matches.length > ROW_LIMIT || !full, coverage: { completeReport: full, limitedPublicScope: Boolean(limitedScope),
            absenceKnown: full && !limitedScope, loadedPositions: all.length, totalPositions: kind === '13f' ? data.portfolio.positionCount : data.pagination?.portfolioTotal || all.length,
            note: !full ? 'Only delivered rows were searchable; no match does not establish absence.' : 'Search covers this public report, not current or undisclosed holdings.' },
          units: 'Whole USD. weightPct uses percentage points (12.5 = 12.5%); quantities retain their reported units.',
          scope: kind === '13f' ? SCOPE_13F : 'Historical fund-series holdings shared across share classes. Weights use full series net assets, not the displayed subset. Derivative fair value does not measure underlying exposure.',
          reports: (data.reports || []).slice(0, 8).map(row => ({ period: row.period || row.reportDate || null, accession: row.accession || null, filed: row.latestFiled || row.filingDate || null })),
          freshness: freshness(data), pageUrl: page(identity, kind, kind === '13f' ? data.selectedPeriod : data.accession), ...evidence };
      }),
    fund_changes: tool('Calculate reported holding changes using the Funds page’s deterministic comparisons. 13F needs consecutive complete, comparable quarters; N-PORT uses two verified same-series filings. Changes do not establish trades, flows or performance.',
      { identifier: stringSchema('Fund name, ticker, series ID or manager CIK.'), kind: enumeration(['nport', '13f']),
        before: optional('Earlier 13F quarter end or N-PORT accession. Empty selects the prior quarter/recent verified earlier filing.', 30),
        after: optional('Later 13F quarter end or N-PORT accession. Empty respects this entity’s page selection; latest overrides.', 30), query: optional('Optional holding name or identifier filter.') }, 'Comparing reported fund positions',
      async ({ identifier, kind, before, after, query }) => {
        const resolved = await resolve(identifier, kind); if (!resolved.identity) return resolved;
        const identity = resolved.identity, selected = selection(kind, identity, after);
        if (before.trim() === 'latest') return unavailable('Choose a verified earlier report before calculating holding changes.');
        const beforeInput = before.trim() || (kind === 'nport' && context.view === 'changes' && context.changeTicker === identity.id
          && selected === context.changeAfter ? context.changeBefore || '' : '');
        let newer, older, calculated, matchCount;
        if (preview && kind === 'nport') {
          const requestedBefore = beforeInput ? selection(kind, identity, beforeInput) : '';
          const response = await read(`fund:nport:changes:${identity.id}:${requestedBefore}:${selected}:${query}`, async s =>
            (await publicJson('/api/fund-workspace', { mode: 'changes', ticker: identity.id, before: requestedBefore, after: selected, q: query }, s, 2 * 1024 * 1024)).payload);
          if (response?.mode !== 'changes') throw fail('The source did not return the selected fund comparison.', 'SOURCE_IDENTITY_MISMATCH');
          if (!response.result?.available) return unavailable(txt(response.result?.reason) || 'Two complete verified N-PORT reports are required for changes.');
          calculated = response.result;
          const funds = Array.isArray(response.funds) ? response.funds : [];
          newer = funds.find(row => row.accession === response.resolvedAfter);
          older = funds.find(row => row.accession === response.resolvedBefore);
          const correctIdentity = row => row?.ticker === identity.id && row.cik === identity.cik && /^S\d{9}$/.test(row.seriesId || '')
            && (!identity.seriesId || row.seriesId === identity.seriesId) && ACCESSION.test(row.accession || '') && /^\d{4}-\d{2}-\d{2}$/.test(row.asOf || '');
          const bound = (row, evidence) => evidence?.ticker === row.ticker && evidence.cik === row.cik && evidence.seriesId === row.seriesId
            && evidence.accession === row.accession && evidence.asOf === row.asOf;
          if (!correctIdentity(newer) || !correctIdentity(older) || funds.length !== 2 || newer === older || older.seriesId !== newer.seriesId
            || selected && newer.accession !== selected || requestedBefore && older.accession !== requestedBefore || older.asOf > newer.asOf
            || !bound(newer, calculated.after) || !bound(older, calculated.before) || calculated.query !== query.trim().slice(0, 100)
            || calculated.coverage?.before?.complete !== true || calculated.coverage?.after?.complete !== true
            || calculated.coverage.before.positions !== older.summary?.count || calculated.coverage.after.positions !== newer.summary?.count
            || !Array.isArray(calculated.rows) || calculated.rows.length > 50 || !Number.isSafeInteger(response.pagination?.total)
            || response.pagination.total < calculated.rows.length)
            throw fail('The fund comparison did not match the exact series, filings and complete-report coverage.', 'SOURCE_IDENTITY_MISMATCH');
          matchCount = response.pagination.total;
        } else {
          const current = await load(identity, kind, selected); if (current.error) return current.error;
          newer = current.data;
          const earlier = beforeInput ? selection(kind, identity, beforeInput) : kind === '13f' ? previousQuarter(newer.selectedPeriod)
            : (newer.reports || []).filter(row => row.reportDate && row.reportDate < newer.asOf).sort((a, b) => b.reportDate.localeCompare(a.reportDate) || String(b.filingDate).localeCompare(String(a.filingDate)))[0]?.accession;
          if (!earlier) return unavailable('Choose a verified earlier report before calculating holding changes.');
          const previous = await load(identity, kind, earlier); if (previous.error) return previous.error;
          older = previous.data;
          if (!complete(older, kind) || !complete(newer, kind)) return unavailable('Complete holdings for both selected reports are required. A delivered holdings page cannot establish additions or removals.');
          calculated = kind === '13f' ? compare13FPortfolios(older.portfolio, newer.portfolio)
            : buildFundChanges({ ...older, complete: true }, { ...newer, complete: true }, { query });
        }
        const evidenceAfter = sources(newer, kind, 'changes'), evidenceBefore = sources(older, kind, 'changes');
        if (!calculated.available) return unavailable(txt(calculated.reason), 'FUND_COMPARISON_UNAVAILABLE', { sourceIds: [...evidenceBefore.sourceIds, ...evidenceAfter.sourceIds] });
        const needle = query.trim().toLowerCase();
        const rows = kind === '13f' ? calculated.changes.filter(row => !needle || [row.issuer, row.classTitle, row.cusip].join(' ').toLowerCase().includes(needle)) : calculated.rows;
        const pageUrl = kind === '13f' ? page(identity, kind, newer.selectedPeriod, 'changes')
          : `${ORIGIN}/fund?${new URLSearchParams({ view: 'changes', changeTicker: identity.id, changeBefore: older.accession, changeAfter: newer.accession })}`;
        const pageId = addSource(`${identity.name} · Funds · selected report changes`, pageUrl, kind === '13f' ? newer.selectedPeriod : newer.asOf);
        return { status: 'ready', kind, entity: identity, before: kind === '13f' ? older.selectedPeriod : { accession: older.accession, period: older.asOf },
          after: kind === '13f' ? newer.selectedPeriod : { accession: newer.accession, period: newer.asOf }, query,
          comparisonType: calculated.comparisonType || 'consecutive-quarter-change', counts: calculated.counts || calculated.summary,
          changes: rows.slice(0, ROW_LIMIT).map(row => kind === '13f' ? { ...row, issuer: txt(row.issuer, 160), classTitle: txt(row.classTitle, 80) }
            : { name: txt(row.name, 160), identifiers: row.ids, direction: row.direction, status: row.status,
              beforeValueUsd: row.before.value, afterValueUsd: row.after.value, valueChangeUsd: row.deltaValue,
              beforeWeightPct: row.before.weight, afterWeightPct: row.after.weight, weightChangePp: row.deltaWeight,
              quantityChange: row.deltaQuantity, quantityUnits: row.after.units, quantityReason: row.quantityReason }),
          matchCount: matchCount ?? rows.length, truncated: (matchCount ?? rows.length) > ROW_LIMIT, coverage: calculated.coverage || { completeReports: true },
          units: 'Whole USD. Percentage fields use 12.5 = 12.5%; weight differences are percentage points. Retain SH/PRN or original N-PORT units.',
          notes: [CHANGE_NOTE, ...(calculated.issues || calculated.warnings || []).slice(0, 5)], scope: kind === '13f' ? SCOPE_13F : 'Selected historical N-PORT series reports; not live portfolios.',
          freshness: { before: freshness(older), after: freshness(newer) }, pageUrl,
          sourceIds: [...new Set([...evidenceBefore.sourceIds, ...evidenceAfter.sourceIds, pageId].filter(Boolean))], filings: [...evidenceBefore.filings, ...evidenceAfter.filings] };
      }),
    fund_overlap: tool('Compare exactly two 13F managers using the existing aligned-quarter Funds comparison. Returns deterministic shared-security counts and weighted overlap, preserving incomplete/confidential coverage and separate share, principal, put and call positions. No company research or CFTC enrichment.',
      { left: stringSchema('First manager name or CIK.'), right: stringSchema('Second manager name or CIK.'), period: optional('Calendar quarter end, empty for this selected manager’s page quarter or automatic alignment, latest for automatic alignment.', 30) }, 'Comparing manager holdings',
      async ({ left, right, period }) => {
        const resolved = await Promise.all([resolve(left, '13f'), resolve(right, '13f')]);
        const missing = resolved.find(value => !value.identity); if (missing) return missing;
        const identities = resolved.map(value => value.identity), ciks = identities.map(value => value.cik);
        if (ciks[0] === ciks[1]) throw fail('Choose two different managers.');
        const sameComparison = Array.isArray(context.managerCompare) && context.managerCompare.length >= 2 && context.managerCompare.length <= 4 && ciks.every(cik => context.managerCompare.includes(cik));
        const periodInput = period || (sameComparison ? context.managerComparePeriod || '' : '');
        const selected = selection('13f', identities.find(value => value.cik === context.managerCik) || identities[0], periodInput);
        const data = await read(`fund:overlap:${ciks.join(',')}:${selected || 'latest'}`, s => overlap({ ciks, period: selected }, s));
        if (!QUARTER.test(data?.period || '') || selected && data.period !== selected || !Array.isArray(data.managers)
          || data.managers.length !== 2 || data.managers.some((row, i) => row.cik !== ciks[i] || row.period !== data.period))
          throw fail('The comparison did not match both selected managers and the same reporting quarter.', 'SOURCE_IDENTITY_MISMATCH');
        const sourceIds = [];
        for (const row of data.managers) if (['ready', 'incomplete'].includes(row.status)) sourceIds.push(...sources({ manager: row, selectedPeriod: data.period, portfolio: { filings: row.filings } }, '13f').sourceIds);
        if (!sourceIds.length) return unavailable('No verified public manager reports were available for this aligned quarter.');
        const pageUrl = `${ORIGIN}/fund?${new URLSearchParams({ view: '13f', managerView: 'compare', managerComparePeriod: data.period, managerCompare: ciks.join(',') })}`;
        const pageId = addSource(`Funds · aligned manager comparison · ${data.period}`, pageUrl, data.period);
        if (pageId) sourceIds.push(pageId);
        return { status: 'ready', period: data.period, selection: data.selection, coverage: data.coverage, scope: SCOPE_13F,
          managers: data.managers.map(row => ({ cik: row.cik, name: txt(row.name, 160), status: row.status, complete: row.complete,
            totalValueUsd: finite(row.totalValueUsd), observedValueUsd: finite(row.observedValueUsd), positionCount: row.positionCount,
            observedPositionCount: row.observedPositionCount, top10Pct: finite(row.top10Pct), publicScopeLimited: row.publicScopeLimited,
            confidentialOmitted: row.confidentialOmitted, amendmentCount: row.amendmentCount, reason: txt(row.reason) || null })),
          pairs: (data.pairs || []).slice(0, 1).map(({ sharedHoldings: _rows, ...pair }) => pair),
          holdings: (data.sharedHoldings || []).slice(0, ROW_LIMIT).map(({ anchorHolding: _anchor, summedSharePct: _sum, ...row }) => row),
          totalSharedHoldings: data.totalSharedHoldings, truncated: data.sharedHoldingsTruncated || data.totalSharedHoldings > ROW_LIMIT,
          units: 'Whole USD. All Pct fields use percentage points (12.5 = 12.5%). Weighted overlap sums the smaller full-portfolio value percentage for each matching security.',
          notes: (data.notes || []).map(note => txt(note, 650)), freshness: data.cache || null, sourceIds: [...new Set(sourceIds)],
          pageUrl };
      }),
  };
}
