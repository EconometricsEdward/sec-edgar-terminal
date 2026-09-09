const TRADING_DAYS = 252;
const EPSILON = 1e-14;
const EASTERN_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export class EconometricsError extends Error {
  constructor(message, { code = 'MODEL_UNAVAILABLE', status = 422, details = null } = {}) {
    super(message);
    this.name = 'EconometricsError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const sampleVariance = (values, center = mean(values)) => values.length > 1
  ? values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1)
  : null;

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function multiply2(a, b) {
  return [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1]],
  ];
}

function normalizeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? value
    : null;
}

function easternAcceptance(value) {
  if (typeof value !== 'string' || !value.includes('T') || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parts = Object.fromEntries(EASTERN_CLOCK.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (![hour, minute, second].every(Number.isFinite)) return null;
  return {
    timestamp: new Date(timestamp).toISOString(),
    marketDate: `${parts.year}-${parts.month}-${parts.day}`,
    secondsAfterMidnight: hour * 3600 + minute * 60 + second,
  };
}

export function normalizePricePoints(rows) {
  const byDate = new Map();
  let excluded = 0;
  let duplicates = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = normalizeDate(row?.date);
    const value = finite(row?.adjustedClose) ? row.adjustedClose : finite(row?.close) ? row.close : null;
    if (!date || !finite(value) || value <= 0) {
      excluded += 1;
      continue;
    }
    if (byDate.has(date)) {
      duplicates += 1;
      if (Math.abs(byDate.get(date) - value) > Math.max(EPSILON, Math.abs(value) * 1e-12)) {
        throw new EconometricsError(`Conflicting prices were supplied for ${date}.`, {
          code: 'CONFLICTING_PRICE_OBSERVATION',
        });
      }
      continue;
    }
    byDate.set(date, value);
  }
  const points = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
  return { points, excluded, duplicates };
}

export function priceLogReturns(rows) {
  const normalized = normalizePricePoints(rows);
  const returns = [];
  for (let index = 1; index < normalized.points.length; index += 1) {
    const previous = normalized.points[index - 1];
    const current = normalized.points[index];
    const value = Math.log(current.value / previous.value);
    if (!finite(value)) continue;
    returns.push({
      key: `${previous.date}/${current.date}`,
      startDate: previous.date,
      endDate: current.date,
      value,
    });
  }
  return { ...normalized, returns };
}

export function alignReturnSeries(series) {
  const names = Object.keys(series || {});
  if (!names.length) return [];
  const rowsByName = Object.fromEntries(names.map((name) => [name, Array.isArray(series[name]) ? series[name] : []]));
  const maps = Object.fromEntries(names.map((name) => [name, new Map(rowsByName[name].map((row) => [row.key, row]))]));
  return rowsByName[names[0]].flatMap((row) => {
    const matches = Object.fromEntries(names.map((name) => [name, maps[name].get(row.key)]));
    if (names.some((name) => !matches[name])) return [];
    return [{
      key: row.key,
      startDate: row.startDate,
      endDate: row.endDate,
      ...Object.fromEntries(names.map((name) => [name, matches[name].value])),
    }];
  });
}

function neweyWestCovariance(x, residuals, lag) {
  const n = x.length;
  const sumX = x.reduce((sum, value) => sum + value, 0);
  const sumXX = x.reduce((sum, value) => sum + value * value, 0);
  const determinant = n * sumXX - sumX * sumX;
  if (Math.abs(determinant) < EPSILON) return null;
  const inverse = [[sumXX / determinant, -sumX / determinant], [-sumX / determinant, n / determinant]];
  const meat = [[0, 0], [0, 0]];
  const vector = (index) => [1, x[index]];
  for (let index = 0; index < n; index += 1) {
    const v = vector(index);
    const scale = residuals[index] ** 2;
    meat[0][0] += scale * v[0] * v[0];
    meat[0][1] += scale * v[0] * v[1];
    meat[1][0] += scale * v[1] * v[0];
    meat[1][1] += scale * v[1] * v[1];
  }
  for (let distance = 1; distance <= lag; distance += 1) {
    const weight = 1 - distance / (lag + 1);
    for (let index = distance; index < n; index += 1) {
      const current = vector(index);
      const prior = vector(index - distance);
      const scale = weight * residuals[index] * residuals[index - distance];
      for (let row = 0; row < 2; row += 1) {
        for (let column = 0; column < 2; column += 1) {
          meat[row][column] += scale * (current[row] * prior[column] + prior[row] * current[column]);
        }
      }
    }
  }
  const covariance = multiply2(multiply2(inverse, meat), inverse);
  const correction = n > 2 ? n / (n - 2) : 1;
  return covariance.map((row) => row.map((value) => value * correction));
}

export function fitMarketModel(observations, { minObservations = 2, hacLag = null } = {}) {
  const rows = (observations || []).filter((row) => finite(row?.asset) && finite(row?.market));
  const required = finite(minObservations) ? Math.max(2, Math.floor(minObservations)) : 2;
  if (rows.length < required) {
    throw new EconometricsError(`At least ${required} matched return observations are required.`, {
      code: 'INSUFFICIENT_OBSERVATIONS',
      details: { observations: rows.length, required },
    });
  }
  const x = rows.map((row) => row.market);
  const y = rows.map((row) => row.asset);
  const xMean = mean(x);
  const yMean = mean(y);
  const sxx = x.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  if (sxx < EPSILON) throw new EconometricsError('Benchmark returns have insufficient variance.', { code: 'DEGENERATE_BENCHMARK' });
  const syy = y.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
  const sxy = rows.reduce((sum, row) => sum + (row.market - xMean) * (row.asset - yMean), 0);
  const beta = sxy / sxx;
  const interceptDaily = yMean - beta * xMean;
  const residuals = rows.map((row) => row.asset - interceptDaily - beta * row.market);
  const sse = residuals.reduce((sum, value) => sum + value * value, 0);
  const rSquared = syy > EPSILON ? Math.max(0, Math.min(1, 1 - sse / syy)) : null;
  const automaticLag = Math.max(0, Math.floor(4 * (rows.length / 100) ** (2 / 9)));
  const lag = hacLag == null || !finite(hacLag)
    ? automaticLag
    : Math.max(0, Math.min(rows.length - 1, Math.floor(hacLag)));
  const covariance = neweyWestCovariance(x, residuals, lag);
  const interceptStandardError = covariance && covariance[0][0] >= 0 ? Math.sqrt(covariance[0][0]) : null;
  const betaStandardError = covariance && covariance[1][1] >= 0 ? Math.sqrt(covariance[1][1]) : null;
  const residualVariance = rows.length > 2 ? sse / (rows.length - 2) : null;
  const xVariance = sampleVariance(x, xMean);
  const yVariance = sampleVariance(y, yMean);
  const cooks = rows.map((row, index) => {
    if (!finite(residualVariance) || residualVariance <= EPSILON) return { date: row.endDate, distance: 0 };
    const leverage = 1 / rows.length + ((row.market - xMean) ** 2 / sxx);
    const distance = residuals[index] ** 2 / (2 * residualVariance) * leverage / Math.max(EPSILON, (1 - leverage) ** 2);
    return { date: row.endDate, distance };
  }).sort((a, b) => b.distance - a.distance).slice(0, 3);
  const durbinNumerator = residuals.slice(1).reduce((sum, value, index) => sum + (value - residuals[index]) ** 2, 0);
  return {
    observations: rows.length,
    interceptDaily,
    interceptAnnualized: interceptDaily * TRADING_DAYS,
    interceptStandardError,
    beta,
    betaStandardError,
    betaConfidenceInterval95: betaStandardError == null ? null : [beta - 1.96 * betaStandardError, beta + 1.96 * betaStandardError],
    betaTStatistic: betaStandardError && betaStandardError > 0 ? beta / betaStandardError : null,
    rSquared,
    adjustedRSquared: rSquared == null || rows.length <= 2 ? null : 1 - (1 - rSquared) * (rows.length - 1) / (rows.length - 2),
    correlation: xVariance && yVariance && xVariance > 0 && yVariance > 0
      ? Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)))
      : null,
    assetVolatilityAnnualized: yVariance == null ? null : Math.sqrt(yVariance * TRADING_DAYS),
    benchmarkVolatilityAnnualized: xVariance == null ? null : Math.sqrt(xVariance * TRADING_DAYS),
    residualVolatilityAnnualized: residualVariance == null ? null : Math.sqrt(residualVariance * TRADING_DAYS),
    hacLag: lag,
    durbinWatson: sse > EPSILON ? durbinNumerator / sse : null,
    influentialDates: cooks,
    residuals,
    fitted: rows.map((row) => interceptDaily + beta * row.market),
  };
}

