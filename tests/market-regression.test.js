import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EconometricsError,
  alignReturnSeries,
  estimateFilingEvent,
  estimateRegressionDiagnostics,
  fitIndependentSectorModel,
  fitMarketModel,
  normalizePricePoints,
  priceLogReturns,
  stripModelInternals,
} from '../src/utils/marketRegression.js';

const DAY = 86400000;

function closeTo(actual, expected, tolerance = 1e-10) {
  assert.ok(Number.isFinite(actual), `Expected a finite value, received ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} was not within ${tolerance} of ${expected}`);
}

function tradingDates(returnCount, start = '2024-01-02') {
  const dates = [];
  let timestamp = Date.parse(`${start}T00:00:00Z`);
  while (dates.length < returnCount + 1) {
    const day = new Date(timestamp).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(new Date(timestamp).toISOString().slice(0, 10));
    timestamp += DAY;
  }
  return dates;
}

function pricesFromLogReturns(returns, dates = tradingDates(returns.length), initial = 100) {
  let price = initial;
  const rows = [{ date: dates[0], adjustedClose: price, close: price * 10 }];
  for (let index = 0; index < returns.length; index += 1) {
    price *= Math.exp(returns[index]);
    rows.push({ date: dates[index + 1], adjustedClose: price, close: price * 10 });
  }
  return rows;
}

function marketSequence(length) {
  return Array.from({ length }, (_, index) => {
    const magnitude = 0.003 + (index % 13) * 0.0007;
    return (index % 2 ? 1 : -1) * magnitude;
  });
}

test('Price normalization is strict, adjusted-close first, ordered, and conflict detecting', () => {
  const normalized = normalizePricePoints([
    { date: '2026-01-05', close: 102 },
    { date: '2026-02-30', close: 500 },
    { date: '2026-01-02', adjustedClose: 100, close: 1000 },
    { date: '2026-01-05', adjustedClose: 102 },
    { date: '2026-01-06', close: 0 },
    { date: '2026-01-07', adjustedClose: 103, close: 999 },
  ]);
  assert.deepEqual(normalized.points, [
    { date: '2026-01-02', value: 100 },
    { date: '2026-01-05', value: 102 },
    { date: '2026-01-07', value: 103 },
  ]);
  assert.equal(normalized.excluded, 2);
  assert.equal(normalized.duplicates, 1);
  assert.throws(
    () => normalizePricePoints([{ date: '2026-01-02', close: 100 }, { date: '2026-01-02', close: 101 }]),
    (error) => error instanceof EconometricsError && error.code === 'CONFLICTING_PRICE_OBSERVATION',
  );
});

test('Returns align only when both exact interval endpoints match', () => {
  const asset = priceLogReturns([
    { date: '2026-01-02', adjustedClose: 100 },
    { date: '2026-01-05', adjustedClose: 101 },
    { date: '2026-01-07', adjustedClose: 104 },
  ]);
  const market = priceLogReturns([
    { date: '2026-01-02', adjustedClose: 200 },
    { date: '2026-01-05', adjustedClose: 202 },
    { date: '2026-01-06', adjustedClose: 203 },
    { date: '2026-01-07', adjustedClose: 204 },
  ]);
  closeTo(asset.returns[0].value, Math.log(1.01));
  assert.deepEqual(alignReturnSeries({ asset: asset.returns, market: market.returns }), [{
    key: '2026-01-02/2026-01-05',
    startDate: '2026-01-02',
    endDate: '2026-01-05',
    asset: Math.log(1.01),
    market: Math.log(1.01),
  }]);
  assert.deepEqual(alignReturnSeries({ asset: asset.returns, missing: undefined }), []);
});

test('OLS recovers known daily intercept and beta with coherent derived statistics', () => {
  const market = marketSequence(180);
  const observations = market.map((value, index) => ({
    market: value,
    asset: 0.0005 + 1.4 * value,
    endDate: `session-${index}`,
  }));
  const model = fitMarketModel(observations, { minObservations: 180, hacLag: 2 });
  closeTo(model.interceptDaily, 0.0005, 1e-14);
  closeTo(model.interceptAnnualized, 0.126, 1e-12);
  closeTo(model.beta, 1.4, 1e-13);
  closeTo(model.rSquared, 1, 1e-13);
  closeTo(model.adjustedRSquared, 1, 1e-13);
  closeTo(model.correlation, 1, 1e-13);
  assert.equal(model.observations, 180);
  assert.equal(model.hacLag, 2);
  assert.equal(model.durbinWatson, null);
});

