const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 2) => finite(value) ? value.toFixed(digits) : 'Unavailable';
const percent = (value) => finite(value) ? `${(value * 100).toFixed(1)}%` : 'Unavailable';
const signed = (value) => finite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}` : 'Unavailable';
const intervalValid = (value) => Array.isArray(value) && value.length === 2 && value.every(finite) && value[0] <= value[1];

export const FACTOR_READING_VERSION = 'factor-reading-1.0.0';

export function betaIntervalReading(model) {
  const interval = model?.beta_confidence_interval95;
  if (!intervalValid(interval)) return { intervalWidth: null, label: 'Uncertainty unavailable', reading: 'A confidence interval is unavailable, so the estimate cannot be compared reliably with zero or one.' };
  const includesZero = interval[0] <= 0 && interval[1] >= 0;
  const includesOne = interval[0] <= 1 && interval[1] >= 1;
  const label = includesZero ? 'Direction remains uncertain' : interval[1] < 0 ? 'Inverse market relationship' : includesOne ? 'Market-like sensitivity remains plausible' : interval[0] > 1 ? 'Sensitivity above one' : 'Positive sensitivity below one';
  const reading = includesZero
    ? 'The interval includes zero. This sample does not clearly distinguish the market relationship from no linear relationship.'
    : includesOne
      ? 'The interval includes one. This sample does not clearly establish different sensitivity from SPY.'
      : interval[1] < 0
        ? 'The whole interval is below zero, consistent with an inverse market relationship in this sample. That does not make the company low risk.'
        : interval[0] > 1
          ? 'The whole interval is above one, consistent with greater market sensitivity in this sample.'
          : 'The whole interval is between zero and one, consistent with a positive but smaller market response. Other risks can still be large.';
  return { intervalWidth: interval[1] - interval[0], label, reading };
}

export function betaScenario(beta, interval, benchmarkMovePercent) {
  if (!finite(beta) || !finite(benchmarkMovePercent) || benchmarkMovePercent <= -100) return null;
  const translate = (coefficient) => 100 * Math.expm1(coefficient * Math.log1p(benchmarkMovePercent / 100));
  const estimate = translate(beta);
  if (!finite(estimate)) return null;
  const endpoints = intervalValid(interval) ? interval.map(translate).sort((a, b) => a - b) : null;
  return { estimate, bounds: endpoints?.every(finite) ? endpoints : null };
}

export function rollingRegime(points, current, median) {
  const values = (points || []).map((point) => point?.beta).filter(finite);
  if (!values.length) return null;
  const aboveOne = values.filter((value) => value > 1).length / values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const standardDeviation = values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : null;
  const change = finite(current) && finite(median) ? current - median : null;
  const direction = change == null ? 'History unavailable' : `${signed(change)} versus rolling median`;
  return { aboveOne, standardDeviation, direction };
}

export function eventTermStructure(windows) {
  return [1, 5, 20].map((sessions) => {
    const value = windows?.[String(sessions)];
    return { sessions, cumulativeAbnormalReturn: finite(value?.cumulative_abnormal_return) ? value.cumulative_abnormal_return : null,
      standardizedResponse: finite(value?.standardized_response) ? value.standardized_response : null, through: value?.through || null };
  });
}

function betaReading(beta, interval) {
  if (!finite(beta)) return 'The price history did not meet the requirements for a market beta. Missing is not zero exposure.';
  const sensitivity = beta < 0
    ? `The fitted relationship runs opposite to SPY: a +1% benchmark move corresponds to approximately ${number(beta)}% from the market component.`
    : beta === 0
      ? 'The fitted market component is zero in this sample; that does not imply the stock never moves.'
      : `A +1% SPY move corresponds to approximately +${number(beta)}% from the market component; a −1% move reverses that contribution.`;
  return `${sensitivity} ${betaIntervalReading({ beta_confidence_interval95: interval }).reading}`;
}

function conditionalReading(model, direction) {
  if (!finite(model?.beta)) return `There are not enough usable ${direction}-market observations to estimate this relationship.`;
  const shock = direction === 'down' ? -1 : 1;
  return `Within SPY ${direction} sessions, a ${shock > 0 ? '+' : '−'}1% market move maps to approximately ${signed(shock * model.beta)}% from the fitted slope. Each sign subset has its own intercept and sample.`;
}

export function evidenceReading(gap, filing, event) {
  const filingZ = gap?.inputs?.filing_change_z ?? filing?.filing_change_z;
  const responseZ = gap?.inputs?.price_response_z ?? event?.windows?.['20']?.standardized_response;
  if (!gap?.available || !finite(gap?.evidence_gap) || !finite(filingZ) || !finite(responseZ)) {
    return { label: 'Comparison incomplete', reading: gap?.reason || 'Both a complete filing score and a complete 20-session standardized price response are required.' };
  }
  const band = finite(gap.neutral_band) && gap.neutral_band > 0 ? gap.neutral_band : .5;
  const filingLabel = filingZ >= band ? 'Above-peer filing change' : filingZ <= -band ? 'Below-peer filing change' : 'Filing change near peers';
  const responseLabel = responseZ >= band ? 'positive adjusted response' : responseZ <= -band ? 'negative adjusted response' : 'muted adjusted response';
  return { label: `${filingLabel}; ${responseLabel}`, reading: `Filing score ${signed(filingZ)} and response score ${signed(responseZ)} produce a gap of ${signed(gap.evidence_gap)} after each input is capped at ±3. A positive gap means the filing score is numerically higher; a negative gap means the response score is higher. A small gap can occur when both inputs are positive or both are negative.` };
}

export function filingComponentReading(component) {
  const descriptions = {
    revenueGrowth: 'Change in year-over-year revenue growth. Faster growth or a smaller contraction raises this input.',
    operatingMargin: 'Change in operating profit as a share of revenue. A rise means more operating profit per revenue dollar, including a narrowing loss.',
    freeCashFlowMargin: 'Change in operating cash flow less capital expenditure, divided by revenue. Investment timing can change this ratio.',
    equityToAssets: 'Change in book equity as a share of assets, not a regulatory capital ratio. Asset shrinkage, valuation changes, or new equity can also raise it.',
    cashToAssets: 'Change in cash as a share of assets. Borrowing or asset sales can raise cash without improving operating performance.',
    netMargin: 'Change in net income as a share of revenue. Taxes and one-time items can affect it.',
  };
  const meaning = descriptions[component?.key] || 'Change in this reported ratio between the current and comparison periods.';
  const change = component?.change;
  const current = component?.current;
  const prior = component?.prior;
  const reading = finite(current) && finite(prior) && finite(change)
    ? `From ${number(prior, 1)}% to ${number(current, 1)}%: ${change > 0 ? 'rose' : change < 0 ? 'fell' : 'changed'} by ${number(Math.abs(change), 1)} percentage points.${finite(component?.peer_percentile) ? ` Its change is at the ${number(component.peer_percentile, 1)}th percentile of eligible peer changes (ties use the midpoint).` : ''}`
    : 'Both comparable periods are required before interpreting the change.';
  return { meaning, reading, caution: component?.reason || 'Peer rank describes this change, not the quality of the company or a return forecast.' };
}

/** Shared deterministic explanations used by the page, API and exported notes. */
export function buildFactorReadingGuide(data = {}) {
  const withheld = data.status === 'withheld' || data.quality?.headline_eligible === false;
  const market = withheld ? null : data.estimates?.market_model;
  const conditional = withheld ? null : data.estimates?.conditional_beta;
  const sector = withheld ? null : data.estimates?.independent_sector_sensitivity;
  const rolling = withheld ? null : data.estimates?.rolling_beta;
  const filing = data.edgar_snapshot;
  const event = data.filing_event;
  const gap = data.evidence_gap;
  const uncertainty = betaIntervalReading(market);
  const evidence = evidenceReading(gap, filing, event);
  const sectorName = data.request?.sector_proxy || 'Sector ETF';
  const rows = [];
  const add = (id, label, value, meaning, reading, caution) => rows.push({ id, label, value, meaning, reading, caution });
  add('market_beta', 'Market sensitivity · beta', number(market?.beta), 'How strongly daily stock returns moved with SPY, the broad-market benchmark.', betaReading(market?.beta, market?.beta_confidence_interval95), 'Beta measures market sensitivity, not total risk. Actual returns also reflect the intercept and unexplained movement.');
  add('confidence', 'Uncertainty · 95% beta interval', intervalValid(market?.beta_confidence_interval95) ? market.beta_confidence_interval95.map((value) => number(value)).join(' to ') : 'Unavailable', 'An approximate range for the estimated slope, using Newey–West standard errors that allow changing error variance and serial correlation.', uncertainty.reading, 'This is uncertainty about beta, not a range containing 95% of future stock returns. Precision does not guarantee model stability.');
  add('downside', 'Sensitivity on down-market days', number(conditional?.downside?.beta), 'A separate slope fitted only on days when SPY fell.', conditionalReading(conditional?.downside, 'down'), 'This does not measure maximum loss, drawdown, or the probability of a decline.');
  add('upside', 'Sensitivity on up-market days', number(conditional?.upside?.beta), 'A separate slope fitted only on days when SPY rose.', conditionalReading(conditional?.upside, 'up'), 'A larger upside beta is not a promise of stronger future returns.');
  add('sector', `${sectorName} sensitivity beyond SPY`, number(sector?.independent_sector_beta), `The relationship with the part of ${sectorName} returns left after removing its fitted relationship with SPY.`, finite(sector?.independent_sector_beta) ? `A +1 percentage point sector residual corresponds to approximately ${signed(sector.independent_sector_beta)}% in the stock's fitted log return, holding SPY fixed.${sector.independent_sector_beta < 0 ? ' The negative sign indicates an inverse relationship with this sector-specific movement.' : ''}` : 'The aligned sector sample or remaining sector variation is insufficient.', 'This release provides no confidence interval for this coefficient. Its magnitude alone does not establish a statistically reliable sector relationship.');
  add('r_squared', 'Variation captured by SPY · R²', percent(market?.r_squared), 'The share of observed daily return variation accounted for by the fitted market model.', finite(market?.r_squared) ? `The model accounts for ${percent(market.r_squared)} of variation; ${percent(1 - market.r_squared)} remains unexplained by this model.` : 'Model fit is unavailable.', 'This is in-sample fit, not prediction accuracy or proof that SPY caused the returns. Low R² can coexist with a precisely estimated beta.');
  add('residual_volatility', 'Movement left unexplained', percent(market?.residual_volatility_annualized), 'The standard deviation of market-model residuals, scaled from daily to annual units using √252.', finite(market?.residual_volatility_annualized) ? `The unexplained annualized volatility is ${percent(market.residual_volatility_annualized)}, equivalent to about ${percent(market.residual_volatility_annualized / Math.sqrt(252))} in daily log-return units.` : 'Residual volatility is unavailable.', 'It includes omitted sectors, factors, company events and noise. It is neither purely company-specific risk nor a maximum possible loss.');
  add('correlation', 'Return correlation', number(market?.correlation), 'Strength and direction of the linear association between stock and SPY returns, on a scale from −1 to +1.', finite(market?.correlation) ? `${number(market.correlation)} indicates ${market.correlation > 0 ? 'same-direction' : market.correlation < 0 ? 'opposite-direction' : 'no estimated linear'} co-movement in this sample.` : 'Correlation is unavailable.', 'Correlation measures co-movement; beta also reflects the size of the stock’s fluctuations relative to SPY. Neither proves causation.');
  add('rolling', 'Recent versus historical beta', number(rolling?.current), `Beta re-estimated over overlapping ${rolling?.window || 126}-observation windows.`, finite(rolling?.current) && finite(rolling?.median) ? `The latest rolling beta is ${number(rolling.current)} versus a rolling median of ${number(rolling.median)} (${signed(rolling.current - rolling.median)} difference).` : 'A complete rolling history is unavailable.', 'The median is across displayed windows. They overlap; a change is descriptive, not a formal structural-break test.');
  add('rolling_range', 'Rolling-beta range and dispersion', number(rolling?.range), 'Range is the largest minus smallest rolling beta. Dispersion is the standard deviation across those estimates; the share above one counts displayed windows.', finite(rolling?.minimum) && finite(rolling?.maximum) ? `Rolling beta ranged from ${number(rolling.minimum)} to ${number(rolling.maximum)}.` : 'Rolling range is unavailable.', 'A wide range prompts a stability review but is not a confidence interval or evidence of a new regime.');
  add('filing_score', 'Filing change versus peers · composite z', filing?.available ? signed(filing.filing_change_z) : 'Unavailable', 'A fixed-weight combination of changes in SEC ratios, each compared with other eligible issuers in the selected cohort.', filing?.available ? `The composite is ${signed(filing.filing_change_z)}. Positive means a higher weighted relative change than the component peer centers; negative means lower relative change. Read the raw changes to see whether fundamentals actually rose or fell.` : filing?.reason || 'Required filing components or peer observations are incomplete.', 'An above-peer score can mean deterioration that was less severe than peers. The composite is not a normally distributed z statistic or a company quality rating.');
  add('event_return', 'Post-filing model-adjusted return', percent(event?.windows?.['20']?.cumulative_abnormal_return), 'The realized gross return relative to the gross return implied by a market-and-sector model fitted before the filing.', finite(event?.windows?.['20']?.cumulative_abnormal_return) ? `Across 20 measured sessions, realized gross return was ${percent(Math.abs(event.windows['20'].cumulative_abnormal_return))} ${event.windows['20'].cumulative_abnormal_return >= 0 ? 'above' : 'below'} the model-implied gross return.` : 'The 20-session horizon is unavailable: it may be unfinished, lack aligned prices, or lack enough pre-event history.', 'This is exp(sum of log-return residuals) − 1, not an arithmetic return difference. Other news can affect it, and intraday filings start measurement next session.');
  add('event_z', 'Response relative to usual residual noise', signed(event?.windows?.['20']?.standardized_response), 'Cumulative log-return residual divided by pre-event daily residual volatility times √sessions.', finite(event?.windows?.['20']?.standardized_response) ? `The 20-session response is ${signed(event.windows['20'].standardized_response)} units of the model’s scaled residual noise.` : 'A complete response and nonzero pre-event residual variation are needed.', 'This descriptive standardization is not a calibrated significance test: it omits parameter-estimation uncertainty and serial-correlation adjustments for the event sum.');
  add('evidence_gap', 'Filing–price disagreement · Evidence Gap', gap?.available ? signed(gap.evidence_gap) : 'Unavailable', 'The clipped filing score minus the clipped 20-session response score. Each is capped at ±3, giving a gap between −6 and +6.', evidence.reading, 'The gap is not a z statistic, valuation discount, or expected alpha. Peer reports may have arrived after the focus filing, so the comparison is not a historical tradable signal.');
  add('overlap', 'Matched observations and overlap', percent(data.sample?.overlap_coverage), 'The percentage of eligible SPY return intervals that exactly match the stock’s start and end dates.', `${data.sample?.observations ?? 'Unavailable'} matched return observations; effective period ${data.sample?.effective_start || 'unavailable'} to ${data.sample?.effective_end || 'unavailable'}.`, 'High overlap does not ensure the full requested history exists. A recent listing can have high overlap over a short effective period. Sector and sign-based models can use different samples.');
  add('intercept', 'Market-model intercept', percent(market?.intercept_annualized), 'The fitted daily log return when SPY’s return is zero, multiplied by 252 for the displayed annualized value.', finite(market?.intercept_annualized) ? `The annualized intercept is ${percent(market.intercept_annualized)}; the daily fitted intercept is ${percent(market.intercept_daily)}.` : 'The intercept is unavailable.', 'This is not Jensen alpha, a compounded annual return, or expected outperformance. No risk-free rate is subtracted.');
  add('standard_error', 'Beta standard error', number(market?.beta_standard_error), 'Estimated sampling uncertainty in beta; the approximate 95% interval is beta ± 1.96 times this standard error.', finite(market?.beta_standard_error) ? `A standard error of ${number(market.beta_standard_error)} implies a 95% interval half-width of ${number(1.96 * market.beta_standard_error)}.` : 'The standard error is unavailable.', 'This addresses estimated sampling noise, not omitted variables or future changes in exposure.');
  add('t_statistic', 'Beta t-statistic · versus zero', number(market?.beta_t_statistic), 'Beta divided by its robust standard error, with zero as the reference hypothesis.', finite(market?.beta_t_statistic) ? `The coefficient is ${number(market.beta_t_statistic)} standard errors from zero.` : 'The t-statistic is unavailable, including when the standard error is zero.', 'This does not test beta against one or compare downside with upside beta. No multiplicity-adjusted test is shown.');
  add('adjusted_r_squared', 'Adjusted R²', percent(market?.adjusted_r_squared), 'R² adjusted for the number of fitted coefficients and observations.', `Adjusted in-sample fit: ${percent(market?.adjusted_r_squared)}.`, 'It still does not measure out-of-sample predictive performance.');
  add('durbin_watson', 'Residual serial pattern · Durbin–Watson', number(market?.durbin_watson), 'A residual diagnostic: near 2 suggests little first-order correlation; below 2 suggests positive and above 2 negative correlation.', finite(market?.durbin_watson) ? `The displayed residual statistic is ${number(market.durbin_watson)}.` : 'The statistic is unavailable.', 'This is a diagnostic pointer, not a standalone pass/fail test. Missing dates affect spacing; HAC uncertainty also relies on modeling assumptions.');
  add('asymmetry', 'Downside minus upside beta', signed(conditional?.asymmetry), 'The difference between slopes fitted on SPY down days and SPY up days.', finite(conditional?.asymmetry) ? `The downside slope is ${number(Math.abs(conditional.asymmetry))} ${conditional.asymmetry >= 0 ? 'higher' : 'lower'} than the upside slope.` : 'Both conditional models are required.', 'No joint test of this difference is provided. It does not establish statistically different behavior.');
  const influenceCount = market?.influential_dates?.length || 0;
  add('influence', 'Influential observations · Cook’s distance', influenceCount ? `${influenceCount} dates` : 'Unavailable', 'Combines a date’s regression leverage and residual size to flag observations with more influence on fitted coefficients.', influenceCount ? 'Review these dates for earnings, corporate actions or unusual price moves before interpreting a large beta.' : 'No influence observations are available for this result.', 'Dates are ranked within this fit. They are not automatically errors, and removing them can bias the analysis.');
  add('grade', 'Input completeness grade', data.quality?.grade || 'Unavailable', 'A rule-based summary of sample length, peer coverage, complete filing components, event availability, source freshness and timing.', 'A requires at least 500 returns, 12 peers, complete filing inputs and the standardized 20-session event; B requires 252 returns, 8 peers and complete filing inputs; C requires 126 usable returns. Staleness and date-only timing can lower the grade.', 'This is a data-coverage grade, not a credit rating, prediction score, or probability that the model is correct.');
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  const summary = [byId.market_beta.reading, byId.r_squared.reading, `${evidence.label}. ${gap?.available ? 'Review the raw SEC changes before inferring business improvement.' : evidence.reading}`];
  const checks = [];
  if (data.status === 'stale' || data.cache_status === 'stale' || data.quality?.sec_snapshot_status === 'stale') checks.push('This result uses retained data. Check the source dates before comparing it with newer research.');
  if (withheld || !finite(market?.beta)) checks.push('Market estimates are unavailable. Review price-basis and sample warnings below.');
  if (!filing?.available) checks.push(filing?.reason || 'Some required SEC inputs are missing. Read the available component changes individually.');
  if (!finite(event?.windows?.['20']?.standardized_response)) checks.push('The full filing-event comparison is unavailable. Shorter measured horizons may still be shown.');
  if ((filing?.coverage?.peer_filing_clock?.peers_after_focus || 0) > 0) checks.push('Some peer filings arrived later than this company’s filing; the peer comparison reflects the current snapshot.');
  return { version: FACTOR_READING_VERSION, summary, checks, metrics: rows };
}

export function withFactorReadingGuide(data) {
  const reading_guide = buildFactorReadingGuide(data);
  const evidence = evidenceReading(data.evidence_gap, data.edgar_snapshot, data.filing_event);
  const evidence_gap = data.evidence_gap?.available ? { ...data.evidence_gap, classification: { ...data.evidence_gap.classification, label: evidence.label, interpretation: evidence.reading } } : data.evidence_gap;
  return { ...data, evidence_gap, interpretation: reading_guide.summary.join(' '), reading_guide };
}
