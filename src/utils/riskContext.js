import { fundingSeries, swapView } from './marketPlumbing/model.js';
import { REFINANCING_RETENTION_MS, REFINANCING_FRESH_MS } from './refinancing/projection.js';
import { isBankReadResult } from './bank/readResult.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const ratio = (a, b) => finite(a) && finite(b) && b > 0 ? a / b * 100 : null;

/** Read-only views of existing prepared evidence. No new source or storage lifecycle. */
export function riskMaturityContext(wall, cik, now = Date.now()) {
  const remaining = Math.floor((Date.parse(wall?.sourceSnapshotAt) + REFINANCING_RETENTION_MS - now) / 1000);
  if (!Number.isFinite(remaining) || remaining <= 0 || Date.parse(wall.sourceSnapshotAt) > now) throw new Error('Expired maturity snapshot');
  const company = wall.companies.find(row => row.cik === cik);
  return { source: 'maturities', cik, status: company?.profile?.status || (company ? 'pending' : 'outside-coverage'),
    snapshotAt: wall.sourceSnapshotAt, checkedAt: company?.checkedAt || null, stale: now - Date.parse(wall.sourceSnapshotAt) >= REFINANCING_FRESH_MS || wall.cache?.status === 'stale',
    expiresAt: new Date(Date.parse(wall.sourceSnapshotAt) + REFINANCING_RETENTION_MS).toISOString(),
    company: company ? { cik: company.cik, ticker: company.ticker, name: company.name } : null,
    profile: company?.profile || null, ttl: Math.min(900, remaining) };
}

/** One decoded universe per warm instance, not one cache entry per issuer.
 * The source reader validates the <=20 MiB snapshot. Reuse avoids inflating and
 * revalidating all 5,000 issuers for every different Risk-page company request.
 */
export function createRiskMaturityRead({ read, now = Date.now }) {
  let cached = null, pending = null, retryAt = 0;
  return async () => {
    if (cached && now() < cached.until) return cached.value;
    if (pending) return pending;
    if (now() < retryAt) throw new Error('Prepared maturity source cooling down');
    pending = Promise.resolve().then(read).then(value => {
      const expiresAt = Date.parse(value?.sourceSnapshotAt) + REFINANCING_RETENTION_MS;
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error('Expired maturity source');
      cached = { value, until: Math.min(now() + 900000, expiresAt) };
      return value;
    }).catch(error => { cached = null; retryAt = now() + 10000; throw error; }).finally(() => { pending = null; });
    return pending;
  };
}

export function riskMarketContext(funding, derivatives, now = Date.now()) {
  // Keep only a year of rates/fails and 26 aggregate weekly swap observations.
  // Breakdown dimensions overlap and must never be summed into a second total.
  const series = funding ? fundingSeries(funding, '1y') : null;
  return { source: 'markets', funding: funding ? {
    generatedAt: funding.generatedAt, availability: funding.availability, stale: funding.availability === 'retained' || now - Date.parse(funding.generatedAt) > 48 * 3600000, notice: funding.notice,
    sources: funding.sources, rates: series.rates, fails: series.fails,
  } : null, swaps: derivatives ? {
    generatedAt: derivatives.generatedAt, availability: derivatives.availability, stale: derivatives.availability === 'retained' || now - Date.parse(derivatives.generatedAt) > 48 * 3600000, sources: derivatives.sources,
    assets: Object.fromEntries(['rates', 'credit', 'fx'].map(asset => {
      const view = swapView(derivatives, { asset, measure: 'volume', product: 'TOTAL' });
      // Only compare exactly adjacent report weeks, never bridge a missing week.
      const adjacent = Date.parse(view.date) - Date.parse(view.previousDate) === 7 * 86400000;
      return [asset, { date: view.date, total: view.total, cleared: view.cleared, share: view.share,
        change: adjacent ? view.change : null, previousDate: adjacent ? view.previousDate : null,
        trend: view.trend.slice(-26) }];
    })),
  } : null };
}

const BANK_ITEMS = [
  ['cet1_ratio', 'CET1 ratio', 'Reported standardized regulatory capital ratio.', ['cet1_ratio']],
  ['leverage_ratio', 'Tier 1 leverage ratio', 'Tier 1 capital / adjusted average assets.', ['leverage_ratio']],
  ['nonaccrual_share', 'Nonaccrual / loans', 'Nonaccrual loans / loans before allowance. Excludes accruing past-due loans.', ['nonaccrual', 'loans']],
  ['allowance_share', 'Allowance / HFI loans', 'Loan allowance / loans held for investment.', ['allowance', 'loans_hfi']],
  ['loan_deposit_share', 'Loans / deposits', 'Loans before allowance / total deposits.', ['loans', 'deposits']],
  ['brokered_share', 'Brokered / domestic deposits', 'Brokered deposits / domestic deposits; domestic-office scope.', ['brokered_deposits', 'domestic_deposits']],
  ['fhlb_share', 'FHLB advances / assets', 'Reported FHLB advances / total bank assets.', ['fhlb_advances', 'assets']],
  ['equity_share', 'Book equity / assets', 'Total equity capital / total assets; distinct from regulatory capital.', ['equity', 'assets']],
];

export function riskBankContext(data, rssd) {
  if (!isBankReadResult(data, [rssd])) throw new Error('Bank evidence identity mismatch');
  const bank = data.banks.find(row => Number(row.id_rssd) === rssd);
  const reports = data.reports.filter(row => Number(row.id_rssd) === rssd).sort((a, b) => a.report_date.localeCompare(b.report_date));
  const periods = [...data.periods].sort();
  const latestPeriod = periods.at(-1);
  const latest = reports.find(row => row.report_date === latestPeriod);
  const value = (report, keys) => {
    if (!report?.validation?.passed) return null;
    const items = keys.map(key => report.metrics.find(metric => metric.key === key)?.value);
    return keys.length === 1 ? finite(items[0]) ? items[0] : null : ratio(...items);
  };
  return { source: 'bank', rssd, bank: bank ? { name: bank.legal_name, form: bank.form_type } : null,
    status: latest?.validation?.passed ? 'ready' : latest ? 'review' : 'pending',
    period: latestPeriod || null, retrievedAt: latest?.retrieved_at || null, stale: Boolean(data.publicReadCache?.stale),
    reportingPeriods: periods.map(date => {
      const report = reports.find(row => row.report_date === date);
      return { date, status: report?.validation?.passed ? 'ready' : report ? 'review' : 'pending', retrievedAt: report?.retrieved_at || null,
        sourceUrl: report?.validation?.passed ? `/api/banks/source?${new URLSearchParams({ rssd: String(rssd), period: date, hash: report.source_sha256 })}` : null };
    }),
    metrics: BANK_ITEMS.map(([key, label, formula, keys]) => ({ key, label, formula,
      value: value(latest, keys), history: periods.map(date => ({ date, value: value(reports.find(r => r.report_date === date), keys) })),
      sources: latest ? keys.map(metric => ({ metric,
        url: `/api/banks/source?${new URLSearchParams({ rssd: String(rssd), period: latest.report_date, hash: latest.source_sha256, metric })}` })) : [],
    })) };
}
