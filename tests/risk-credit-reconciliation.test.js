import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessRisk } from '../src/utils/riskAnalysis.js';
import { decorateRiskProfile } from '../src/utils/riskWorkspace.js';
import { buildRiskProfilePresentation } from '../src/app/risk/riskProfilePresentation.js';

const apple = JSON.parse(fs.readFileSync(new URL('./fixtures/apple-risk-2026-q3.json', import.meta.url))).facts;
const profile = (facts = apple, basis = 'ttm') => decorateRiskProfile(assessRisk(facts, 3571, 320193, { basis }));
const metric = (p, id) => p.metrics.find((item) => item.id === id);
const latestBalance = (p, key) => p.reportedBalances[key].find((item) => item.end === p.periods[0].end);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const modified = (changes) => {
  const copy = structuredClone(apple);
  for (const [tag, value] of Object.entries(changes)) {
    if (value == null) delete copy['us-gaap'][tag];
    else copy['us-gaap'][tag] = { units: { USD: [{ val: value, end: '2026-06-27', fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-07-31', accn: '0000320193-26-000020' }] } };
  }
  return copy;
};

// The balance sheet reports these three borrowing lines separately. The term
// debt note's rounded $82.3B is not substituted for the exact carrying amounts.
test('Apple quarterly debt includes commercial paper and current term maturities exactly once', () => {
  const p = profile();
  const debt = latestBalance(p, 'totalDebt');
  assert.equal(p.periods[0].end, '2026-06-27');
  assert.equal(debt.value, (1997 + 11007 + 71340) * 1e6);
  assert.deepEqual(debt.sources.map((source) => source.tag).sort(), ['CommercialPaper', 'LongTermDebtCurrent', 'LongTermDebtNoncurrent']);
  assert.ok(debt.sources.every((source) => source.end === '2026-06-27' && source.start == null));
  assert.equal(metric(p, 'net_debt').value, 44800e6);
  close(metric(p, 'ocf_to_debt').value, 146724 / 84344);
});

test('Apple annual debt and cash ratios reconcile to the FY2025 balance sheet', () => {
  const p = profile(apple, 'annual');
  assert.equal(p.periods[0].end, '2025-09-27');
  assert.equal(latestBalance(p, 'totalDebt').value, (7979 + 12350 + 78328) * 1e6);
  assert.equal(metric(p, 'net_debt').value, 62723e6);
  close(metric(p, 'ocf_to_debt').value, 111482 / 98657);
  close(metric(p, 'debt_to_equity').value, 285508 / 73733);
  close(metric(p, 'liab_to_assets').value, 285508 / 359241);
  close(metric(p, 'current_ratio').value, 147957 / 165631);
  close(metric(p, 'quick_ratio').value, (147957 - 5718) / 165631);
  close(metric(p, 'cash_to_assets').value, 35934 / 359241);
  close(metric(p, 'net_margin').value, 112010 / 416161);
  close(metric(p, 'accruals_ratio').value, (112010 - 111482) / 359241);
  close(metric(p, 'receivables_gap').value, 39777 / 33410 - 416161 / 391035);
});

test('every available latest Apple risk ratio reconciles to SEC inputs with consistent TTM flows', () => {
  const p = profile();
  // TTM = FY2025 + nine months FY2026 − nine months FY2025.
  const ni = 112010 + 101464 - 84544;
  const ocf = 111482 + 116996 - 81754;
  const sales = 416161 + 364357 - 313695;
  close(metric(p, 'debt_to_equity').value, 275746 / 107520);
  close(metric(p, 'liab_to_assets').value, 275746 / 383266);
  close(metric(p, 'current_ratio').value, 149818 / 149326);
  close(metric(p, 'quick_ratio').value, (149818 - 11092) / 149326);
  close(metric(p, 'cash_to_assets').value, 39544 / 383266);
  close(metric(p, 'net_margin').value, ni / sales);
  close(metric(p, 'accruals_ratio').value, (ni - ocf) / 383266);
  close(metric(p, 'receivables_gap').value, 31398 / 27557 - sales / 408625);
  assert.equal(metric(p, 'loss_years').value, 0);
  assert.equal(metric(p, 'quick_ratio').label, 'Current ratio, ex inventory');
  assert.equal(metric(p, 'quick_ratio').zone.level, 'info');
});

test('absent interest expense remains unavailable even when cash interest is reported', () => {
  const facts = modified({});
  facts['us-gaap'].InterestPaid = structuredClone(facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities);
  const p = profile(facts);
  assert.equal(metric(p, 'interest_coverage').value, null);
  assert.match(metric(p, 'interest_coverage').note, /Cash interest paid.*not substitutes/);
  assert.match(metric(p, 'interest_coverage').note, /does not establish low or zero credit risk/);
  assert.ok(metric(p, 'ocf_to_debt').value > 0);
});

test('a reported current-debt aggregate takes precedence over its component balances', () => {
  const p = profile(modified({ DebtCurrent: 15000e6, ShortTermBorrowings: 6000e6 }));
  assert.equal(latestBalance(p, 'totalDebt').value, (71340 + 15000) * 1e6);
  assert.deepEqual(latestBalance(p, 'totalDebt').sources.map((source) => source.tag).sort(), ['DebtCurrent', 'LongTermDebtNoncurrent']);
});

test('short-term borrowing aggregate and commercial paper are never added together', () => {
  const p = profile(modified({ ShortTermBorrowings: 6000e6 }));
  assert.equal(latestBalance(p, 'totalDebt').value, (71340 + 11007 + 6000) * 1e6);
  assert.ok(!latestBalance(p, 'totalDebt').sources.some((source) => source.tag === 'CommercialPaper'));
});

test('missing, stale, or invalid debt components are not assumed zero', () => {
  for (const changes of [{ CommercialPaper: null }, { LongTermDebtCurrent: null }, { LongTermDebtNoncurrent: null }, { CommercialPaper: -1 }]) {
    const p = profile(modified(changes));
    assert.equal(latestBalance(p, 'totalDebt').value, null);
    assert.equal(metric(p, 'net_debt').value, null);
    assert.equal(metric(p, 'ocf_to_debt').value, null);
  }
  const stale = modified({});
  stale['us-gaap'].CommercialPaper.units.USD = stale['us-gaap'].CommercialPaper.units.USD.filter((point) => point.end !== '2026-06-27');
  assert.equal(latestBalance(profile(stale), 'totalDebt').value, null);
  const zero = profile(modified({ CommercialPaper: 0 }));
  assert.equal(latestBalance(zero, 'totalDebt').value, (71340 + 11007) * 1e6);
});

test('cash-only net debt is accompanied by separately sourced marketable-securities context', () => {
  const view = buildRiskProfilePresentation(profile(), { sic: 3571 });
  assert.equal(view.balance.currentSecurities.value, 22855e6);
  assert.equal(view.balance.noncurrentSecurities.value, 84118e6);
  assert.equal(view.balance.cashAndMarketableSecurities.value, 146517e6);
  assert.equal(view.balance.netDebtAfterMarketableSecurities.value, -62173e6);
  assert.equal(view.balance.currentDebt.value, 13004e6);
  assert.equal(view.balance.noncurrentDebt.value, 71340e6);
  assert.match(metric(profile(), 'net_debt').label, /cash only/);
  const missing = buildRiskProfilePresentation(profile(modified({ MarketableSecuritiesNoncurrent: null })));
  assert.equal(missing.balance.cashAndMarketableSecurities.value, null);
  assert.equal(missing.balance.netDebtAfterMarketableSecurities.value, null);
});
