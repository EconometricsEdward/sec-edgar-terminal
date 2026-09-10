/** Absolute, paired filing diagnostics. No prices, network calls or peer rankings. */
export const UNIVERSE_METRICS = [
  { key:'revenueGrowth', label:'Revenue growth acceleration', short:'Growth acceleration', population:'all', meaning:'Change in year-over-year revenue growth, compared with the comparable period one year earlier. Faster growth can still mean a smaller revenue decline.' },
  { key:'operatingMargin', label:'Operating margin', short:'Operating margin', population:'operating', meaning:'Operating income as a share of revenue. A higher margin means more operating profit per dollar of sales; accounting changes and one-off items can also affect it.' },
  { key:'freeCashFlowMargin', label:'Free cash flow margin', short:'Free cash flow margin', population:'operating', meaning:'Operating cash flow less purchases of property, plant and equipment, divided by revenue. A decline can reflect greater investment or working-capital needs.' },
  { key:'equityToAssets', label:'Book equity / assets', short:'Book equity / assets', population:'all', meaning:'Book equity as a share of total assets. Higher or lower is a capital-structure change, not a standalone safety rating or regulatory capital measure.' },
  { key:'netMargin', label:'Net margin', short:'Net margin', population:'all', meaning:'Net income divided by revenue. Financing, taxes and nonrecurring items can change this ratio.' },
  { key:'cashToAssets', label:'Cash / assets', short:'Cash / assets', population:'operating', meaning:'Reported cash as a share of assets. A higher cash share may provide flexibility but does not by itself establish efficient capital allocation.' },
];
export const finite = value => typeof value === 'number' && Number.isFinite(value);
const average = values => values.length ? values.reduce((a,b) => a+b,0)/values.length : null;
export function distribution(values) {
  const sorted = values.filter(finite).sort((a,b)=>a-b);
  const q = p => { if (!sorted.length) return null; const i=(sorted.length-1)*p, lo=Math.floor(i); return sorted[lo]+(sorted[Math.ceil(i)]-sorted[lo])*(i-lo); };
  return { count:sorted.length, median:q(.5), q25:q(.25), q75:q(.75), iqr:sorted.length ? q(.75)-q(.25) : null, minimum:sorted[0]??null, maximum:sorted.at(-1)??null };
}

export const CHANGE_THRESHOLDS = [0, 0.5, 1];
export const FUNDAMENTAL_DEFINITIONS = {
  direction: 'Higher: change > threshold + 1e-9; lower: change < -threshold - 1e-9; otherwise neutral. Threshold units are percentage points. Missing values are excluded.',
  thresholds: CHANGE_THRESHOLDS,
  default_threshold: 0,
  breadth: '100 × higher count / paired count. All neutral observations remain in the denominator.',
  balance: '100 × (higher count − lower count) / paired count, in percentage points from -100 to 100.',
  magnitude: 'Median of issuer-level current minus prior values, in percentage points. Threshold selection does not alter this sample.',
  dispersion: 'Current IQR minus prior IQR on the same paired issuer set. IQR = 75th percentile − 25th percentile with linear interpolation.',
  cash_confirmation: 'Growth-acceleration and free-cash-flow-margin directions on the same operating issuers. Both-higher / growth-higher is null if no issuer has higher growth.',
  variance: 'Population total variance = count-weighted within-group population variance + count-weighted squared differences between group means and universe mean. Fixed paired issuer/group membership; units are squared percentage points.',
  limitations: 'These are descriptive statistics of the covered universe. Thresholds are sensitivity settings, not statistical significance or universally meaningful economic cutoffs. Groups are curated research themes. Variance is sensitive to extreme observations; IQR is not additive.',
};
export const normalizeChangeThreshold = value => CHANGE_THRESHOLDS.includes(Number(value)) ? Number(value) : 0;
export const changeDirection = (value, threshold = 0) => !finite(value) ? null : value > threshold + 1e-9 ? 'higher' : value < -threshold - 1e-9 ? 'lower' : 'neutral';
const dateRange = values => {
  const sorted = values.filter(Boolean).sort();
  return { earliest: sorted[0] ?? null, latest: sorted.at(-1) ?? null };
};