test('Newey-West covariance matches an independently calculated golden fixture', () => {
  const market = [-0.020, 0.010, 0.015, -0.005, 0.030, -0.010, 0.005, 0.020, -0.015, 0.012];
  const asset = [-0.025, 0.017, 0.018, -0.003, 0.041, -0.010, 0.009, 0.026, -0.017, 0.016];
  const model = fitMarketModel(market.map((value, index) => ({
    market: value,
    asset: asset[index],
    endDate: `session-${index}`,
  })), { hacLag: 2 });
  closeTo(model.interceptDaily, 0.00188773441459706, 1e-15);
  closeTo(model.beta, 1.2648251393816523, 1e-14);
  closeTo(model.rSquared, 0.9937153327716172, 1e-14);
  closeTo(model.interceptStandardError, 0.0003789950440937656, 1e-15);
  closeTo(model.betaStandardError, 0.025108236685921912, 1e-14);
  closeTo(model.residualVolatilityAnnualized, 0.027469457305208576, 1e-14);
  closeTo(model.durbinWatson, 2.9352747089677846, 1e-13);
  closeTo(model.betaConfidenceInterval95[0], model.beta - 1.96 * model.betaStandardError, 1e-15);
  closeTo(model.betaConfidenceInterval95[1], model.beta + 1.96 * model.betaStandardError, 1e-15);
});

test('The headline estimate enforces the 126-return boundary and measures coverage within overlap', () => {
  const marketReturns = marketSequence(150);
  const assetReturns = marketReturns.map((value) => 0.0002 + 1.2 * value);
  const dates = tradingDates(150);
  const marketPrices = pricesFromLogReturns(marketReturns, dates);
  const fullAssetPrices = pricesFromLogReturns(assetReturns, dates);
  const recentAssetPrices = fullAssetPrices.slice(-127);
  const result = estimateRegressionDiagnostics({
    assetPrices: recentAssetPrices,
    marketPrices,
    sectorPrices: marketPrices,
    minimumObservations: 126,
  });
  assert.equal(result.sample.observations, 126);
  assert.equal(result.sample.eligibleBenchmarkIntervals, 126);
  assert.equal(result.sample.overlapCoverage, 1);
  closeTo(result.marketModel.beta, 1.2, 1e-11);

  assert.throws(
    () => estimateRegressionDiagnostics({
      assetPrices: recentAssetPrices.slice(1),
      marketPrices,
      sectorPrices: marketPrices,
      minimumObservations: 126,
    }),
    (error) => error instanceof EconometricsError
      && error.code === 'INSUFFICIENT_OVERLAP'
      && error.details.observations === 125
      && error.details.required === 126,
  );
});

test('Conditional estimates preserve separate counts and recover asymmetric beta', () => {
  const market = marketSequence(260);
  const asset = market.map((value) => (value > 0 ? 0.5 : 2) * value);
  const dates = tradingDates(market.length);
  const result = estimateRegressionDiagnostics({
    assetPrices: pricesFromLogReturns(asset, dates),
    marketPrices: pricesFromLogReturns(market, dates),
    sectorPrices: pricesFromLogReturns(market, dates),
    minimumObservations: 126,
    rollingWindow: 60,
  });
  assert.deepEqual(result.conditionalBeta.observations, { upside: 130, downside: 130, zero: 0 });
  closeTo(result.conditionalBeta.upside.beta, 0.5, 1e-11);
  closeTo(result.conditionalBeta.downside.beta, 2, 1e-11);
  closeTo(result.conditionalBeta.asymmetry, 1.5, 1e-11);
  assert.equal(result.conditionalBeta.upside.hacLag, 0);
  assert.match(result.conditionalBeta.inference, /HC1/);
});