export function fitIndependentSectorModel(observations, { minObservations = 126 } = {}) {
  const rows = (observations || []).filter((row) => finite(row?.asset) && finite(row?.market) && finite(row?.sector));
  const required = finite(minObservations) ? Math.max(2, Math.floor(minObservations)) : 126;
  if (rows.length < required) return null;
  const sectorMarket = fitMarketModel(rows.map((row) => ({ ...row, asset: row.sector })), { minObservations: required });
  const sectorResiduals = rows.map((row, index) => row.sector - sectorMarket.fitted[index]);
  const residualMean = mean(sectorResiduals);
  const residualVarianceSum = sectorResiduals.reduce((sum, value) => sum + (value - residualMean) ** 2, 0);
  if (residualVarianceSum < EPSILON) return null;
  const assetMarket = fitMarketModel(rows, { minObservations: required });
  const assetMean = mean(rows.map((row) => row.asset));
  const independentSectorBeta = rows.reduce((sum, row, index) => (
    sum + (row.asset - assetMean) * (sectorResiduals[index] - residualMean)
  ), 0) / residualVarianceSum;
  const interceptDaily = assetMean
    - assetMarket.beta * mean(rows.map((row) => row.market))
    - independentSectorBeta * residualMean;
  const fitted = rows.map((row, index) => interceptDaily + assetMarket.beta * row.market + independentSectorBeta * sectorResiduals[index]);
  const residuals = rows.map((row, index) => row.asset - fitted[index]);
  const assetCentered = rows.map((row) => row.asset - assetMean);
  const sse = residuals.reduce((sum, value) => sum + value * value, 0);
  const sst = assetCentered.reduce((sum, value) => sum + value * value, 0);
  return {
    observations: rows.length,
    interceptDaily,
    marketBeta: assetMarket.beta,
    independentSectorBeta,
    // Equivalent coefficients when the same fit is written against the raw
    // sector ETF return rather than its market-orthogonal residual.
    jointInterceptDaily: interceptDaily - independentSectorBeta * sectorMarket.interceptDaily,
    jointMarketBeta: assetMarket.beta - independentSectorBeta * sectorMarket.beta,
    sectorMarketBeta: sectorMarket.beta,
    sectorMarketInterceptDaily: sectorMarket.interceptDaily,
    rSquared: sst > EPSILON ? Math.max(0, Math.min(1, 1 - sse / sst)) : null,
    residualVolatilityAnnualized: rows.length > 3 ? Math.sqrt(sse / (rows.length - 3) * TRADING_DAYS) : null,
    residuals,
    fitted,
  };
}