/** Population variance on an identical issuer/group sample at both dates. IQR is not decomposed. */
export function pairedGroupVariance(rows, key) {
  const pairs = rows.filter(r => finite(r.metrics[key]?.current) && finite(r.metrics[key]?.prior));
  const groups = new Map();
  for (const row of pairs) {
    const id = row.group || 'unclassified';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  const period = field => {
    if (!pairs.length) return { total: null, within: null, between: null, within_share: null, between_share: null };
    const mean = average(pairs.map(r => r.metrics[key][field]));
    let within = 0, between = 0;
    for (const group of groups.values()) {
      const groupMean = average(group.map(r => r.metrics[key][field]));
      within += group.reduce((sum, r) => sum + (r.metrics[key][field] - groupMean) ** 2, 0) / pairs.length;
      between += group.length / pairs.length * (groupMean - mean) ** 2;
    }
    const total = within + between;
    return { total, within, between, within_share: total > 1e-14 ? within / total : null, between_share: total > 1e-14 ? between / total : null };
  };
  const current = period('current'), prior = period('prior');
  const difference = key => finite(current[key]) && finite(prior[key]) ? current[key] - prior[key] : null;
  return {
    eligible: pairs.length, groups: groups.size, singleton_groups: [...groups.values()].filter(g => g.length === 1).length,
    units: 'squared_percentage_points', current, prior,
    change: { total: difference('total'), within: difference('within'), between: difference('between') },
  };
}

/** Direction changes with the selected band; raw magnitudes and dispersion never do. */
export function computeFundamentalDiagnostics(rows, selectedThreshold = 0) {
  const threshold = normalizeChangeThreshold(selectedThreshold);
  const breadth = UNIVERSE_METRICS.map(def => {
    const population = rows.filter(r => def.population === 'all' || !r.financial);
    const pairs = population.filter(r => finite(r.metrics[def.key]?.current) && finite(r.metrics[def.key]?.prior) && finite(r.metrics[def.key]?.change));
    const changes = pairs.map(r => r.metrics[def.key].change);
    const higher = changes.filter(x => changeDirection(x, threshold) === 'higher').length;
    const lower = changes.filter(x => changeDirection(x, threshold) === 'lower').length;
    const current = distribution(pairs.map(r => r.metrics[def.key].current)), prior = distribution(pairs.map(r => r.metrics[def.key].prior));
    return {
      ...def, threshold, population_count: population.length, eligible: pairs.length, missing: population.length - pairs.length,
      higher, lower, unchanged: pairs.length - higher - lower,
      higher_pct: pairs.length ? 100 * higher / pairs.length : null,
      lower_pct: pairs.length ? 100 * lower / pairs.length : null,
      balance_pct: pairs.length ? 100 * (higher - lower) / pairs.length : null,
      change: distribution(changes), current, prior, paired_iqr_change: pairs.length ? current.iqr - prior.iqr : null,
      filing_dates: dateRange(pairs.map(r => r.filed)), fiscal_ends: dateRange(pairs.map(r => r.fiscal_end)),
      prior_fiscal_ends: dateRange(pairs.map(r => r.prior_fiscal_end)), eligible_tickers: pairs.map(r => r.ticker),
      variance: pairedGroupVariance(pairs, def.key),
    };
  });
  const operating = rows.filter(r => !r.financial);
  const matched = operating.filter(r => ['revenueGrowth', 'freeCashFlowMargin'].every(k => finite(r.metrics[k]?.change)));
  const cells = [];
  for (const growth of ['higher', 'neutral', 'lower']) for (const cash of ['higher', 'neutral', 'lower']) {
    const members = matched.filter(r => changeDirection(r.metrics.revenueGrowth.change, threshold) === growth && changeDirection(r.metrics.freeCashFlowMargin.change, threshold) === cash);
    cells.push({ growth, cash, count: members.length, pct: matched.length ? 100 * members.length / matched.length : null, tickers: members.map(r => r.ticker) });
  }
  const growthHigher = cells.filter(c => c.growth === 'higher').reduce((n,c) => n+c.count,0);
  const cashHigher = cells.filter(c => c.cash === 'higher').reduce((n,c) => n+c.count,0);
  const bothHigher = cells.find(c => c.growth === 'higher' && c.cash === 'higher').count;
  const cash_confirmation = {
    threshold, population: operating.length, eligible: matched.length, missing: operating.length - matched.length,
    coverage: operating.length ? matched.length / operating.length : 0,
    growth_higher: growthHigher, cash_higher: cashHigher, both_higher: bothHigher,
    growth_higher_pct: matched.length ? 100 * growthHigher / matched.length : null,
    cash_higher_pct: matched.length ? 100 * cashHigher / matched.length : null,
    higher_share_gap: matched.length ? 100 * (growthHigher - cashHigher) / matched.length : null,
    confirmation_pct: growthHigher ? 100 * bothHigher / growthHigher : null,
    cells, filing_dates: dateRange(matched.map(r => r.filed)), fiscal_ends: dateRange(matched.map(r => r.fiscal_end)), prior_fiscal_ends: dateRange(matched.map(r => r.prior_fiscal_end)),
  };
  const joint = operating.filter(r => ['revenueGrowth','operatingMargin','freeCashFlowMargin'].every(k => finite(r.metrics[k]?.change)));
  const weakening = joint.filter(r => ['revenueGrowth','operatingMargin','freeCashFlowMargin'].every(k => changeDirection(r.metrics[k].change, threshold) === 'lower'));
  return { threshold, breadth, cash_confirmation, simultaneous_weakening: { eligible: joint.length, missing: operating.length-joint.length, count: weakening.length, pct: joint.length ? 100*weakening.length/joint.length : null, tickers: weakening.map(r => r.ticker) } };
}