test('Rolling beta captures a regime change and always includes the final window', () => {
  const market = marketSequence(260);
  const asset = market.map((value, index) => (index < 130 ? 0.5 : 2) * value);
  const dates = tradingDates(market.length);
  const result = estimateRegressionDiagnostics({
    assetPrices: pricesFromLogReturns(asset, dates),
    marketPrices: pricesFromLogReturns(market, dates),
    sectorPrices: pricesFromLogReturns(market, dates),
    minimumObservations: 126,
    rollingWindow: 60,
  });
  closeTo(result.rollingBeta.points[0].beta, 0.5, 1e-11);
  closeTo(result.rollingBeta.current, 2, 1e-11);
  assert.equal(result.rollingBeta.points.at(-1).date, dates.at(-1));
  assert.ok(result.rollingBeta.maximum > result.rollingBeta.minimum);
  assert.ok(result.rollingBeta.firstQuartile <= result.rollingBeta.median);
  assert.ok(result.rollingBeta.thirdQuartile >= result.rollingBeta.median);
  assert.ok(result.rollingBeta.currentPercentile > 50);
});

test('Rolling beta uses a neutral midrank percentile when every estimate is tied', () => {
  const market = marketSequence(260);
  const dates = tradingDates(market.length);
  const result = estimateRegressionDiagnostics({
    assetPrices: pricesFromLogReturns(market.map((value) => 1.25 * value), dates),
    marketPrices: pricesFromLogReturns(market, dates),
    sectorPrices: pricesFromLogReturns(market, dates),
    minimumObservations: 126,
    rollingWindow: 60,
  });
  closeTo(result.rollingBeta.currentPercentile, 50, 1e-10);
});

test('Term structure, influence sensitivity, and residual tails reuse the aligned sample', () => {
  const market = marketSequence(520);
  const asset = market.map((value, index) => (
    0.0001 + (index < 260 ? 0.8 : 1.35) * value + (index === 500 ? 0.045 : Math.sin(index * 0.77) * 0.0004)
  ));
  const dates = tradingDates(market.length, '2023-01-03');
  const result = estimateRegressionDiagnostics({
    assetPrices: pricesFromLogReturns(asset, dates),
    marketPrices: pricesFromLogReturns(market, dates),
    sectorPrices: pricesFromLogReturns(market, dates),
    requestedStart: dates[0],
    horizonStarts: {
      '1y': dates[260],
      '3y': dates[0],
      '5y': '2020-01-01',
    },
  });
  const oneYear = result.betaTermStructure.find((point) => point.window === '1y');
  const threeYear = result.betaTermStructure.find((point) => point.window === '3y');
  const fiveYear = result.betaTermStructure.find((point) => point.window === '5y');
  assert.equal(oneYear.available, true);
  assert.equal(threeYear.available, true);
  assert.equal(fiveYear.available, false);
  assert.equal(fiveYear.reason, 'history_not_loaded');
  assert.ok(oneYear.beta > threeYear.beta);
  assert.equal(result.influenceSensitivity.available, true);
  assert.equal(result.influenceSensitivity.excludedDates.length, 3);
  assert.ok(Number.isFinite(result.influenceSensitivity.betaDelta));
  assert.equal(result.residualTail.probability, 0.05);
  assert.ok(result.residualTail.expectedShortfall <= result.residualTail.lowerQuantile);
  assert.ok(result.residualTail.worst.abnormalReturn <= result.residualTail.best.abnormalReturn);
});

test('Term structure withholds long-horizon labels for a short issuer history', () => {
  const market = marketSequence(520);
  const dates = tradingDates(market.length, '2023-01-03');
  const recentDates = dates.slice(-150);
  const recentAsset = market.slice(-149).map((value) => 1.1 * value);
  const result = estimateRegressionDiagnostics({
    assetPrices: pricesFromLogReturns(recentAsset, recentDates),
    marketPrices: pricesFromLogReturns(market, dates),
    sectorPrices: pricesFromLogReturns(market, dates),
    minimumObservations: 126,
    horizonStarts: { '3y': dates[0] },
  });
  const threeYear = result.betaTermStructure[0];
  assert.equal(threeYear.available, false);
  assert.equal(threeYear.reason, 'insufficient_requested_horizon_coverage');
  assert.ok(threeYear.observations >= 126);
  assert.ok(threeYear.overlapCoverage < 0.8);
});

