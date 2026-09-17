import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketMacroPositioning, macroPositioningDescription, MARKET_MACRO_CONTRACTS } from '../src/utils/marketMacroPositioning.js';

function snapshot(family, { date = '2026-09-08', values = {}, ...overrides } = {}) {
  return {
    report_family: family, report_basis: 'futures_only', report_date: date,
    retrieved_at: '2026-09-12T14:00:00Z', status: 'ready',
    freshness: { source_report_age_days: 4, source_currency: 'current', cache_status: 'shared-cache' },
    latest: MARKET_MACRO_CONTRACTS.filter(item => item.family === family).map((definition, index) => ({
      code: definition.code, family, reportBasis: 'futures_only', reportDate: date,
      exchange: 'Fixture exchange', units: 'Fixture units', openInterest: 1000,
      groups: { [definition.group]: { long: 300, short: 200, net: 100, netPctOi: 10, oneWeekNetPctChange: index + 1, oneWeekChange: index + 10, ...values[definition.code] } },
    })),
    ...overrides,
  };
}

test('macro summary preserves each exact family, code, participant, report date and source', () => {
  const result = buildMarketMacroPositioning({ tff: snapshot('tff'), disaggregated: snapshot('disaggregated') });
  assert.equal(result.availableCount, 6);
  assert.equal(result.comparableCount, 6);
  assert.equal(result.differentReportDates, false);
  assert.equal(new Set(result.cards.map(item => `${item.family}|${item.code}|${item.group}`)).size, 6);
  for (const card of result.cards) {
    assert.equal(card.groupLabel, card.family === 'tff' ? 'Leveraged Funds' : 'Managed Money');
    assert.equal(card.view.cftcDate, '2026-09-08');
    assert.equal(card.view.cftcGroup, card.group);
    assert.equal(card.view.cftcContract, card.code);
    assert.equal(card.view.cftcFamily, card.family);
    assert.equal(card.net, 100);
    assert.equal(card.netPctOi, 10);
    const source = new URL(card.sourceUrl);
    assert.equal(source.hostname, 'publicreporting.cftc.gov');
    assert.ok(source.searchParams.get('$where').includes(`cftc_contract_market_code = '${card.code}'`));
    assert.ok(source.searchParams.get('$where').includes('2026-09-08T00:00:00.000'));
  }
});

test('missing or duplicate exact contracts are unavailable and never replaced by another market', () => {
  const tff = snapshot('tff');
  tff.latest[0].code = '042601';
  tff.latest.push(structuredClone(tff.latest[1]));
  const result = buildMarketMacroPositioning({ tff });
  assert.equal(result.availableCount, 1);
  assert.equal(result.cards[0].code, '043602');
  assert.equal(result.cards[0].available, false);
  assert.equal(result.cards[0].sourceUrl, null);
  assert.equal(result.cards[1].available, false);
  assert.equal(result.cards[2].available, true);
  assert.equal(result.largestMove, null);
});

test('mixed dates, report bases, or report families do not leak into cards', () => {
  const tff = snapshot('tff');
  tff.latest[0].reportDate = '2026-09-01';
  tff.latest[1].reportBasis = 'futures_and_options';
  tff.latest[2].family = 'disaggregated';
  assert.equal(buildMarketMacroPositioning({ tff }).availableCount, 0);
  assert.equal(buildMarketMacroPositioning({ tff: snapshot('disaggregated') }).availableCount, 0);
  assert.equal(buildMarketMacroPositioning({ tff: snapshot('tff', { report_basis: 'combined' }) }).families[0].valid, false);
});

test('zero is preserved while missing net, open interest, and weekly comparisons remain unavailable', () => {
  const tff = snapshot('tff', { values: {
    '043602': { long: 200, short: 200, net: 0, netPctOi: 0, oneWeekNetPctChange: 0 },
    '099741': { oneWeekNetPctChange: null, fourWeekNetPctChange: 50 },
    '13874A': { net: null, netPctOi: 20, oneWeekNetPctChange: 10 },
  } });
  const result = buildMarketMacroPositioning({ tff });
  assert.equal(result.cards[0].netPctOi, 0);
  assert.equal(result.cards[0].weeklyChange, 0);
  assert.match(result.cards[0].description, /balanced; net share was unchanged/);
  assert.equal(result.cards[1].weeklyChange, null);
  assert.match(result.cards[1].description, /comparison|change unavailable/);
  assert.equal(result.cards[2].netPctOi, null);
  assert.equal(result.cards[2].weeklyChange, null);
  tff.latest[0].openInterest = 0;
  assert.equal(buildMarketMacroPositioning({ tff }).cards[0].netPctOi, null);
});

test('largest weekly shift ranks absolute percentage-point changes, never total net contracts', () => {
  const tff = snapshot('tff', { values: { '043602': { net: 900, netPctOi: 90, oneWeekNetPctChange: 2 }, '099741': { net: -100, netPctOi: -10, oneWeekNetPctChange: -4 } } });
  const result = buildMarketMacroPositioning({ tff, disaggregated: snapshot('disaggregated') });
  assert.equal(result.largestMove.code, '099741');
  assert.equal(result.largestMove.weeklyChange, -4);
  assert.match(result.largestMove.description, /Net short; net share fell 4 pp/);
  assert.equal(Object.hasOwn(result, 'totalNet'), false);
});

test('reports for different weeks retain their dates without a cross-week winning move', () => {
  const result = buildMarketMacroPositioning({ tff: snapshot('tff'), disaggregated: snapshot('disaggregated', { date: '2026-09-01' }) });
  assert.equal(result.availableCount, 6);
  assert.equal(result.differentReportDates, true);
  assert.equal(result.largestMove, null);
  assert.equal(result.cards[3].view.cftcDate, '2026-09-01');
});

test('source age, preserved cache, and partial status remain independent and visible', () => {
  const tff = snapshot('tff', { status: 'partial', freshness: { source_report_age_days: 20, source_currency: 'aged', cache_status: 'stale-fallback' }, refresh_warning: 'Bounded report history is incomplete.' });
  const result = buildMarketMacroPositioning({ tff });
  assert.equal(result.families[0].aged, true);
  assert.equal(result.families[0].stale, true);
  assert.equal(result.families[0].partial, true);
  assert.equal(result.families[0].sourceAgeDays, 20);
  assert.equal(result.cards[0].aged, true);
  assert.equal(result.cards[0].stale, true);
  assert.equal(result.families[1].valid, false);
  assert.equal(result.cards[3].netPctOi, null);
});

test('descriptions state measured net share direction without inferring prices or flows', () => {
  assert.equal(macroPositioningDescription(-10, 2), 'Net short; net share rose 2 pp over one week.');
  assert.equal(macroPositioningDescription(10, -2), 'Net long; net share fell 2 pp over one week.');
  assert.equal(macroPositioningDescription(null, 2), 'Positioning unavailable in this report.');
  assert.equal(macroPositioningDescription(0, null), 'Long and short positions are balanced. Comparable weekly change unavailable.');
});
