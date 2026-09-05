// Risk-page presentation and deterministic, before-tax sensitivity calculations.
export const RISK_VERSION = 'risk-workspace-v2';
export const SCREEN_LABELS = { low: 'Within screen', moderate: 'Monitor', elevated: 'Review', high: 'Priority review', info: 'Context', na: 'Unavailable' };
export const PILLAR_LABELS = { credit: 'Credit', capital: 'Capital', liquidity: 'Liquidity', profitability: 'Earnings', quality: 'Earnings quality' };

// These are explicit product screening thresholds, not sector-calibrated ratings.
const definitions = {
  reserve_coverage: ['Reserve coverage', 'Allowance / (net loans + allowance). Reserve levels depend on portfolio mix and expected losses; a larger allowance can reflect either coverage or deterioration.', 'Read the allowance and charge-off tables together. Does the reserve reflect a change in portfolio quality?', '≥1.5% / ≥1.0% / ≥0.5% / <0.5%'],
  provision_rate: ['Provision rate', 'Annual or trailing-twelve-month credit-loss provision divided by ending gross loans. Some provision tags include non-loan exposures; check the numerator’s scope.', 'Are provisions rising because of loan growth, portfolio mix, or higher expected losses?', '≤0.25% / ≤0.60% / ≤1.20% / >1.20%'],
  npl_ratio: ['Nonaccrual loans / gross loans', 'Consolidated nonaccrual loans divided by net loans plus allowance. Missing dimensional disclosures cannot be inferred from company facts.', 'Review the credit-quality note for nonaccruals, delinquencies, and charge-offs.', '≤0.5% / ≤1% / ≤2% / >2%'],
  bank_equity_assets: ['Equity / assets', 'Book equity divided by total assets. This is an accounting leverage screen; it does not measure CET1, risk-weighted capital, or regulatory compliance.', 'Check CET1, risk-weighted assets, and capital distributions in the capital note.', '≥11% / ≥8% / ≥5% / <5%'],
  loans_deposits: ['Loans / deposits', 'Net loans divided by deposits. The ratio does not identify uninsured deposits, depositor concentration, or contingent liquidity.', 'Check deposit composition, uninsured balances, and alternative funding capacity.', '≤80% / ≤100% / ≤110% / >110%'],
  deposits_trend: ['Deposits', 'The reported deposit balance. Changes may reflect customer flows, acquisitions, pricing, or currency translation.', 'What explains the movement in deposits and their funding cost?', null],
  bank_cash_assets: ['Tagged cash / assets', 'The available cash tag divided by assets. Its scope is shown in the evidence; other liquidity sources, restrictions, and borrowing capacity are not inferred.', 'Reconcile the tagged balance to the liquidity note before using it as available funding.', null],
  texas_ratio: ['Nonaccrual coverage screen', 'Nonaccrual loans / (book equity − goodwill − other intangibles + allowance). This is a partial coverage screen, not a full Texas ratio: OREO and other adjustments are excluded.', 'Review untagged nonperforming assets and the composition of tangible capital.', '<30% / <60% / <100% / ≥100%'],
  htm_unrealized: ['HTM valuation gap', 'Tagged HTM fair value minus tagged carrying value. A gap is a valuation sensitivity, not a prediction of realized loss.', 'Check valuation assumptions, credit allowances, maturity, and the need to sell.', null],
  htm_adj_equity: ['Equity / assets after HTM mark', 'Before-tax sensitivity: apply the HTM valuation gap to both equity and assets. Taxes, hedges, and regulatory adjustments are excluded.', 'How would liquidity needs affect the ability to hold these securities to maturity?', null],
  nib_deposit_share: ['Noninterest-bearing deposits', 'Noninterest-bearing deposits divided by total deposits. Cost and stability depend on the depositor mix; direction alone is not a risk conclusion.', 'Review deposit concentration and repricing alongside this share.', null],
  loss_ratio: ['Insurance loss ratio', 'Claims incurred divided by earned premiums. This excludes operating expenses and is not a combined ratio or statutory capital measure.', 'Review reserve development, expenses, and investment results.', '≤65% / ≤80% / ≤95% / >95%'],
  ins_equity_assets: ['Equity / assets', 'Book equity / assets. Statutory insurance capital and reserve adequacy require separate disclosures.', 'Read subsidiary statutory capital and reserve development.', null],
  interest_coverage: ['Interest coverage', 'Operating income / interest expense, using an annual or trailing-twelve-month flow for both inputs. Operating income is an EBIT proxy.', 'Check cash interest, maturities, covenants, and the sustainability of operating profit.', '≥8× / ≥3× / ≥1.5× / <1.5×'],
  ocf_to_debt: ['Operating cash flow / debt', 'Annual or trailing-twelve-month operating cash flow / (current debt + noncurrent debt). Both debt components must be explicitly tagged; missing amounts are not zero.', 'Check cash conversion, debt definitions, maturities, and committed facilities.', '≥40% / ≥20% / ≥10% / <10%'],
  net_debt: ['Net debt', 'Current debt + noncurrent debt − cash. All three balances must be available for the same period.', 'Review restrictions on cash and obligations outside these debt tags.', null],
  accruals_ratio: ['Accruals / assets', '(Net income − operating cash flow) / ending assets. Working-capital timing and industry structure can affect this accounting screen.', 'Which accruals explain the gap between income and cash flow?', '≤0% / <5% / <10% / ≥10%'],
  receivables_gap: ['Receivables growth − sales growth', 'Year-over-year receivables growth minus year-over-year revenue growth. Revenue is annual or TTM, matching the selected basis.', 'Check collection timing, acquisitions, and revenue recognition in the notes.', '≤3 pp / ≤8 pp / ≤15 pp / >15 pp'],
  debt_to_equity: ['Liabilities / equity', 'Total liabilities / book equity. Negative equity makes the ratio hard to interpret. Financial-company leverage is shown without industrial thresholds.', 'Read the liability mix and the reasons for any equity deficit.', '<0.5× / <1.5× / <3× / ≥3× or negative'],
  liab_to_assets: ['Liabilities / assets', 'Total liabilities / total assets. An accounting capital-structure measure; financial-company leverage has no industrial threshold here.', 'Review the maturity, seniority, and nature of the obligations.', '<50% / <70% / <85% / ≥85%'],
  current_ratio: ['Current ratio', 'Current assets / current liabilities. Business models differ in their working-capital requirements.', 'Review the timing and quality of near-term assets and obligations.', '≥2× / ≥1.2× / ≥1× / <1×'],
  quick_ratio: ['Quick ratio', '(Current assets − inventory) / current liabilities. All inputs must be tagged; this approximation still includes other current assets.', 'Check receivable collectability and prepaid or restricted balances.', '≥1.5× / ≥1× / ≥0.7× / <0.7×'],
  cash_to_assets: ['Cash / assets', 'Cash and cash equivalents / total assets. Restricted cash and other funding sources require separate review.', 'Read cash restrictions and committed funding facilities.', '≥15% / ≥7% / ≥3% / <3%'],
  net_margin: ['Net margin', 'Annual or trailing-twelve-month net income / revenue. One-off items and differing revenue definitions affect comparability.', 'Check recurring earnings, one-time items, and cash conversion.', '≥10% / ≥3% / ≥0% / <0%'],
  loss_years: [null, 'Counts negative net-income observations in the displayed history. Missing periods are excluded and TTM windows overlap.', 'Check the cause and persistence of reported losses.', '0 / 1 / 2 / ≥3 loss observations'],
};