function summarizeRolling(points) {
  if (!points.length) return {
    current: null,
    median: null,
    firstQuartile: null,
    thirdQuartile: null,
    interquartileRange: null,
    minimum: null,
    maximum: null,
    range: null,
    currentMinusMedian: null,
    currentPercentile: null,
  };
  const values = points.map((point) => point.beta).sort((a, b) => a - b);
  const current = points.at(-1).beta;
  const median = quantile(values, 0.5);
  const firstQuartile = quantile(values, 0.25);
  const thirdQuartile = quantile(values, 0.75);
  const tieTolerance = 1e-10 * Math.max(1, Math.abs(current));
  const belowCurrent = values.filter((value) => value < current - tieTolerance).length;
  const equalCurrent = values.filter((value) => Math.abs(value - current) <= tieTolerance).length;
  return {
    current,
    median,
    firstQuartile,
    thirdQuartile,
    interquartileRange: thirdQuartile - firstQuartile,
    minimum: values[0],
    maximum: values.at(-1),
    range: values.at(-1) - values[0],
    currentMinusMedian: current - median,
    // A midrank keeps a tied, stable series at the 50th percentile instead of
    // incorrectly presenting every tied observation as the historical maximum.
    currentPercentile: 100 * (belowCurrent + 0.5 * equalCurrent) / values.length,
  };
}