test('Sector residualization recovers independent and equivalent joint coefficients', () => {
  const market = marketSequence(180);
  const rawShock = Array.from({ length: market.length }, (_, index) => Math.sin(index * 0.71) * 0.006);
  const marketMean = market.reduce((sum, value) => sum + value, 0) / market.length;
  const shockMean = rawShock.reduce((sum, value) => sum + value, 0) / rawShock.length;
  const shockSlope = rawShock.reduce((sum, value, index) => (
    sum + (value - shockMean) * (market[index] - marketMean)
  ), 0) / market.reduce((sum, value) => sum + (value - marketMean) ** 2, 0);
  const shock = rawShock.map((value, index) => value - shockMean - shockSlope * (market[index] - marketMean));
  const rows = market.map((value, index) => ({
    market: value,
    sector: 0.8 * value + shock[index],
    asset: 0.0002 + 1.1 * value + 0.7 * shock[index],
    endDate: `session-${index}`,
  }));
  const model = fitIndependentSectorModel(rows, { minObservations: 126 });
  closeTo(model.marketBeta, 1.1, 1e-12);
  closeTo(model.independentSectorBeta, 0.7, 1e-12);
  closeTo(model.sectorMarketBeta, 0.8, 1e-12);
  closeTo(model.jointMarketBeta, 0.54, 1e-12);
  closeTo(model.jointInterceptDaily, 0.0002, 1e-12);
  closeTo(model.rSquared, 1, 1e-12);
  assert.equal(fitIndependentSectorModel(rows.map((row) => ({ ...row, sector: 0.8 * row.market + 0.001 })), { minObservations: 126 }), null);
});

test('Independent sector sensitivity is withheld when triple-series coverage is too sparse', () => {
  const returns = marketSequence(180);
  const dates = tradingDates(returns.length);
  const prices = pricesFromLogReturns(returns, dates);
  const sparseSector = prices.filter((_, index) => index % 5 !== 0);
  const result = estimateRegressionDiagnostics({
    assetPrices: prices,
    marketPrices: prices,
    sectorPrices: sparseSector,
    minimumObservations: 126,
  });
  assert.ok(result.sample.sectorOverlapCoverage < 0.8);
  assert.equal(result.independentSector, null);
});