export function decorateRiskProfile(profile) {
  const contextOnly = new Set(['reserve_coverage', 'htm_adj_equity']);
  const metrics = profile.metrics.map((metric) => {
    const [label, why, question, thresholds] = definitions[metric.id] || [null, metric.why, 'Review the source filing.', null];
    const level = contextOnly.has(metric.id) && metric.value != null ? 'info' : metric.zone.level;
    const contextual = level === 'info';
    return { ...metric, label: label || metric.label, why, question,
      zone: { level, label: SCREEN_LABELS[level] },
      thresholds: contextual ? null : thresholds,
      trajectory: contextOnly.has(metric.id) ? null : metric.trajectory,
      classification: metric.id === 'htm_adj_equity' && metric.value != null ? 'illustrative' : metric.classification,
      // Do not retain legacy prose that implied untagged inputs were zero.
      note: ['loss_years', 'quick_ratio'].includes(metric.id) ? metric.note : null,
    };
  });
  const watchItems = metrics.filter((m) => m.value != null && (['high', 'elevated'].includes(m.zone.level) || m.trajectory?.direction === 'deteriorating' && m.trajectory.steps >= 3))
    .map((m) => ({ id: m.id, label: m.label, severity: m.zone.level === 'high' ? 'high' : 'elevated', pillar: m.pillar,
      reason: [ ['high', 'elevated'].includes(m.zone.level) ? `${m.zone.label} under the stated screen` : null,
        m.trajectory?.direction === 'deteriorating' ? `${m.trajectory.steps} consecutive adverse changes${profile.basis === 'ttm' ? ' in overlapping TTM/quarter-end observations' : ''}` : null ].filter(Boolean).join(' · '), question: m.question,
    })).sort((a, b) => Number(b.severity === 'high') - Number(a.severity === 'high'));
  return { ...profile, metrics, watchItems, coverage: { available: metrics.filter((m) => m.value != null).length, total: metrics.length, missing: metrics.filter((m) => m.value == null).map((m) => m.id) } };
}