function summarizeHorizon(pairs, eligibleIntervals, required, window, requestedStart) {
  const coverage = eligibleIntervals.length ? pairs.length / eligibleIntervals.length : 0;
  if (pairs.length < required || coverage < 0.8) {
    return {
      window,
      requestedStart,
      available: false,
      reason: pairs.length < required ? 'insufficient_observations' : 'insufficient_requested_horizon_coverage',
      observations: pairs.length,
      overlapCoverage: coverage,
    };
  }
  const model = fitMarketModel(pairs, { minObservations: required });
  return {
    window,
    requestedStart,
    available: true,
    effectiveStart: pairs[0].startDate,
    effectiveEnd: pairs.at(-1).endDate,
    observations: pairs.length,
    overlapCoverage: coverage,
    beta: model.beta,
    betaConfidenceInterval95: model.betaConfidenceInterval95,
    rSquared: model.rSquared,
    residualVolatilityAnnualized: model.residualVolatilityAnnualized,
  };
}

function influenceSensitivity(pairs, marketModel, required) {
  const candidates = (marketModel.influentialDates || [])
    .filter((point) => point?.date && finite(point?.distance));
  const excludedDates = candidates.map((point) => point.date);
  const retained = pairs.filter((row) => !excludedDates.includes(row.endDate));
  if (!excludedDates.length || retained.length < required) {
    return {
      available: false,
      method: 'OLS excluding the three largest Cook-distance sessions',
      reason: excludedDates.length ? 'insufficient_observations_after_exclusion' : 'no_influential_dates',
      excludedDates: candidates,
    };
  }
  const refit = fitMarketModel(retained, { minObservations: required });
  return {
    available: true,
    method: 'OLS excluding the three largest Cook-distance sessions',
    observations: retained.length,
    excludedDates: candidates,
    beta: refit.beta,
    betaDelta: refit.beta - marketModel.beta,
    rSquared: refit.rSquared,
  };
}

function residualTailDiagnostics(pairs, marketModel) {
  const rows = (marketModel.residuals || []).flatMap((logResidual, index) => {
    const pair = pairs[index];
    return finite(logResidual) && pair?.endDate
      ? [{ date: pair.endDate, logResidual, abnormalReturn: Math.expm1(logResidual) }]
      : [];
  });
  if (!rows.length) return null;
  const values = rows.map((row) => row.abnormalReturn);
  const lowerQuantile = quantile(values, 0.05);
  const tail = rows.filter((row) => row.abnormalReturn <= lowerQuantile);
  const ordered = [...rows].sort((a, b) => a.abnormalReturn - b.abnormalReturn);
  return {
    probability: 0.05,
    lowerQuantile,
    expectedShortfall: mean(tail.map((row) => row.abnormalReturn)),
    tailObservations: tail.length,
    worst: ordered[0],
    best: ordered.at(-1),
    interpretation: 'Empirical market-model residual distribution; descriptive, not a portfolio loss forecast.',
  };
}