test('Date-only filing events begin strictly after the filing date', () => {
  const count = 340;
  const dates = tradingDates(count, '2024-01-02');
  const market = marketSequence(count);
  const sector = market.map((value, index) => 0.6 * value + Math.cos(index * 0.43) * 0.004);
  const asset = market.map((value, index) => 0.0001 + 0.5 * value + 0.4 * sector[index]);
  const eventIndex = dates.findIndex((date, index) => index > 280 && new Date(`${date}T00:00:00Z`).getUTCDay() === 5);
  assert.ok(eventIndex > 280 && eventIndex < count);
  const filedDate = new Date(Date.parse(`${dates[eventIndex]}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  asset[eventIndex] += 0.02;
  const result = estimateFilingEvent({
    assetPrices: pricesFromLogReturns(asset, dates),
    marketPrices: pricesFromLogReturns(market, dates),
    sectorPrices: pricesFromLogReturns(sector, dates),
    filedDate,
  });
  assert.ok(result);
  assert.equal(result.eventDate, filedDate);
  assert.equal(result.acceptanceTimestamp, null);
  assert.equal(result.eventStart, dates[eventIndex]);
  assert.equal(result.eventIntervalEnd, dates[eventIndex + 1]);
  assert.equal(result.timingQuality, 'filing_date_next_session_proxy');
  assert.equal(result.windows['1'].through, dates[eventIndex + 1]);
  closeTo(result.windows['1'].cumulativeAbnormalReturn, Math.exp(0.02) - 1, 1e-11);
  assert.equal(result.path.length, 20);
  assert.equal(result.path[0].session, 1);
  assert.equal(result.path[19].session, 20);
  closeTo(result.path[0].cumulativeAbnormalReturn, result.windows['1'].cumulativeAbnormalReturn, 1e-14);
  closeTo(result.path[19].cumulativeAbnormalReturn, result.windows['20'].cumulativeAbnormalReturn, 1e-14);
  assert.equal(result.estimation.observations, 252);
  assert.equal(result.estimation.gapSessions, 20);
  assert.match(result.estimation.inference, /HAC/);
  assert.ok(Number.isSafeInteger(result.estimation.hacLag));
  assert.equal(estimateFilingEvent({ assetPrices: [], marketPrices: [], sectorPrices: [], filedDate: '2026-02-30' }), null);
});

test('Timestamped filing events separate pre-open, intraday, and post-close acceptance', () => {
  const count = 340;
  const dates = tradingDates(count, '2024-01-02');
  const market = marketSequence(count);
  const sector = market.map((value, index) => 0.7 * value + Math.sin(index * 0.31) * 0.003);
  const asset = market.map((value, index) => 0.0001 + 0.8 * value + 0.3 * sector[index]);
  const marketDate = dates[300];
  const inputs = {
    assetPrices: pricesFromLogReturns(asset, dates),
    marketPrices: pricesFromLogReturns(market, dates),
    sectorPrices: pricesFromLogReturns(sector, dates),
    filedDate: marketDate,
  };
  const preOpen = estimateFilingEvent({ ...inputs, acceptedAt: `${marketDate}T12:00:00.000Z` });
  const intraday = estimateFilingEvent({ ...inputs, acceptedAt: `${marketDate}T15:00:00.000Z` });
  const postClose = estimateFilingEvent({ ...inputs, acceptedAt: `${marketDate}T21:30:00.000Z` });
  const dateOnly = estimateFilingEvent(inputs);
  assert.equal(preOpen.timingQuality, 'acceptance_timestamp_before_market_open');
  assert.equal(preOpen.eventIntervalEnd, marketDate);
  assert.equal(intraday.timingQuality, 'acceptance_timestamp_during_or_after_session');
  assert.equal(intraday.eventIntervalEnd, dates[301]);
  assert.equal(postClose.timingQuality, 'acceptance_timestamp_during_or_after_session');
  assert.equal(postClose.eventIntervalEnd, dates[301]);
  assert.equal(dateOnly.timingQuality, 'filing_date_next_session_proxy');
  assert.equal(dateOnly.eventIntervalEnd, dates[301]);

  const missingEventPrice = estimateFilingEvent({
    ...inputs,
    assetPrices: inputs.assetPrices.filter((row) => row.date !== marketDate),
    acceptedAt: `${marketDate}T12:00:00.000Z`,
  });
  assert.equal(missingEventPrice.eventIntervalEnd, marketDate);
  assert.equal(missingEventPrice.windows['1'], null);
  assert.equal(missingEventPrice.windows['5'], null);
});

test('Failures and stripped public results are JSON-safe and never leak model internals', () => {
  assert.throws(
    () => fitMarketModel(Array.from({ length: 126 }, (_, index) => ({ market: 0, asset: index / 1000 })), { minObservations: 126 }),
    (error) => error instanceof EconometricsError && error.code === 'DEGENERATE_BENCHMARK',
  );
  const stripped = stripModelInternals({
    beta: 1.2,
    missing: Number.NaN,
    upper: Number.POSITIVE_INFINITY,
    lower: Number.NEGATIVE_INFINITY,
    zero: 0,
    residuals: [1, 2],
    nested: { fitted: [3], values: [1, Number.NaN, Number.POSITIVE_INFINITY] },
  });
  assert.deepEqual(stripped, {
    beta: 1.2,
    missing: null,
    upper: null,
    lower: null,
    zero: 0,
    nested: { values: [1, null, null] },
  });
  assert.doesNotThrow(() => JSON.stringify(stripped));

  const model = fitMarketModel([
    { market: -0.01, asset: -0.012 },
    { market: 0.01, asset: 0.014 },
    { market: 0.02, asset: 0.025 },
  ], { hacLag: Number.NaN });
  assert.ok(Number.isSafeInteger(model.hacLag));
  assert.doesNotThrow(() => JSON.stringify(stripModelInternals(model)));
});
