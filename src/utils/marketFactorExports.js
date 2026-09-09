const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function safeSegment(value, fallback = 'unknown') {
  const clean = String(value || fallback).trim().replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || fallback;
}

function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  // Treat external filing/company text as untrusted spreadsheet input. Excel
  // and similar tools may ignore leading whitespace/control characters before
  // interpreting a formula token, so inspect the first non-padding character.
  if (/^[\u0000-\u0020\uFEFF]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function factorFileStem(data) {
  const request = data?.request || {};
  return [
    safeSegment(data?.issuer?.ticker || request.ticker, 'company').toUpperCase(),
    'factor-lab',
    safeSegment(request.window, 'window'),
    safeSegment(request.basis, 'basis'),
    safeSegment(request.sector_proxy, 'sector').toUpperCase(),
    safeSegment(data?.data_through || data?.generated_at?.slice?.(0, 10), 'undated'),
  ].join('-');
}

export function compactFactorContext(data) {
  const estimates = data?.estimates || {};
  const eventWindows = data?.filing_event?.windows || {};
  const missing = [];
  for (const [path, value] of [
    ['estimates.market_model', estimates.market_model],
    ['estimates.independent_sector_sensitivity', estimates.independent_sector_sensitivity],
    ['edgar_snapshot.filing_change_z', data?.edgar_snapshot?.filing_change_z],
    ['filing_event.windows.20', eventWindows['20']],
    ['evidence_gap.evidence_gap', data?.evidence_gap?.evidence_gap],
  ]) if (value == null) missing.push(path);
  return {
    format_version: 'edgar.factor-context.v1',
    task_boundary: 'Use as dated descriptive research evidence. Preserve nulls, uncertainty, source clocks, and claim limits.',
    identity: {
      issuer: data?.issuer || null,
      request: data?.request || null,
      api_schema_version: data?.schema_version || null,
      methodology_version: data?.methodology_version || null,
      universe_version: data?.universe_version || null,
      status: data?.status || null,
      cache_status: data?.cache_status || null,
      snapshot_id: data?.snapshot_id || null,
      fingerprints: data?.fingerprints || null,
    },
    clocks: {
      generated_at: data?.generated_at || null,
      data_through: data?.data_through || null,
      sec_snapshot_generated_at: data?.provenance?.sec?.snapshot_generated_at || null,
      current_filing_accepted_at: data?.provenance?.sec?.current_filing?.accepted_at || null,
    },
    headline: {
      interpretation: data?.interpretation || null,
      market_model: estimates.market_model || null,
      conditional_beta: estimates.conditional_beta || null,
      independent_sector_sensitivity: estimates.independent_sector_sensitivity || null,
      beta_term_structure: estimates.beta_term_structure || [],
      influence_sensitivity: estimates.influence_sensitivity || null,
      residual_tail: estimates.residual_tail || null,
    },
    filing_market_evidence: {
      filing_change_z: data?.edgar_snapshot?.filing_change_z ?? null,
      drivers: data?.edgar_snapshot?.driver_summary || null,
      event_windows: eventWindows,
      evidence_gap: data?.evidence_gap || null,
    },
    measurement: data?.measurement || null,
    provenance: {
      sec: {
        source: data?.provenance?.sec?.source || null,
        reporting_basis: data?.provenance?.sec?.reporting_basis || null,
        point_in_time: data?.provenance?.sec?.point_in_time ?? null,
        current_filing: data?.provenance?.sec?.current_filing || null,
        prior_filing: data?.provenance?.sec?.prior_filing || null,
      },
      prices: Object.fromEntries(Object.entries(data?.provenance?.prices || {}).map(([role, series]) => [role, series ? {
        ticker: series.ticker ?? null,
        provider: series.provider ?? null,
        price_basis: series.price_basis ?? null,
        adjustment_coverage: series.adjustment_coverage ?? null,
        retrieved_at: series.retrieved_at ?? null,
        first_observation: series.first_observation ?? null,
        last_observation: series.last_observation ?? null,
        observations: series.observations ?? null,
      } : null])),
    },
    research_readout: data?.research_readout || null,
    quality: data?.quality || null,
    missing_fields: missing,
    warnings: data?.warnings || [],
    sources: {
      current_filing: data?.provenance?.sec?.current_filing?.source || null,
      prior_filing: data?.provenance?.sec?.prior_filing?.source || null,
      company_facts: data?.links?.sec_companyfacts || null,
      methodology: data?.links?.methodology || null,
      canonical_api_record: data?.links?.api || null,
      schema: data?.links?.schema || null,
    },
    allowed_claims: [
      'Describe dated regression estimates, intervals, samples, and sensitivity diagnostics.',
      'Describe peer-normalized filing changes and model-adjusted event responses as separate observations.',
      'Identify missing data, warnings, influential dates, and follow-up diligence questions.',
    ],
    prohibited_claims: [
      'Do not infer expected return, mispricing, valuation, causality, or an investment recommendation.',
      'Do not call the current filing snapshot a historical factor return or beta_EDGAR.',
      'Do not treat overlapping rolling windows as independent statistical tests.',
    ],
    limitations: data?.limitations || [],
    citation: data?.cite_as || null,
  };
}

export function factorContextText(data) {
  return [
    'EDGAR Terminal compact model context',
    'Treat null as unavailable. Preserve source clocks and do not turn descriptive diagnostics into a forecast or recommendation.',
    '',
    JSON.stringify(compactFactorContext(data), null, 2),
  ].join('\n');
}

export function factorTidyCsv(data) {
  const request = data?.request || {};
  const base = [
    data?.issuer?.ticker || request.ticker || '',
    request.window || '',
    request.basis || '',
    request.cohort || '',
    request.sector_proxy || '',
    data?.data_through || '',
    data?.methodology_version || '',
    data?.schema_version || '',
    data?.universe_version || '',
    data?.status || '',
    data?.cache_status || '',
    data?.generated_at || '',
    data?.snapshot_id || '',
    data?.fingerprints?.input_sha256 || '',
    data?.fingerprints?.result_sha256 || '',
  ];
  const rows = [[
    'ticker', 'window', 'basis', 'cohort', 'sector_proxy', 'data_through', 'methodology_version', 'schema_version',
    'universe_version', 'status', 'cache_status', 'generated_at', 'snapshot_id', 'input_sha256', 'result_sha256',
    'record_type', 'key', 'date_or_horizon', 'value', 'unit', 'detail',
  ]];
  const add = (recordType, key, dateOrHorizon, value, unit, detail = '') => {
    rows.push([...base, recordType, key, dateOrHorizon, finite(value) ? value : value ?? '', unit, detail]);
  };
  const market = data?.estimates?.market_model || {};
  for (const [key, value, unit] of [
    ['beta', market.beta, 'unitless'],
    ['beta_ci95_low', market.beta_confidence_interval95?.[0], 'unitless'],
    ['beta_ci95_high', market.beta_confidence_interval95?.[1], 'unitless'],
    ['r_squared', market.r_squared, 'decimal'],
    ['residual_volatility_annualized', market.residual_volatility_annualized, 'decimal'],
  ]) add('regression_summary', key, request.window || '', value, unit);
  const conditional = data?.estimates?.conditional_beta || {};
  add('conditional_beta', 'upside_beta', request.window || '', conditional.upside?.beta, 'unitless', `${conditional.observations?.upside ?? ''} observations`);
  add('conditional_beta', 'downside_beta', request.window || '', conditional.downside?.beta, 'unitless', `${conditional.observations?.downside ?? ''} observations`);
  add('conditional_beta', 'downside_minus_upside', request.window || '', conditional.asymmetry, 'unitless', conditional.inference || '');
  const sector = data?.estimates?.independent_sector_sensitivity || {};
  for (const [key, value, unit] of [
    ['independent_sector_beta', sector.independent_sector_beta, 'unitless'],
    ['market_beta', sector.market_beta, 'unitless'],
    ['joint_market_beta', sector.joint_market_beta, 'unitless'],
    ['r_squared', sector.r_squared, 'decimal'],
    ['residual_volatility_annualized', sector.residual_volatility_annualized, 'decimal'],
  ]) add('sector_model', key, request.sector_proxy || '', value, unit, `${sector.observations ?? ''} observations`);
  for (const horizon of data?.estimates?.beta_term_structure || []) {
    const horizonDetail = horizon.available === false
      ? horizon.reason || 'unavailable'
      : `${horizon.effective_start || ''} to ${horizon.effective_end || ''}`;
    add('beta_term_structure', 'available', horizon.window || '', horizon.available, 'boolean', horizonDetail);
    add('beta_term_structure', 'observations', horizon.window || '', horizon.observations, 'count', horizonDetail);
    add('beta_term_structure', 'overlap_coverage', horizon.window || '', horizon.overlap_coverage, 'decimal', horizonDetail);
    add('beta_term_structure', 'beta', horizon.window || '', horizon.beta, 'unitless', horizonDetail);
    add('beta_term_structure', 'beta_ci95_low', horizon.window || '', horizon.beta_confidence_interval95?.[0], 'unitless', horizonDetail);
    add('beta_term_structure', 'beta_ci95_high', horizon.window || '', horizon.beta_confidence_interval95?.[1], 'unitless', horizonDetail);
    add('beta_term_structure', 'r_squared', horizon.window || '', horizon.r_squared, 'decimal', horizonDetail);
    add('beta_term_structure', 'residual_volatility_annualized', horizon.window || '', horizon.residual_volatility_annualized, 'decimal', horizonDetail);
  }
  const influence = data?.estimates?.influence_sensitivity || {};
  add('influence_sensitivity', 'available', request.window || '', influence.available, 'boolean', influence.method || influence.reason || '');
  add('influence_sensitivity', 'refit_beta', request.window || '', influence.beta, 'unitless', influence.method || '');
  add('influence_sensitivity', 'beta_delta', request.window || '', influence.beta_delta, 'unitless', influence.method || '');
  for (const point of influence.excluded_dates || []) add('influence_date', 'cook_distance', point.date || '', point.distance, 'unitless');
  const tail = data?.estimates?.residual_tail || {};
  add('residual_tail', 'lower_quantile', tail.probability ?? '', tail.lower_quantile, 'decimal', tail.interpretation || '');
  add('residual_tail', 'mean_lower_tail_abnormal_return', tail.probability ?? '', tail.expected_shortfall, 'decimal', `${tail.tail_observations ?? ''} observations`);
  add('residual_tail', 'worst_abnormal_return', tail.worst?.date || '', tail.worst?.abnormal_return, 'decimal');
  add('residual_tail', 'best_abnormal_return', tail.best?.date || '', tail.best?.abnormal_return, 'decimal');
  for (const [horizon, point] of Object.entries(data?.filing_event?.windows || {})) {
    add('filing_event', 'cumulative_abnormal_return', horizon, point?.cumulative_abnormal_return, 'decimal', point?.through || '');
    add('filing_event', 'standardized_response', horizon, point?.standardized_response, 'unitless', point?.through || '');
  }
  for (const component of data?.edgar_snapshot?.components || []) {
    const key = component.key || component.label || '';
    const detail = component.reason || `${component.peer_count ?? ''} peers; ${component.peer_distribution?.scale_method || ''}`;
    for (const [metric, value, unit] of [
      ['current', component.current, 'percent'], ['prior', component.prior, 'percent'], ['change', component.change, 'percentage_points'],
      ['peer_median', component.peer_distribution?.median, 'percentage_points'], ['peer_scale', component.peer_distribution?.scale, 'percentage_points'],
      ['peer_percentile', component.peer_percentile, 'percentile'], ['peer_count', component.peer_count, 'count'],
      ['weight', component.weight, 'decimal'], ['raw_z', component.raw_z, 'unitless'], ['z', component.z, 'unitless'],
      ['weighted_z', component.weighted_z, 'unitless'],
    ]) add('filing_component', `${key}.${metric}`, 'latest_vs_prior', value, unit, detail);
  }
  for (const point of data?.estimates?.rolling_beta?.points || []) add('rolling_beta', 'beta', point.date || '', point.beta, 'unitless');
  for (const gate of data?.quality?.gates || []) add('quality_gate', gate.id || '', '', gate.status || '', 'status', `${gate.value || ''}; ${gate.requirement || ''}`);
  for (const [role, series] of Object.entries(data?.provenance?.prices || {})) {
    add('price_provenance', `${role}.observations`, series?.last_observation || '', series?.observations, 'count', `${series?.ticker || ''}; ${series?.provider || ''}; ${series?.price_basis || ''}; coverage ${series?.adjustment_coverage ?? ''}; retrieved ${series?.retrieved_at || ''}`);
  }
  for (const [role, filing] of [['current', data?.provenance?.sec?.current_filing], ['prior', data?.provenance?.sec?.prior_filing]]) {
    add('sec_provenance', `${role}_filing`, filing?.filed || '', filing?.accession || '', 'accession', `${filing?.form || ''}; period ${filing?.end || ''}; accepted ${filing?.accepted_at || ''}; ${filing?.source || ''}`);
  }
  for (const warning of data?.warnings || []) add('warning', warning.code || '', '', warning.severity || '', 'severity', warning.message || '');
  return `${csv(rows)}\r\n`;
}

export function factorComparisonSnapshot(data) {
  return {
    snapshot_id: data?.snapshot_id || '',
    ticker: data?.issuer?.ticker || data?.request?.ticker || '',
    name: data?.issuer?.name || '',
    request: data?.request || {},
    data_through: data?.data_through || null,
    methodology_version: data?.methodology_version || null,
    quality: data?.quality?.grade || null,
    beta: data?.estimates?.market_model?.beta ?? null,
    beta_ci95: data?.estimates?.market_model?.beta_confidence_interval95 || null,
    downside_beta: data?.estimates?.conditional_beta?.downside?.beta ?? null,
    upside_beta: data?.estimates?.conditional_beta?.upside?.beta ?? null,
    sector_sensitivity: data?.estimates?.independent_sector_sensitivity?.independent_sector_beta ?? null,
    evidence_gap: data?.evidence_gap?.evidence_gap ?? null,
    api: data?.links?.api || null,
  };
}

export function parseFactorComparisons(raw) {
  if (typeof raw !== 'string' || raw.length > 100_000) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      if (typeof item.snapshot_id !== 'string' || !item.snapshot_id || item.snapshot_id.length > 160) return [];
      if (typeof item.ticker !== 'string' || !/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(item.ticker)) return [];
      const request = item.request;
      if (!request || typeof request !== 'object' || !['1y', '3y', '5y'].includes(request.window) || !['ttm', 'annual'].includes(request.basis)) return [];
      const numberOrNull = (value) => finite(value) ? value : null;
      const interval = Array.isArray(item.beta_ci95) && item.beta_ci95.length === 2 && item.beta_ci95.every(finite)
        ? [item.beta_ci95[0], item.beta_ci95[1]]
        : null;
      return [{
        snapshot_id: item.snapshot_id,
        ticker: item.ticker,
        name: typeof item.name === 'string' ? item.name.slice(0, 160) : '',
        request: {
          window: request.window,
          basis: request.basis,
          cohort: typeof request.cohort === 'string' ? request.cohort.slice(0, 80) : '',
          sector_proxy: typeof request.sector_proxy === 'string' ? request.sector_proxy.slice(0, 10) : '',
        },
        data_through: typeof item.data_through === 'string' ? item.data_through.slice(0, 10) : null,
        methodology_version: typeof item.methodology_version === 'string' ? item.methodology_version.slice(0, 80) : null,
        quality: typeof item.quality === 'string' ? item.quality.slice(0, 4) : null,
        beta: numberOrNull(item.beta),
        beta_ci95: interval,
        downside_beta: numberOrNull(item.downside_beta),
        upside_beta: numberOrNull(item.upside_beta),
        sector_sensitivity: numberOrNull(item.sector_sensitivity),
        evidence_gap: numberOrNull(item.evidence_gap),
        api: typeof item.api === 'string' && item.api.startsWith('https://secedgarterminal.com/api/v1/market-signals?') ? item.api : null,
      }];
    }).slice(0, 4);
  } catch {
    return [];
  }
}

export function factorComparisonCsv(snapshots) {
  const rows = [[
    'ticker', 'name', 'window', 'basis', 'cohort', 'sector_proxy', 'data_through', 'methodology_version',
    'quality', 'market_beta', 'beta_ci95_low', 'beta_ci95_high', 'downside_beta', 'upside_beta',
    'independent_sector_sensitivity', 'evidence_gap', 'snapshot_id', 'api',
  ]];
  for (const item of snapshots || []) rows.push([
    item.ticker, item.name, item.request?.window, item.request?.basis, item.request?.cohort, item.request?.sector_proxy,
    item.data_through, item.methodology_version, item.quality, item.beta, item.beta_ci95?.[0], item.beta_ci95?.[1],
    item.downside_beta, item.upside_beta, item.sector_sensitivity, item.evidence_gap, item.snapshot_id, item.api,
  ]);
  return `${csv(rows)}\r\n`;
}

export const _test = { csvCell };