export function estimateRegressionDiagnostics({ assetPrices, marketPrices, sectorPrices, requestedStart, horizonStarts = null, minimumObservations = 126, rollingWindow = 126 }) {
  const required = finite(minimumObservations) ? Math.max(2, Math.floor(minimumObservations)) : 126;
  const rollingLength = finite(rollingWindow) ? Math.max(2, Math.floor(rollingWindow)) : 126;
  const asset = priceLogReturns(assetPrices);
  const market = priceLogReturns(marketPrices);
  const sector = priceLogReturns(sectorPrices);
  const allPairs = alignReturnSeries({ asset: asset.returns, market: market.returns });
  const pairs = allPairs
    .filter((row) => !requestedStart || row.startDate >= requestedStart);
  const assetStart = asset.points[0]?.date || null;
  const assetEnd = asset.points.at(-1)?.date || null;
  // Coverage is measured only where both price series could have supplied an
  // interval. This avoids classifying a recent listing as missing before its
  // first available price while still exposing the shorter effective sample.
  const eligibleMarket = market.returns.filter((row) => (
    (!requestedStart || row.startDate >= requestedStart)
    && (!assetStart || row.startDate >= assetStart)
    && (!assetEnd || row.endDate <= assetEnd)
  ));
  const coverage = eligibleMarket.length ? pairs.length / eligibleMarket.length : 0;
  if (pairs.length < required || coverage < 0.8) {
    throw new EconometricsError('The selected window does not have enough exactly aligned return observations.', {
      code: 'INSUFFICIENT_OVERLAP',
      details: { observations: pairs.length, required, coverage },
    });
  }
  const marketModel = fitMarketModel(pairs, { minObservations: required });
  const termStructure = Object.entries(horizonStarts || {}).map(([window, start]) => {
    const marketHistoryStart = market.points[0]?.date || null;
    if (start && marketHistoryStart && Date.parse(marketHistoryStart) - Date.parse(start) > 7 * 86_400_000) {
      return {
        window,
        requestedStart: start,
        available: false,
        reason: 'history_not_loaded',
        observations: 0,
        overlapCoverage: 0,
      };
    }
    const horizonPairs = allPairs.filter((row) => !start || row.startDate >= start);
    const eligibleIntervals = market.returns.filter((row) => (
      (!start || row.startDate >= start)
      && (!assetEnd || row.endDate <= assetEnd)
    ));
    return summarizeHorizon(horizonPairs, eligibleIntervals, required, window, start);
  });
  const upsideRows = pairs.filter((row) => row.market > 0);
  const downsideRows = pairs.filter((row) => row.market < 0);
  const conditional = {
    // Sign-filtered observations are not consecutive in calendar time. Lag-0
    // HAC is therefore used as an HC1 heteroskedasticity correction rather
    // than pretending adjacent subset rows are adjacent trading sessions.
    upside: upsideRows.length >= 30 ? fitMarketModel(upsideRows, { minObservations: 30, hacLag: 0 }) : null,
    downside: downsideRows.length >= 30 ? fitMarketModel(downsideRows, { minObservations: 30, hacLag: 0 }) : null,
    observations: {
      upside: upsideRows.length,
      downside: downsideRows.length,
      zero: pairs.length - upsideRows.length - downsideRows.length,
    },
  };
  conditional.inference = 'HC1 (Newey-West lag 0) on nonconsecutive sign subsamples';
  conditional.asymmetry = conditional.upside && conditional.downside
    ? conditional.downside.beta - conditional.upside.beta
    : null;

  const triples = alignReturnSeries({ asset: asset.returns, market: market.returns, sector: sector.returns })
    .filter((row) => !requestedStart || row.startDate >= requestedStart);
  const sectorStart = sector.points[0]?.date || null;
  const sectorEnd = sector.points.at(-1)?.date || null;
  const eligibleSectorMarket = market.returns.filter((row) => (
    (!requestedStart || row.startDate >= requestedStart)
    && (!assetStart || row.startDate >= assetStart)
    && (!assetEnd || row.endDate <= assetEnd)
    && (!sectorStart || row.startDate >= sectorStart)
    && (!sectorEnd || row.endDate <= sectorEnd)
  ));
  const sectorCoverage = eligibleSectorMarket.length ? triples.length / eligibleSectorMarket.length : 0;
  const independentSector = triples.length >= required && sectorCoverage >= 0.8
    ? fitIndependentSectorModel(triples, { minObservations: required })
    : null;
  const rolling = [];
  if (pairs.length >= rollingLength) {
    for (let end = rollingLength; end <= pairs.length; end += 5) {
      const window = pairs.slice(end - rollingLength, end);
      const model = fitMarketModel(window, { minObservations: rollingLength });
      rolling.push({ date: window.at(-1).endDate, beta: model.beta });
    }
    if (rolling.at(-1)?.date !== pairs.at(-1).endDate) {
      const window = pairs.slice(-rollingLength);
      rolling.push({ date: window.at(-1).endDate, beta: fitMarketModel(window, { minObservations: rollingLength }).beta });
    }
  }
  return {
    sample: {
      requestedStart,
      effectiveStart: pairs[0].startDate,
      effectiveEnd: pairs.at(-1).endDate,
      observations: pairs.length,
      eligibleBenchmarkIntervals: eligibleMarket.length,
      overlapCoverage: coverage,
      eligibleSectorBenchmarkIntervals: eligibleSectorMarket.length,
      sectorOverlapCoverage: sectorCoverage,
      excluded: {
        assetPrices: asset.excluded,
        marketPrices: market.excluded,
        sectorPrices: sector.excluded,
        unmatchedBenchmarkIntervals: Math.max(0, eligibleMarket.length - pairs.length),
        unmatchedSectorBenchmarkIntervals: Math.max(0, eligibleSectorMarket.length - triples.length),
      },
    },
    marketModel,
    betaTermStructure: termStructure,
    influenceSensitivity: influenceSensitivity(pairs, marketModel, required),
    residualTail: residualTailDiagnostics(pairs, marketModel),
    conditionalBeta: conditional,
    independentSector,
    rollingBeta: { window: rollingLength, points: rolling, ...summarizeRolling(rolling) },
    aligned: { pairs, triples },
  };
}