export function formatRiskValue(value, format = 'usd', signed = false) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  const n = Math.abs(value);
  if (format === 'pct' || format === 'pp') return `${sign}${(n * 100).toFixed(2)}${format === 'pp' ? ' pp' : '%'}`;
  if (format === 'x' || format === 'ratio') return `${sign}${n.toFixed(2)}×`;
  if (format === 'count') return `${sign}${n}`;
  const scale = n >= 1e12 ? [1e12, 'T'] : n >= 1e9 ? [1e9, 'B'] : n >= 1e6 ? [1e6, 'M'] : n >= 1e3 ? [1e3, 'K'] : [1, ''];
  return `${sign}$${(n / Number(scale[0])).toFixed(2)}${scale[1]}`;
}
export const riskDelta = (metric) => formatRiskValue(metric.delta, metric.format === 'pct' ? 'pp' : metric.format, true);
export const riskPeriodLabel = (p) => p ? p.kind === 'ttm' ? `${p.fp} ${p.fy}` : `FY${p.fy}` : 'Unavailable';

export function runRiskStress(profile, controls = {}) {
  const inputs = profile.stressInputs || {};
  const get = (key) => inputs[key]?.value;
  const isBank = profile.industry.isBank;
  const isInsurer = profile.industry.isFinancial && !isBank;
  const keys = isBank ? ['totalAssets', 'equity', 'cash', 'loans', 'deposits'] : isInsurer ? ['totalAssets', 'equity'] : ['operatingIncome', 'interestExpense'];
  const missing = keys.filter((k) => !Number.isFinite(get(k)));
  if (missing.length) return { available: false, missing, rows: [], assumptions: [] };
  const clamp = (key, max) => Math.max(0, Math.min(max, Number(controls[key]) || 0)) / 100;
  const row = (label, baseline, stressed, format, formula) => ({ label, baseline, stressed, format, formula });
  if (isBank) {
    const assets = get('totalAssets'), equity = get('equity'), cash = get('cash'), deposits = get('deposits'), loans = get('loans');
    if (assets <= 0 || cash < 0 || deposits <= 0 || loans < 0 || cash > assets || loans > assets) return { available: false, missing: ['compatible positive bank balances'], rows: [], assumptions: [] };
    const runoff = deposits * clamp('runoff', 30);
    const paid = Math.min(runoff, cash);
    const gap = runoff - paid;
    const loss = loans * clamp('creditLoss', 5);
    const stressedAssets = assets - paid - loss;
    return { available: true, missing: [], inputs: keys, parameters: { runoff: clamp('runoff', 30) * 100, creditLoss: clamp('creditLoss', 5) * 100 },
      rows: [row('Equity / assets', equity / assets, stressedAssets > 0 ? (equity - loss) / stressedAssets : null, 'pct', '(Equity − additional loss) / (Assets − funded withdrawals − additional loss)'),
        row('Book equity', equity, equity - loss, 'usd', 'Equity − additional loss'),
        row('Tagged cash remaining', cash, cash - paid, 'usd', 'Cash − min(requested withdrawals, cash)'),
        row('Withdrawals beyond modeled cash', 0, gap, 'usd', 'max(Deposits × runoff rate − cash, 0)'),
        row('Additional unreserved credit loss', 0, loss, 'usd', 'Net loans × additional loss rate')],
      assumptions: ['Instantaneous, before-tax sensitivity; no forecast or regulatory capital calculation.', 'Additional losses are beyond existing allowances and reduce both assets and equity.', 'Requested withdrawals = reported deposits × runoff rate. Only the portion covered by tagged cash is paid; unpaid amounts remain deposits.', 'All tagged cash is assumed usable. Securities sales, new borrowing, inflows, taxes, and management actions are excluded.', 'A modeled cash gap is a need to examine other funding sources, not a finding of default. Paying deposits can mechanically increase equity/assets even as liquidity falls.'] };
  }
  if (isInsurer) {
    const assets = get('totalAssets'), equity = get('equity'), loss = assets * clamp('assetLoss', 10);
    if (assets <= 0) return { available: false, missing: ['positive total assets'], rows: [], assumptions: [] };
    return { available: true, missing: [], inputs: keys, parameters: { assetLoss: clamp('assetLoss', 10) * 100 }, rows: [row('Equity / assets', equity / assets, (equity - loss) / (assets - loss), 'pct', '(Equity − loss) / (Assets − loss)'), row('Book equity', equity, equity - loss, 'usd', 'Equity − assets × loss rate')], assumptions: ['Illustrative before-tax loss across the total asset base; asset mix, liability offsets, and hedges are excluded.', 'This is an accounting sensitivity, not an insurer solvency or statutory capital test.'] };
  }
  const profit = get('operatingIncome'), interest = get('interestExpense');
  if (interest <= 0) return { available: false, missing: ['positive tagged interest expense'], rows: [], assumptions: [] };
  const stressedProfit = profit - Math.abs(profit) * clamp('earningsDecline', 100);
  const stressedInterest = interest * (1 + clamp('interestIncrease', 100));
  return { available: true, missing: [], inputs: keys, parameters: { earningsDecline: clamp('earningsDecline', 100) * 100, interestIncrease: clamp('interestIncrease', 100) * 100 }, rows: [row('Interest coverage', profit / interest, stressedProfit / stressedInterest, 'x', '(Operating income − |operating income| × decline) / (Interest expense × (1 + increase))'), row('Operating income', profit, stressedProfit, 'usd', 'Operating income − |operating income| × decline'), row('Interest expense', interest, stressedInterest, 'usd', 'Interest expense × (1 + increase)')], assumptions: ['Sensitivity on the selected annual or TTM flows, not a forecast.', 'Operating income is an EBIT proxy. A decline makes an existing operating loss more negative.', 'No refinancing schedule, taxes, cash conversion, or balance-sheet effects are modeled.'] };
}

