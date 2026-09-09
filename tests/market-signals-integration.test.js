import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

const METRIC_KEYS = [
  'revenueGrowth', 'netMargin', 'operatingMargin', 'cashFlowMargin', 'freeCashFlowMargin',
  'capexIntensity', 'equityToAssets', 'liabilitiesToAssets', 'cashToAssets', 'revenue',
  'totalAssets', 'netIncome',
];

function filingPoint(cik, accession, end, filed, metrics) {
  const factorKeys = ['revenueGrowth', 'netMargin', 'operatingMargin', 'freeCashFlowMargin', 'equityToAssets', 'cashToAssets'];
  const factorMetrics = Object.fromEntries(factorKeys.map((key) => [key, metrics[key] ?? null]));
  return {
    end,
    filed,
    acceptedAt: `${filed}T21:30:00.000Z`,
    form: '10-Q',
    accession,
    source: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/`,
    metrics: factorMetrics,
    factorSourceAccessions: factorKeys.some((key) => metrics[key] != null) ? [accession] : [],
    factorSourceMasks: factorKeys.map((key) => metrics[key] == null ? '0' : '1'),
  };
}

function company(index, ticker) {
  const cik = String(index + 100).padStart(10, '0');
  const change = (index - 5) * 0.45;
  const current = Object.fromEntries(METRIC_KEYS.map((key) => [key, null]));
  Object.assign(current, {
    revenueGrowth: 12 + change,
    operatingMargin: 25 + change * 0.7,
    freeCashFlowMargin: 18 + change * 0.9,
    equityToAssets: 45 + change * 0.5,
    cashToAssets: 16 + change * 0.6,
  });
  const changes = Object.fromEntries(METRIC_KEYS.map((key) => [key, null]));
  Object.assign(changes, {
    revenueGrowth: change,
    operatingMargin: change * 0.7,
    freeCashFlowMargin: change * 0.9,
    equityToAssets: change * 0.5,
    cashToAssets: change * 0.6,
  });
  const prior = Object.fromEntries(METRIC_KEYS.map((key) => [key,
    current[key] == null || changes[key] == null ? null : current[key] - changes[key],
  ]));
  const currentAccession = `${cik}-${ticker === 'NVDA' ? '26' : '25'}-${String(index + 1).padStart(6, '0')}`;
  const priorAccession = `${cik}-${ticker === 'NVDA' ? '25' : '24'}-${String(index + 1).padStart(6, '0')}`;
  const currentPoint = filingPoint(cik, currentAccession, '2026-06-30', '2026-07-31', current);
  const priorPoint = filingPoint(cik, priorAccession, '2025-06-30', '2025-07-31', prior);
  return {
    version: 'market-research-v3',
    ticker,
    name: ticker === 'NVDA' ? 'NVIDIA Corporation' : `Peer ${index}`,
    cik,
    sic: '3674',
    cohorts: ['ai-infrastructure'],
    observedAt: '2026-09-09T08:00:00.000Z',
    metrics: { annual: current, ttm: current },
    reports: { annual: currentPoint, ttm: currentPoint },
    filingComparisons: {
      annual: { pointInTime: true, cutoff: { filed: currentPoint.filed, acceptedAt: currentPoint.acceptedAt, accession: currentPoint.accession }, current: currentPoint, prior: priorPoint, gapDays: 365, changes },
      ttm: { pointInTime: true, cutoff: { filed: currentPoint.filed, acceptedAt: currentPoint.acceptedAt, accession: currentPoint.accession }, current: currentPoint, prior: priorPoint, gapDays: 365, changes },
    },
  };
}

function atlas() {
  const companies = [company(10, 'NVDA'), ...Array.from({ length: 10 }, (_, index) => company(index, `P${index + 1}`))];
  return {
    version: 'market-research-v3',
    generatedAt: '2026-09-09T08:00:00.000Z',
    requested: companies.length,
    companies,
    cohorts: [{
      id: 'ai-infrastructure', label: 'Digital Infrastructure', title: 'AI infrastructure',
      description: 'Synthetic integration-test cohort.', disclosureTerms: 'artificial intelligence',
      tickers: companies.map((row) => row.ticker),
    }],
    failures: [],
    historyPersistence: true,
    observations: [{
      observedAt: '2026-09-09T08:00:00.000Z', companies: companies.length,
      tickers: companies.map((row) => row.ticker),
      revenueGrowth: { count: companies.length, median: 12 },
      netMargin: { count: 0, median: null },
    }],
  };
}

function weekdays(start, end) {
  const rows = [];
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += 86_400_000) {
    const day = new Date(time).getUTCDay();
    if (day !== 0 && day !== 6) rows.push(new Date(time).toISOString().slice(0, 10));
  }
  return rows;
}

function yahooPayload(ticker, includeAdjusted = true) {
  const dates = weekdays('2025-01-02', '2026-09-09');
  let price = 100;
  const prices = dates.map((date, index) => {
    if (index) {
      const market = 0.0003 + 0.008 * Math.sin(index * 0.37) + 0.004 * Math.cos(index * 0.11);
      const sectorNoise = 0.003 * Math.sin(index * 0.71);
      const idiosyncratic = 0.0015 * Math.cos(index * 0.53);
      const eventShock = ticker === 'NVDA' && date >= '2026-08-03' && date <= '2026-08-07' ? 0.006 : 0;
      const value = ticker === 'SPY'
        ? market
        : ticker === 'XLK'
          ? 0.85 * market + sectorNoise
          : 0.0002 + 1.15 * market + 0.55 * sectorNoise + idiosyncratic + eventShock;
      price *= Math.exp(value);
    }
    return price;
  });
  return { chart: { result: [{
    timestamp: dates.map((date) => Date.parse(`${date}T00:00:00Z`) / 1000),
    indicators: {
      quote: [{ close: prices, volume: prices.map(() => 1_000_000) }],
      ...(includeAdjusted ? { adjclose: [{ adjclose: prices }] } : {}),
    },
  }] } };
}

test('Signal orchestration joins one warm SEC snapshot to three adjusted price series without exposing raw histories', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.KV_REST_API_URL;
  const originalToken = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_URL = 'https://redis.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  const snapshot = atlas();
  const redis = new Map();
  let includeAdjusted = true;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'redis.test') {
      if (url.pathname.startsWith('/get/')) {
        const cacheKey = decodeURIComponent(url.pathname.slice('/get/'.length));
        const value = cacheKey === 'warm:market-research-v3:ATLAS'
          ? JSON.stringify(snapshot)
          : redis.get(cacheKey) ?? null;
        return Response.json({ result: value });
      }
      if (url.pathname === '/pipeline') {
        const commands = JSON.parse(options.body || '[]');
        return Response.json(commands.map((command) => ({ result: command?.[0] === 'PTTL' ? 0 : 1 })));
      }
      if (url.pathname.startsWith('/set/')) {
        redis.set(decodeURIComponent(url.pathname.slice('/set/'.length)), String(options.body));
        return Response.json({ result: 'OK' });
      }
      if ((options.method || 'GET') === 'POST') return Response.json({ result: 'OK' });
    }
    if (url.hostname === 'query1.finance.yahoo.com') {
      const ticker = decodeURIComponent(url.pathname.split('/').at(-1));
      return Response.json(yahooPayload(ticker, includeAdjusted));
    }
    throw new Error(`Unexpected integration-test request: ${url}`);
  };

  try {
    const { loadMarketSignal } = await import(`../src/utils/marketSignalsServer.js?integration=${Date.now()}`);
    const result = await loadMarketSignal({
      ticker: 'NVDA', window: '1y', basis: 'ttm', cohort: 'ai-infrastructure', sectorProxy: 'XLK',
    }, { now: new Date('2026-09-09T12:00:00.000Z') });
    assert.equal(result.schema_version, 'edgar.market-signals.v1');
    assert.equal(result.universe_version, 'market-research-v3');
    assert.equal(result.status, 'ready', JSON.stringify({ warnings: result.warnings, quality: result.quality, filing: result.edgar_snapshot, event: result.filing_event }, null, 2));
    assert.ok(Number.isFinite(result.estimates.market_model.beta));
    assert.ok(result.estimates.market_model.beta_confidence_interval95.every(Number.isFinite));
    assert.ok(Number.isFinite(result.estimates.independent_sector_sensitivity.independent_sector_beta));
    assert.ok(Number.isFinite(result.edgar_snapshot.filing_change_z));
    assert.equal(result.edgar_snapshot.coverage.eligible_peer_issuers, 10);
    assert.ok(Number.isFinite(result.filing_event.windows['20'].standardized_response));
    assert.equal(result.filing_event.timing_quality, 'acceptance_timestamp_during_or_after_session');
    assert.equal(result.filing_event.event_interval_end, '2026-08-03');
    assert.ok(Number.isFinite(result.evidence_gap.evidence_gap));
    assert.equal(result.estimates.beta_term_structure.length, 3);
    assert.equal(result.estimates.influence_sensitivity.available, true);
    assert.ok(Number.isFinite(result.estimates.residual_tail.expected_shortfall));
    assert.equal(result.filing_event.path.length, 20);
    assert.match(result.filing_event.estimation.inference, /HAC/);
    assert.equal(result.quality.gates.length, 7);
    assert.ok(result.research_readout.questions.length > 0);
    assert.match(result.fingerprints.input_sha256, /^[0-9a-f]{64}$/);
    assert.match(result.fingerprints.result_sha256, /^[0-9a-f]{64}$/);
    assert.match(result.fingerprints.sec_sha256, /^[0-9a-f]{64}$/);
    assert.match(result.fingerprints.canonicalization, /lexicographic/);
    assert.equal(result.quality.headline_eligible, true);
    assert.equal(result.quality.filing_score_complete, true);
    assert.equal(result.quality.peer_count, 10);
    assert.equal(result.quality.eligible_peer_issuers, 10);
    assert.equal(result.provenance.prices.asset.provider, 'yahoo_finance');
    assert.equal(result.provenance.prices.asset.price_basis, 'adjusted_close');
    assert.equal(result.data_through, '2026-09-08');
    assert.equal(result.provenance.prices.asset.last_observation, '2026-09-08');
    assert.equal(JSON.stringify(result).includes('adjustedClose'), false);
    assert.equal(JSON.stringify(result).includes('rawClose'), false);
    const repeated = await loadMarketSignal({
      ticker: 'NVDA', window: '1y', basis: 'ttm', cohort: 'ai-infrastructure', sectorProxy: 'XLK',
    }, { now: new Date('2026-09-09T12:00:00.000Z') });
    assert.equal(repeated.snapshot_id, result.snapshot_id);
    assert.equal(repeated.fingerprints.input_sha256, result.fingerprints.input_sha256);
    assert.equal(repeated.fingerprints.result_sha256, result.fingerprints.result_sha256);

    // Compile the published contract and validate the real orchestration
    // output so response-key drift cannot silently break generated clients.
    const schema = JSON.parse(readFileSync(new URL('../public/schemas/market-signals-v1.schema.json', import.meta.url), 'utf8'));
    delete schema.$schema;
    const validate = new Ajv({ allErrors: true, schemaId: 'auto' }).compile(schema);
    assert.equal(validate(result), true, JSON.stringify(validate.errors, null, 2));
    assert.ok(Object.hasOwn(schema.$defs.regression.properties, 'beta_confidence_interval95'));
    assert.equal(Object.hasOwn(schema.$defs.regression.properties, 'beta_confidence_interval_95'), false);

    const { GET: signalRouteGet } = await import(`../src/app/api/v1/market-signals/route.js?integration=${Date.now()}`);
    const routeUrl = 'https://secedgarterminal.com/api/v1/market-signals?ticker=NVDA&window=1y&basis=ttm&cohort=ai-infrastructure&sector_proxy=XLK';
    const firstRouteResponse = await signalRouteGet(new Request(routeUrl, { headers: { 'x-forwarded-for': '192.0.2.210' } }));
    assert.equal(firstRouteResponse.status, 200);
    const etag = firstRouteResponse.headers.get('etag');
    assert.match(etag, /^"[A-Za-z0-9_-]+"$/);
    assert.equal(firstRouteResponse.headers.get('content-location'), '/api/v1/market-signals?ticker=NVDA&window=1y&basis=ttm&cohort=ai-infrastructure&sector_proxy=XLK');
    assert.match(firstRouteResponse.headers.get('server-timing'), /total;dur=/);
    const conditionalResponse = await signalRouteGet(new Request(routeUrl, {
      headers: { 'x-forwarded-for': '192.0.2.211', 'if-none-match': etag },
    }));
    assert.equal(conditionalResponse.status, 304);
    assert.equal(await conditionalResponse.text(), '');
    for (const [index, validator] of [`W/${etag}`, `"unmatched", W/${etag}`, '*'].entries()) {
      const conditional = await signalRouteGet(new Request(routeUrl, {
        headers: { 'x-forwarded-for': `192.0.2.${212 + index}`, 'if-none-match': validator },
      }));
      assert.equal(conditional.status, 304);
      assert.equal(await conditional.text(), '');
    }
    const nonmatch = await signalRouteGet(new Request(routeUrl, {
      headers: { 'x-forwarded-for': '192.0.2.215', 'if-none-match': '"unmatched"' },
    }));
    assert.equal(nonmatch.status, 200);

    // Refresh clocks are provenance, not analytic inputs; exact filing values,
    // peers, versions, cutoffs, and price rows determine the stable snapshot.
    snapshot.generatedAt = '2026-09-09T08:30:00.000Z';
    const reclocked = await loadMarketSignal({
      ticker: 'NVDA', window: '1y', basis: 'ttm', cohort: 'ai-infrastructure', sectorProxy: 'XLK',
    }, { now: new Date('2026-09-09T12:00:00.000Z') });
    assert.equal(reclocked.fingerprints.input_sha256, result.fingerprints.input_sha256);
    assert.equal(reclocked.snapshot_id, result.snapshot_id);
    assert.notEqual(reclocked.fingerprints.result_sha256, result.fingerprints.result_sha256);

    snapshot.companies[1].filingComparisons.ttm.current.metrics.revenueGrowth += 0.25;
    snapshot.generatedAt = '2026-09-09T08:45:00.000Z';
    const changedPeerInput = await loadMarketSignal({
      ticker: 'NVDA', window: '1y', basis: 'ttm', cohort: 'ai-infrastructure', sectorProxy: 'XLK',
    }, { now: new Date('2026-09-09T12:00:00.000Z') });
    assert.notEqual(changedPeerInput.fingerprints.input_sha256, result.fingerprints.input_sha256);
    assert.notEqual(changedPeerInput.snapshot_id, result.snapshot_id);

    includeAdjusted = false;
    for (const key of redis.keys()) if (key.includes('stock-raw-yahoo')) redis.delete(key);
    const withheld = await loadMarketSignal({
      ticker: 'NVDA', window: '3y', basis: 'ttm', cohort: 'ai-infrastructure', sectorProxy: 'XLK',
    }, { now: new Date('2026-09-09T12:00:00.000Z') });
    assert.equal(withheld.status, 'withheld');
    assert.equal(withheld.evidence_gap.available, false);
    assert.equal(withheld.evidence_gap.gap_interpretation, null);
    assert.equal(validate(withheld), true, JSON.stringify(validate.errors, null, 2));

    // A new SEC snapshot changes the immutable result key. The request-level
    // last-eligible pointer must still protect users during a simultaneous
    // adjusted-price degradation, while preserving the older source clocks.
    snapshot.generatedAt = '2026-09-09T09:00:00.000Z';
    const rolloverFallback = await loadMarketSignal({
      ticker: 'NVDA', window: '1y', basis: 'ttm', cohort: 'ai-infrastructure', sectorProxy: 'XLK',
    }, { now: new Date('2026-09-09T12:00:00.000Z') });
    assert.equal(rolloverFallback.status, 'stale');
    assert.equal(rolloverFallback.cache_status, 'stale');
    assert.equal(rolloverFallback.generated_at, result.generated_at);
    assert.ok(rolloverFallback.warnings.some((warning) => warning.code === 'STALE_SIGNAL_RESULT'));
    assert.equal(validate(rolloverFallback), true, JSON.stringify(validate.errors, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = originalUrl;
    if (originalToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = originalToken;
  }
});