export function estimateFilingEvent({ assetPrices, marketPrices, sectorPrices, filedDate, acceptedAt = null }) {
  if (!normalizeDate(filedDate)) return null;
  const returns = {
    asset: priceLogReturns(assetPrices).returns,
    market: priceLogReturns(marketPrices).returns,
    sector: priceLogReturns(sectorPrices).returns,
  };
  const aligned = alignReturnSeries(returns);
  const alignedByKey = new Map(aligned.map((row) => [row.key, row]));
  const acceptance = easternAcceptance(acceptedAt);
  const sameDayClose = acceptance
    ? returns.market.some((row) => row.endDate === acceptance.marketDate)
    : false;
  const beforeMarketOpen = Boolean(acceptance && acceptance.secondsAfterMidnight < (9 * 3600 + 30 * 60));
  // Only a pre-open acceptance may use that session's close-to-close return.
  // Intraday filings begin on the following benchmark session so nearly a
  // full day of pre-filing movement cannot be mislabeled as an event response.
  const benchmarkEventIndex = acceptance
    ? returns.market.findIndex((row) => (
      sameDayClose && beforeMarketOpen
        ? row.endDate >= acceptance.marketDate
        : row.endDate > acceptance.marketDate
    ))
    : returns.market.findIndex((row) => row.endDate > filedDate);
  if (benchmarkEventIndex < 0) return null;
  const timingQuality = !acceptance
    ? 'filing_date_next_session_proxy'
    : !sameDayClose
      ? 'acceptance_timestamp_nontrading_date'
      : beforeMarketOpen
        ? 'acceptance_timestamp_before_market_open'
        : 'acceptance_timestamp_during_or_after_session';
  const estimationCutoff = returns.market[benchmarkEventIndex - 21]?.endDate || null;
  if (!estimationCutoff) return null;
  const estimation = aligned.filter((row) => row.endDate <= estimationCutoff).slice(-252);
  if (estimation.length < 180) return null;
  const model = fitIndependentSectorModel(estimation, { minObservations: 180 });
  if (!model) return null;
  const expectedPost = returns.market.slice(benchmarkEventIndex, benchmarkEventIndex + 20);
  const estimationResiduals = model.residuals || [];
  const residualMean = estimationResiduals.length ? mean(estimationResiduals) : 0;
  const centeredResiduals = estimationResiduals.map((value) => value - residualMean);
  const hacLag = Math.max(0, Math.floor(4 * (estimationResiduals.length / 100) ** (2 / 9)));
  const autocovariances = Array.from({ length: hacLag + 1 }, (_, lag) => (
    centeredResiduals.slice(lag).reduce((sum, value, index) => (
      sum + value * centeredResiduals[index]
    ), 0) / Math.max(1, centeredResiduals.length)
  ));
  const cumulativeVariance = (horizon) => {
    if (!finite(autocovariances[0]) || autocovariances[0] <= EPSILON) return null;
    let variance = horizon * autocovariances[0];
    for (let lag = 1; lag <= Math.min(hacLag, horizon - 1); lag += 1) {
      const weight = 1 - lag / (hacLag + 1);
      variance += 2 * (horizon - lag) * weight * autocovariances[lag];
    }
    return finite(variance) && variance > EPSILON ? variance : null;
  };
  const path = [];
  let cumulativeLogResidual = 0;
  for (let index = 0; index < expectedPost.length; index += 1) {
    const row = alignedByKey.get(expectedPost[index].key);
    if (!row) break;
    const sectorResidual = row.sector - model.sectorMarketInterceptDaily - model.sectorMarketBeta * row.market;
    const fitted = model.interceptDaily + model.marketBeta * row.market + model.independentSectorBeta * sectorResidual;
    const logResidual = row.asset - fitted;
    cumulativeLogResidual += logResidual;
    const variance = cumulativeVariance(index + 1);
    path.push({
      session: index + 1,
      date: row.endDate,
      dailyAbnormalReturn: Math.expm1(logResidual),
      cumulativeAbnormalReturn: Math.expm1(cumulativeLogResidual),
      standardizedResponse: variance ? cumulativeLogResidual / Math.sqrt(variance) : null,
    });
  }
  const windows = {};
  for (const horizon of [1, 5, 20]) {
    const point = path[horizon - 1];
    if (expectedPost.length < horizon || !point || path.length < horizon) {
      windows[String(horizon)] = null;
      continue;
    }
    windows[String(horizon)] = {
      sessions: horizon,
      through: point.date,
      cumulativeAbnormalReturn: point.cumulativeAbnormalReturn,
      standardizedResponse: point.standardizedResponse,
    };
  }
  return {
    eventDate: filedDate,
    acceptanceTimestamp: acceptance?.timestamp || null,
    eventStart: expectedPost[0]?.startDate || null,
    eventIntervalEnd: expectedPost[0]?.endDate || null,
    timingQuality,
    estimation: {
      start: estimation[0].startDate,
      end: estimation.at(-1).endDate,
      observations: estimation.length,
      gapSessions: 20,
      inference: 'Bartlett-weighted HAC cumulative residual variance',
      hacLag,
    },
    windows,
    path,
  };
}

export function stripModelInternals(value) {
  if (Array.isArray(value)) return value.map(stripModelInternals);
  if (!value || typeof value !== 'object') return finite(value) || value == null || typeof value !== 'number' ? value : null;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
    ['residuals', 'fitted', 'aligned'].includes(key) ? [] : [[key, stripModelInternals(item)]]
  )));
}