export function riskBrief(data, profile, stress) {
  const lines = [`# ${data.ticker} — Risk brief`, data.companyName, `Reporting end: ${profile.periods[0]?.end || 'Unavailable'} · Basis: ${profile.basis === 'ttm' ? 'Quarter-end balance sheet and trailing twelve months' : 'Annual'}`, `Data retrieved: ${data.generatedAt}`, `Coverage: ${profile.coverage.available}/${profile.coverage.total} metrics available`, '', 'Screening thresholds are product conventions, not credit ratings or default probabilities.', '', '## Review priorities', ...profile.watchItems.map((w) => `- ${w.label}: ${w.reason}. ${w.question}`), '', '## Metrics'];
  for (const m of profile.metrics) {
    lines.push(`\n### ${m.label}`, `${formatRiskValue(m.value, m.format)} · ${m.zone.label} · Change: ${riskDelta(m)}`, m.why, `Formula: ${m.formula}`);
    if (m.thresholds) lines.push(`Screen thresholds (Within screen / Monitor / Review / Priority review): ${m.thresholds}`);
    if (m.note) lines.push(m.note);
    for (const s of m.sources) lines.push(`- ${s.label}: ${s.value ?? 'unavailable'} ${s.unit || ''} (${s.start ? s.start + ' to ' : ''}${s.end}) · [${s.tag}](${s.documentUrl || s.url})`);
  }
  lines.push('', '## Illustrative stress scenario', `Assumptions: ${JSON.stringify(stress.parameters || {})}`);
  if (stress.available) for (const r of stress.rows) lines.push(`- ${r.label}: ${formatRiskValue(r.baseline, r.format)} → ${formatRiskValue(r.stressed, r.format)}. ${r.formula}`);
  else lines.push(`Unavailable: ${stress.missing.join(', ')}`);
  lines.push(...stress.assumptions.map((a) => `- ${a}`));
  for (const key of stress.inputs || []) lines.push(`- Modeled ${key}: ${profile.stressInputs[key].value} USD. ${profile.stressInputs[key].formula || 'Reported balance'}`);
  for (const key of stress.inputs || []) for (const s of profile.stressInputs[key].sources) lines.push(`- Scenario input ${key}: ${s.value} ${s.unit} (${s.end}), [${s.tag}](${s.documentUrl || s.url})`);
  return lines.join('\n');
}

export function riskHistoryCsv(data, profile, metric) {
  const quote = (s) => `"${String(s ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
  const rows = [['Ticker', 'Metric', 'Basis', 'Period end', 'Value (raw; percentages as fractions)', 'Unit', 'SEC filing URLs'], ...metric.series.map((p) => [data.ticker, metric.label, profile.basis, p.end, p.value, metric.format, [...new Set(p.sources.map((s) => s.documentUrl).filter(Boolean))].join(' ')])];
  return rows.map((r) => r.map(quote).join(',')).join('\r\n');
}
