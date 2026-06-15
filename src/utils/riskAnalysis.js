// ============================================================================
// riskAnalysis — compute a multi-pillar risk profile from SEC XBRL company facts.
//
// Design principles (match the site's ethos):
//   - Pure and dependency-light: everything here is computable offline from a
//     companyfacts JSON + SIC code, so it can be unit-tested without network.
//   - No black boxes: the only composite score is the Altman Z''-Score, a
//     published academic formula, shown with its full formula and every input.
//     Everything else is a plain ratio with its threshold bands stated.
//   - Source-linked: every metric carries the XBRL tag(s) and accession that
//     produced it, so the UI can link each number to data.sec.gov.
//   - Sector-aware: financial institutions (banks SIC 6000–6199, insurers
//     6300–6411) get a different credit lens. Altman's models explicitly
//     exclude financials — their leverage is structural, their balance sheets
//     are unclassified (no current assets/liabilities), and their credit risk
//     lives in the loan book. Banks therefore get a dedicated credit profile:
//     asset quality, reserves, capital, and funding.
//
// Pillars:
//   credit         — default/credit risk (Z'' or bank asset quality + reserves)
//   capital        — leverage & capital adequacy
//   liquidity      — near-term obligations coverage / funding
//   profitability  — earnings stability
// ============================================================================

import {
  extractAnnualPeriods,
  buildMetricRow,
  buildSourceUrl,
} from './xbrlParser.js';
import { classifyIndustry, industryLabel, INDUSTRY_GROUPS } from './industry.js';

const MAX_YEARS = 6;

export const ZONE_LEVELS = ['low', 'moderate', 'elevated', 'high'];

const ZONE_LABELS = {
  low: 'Low',
  moderate: 'Moderate',
  elevated: 'Elevated',
  high: 'High',
  info: 'Context',
  na: 'N/A',
};

// ----------------------------------------------------------------------------
// Small helpers over buildMetricRow rows
// (rows: { key, label, values: [{ period, value, source }], format })
// ----------------------------------------------------------------------------

function latestPoint(row) {
  if (!row) return null;
  for (const v of row.values) {
    if (v.value != null && Number.isFinite(v.value)) return v;
  }
  return null;
}

function pointAt(row, index) {
  const v = row?.values?.[index];
  return v && v.value != null && Number.isFinite(v.value) ? v : null;
}

function seriesOf(row, periods) {
  if (!row) return [];
  return row.values
    .map((v, i) => ({
      fy: periods[i]?.fy ?? null,
      end: periods[i]?.end ?? null,
      value: v.value != null && Number.isFinite(v.value) ? v.value : null,
    }))
    .filter((p) => p.fy != null);
}

function sourcesOf(cik, ...points) {
  const seen = new Set();
  const out = [];
  for (const p of points) {
    const s = p?.source;
    if (!s?.tag || seen.has(s.tag)) continue;
    seen.add(s.tag);
    out.push({
      tag: s.tag,
      end: s.end || null,
      accession: s.accession || null,
      url: buildSourceUrl(cik, s),
    });
  }
  return out;
}

/** Per-period sum of several rows. Null components count as 0 only if at least
 *  one component is present for that period; tracks which components were found. */
function sumRows(rows, label, periods) {
  const componentTags = new Set();
  const values = periods.map((p, i) => {
    let sum = 0;
    let found = 0;
    let source = null;
    for (const row of rows) {
      const v = row?.values?.[i];
      if (v && v.value != null && Number.isFinite(v.value)) {
        sum += v.value;
        found += 1;
        if (v.source?.tag) componentTags.add(v.source.tag);
        if (!source) source = v.source;
      }
    }
    return { period: p, value: found > 0 ? sum : null, source };
  });
  return { key: label, label, values, format: 'currency', componentTags: Array.from(componentTags) };
}

/** Per-period ratio of two rows (num/den); null when either side missing or den 0. */
function ratioRows(numRow, denRow, label, periods) {
  const values = periods.map((p, i) => {
    const n = numRow?.values?.[i];
    const d = denRow?.values?.[i];
    const nOk = n && n.value != null && Number.isFinite(n.value);
    const dOk = d && d.value != null && Number.isFinite(d.value) && d.value !== 0;
    return {
      period: p,
      value: nOk && dOk ? n.value / d.value : null,
      source: nOk ? n.source : null,
    };
  });
  return { key: label, label, values, format: 'ratio' };
}

function zone(level, detail = null) {
  return { level, label: ZONE_LABELS[level] || level, detail };
}

/** Map a value to a zone given ordered bands. Bands are evaluated in order;
 *  the first matching predicate wins. */
function bandZone(value, bands) {
  if (value == null || !Number.isFinite(value)) return zone('na');
  for (const [predicate, level] of bands) {
    if (predicate(value)) return zone(level);
  }
  return zone('na');
}

// ----------------------------------------------------------------------------
// Altman Z''-Score (1995 four-variable model, non-manufacturers / all industries
// EXCEPT financials). Z'' = 6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·X4
//   X1 = working capital / total assets
//   X2 = retained earnings / total assets
//   X3 = EBIT (operating income) / total assets
//   X4 = book equity / total liabilities
// Zones: > 2.60 safe · 1.10–2.60 grey · < 1.10 distress
// Chosen over the original 1968 Z because it needs no market cap and is the
// published variant for non-manufacturing firms — it works for the whole
// non-financial universe this page serves.
// ----------------------------------------------------------------------------

export const Z_DOUBLE_PRIME = {
  weights: { x1: 6.56, x2: 3.26, x3: 6.72, x4: 1.05 },
  thresholds: { safe: 2.6, distress: 1.1 },
  formula: "Z'' = 6.56·(WC/TA) + 3.26·(RE/TA) + 6.72·(EBIT/TA) + 1.05·(Equity/Liabilities)",
};

export function computeZScore({ currentAssets, currentLiabilities, totalAssets, retainedEarnings, operatingIncome, equity, totalLiabilities }) {
  const need = { currentAssets, currentLiabilities, totalAssets, retainedEarnings, operatingIncome, equity, totalLiabilities };
  const missing = Object.entries(need)
    .filter(([, v]) => v == null || !Number.isFinite(v))
    .map(([k]) => k);
  if (missing.length > 0 || totalAssets === 0 || totalLiabilities === 0) {
    return { value: null, zone: zone('na'), missing };
  }

  const w = Z_DOUBLE_PRIME.weights;
  const x1 = (currentAssets - currentLiabilities) / totalAssets;
  const x2 = retainedEarnings / totalAssets;
  const x3 = operatingIncome / totalAssets;
  const x4 = equity / totalLiabilities;
  const value = w.x1 * x1 + w.x2 * x2 + w.x3 * x3 + w.x4 * x4;

  const t = Z_DOUBLE_PRIME.thresholds;
  const z =
    value > t.safe ? { level: 'low', label: 'Safe zone' }
    : value >= t.distress ? { level: 'elevated', label: 'Grey zone' }
    : { level: 'high', label: 'Distress zone' };

  return {
    value,
    zone: z,
    missing: [],
    inputs: [
      { id: 'x1', label: 'Working capital / Total assets', ratio: x1, weight: w.x1, contribution: w.x1 * x1 },
      { id: 'x2', label: 'Retained earnings / Total assets', ratio: x2, weight: w.x2, contribution: w.x2 * x2 },
      { id: 'x3', label: 'EBIT / Total assets', ratio: x3, weight: w.x3, contribution: w.x3 * x3 },
      { id: 'x4', label: 'Book equity / Total liabilities', ratio: x4, weight: w.x4, contribution: w.x4 * x4 },
    ],
  };
}

// ----------------------------------------------------------------------------
// Threshold bands (stated in the UI methodology verbatim).
// These are standard analyst conventions, not proprietary scores.
// ----------------------------------------------------------------------------

const BANDS = {
  interestCoverage: [
    [(v) => v >= 8, 'low'],
    [(v) => v >= 3, 'moderate'],
    [(v) => v >= 1.5, 'elevated'],
    [() => true, 'high'],
  ],
  debtToEquity: [
    [(v) => v < 0, 'high'], // negative equity
    [(v) => v < 0.5, 'low'],
    [(v) => v < 1.5, 'moderate'],
    [(v) => v < 3, 'elevated'],
    [() => true, 'high'],
  ],
  liabilitiesToAssets: [
    [(v) => v < 0.5, 'low'],
    [(v) => v < 0.7, 'moderate'],
    [(v) => v < 0.85, 'elevated'],
    [() => true, 'high'],
  ],
  ocfToDebt: [
    [(v) => v >= 0.4, 'low'],
    [(v) => v >= 0.2, 'moderate'],
    [(v) => v >= 0.1, 'elevated'],
    [() => true, 'high'],
  ],
  currentRatio: [
    [(v) => v >= 2, 'low'],
    [(v) => v >= 1.2, 'moderate'],
    [(v) => v >= 1.0, 'elevated'],
    [() => true, 'high'],
  ],
  quickRatio: [
    [(v) => v >= 1.5, 'low'],
    [(v) => v >= 1.0, 'moderate'],
    [(v) => v >= 0.7, 'elevated'],
    [() => true, 'high'],
  ],
  cashToAssets: [
    [(v) => v >= 0.15, 'low'],
    [(v) => v >= 0.07, 'moderate'],
    [(v) => v >= 0.03, 'elevated'],
    [() => true, 'high'],
  ],
  netMargin: [
    [(v) => v >= 0.10, 'low'],
    [(v) => v >= 0.03, 'moderate'],
    [(v) => v >= 0, 'elevated'],
    [() => true, 'high'],
  ],
  // ---- bank-specific ----
  bankEquityToAssets: [
    [(v) => v >= 0.11, 'low'],
    [(v) => v >= 0.08, 'moderate'],
    [(v) => v >= 0.05, 'elevated'],
    [() => true, 'high'],
  ],
  reserveCoverage: [ // allowance / gross loans
    [(v) => v >= 0.015, 'low'],
    [(v) => v >= 0.010, 'moderate'],
    [(v) => v >= 0.005, 'elevated'],
    [() => true, 'high'],
  ],
  provisionRate: [ // provision / gross loans, annual
    [(v) => v <= 0.0025, 'low'],
    [(v) => v <= 0.006, 'moderate'],
    [(v) => v <= 0.012, 'elevated'],
    [() => true, 'high'],
  ],
  nplRatio: [ // nonaccrual / gross loans
    [(v) => v <= 0.005, 'low'],
    [(v) => v <= 0.01, 'moderate'],
    [(v) => v <= 0.02, 'elevated'],
    [() => true, 'high'],
  ],
  loansToDeposits: [
    [(v) => v <= 0.8, 'low'],
    [(v) => v <= 1.0, 'moderate'],
    [(v) => v <= 1.1, 'elevated'],
    [() => true, 'high'],
  ],
  lossRatio: [ // insurance: claims incurred / premiums earned
    [(v) => v <= 0.65, 'low'],
    [(v) => v <= 0.8, 'moderate'],
    [(v) => v <= 0.95, 'elevated'],
    [() => true, 'high'],
  ],
  texasRatio: [ // nonaccruals / (tangible equity + allowance)
    [(v) => v < 0.3, 'low'],
    [(v) => v < 0.6, 'moderate'],
    [(v) => v < 1.0, 'elevated'],
    [() => true, 'high'],
  ],
  accruals: [ // (NI - OCF) / total assets, Sloan (1996)
    [(v) => v <= 0, 'low'],
    [(v) => v < 0.05, 'moderate'],
    [(v) => v < 0.10, 'elevated'],
    [() => true, 'high'],
  ],
  receivablesGap: [ // receivables growth - revenue growth, latest FY
    [(v) => v <= 0.03, 'low'],
    [(v) => v <= 0.08, 'moderate'],
    [(v) => v <= 0.15, 'elevated'],
    [() => true, 'high'],
  ],
};

// ----------------------------------------------------------------------------
// Metric assembly
// ----------------------------------------------------------------------------

function makeMetric({ id, label, pillar, format, row, periods, cik, bands, why, note = null, invertDeltaGood = false, extraSources = [] }) {
  const latest = latestPoint(row);
  const prior = row ? pointAt(row, row.values.findIndex((v) => v === latest) + 1) : null;
  const value = latest ? latest.value : null;
  const priorValue = prior ? prior.value : null;
  const z = bands ? bandZone(value, bands) : zone(value == null ? 'na' : 'info');
  // If the most recent tagged value is older than the newest fiscal year on
  // record, say so plainly rather than presenting a stale number as current.
  const staleness =
    latest && periods[0] && latest.period?.fy != null && latest.period.fy < periods[0].fy
      ? `Latest tagged value is FY${latest.period.fy} \u2014 this filer has not tagged this item in more recent annual filings.`
      : null;
  const combinedSources = [...sourcesOf(cik, latest), ...extraSources];
  const seenTags = new Set();
  const seriesOldestFirst = seriesOf(row, periods).slice(0, MAX_YEARS).reverse();
  return {
    id,
    label,
    pillar,
    format,
    value,
    prior: priorValue,
    delta: value != null && priorValue != null ? value - priorValue : null,
    deltaGoodWhenDown: invertDeltaGood,
    zone: z,
    why,
    note: [note, staleness].filter(Boolean).join(' ') || null,
    series: seriesOldestFirst, // oldest → newest for trend bars
    trajectory: classifyTrajectory(seriesOldestFirst, invertDeltaGood),
    sources: combinedSources.filter((s) => (seenTags.has(s.tag) ? false : (seenTags.add(s.tag), true))),
  };
}

const FINANCIAL_GROUPS = new Set([INDUSTRY_GROUPS.BANKING, INDUSTRY_GROUPS.INSURANCE]);

/**
 * Main entry: assess risk from a companyfacts JSON + SIC code.
 * @returns {{ industry, periods, zScore, metrics, watchItems, notes }}
 */
export function assessRisk(facts, sicCode, cik) {
  const group = classifyIndustry(sicCode);
  const isBank = group === INDUSTRY_GROUPS.BANKING;
  const isInsurer = group === INDUSTRY_GROUPS.INSURANCE;
  const isFinancial = FINANCIAL_GROUPS.has(group);

  const allPeriods = extractAnnualPeriods(facts);
  const periods = allPeriods.slice(0, MAX_YEARS);
  const notes = [];

  if (periods.length === 0) {
    return {
      industry: { group, label: industryLabel(group), isFinancial, isBank },
      periods: [],
      zScore: null,
      models: { zmijewski: null, beneish: null },
      metrics: [],
      watchItems: [],
      notes: ['No annual (10-K) XBRL periods found for this filer. Newly public companies and foreign private issuers (20-F filers) may not expose us-gaap annual facts.'],
    };
  }

  // Pull every base row once. buildMetricRow applies industry tag overrides
  // (e.g. banks have no currentAssets — the override returns an empty chain).
  const R = (key, label, format = 'currency') => buildMetricRow(facts, key, label, periods, format, group);

  const rows = {
    totalAssets: R('totalAssets', 'Total assets'),
    totalLiabilities: R('totalLiabilities', 'Total liabilities'),
    equity: R('stockholdersEquity', 'Stockholders equity'),
    retainedEarnings: R('retainedEarnings', 'Retained earnings'),
    currentAssets: R('currentAssets', 'Current assets'),
    currentLiabilities: R('currentLiabilities', 'Current liabilities'),
    inventory: R('inventory', 'Inventory'),
    cash: R('cash', 'Cash & equivalents'),
    operatingIncome: R('operatingIncome', 'Operating income'),
    interestExpense: R('interestExpense', 'Interest expense'),
    revenue: R('revenue', 'Revenue'),
    netIncome: R('netIncome', 'Net income'),
    ocf: R('operatingCashFlow', 'Operating cash flow'),
    longTermDebt: R('longTermDebt', 'Long-term debt'),
    shortTermDebt: R('shortTermDebt', 'Short-term debt'),
    receivables: R('receivables', 'Receivables'),
    cogs: R('costOfRevenue', 'Cost of revenue'),
    ppe: R('ppe', 'PP&E, net'),
    securities: R('shortTermInvestments', 'Short-term investments'),
    depreciation: R('depreciationAmortization', 'Depreciation & amortization'),
    sga: R('sga', 'SG&A expense'),
    goodwill: R('goodwill', 'Goodwill'),
    intangibles: R('intangibles', 'Intangibles'),
  };

  const metrics = [];

  // ---------- shared pillar: capital structure ----------
  const totalDebt = sumRows([rows.longTermDebt, rows.shortTermDebt], 'Total debt', periods);
  const debtToEquity = ratioRows(rows.totalLiabilities, rows.equity, 'Liabilities / Equity', periods);
  const liabToAssets = ratioRows(rows.totalLiabilities, rows.totalAssets, 'Liabilities / Assets', periods);

  const eqLatest = latestPoint(rows.equity);
  if (eqLatest && eqLatest.value < 0) {
    notes.push('Stockholders\u2019 equity is negative in the latest fiscal year. This can reflect sustained buybacks and accumulated deficits rather than insolvency \u2014 weigh interest coverage and cash generation, and read the equity note in the 10-K.');
  }

  // ---------- BANK MODE ----------
  if (isBank) {
    const loansNet = R('loans', 'Loans, net');
    const allowance = R('allowanceForLoanLoss', 'Allowance for credit losses');
    const provision = R('provisionForLoanLoss', 'Provision for credit losses');
    const npl = R('nonperformingLoans', 'Nonaccrual loans');
    const deposits = R('deposits', 'Deposits');

    const grossLoans = sumRows([loansNet, allowance], 'Gross loans (net + allowance)', periods);
    const reserveCov = ratioRows(allowance, grossLoans, 'Allowance / gross loans', periods);
    const provisionRate = ratioRows(provision, grossLoans, 'Provision / gross loans', periods);
    const nplRatio = ratioRows(npl, grossLoans, 'Nonaccrual / gross loans', periods);
    const loansToDeposits = ratioRows(loansNet, deposits, 'Loans / deposits', periods);
    const equityToAssets = ratioRows(rows.equity, rows.totalAssets, 'Equity / assets', periods);
    const cashToAssets = ratioRows(rows.cash, rows.totalAssets, 'Cash / assets', periods);
    const htmAC = R('htmSecuritiesAmortizedCost', 'HTM amortized cost');
    const htmFV = R('htmSecuritiesFairValue', 'HTM fair value');
    const nibRow = R('noninterestBearingDeposits', 'Noninterest-bearing deposits');
    const htmUnrealizedRow = {
      key: 'htmUnrealized', label: 'HTM unrealized', format: 'currency',
      values: periods.map((p, i) => {
        const f = htmFV.values[i];
        const a = htmAC.values[i];
        const ok = f?.value != null && a?.value != null;
        return { period: p, value: ok ? f.value - a.value : null, source: ok ? a.source : null };
      }),
    };
    const htmAdjEquityRow = {
      key: 'htmAdjEquity', label: 'Adjusted equity / assets', format: 'ratio',
      values: periods.map((p, i) => {
        const e = rows.equity.values[i];
        const t = rows.totalAssets.values[i];
        const u = htmUnrealizedRow.values[i];
        const ok = e?.value != null && t?.value != null && t.value !== 0 && u?.value != null;
        return { period: p, value: ok ? (e.value + u.value) / t.value : null, source: e?.source || null };
      }),
    };
    const tangibleEquityRow = {
      key: 'tangibleEquity', label: 'Tangible equity', format: 'currency',
      values: periods.map((p, i) => {
        const e = rows.equity.values[i];
        const g = rows.goodwill.values[i];
        const n = rows.intangibles.values[i];
        if (e?.value == null) return { period: p, value: null, source: null };
        return { period: p, value: e.value - (g?.value || 0) - (n?.value || 0), source: e.source };
      }),
    };
    const texasDenomRow = sumRows([tangibleEquityRow, allowance], 'Tangible equity + ACL', periods);
    const texasRow = ratioRows(npl, texasDenomRow, 'Texas ratio', periods);
    const nibShareRow = ratioRows(nibRow, deposits, 'NIB / deposits', periods);

    metrics.push(
      makeMetric({
        id: 'reserve_coverage', label: 'Reserve coverage (ACL / gross loans)', pillar: 'credit', format: 'pct',
        row: reserveCov, periods, cik, bands: BANDS.reserveCoverage, invertDeltaGood: false,
        why: 'The allowance for credit losses is the cushion already set aside against loan defaults. Around 1\u20132% of gross loans is typical; thin coverage leaves earnings exposed to charge-offs. A rising ratio can also signal a deteriorating book \u2014 read it with the provision trend below.',
        extraSources: sourcesOf(cik, latestPoint(allowance), latestPoint(loansNet)),
      }),
      makeMetric({
        id: 'provision_rate', label: 'Provision rate (provision / gross loans)', pillar: 'credit', format: 'pct',
        row: provisionRate, periods, cik, bands: BANDS.provisionRate, invertDeltaGood: true,
        why: 'What the bank charged against earnings this year for expected loan losses. A climbing provision rate is the earliest income-statement signal that management sees credit deteriorating.',
        extraSources: sourcesOf(cik, latestPoint(provision)),
      }),
      makeMetric({
        id: 'npl_ratio', label: 'Nonaccrual loans / gross loans', pillar: 'credit', format: 'pct',
        row: nplRatio, periods, cik, bands: BANDS.nplRatio, invertDeltaGood: true,
        why: 'Loans no longer accruing interest \u2014 the loans already going bad. Many large banks tag nonaccrual totals only inside dimensional disclosures the SEC facts API does not expose; if blank here, the figure is in the credit-quality note of the 10-K.',
        note: latestPoint(nplRatio) ? null : 'Not tagged at the consolidated level by this filer \u2014 see the credit quality note in the 10-K.',
        extraSources: sourcesOf(cik, latestPoint(npl)),
      }),
      makeMetric({
        id: 'bank_equity_assets', label: 'Equity / assets', pillar: 'capital', format: 'pct',
        row: equityToAssets, periods, cik, bands: BANDS.bankEquityToAssets,
        why: 'The simplest capital cushion: how much of the balance sheet is funded by shareholders rather than depositors and creditors. Large banks typically run 8\u201312%. Regulatory ratios (CET1, Tier 1 leverage) live in the capital adequacy note of the 10-K.',
      }),
      makeMetric({
        id: 'loans_deposits', label: 'Loans / deposits', pillar: 'liquidity', format: 'pct',
        row: loansToDeposits, periods, cik, bands: BANDS.loansToDeposits, invertDeltaGood: true,
        why: 'How much of the loan book is funded by stable deposits. Above 100% means reliance on wholesale funding, which reprices and flees faster under stress.',
        extraSources: sourcesOf(cik, latestPoint(deposits)),
      }),
      makeMetric({
        id: 'deposits_trend', label: 'Deposits', pillar: 'liquidity', format: 'usd',
        row: deposits, periods, cik, bands: null,
        why: 'The funding base itself. Shrinking deposits force a bank to replace cheap, sticky funding with expensive wholesale borrowings \u2014 the dynamic at the center of recent bank failures.',
      }),
      makeMetric({
        id: 'bank_cash_assets', label: 'Cash / assets', pillar: 'liquidity', format: 'pct',
        row: cashToAssets, periods, cik, bands: null,
        why: 'On-balance-sheet liquidity available to meet outflows before selling securities or borrowing.',
        note: 'Narrow cash only \u2014 securities portfolios and deposits placed at other banks are additional liquidity sources detailed in the 10-K.',
      }),
      makeMetric({
        id: 'texas_ratio', label: 'Texas ratio (nonaccruals / (tangible equity + ACL))', pillar: 'credit', format: 'pct',
        row: texasRow, periods, cik, bands: BANDS.texasRatio, invertDeltaGood: true,
        why: 'The classic bank-failure screen from the S&L era: loans already gone bad measured against the capital actually available to absorb them \u2014 tangible common equity plus reserves. Readings approaching 100% preceded most historical bank failures.',
        note: latestPoint(texasRow)
          ? 'Tangible equity = stockholders equity \u2212 goodwill \u2212 intangibles; untagged intangible components treated as 0.'
          : 'Requires consolidated nonaccrual tagging, which the largest banks often report only dimensionally \u2014 see the credit-quality note in the 10-K.',
        extraSources: sourcesOf(cik, latestPoint(npl), latestPoint(allowance), latestPoint(rows.goodwill)),
      }),
      makeMetric({
        id: 'htm_unrealized', label: 'HTM securities unrealized gain/(loss)', pillar: 'capital', format: 'usd',
        row: htmUnrealizedRow, periods, cik, bands: null,
        why: 'Held-to-maturity bonds are carried at cost, so rate-driven losses sit outside both equity and AOCI \u2014 the dynamic at the center of the March 2023 bank failures. Computed as tagged fair value minus tagged amortized cost.',
        note: latestPoint(htmUnrealizedRow) ? null : 'No held-to-maturity portfolio tagged at the consolidated level.',
        extraSources: sourcesOf(cik, latestPoint(htmFV), latestPoint(htmAC)),
      }),
      makeMetric({
        id: 'htm_adj_equity', label: 'Equity / assets after HTM mark', pillar: 'capital', format: 'pct',
        row: htmAdjEquityRow, periods, cik, bands: BANDS.bankEquityToAssets,
        why: 'The capital cushion if held-to-maturity securities were carried at fair value \u2014 the stress question regulators and depositors started asking in March 2023.',
        note: latestPoint(htmAdjEquityRow) ? null : 'Computable only when both HTM amortized cost and fair value are tagged.',
      }),
      makeMetric({
        id: 'nib_deposit_share', label: 'Noninterest-bearing share of deposits', pillar: 'liquidity', format: 'pct',
        row: nibShareRow, periods, cik, bands: null,
        why: 'Noninterest-bearing balances are cheap funding, but they are typically corporate operating accounts that can exceed insurance limits \u2014 a high share cuts funding costs while concentrating run risk, so the trend matters more than the level.',
        note: latestPoint(nibShareRow) ? null : 'Noninterest-bearing deposits not tagged separately by this filer.',
      }),
    );
  }

  // ---------- INSURER MODE ----------
  if (isInsurer) {
    const premiums = R('premiumsEarned', 'Premiums earned');
    const claims = R('lossesIncurred', 'Claims incurred');
    const lossRatio = ratioRows(claims, premiums, 'Loss ratio', periods);
    const equityToAssets = ratioRows(rows.equity, rows.totalAssets, 'Equity / assets', periods);

    metrics.push(
      makeMetric({
        id: 'loss_ratio', label: 'Loss ratio (claims / premiums earned)', pillar: 'credit', format: 'pct',
        row: lossRatio, periods, cik, bands: BANDS.lossRatio, invertDeltaGood: true,
        why: 'The share of premium income consumed by policyholder claims \u2014 the core underwriting risk gauge. Sustained ratios near or above 100% mean underwriting losses covered only by investment income.',
        extraSources: sourcesOf(cik, latestPoint(claims), latestPoint(premiums)),
      }),
      makeMetric({
        id: 'ins_equity_assets', label: 'Equity / assets', pillar: 'capital', format: 'pct',
        row: equityToAssets, periods, cik, bands: null,
        why: 'Capital cushion against reserve deterioration and investment losses. Statutory capital ratios live in the insurance subsidiaries\u2019 regulatory filings.',
      }),
    );
  }

  // ---------- NON-FINANCIAL credit pillar ----------
  let zScore = null;
  let zmijewski = null;
  let beneish = null;
  if (!isFinancial) {
    const v = (row) => latestPoint(row)?.value ?? null;
    const reLatest = latestPoint(rows.retainedEarnings);
    const zCautions = [];
    if (group === INDUSTRY_GROUPS.REIT) {
      zCautions.push('Asset-heavy REIT balance sheets often sit low on Z\u2033 by construction \u2014 weigh interest coverage and liabilities/assets more heavily here.');
    }
    if (reLatest && reLatest.value < 0 && eqLatest && eqLatest.value >= 0) {
      zCautions.push('Retained earnings are negative \u2014 common after years of heavy buybacks \u2014 which drags the X2 input down without by itself implying distress.');
    }
    const zRaw = computeZScore({
      currentAssets: v(rows.currentAssets),
      currentLiabilities: v(rows.currentLiabilities),
      totalAssets: v(rows.totalAssets),
      retainedEarnings: v(rows.retainedEarnings),
      operatingIncome: v(rows.operatingIncome),
      equity: v(rows.equity),
      totalLiabilities: v(rows.totalLiabilities),
    });
    zScore = {
      ...zRaw,
      formula: Z_DOUBLE_PRIME.formula,
      thresholds: Z_DOUBLE_PRIME.thresholds,
      fiscalYear: periods[0]?.fy ?? null,
      sources: sourcesOf(
        cik,
        latestPoint(rows.currentAssets),
        latestPoint(rows.currentLiabilities),
        latestPoint(rows.totalAssets),
        latestPoint(rows.retainedEarnings),
        latestPoint(rows.operatingIncome),
        latestPoint(rows.equity),
        latestPoint(rows.totalLiabilities),
      ),
      caution: zCautions.join(' ') || null,
    };

    const interestCoverage = ratioRows(rows.operatingIncome, rows.interestExpense, 'Interest coverage', periods);
    const ocfToDebt = ratioRows(rows.ocf, totalDebt, 'OCF / total debt', periods);
    const debtLatest = latestPoint(totalDebt);
    const cashLatest = latestPoint(rows.cash);

    metrics.push(
      makeMetric({
        id: 'interest_coverage', label: 'Interest coverage (EBIT / interest expense)', pillar: 'credit', format: 'x',
        row: interestCoverage, periods, cik, bands: BANDS.interestCoverage,
        why: 'How many times operating profit covers the interest bill. Below ~1.5\u00d7 a company is one weak year from missing payments; above 8\u00d7 debt service is a rounding error.',
        note: latestPoint(rows.interestExpense) ? null : 'Interest expense is not tagged separately by this filer \u2014 coverage cannot be computed from the facts API.',
        extraSources: sourcesOf(cik, latestPoint(rows.interestExpense), latestPoint(rows.operatingIncome)),
      }),
      makeMetric({
        id: 'ocf_to_debt', label: 'Operating cash flow / total debt', pillar: 'credit', format: 'pct',
        row: ocfToDebt, periods, cik, bands: BANDS.ocfToDebt,
        why: 'The repayment test: what share of total debt one year of operating cash flow could retire. Rating agencies lean on this family of ratios. Total debt here sums the tagged short- and long-term debt components.',
        note: debtLatest ? `Debt components found: ${totalDebt.componentTags.join(', ') || 'none'}.` : 'No tagged debt found \u2014 this filer may be debt-free or tag borrowings under nonstandard concepts.',
        extraSources: sourcesOf(cik, latestPoint(rows.ocf), debtLatest),
      }),
      makeMetric({
        id: 'net_debt', label: 'Net debt (total debt \u2212 cash)', pillar: 'credit', format: 'usd',
        row: {
          key: 'netDebt', label: 'Net debt', format: 'currency',
          values: periods.map((p, i) => {
            const d = totalDebt.values[i];
            const c = rows.cash.values[i];
            const dOk = d?.value != null, cOk = c?.value != null;
            return { period: p, value: dOk || cOk ? (d?.value || 0) - (c?.value || 0) : null, source: d?.source || c?.source || null };
          }),
        },
        periods, cik, bands: null, invertDeltaGood: true,
        why: 'Debt the business actually has to earn its way out of after netting cash. A multi-year climb in net debt alongside flat earnings is the classic slow-motion credit deterioration.',
        extraSources: sourcesOf(cik, debtLatest, cashLatest),
      }),
    );

    // ---------- research models: Zmijewski probit + Beneish M-Score ----------
    const at = (row, i) => pointAt(row, i)?.value ?? null;
    const zm = computeZmijewski({
      netIncome: at(rows.netIncome, 0),
      totalAssets: at(rows.totalAssets, 0),
      totalLiabilities: at(rows.totalLiabilities, 0),
      currentAssets: at(rows.currentAssets, 0),
      currentLiabilities: at(rows.currentLiabilities, 0),
    });
    zmijewski = {
      ...zm,
      formula: ZMIJEWSKI.formula,
      bands: ZMIJEWSKI.bands,
      fiscalYear: periods[0]?.fy ?? null,
      sources: sourcesOf(
        cik,
        pointAt(rows.netIncome, 0), pointAt(rows.totalAssets, 0), pointAt(rows.totalLiabilities, 0),
        pointAt(rows.currentAssets, 0), pointAt(rows.currentLiabilities, 0),
      ),
    };

    if (periods.length >= 2) {
      const year = (i) => ({
        receivables: at(rows.receivables, i), revenue: at(rows.revenue, i), cogs: at(rows.cogs, i),
        currentAssets: at(rows.currentAssets, i), ppe: at(rows.ppe, i), securities: at(rows.securities, i),
        depreciation: at(rows.depreciation, i), sga: at(rows.sga, i), totalAssets: at(rows.totalAssets, i),
        currentLiabilities: at(rows.currentLiabilities, i), longTermDebt: at(rows.longTermDebt, i),
        netIncome: at(rows.netIncome, i), cfo: at(rows.ocf, i),
      });
      const bn = computeBeneish(year(0), year(1));
      const bnRows = [rows.receivables, rows.revenue, rows.cogs, rows.currentAssets, rows.ppe, rows.securities,
        rows.depreciation, rows.sga, rows.totalAssets, rows.currentLiabilities, rows.longTermDebt, rows.netIncome, rows.ocf];
      beneish = {
        ...bn,
        fiscalYear: periods[0]?.fy ?? null,
        priorFiscalYear: periods[1]?.fy ?? null,
        sources: sourcesOf(cik, ...bnRows.map((r) => pointAt(r, 0)), ...bnRows.map((r) => pointAt(r, 1))),
      };
    } else {
      beneish = {
        value: null, variant: null, zone: { level: 'na', label: 'N/A' }, indices: [], assumptions: [],
        missing: ['two consecutive fiscal years of 10-K facts required'],
        thresholds: BENEISH.thresholds, formula: BENEISH.formula8,
        fiscalYear: periods[0]?.fy ?? null, priorFiscalYear: null, sources: [],
      };
    }

    // ---------- earnings quality & forensic flags ----------
    const accrualsRow = {
      key: 'accruals', label: 'Accruals / assets', format: 'ratio',
      values: periods.map((p, i) => {
        const ni = rows.netIncome.values[i];
        const cf = rows.ocf.values[i];
        const ta = rows.totalAssets.values[i];
        const ok = ni?.value != null && cf?.value != null && ta?.value != null && ta.value !== 0;
        return { period: p, value: ok ? (ni.value - cf.value) / ta.value : null, source: ni?.source || null };
      }),
    };
    const grow = (row, i) => {
      const a = row.values[i];
      const b = row.values[i + 1];
      return a?.value != null && b?.value != null && b.value > 0 ? a.value / b.value - 1 : null;
    };
    const recGapRow = {
      key: 'recGap', label: 'Receivables vs revenue growth', format: 'ratio',
      values: periods.map((p, i) => {
        const gr = grow(rows.receivables, i);
        const gs = grow(rows.revenue, i);
        return { period: p, value: gr != null && gs != null ? gr - gs : null, source: rows.receivables.values[i]?.source || null };
      }),
    };
    metrics.push(
      makeMetric({
        id: 'accruals_ratio', label: 'Accruals / assets (net income − operating cash flow)', pillar: 'quality', format: 'pct',
        row: accrualsRow, periods, cik, bands: BANDS.accruals, invertDeltaGood: true,
        why: 'The Sloan (1996) earnings-quality test: the share of reported income not backed by operating cash flow. Persistently high accruals predict weaker future earnings and precede a disproportionate share of restatements.',
        extraSources: sourcesOf(cik, latestPoint(rows.ocf), latestPoint(rows.totalAssets)),
      }),
      makeMetric({
        id: 'receivables_gap', label: 'Receivables growth − revenue growth', pillar: 'quality', format: 'pct',
        row: recGapRow, periods, cik, bands: BANDS.receivablesGap, invertDeltaGood: true,
        why: 'When receivables grow much faster than sales, revenue may be pulled forward or collection is slipping — among the most common precursor flags in the accounting-fraud literature. Shown as the growth differential each fiscal year.',
        note: latestPoint(recGapRow) ? null : 'Requires receivables and revenue tagged in consecutive fiscal years.',
        extraSources: sourcesOf(cik, latestPoint(rows.receivables), latestPoint(rows.revenue)),
      }),
    );
  }

  // ---------- shared: capital pillar ----------
  metrics.push(
    makeMetric({
      id: 'debt_to_equity', label: 'Liabilities / equity', pillar: 'capital', format: 'x',
      row: debtToEquity, periods, cik, bands: isFinancial ? null : BANDS.debtToEquity, invertDeltaGood: true,
      why: isFinancial
        ? 'Financial institutions are structurally levered \u2014 read this with the capital metrics above rather than against industrial benchmarks.'
        : 'Total obligations per dollar of shareholder capital. Above ~3\u00d7, equity holders own a sliver of the balance sheet and refinancing risk dominates. Negative equity makes the ratio meaningless \u2014 see the note above if flagged.',
    }),
    makeMetric({
      id: 'liab_to_assets', label: 'Liabilities / assets', pillar: 'capital', format: 'pct',
      row: liabToAssets, periods, cik, bands: isFinancial ? null : BANDS.liabilitiesToAssets, invertDeltaGood: true,
      why: 'The share of the asset base financed by creditors. Robust to negative equity, so it is the cleaner leverage gauge for heavily bought-back balance sheets.',
    }),
  );

  // ---------- liquidity pillar (classic ratios; auto-N/A for banks whose
  //            balance sheets are unclassified) ----------
  if (!isBank) {
    const currentRatio = ratioRows(rows.currentAssets, rows.currentLiabilities, 'Current ratio', periods);
    const quickNum = {
      key: 'quickAssets', label: 'Quick assets', format: 'currency',
      values: periods.map((p, i) => {
        const ca = rows.currentAssets.values[i];
        const inv = rows.inventory.values[i];
        if (ca?.value == null) return { period: p, value: null, source: null };
        return { period: p, value: ca.value - (inv?.value || 0), source: ca.source };
      }),
    };
    const quickRatio = ratioRows(quickNum, rows.currentLiabilities, 'Quick ratio', periods);
    const cashToAssets = ratioRows(rows.cash, rows.totalAssets, 'Cash / assets', periods);
    const hasInventory = latestPoint(rows.inventory) != null;

    metrics.push(
      makeMetric({
        id: 'current_ratio', label: 'Current ratio', pillar: 'liquidity', format: 'x',
        row: currentRatio, periods, cik, bands: BANDS.currentRatio,
        why: 'Near-term assets against obligations due within a year. Below 1.0 deserves attention, though capital-light businesses with negative working-capital models (subscriptions, fast-turn retail) run there deliberately.',
      }),
      makeMetric({
        id: 'quick_ratio', label: 'Quick ratio (ex-inventory)', pillar: 'liquidity', format: 'x',
        row: quickRatio, periods, cik, bands: BANDS.quickRatio,
        why: 'The stricter test: can near-cash assets alone cover current liabilities without selling a single unit of inventory.',
        note: hasInventory ? null : 'No inventory tagged \u2014 quick ratio equals the current ratio for this filer.',
      }),
      makeMetric({
        id: 'cash_to_assets', label: 'Cash / assets', pillar: 'liquidity', format: 'pct',
        row: cashToAssets, periods, cik, bands: BANDS.cashToAssets,
        why: 'Dry powder relative to the size of the business \u2014 the buffer that buys time in a downturn or credit-market freeze.',
      }),
    );
  }

  // ---------- profitability stability ----------
  const netMargin = ratioRows(rows.netIncome, rows.revenue, 'Net margin', periods);
  const niSeries = seriesOf(rows.netIncome, periods);
  const lossYears = niSeries.filter((p) => p.value != null && p.value < 0).length;

  metrics.push(
    makeMetric({
      id: 'net_margin', label: 'Net margin', pillar: 'profitability', format: 'pct',
      row: netMargin, periods, cik, bands: BANDS.netMargin,
      why: 'Earnings power is the first line of defense against every other risk on this page \u2014 leverage and thin liquidity are survivable while margins hold.',
    }),
    makeMetric({
      id: 'loss_years', label: `Loss-making fiscal years (last ${niSeries.length})`, pillar: 'profitability', format: 'count',
      row: rows.netIncome, periods, cik, bands: null,
      why: 'How often the bottom line has gone negative in the window shown. Repeated losses compound every credit metric above.',
      note: lossYears > 0 ? `${lossYears} of the last ${niSeries.length} fiscal years closed at a net loss.` : 'No loss years in the window shown.',
    }),
  );
  // overwrite value for the loss-years metric (count, not the raw net income)
  const lossMetric = metrics[metrics.length - 1];
  lossMetric.value = lossYears;
  lossMetric.prior = null;
  lossMetric.delta = null;
  lossMetric.zone = lossYears === 0 ? zone('low') : lossYears === 1 ? zone('moderate') : lossYears === 2 ? zone('elevated') : zone('high');

  // ---------- watch items ----------
  const severityRank = { high: 0, elevated: 1 };
  const flagged = (m) => m && (m.zone.level === 'high' || m.zone.level === 'elevated');
  const watchItems = metrics
    .filter((m) => flagged(m))
    .map((m) => ({ id: m.id, label: m.label, severity: m.zone.level, pillar: m.pillar }));
  if (flagged(zScore)) {
    watchItems.push({ id: 'z_score', label: `Altman Z\u2033 ${zScore.zone.label.toLowerCase()}`, severity: zScore.zone.level, pillar: 'credit' });
  }
  if (flagged(zmijewski)) {
    watchItems.push({ id: 'zmijewski', label: `Zmijewski distress probability ${(zmijewski.probability * 100).toFixed(0)}%`, severity: zmijewski.zone.level, pillar: 'credit' });
  }
  if (flagged(beneish)) {
    watchItems.push({ id: 'beneish', label: `Beneish M-Score in ${beneish.zone.label.toLowerCase()}`, severity: beneish.zone.level, pillar: 'quality' });
  }
  for (const m of metrics) {
    if (m.trajectory?.direction === 'deteriorating' && m.trajectory.steps >= 3 && m.zone.level !== 'high') {
      watchItems.push({ id: `${m.id}_trend`, label: `${m.label} \u2014 worsening ${m.trajectory.years} straight FYs`, severity: 'elevated', pillar: m.pillar });
    }
  }
  const modelIds = new Set(['z_score', 'zmijewski', 'beneish']);
  watchItems.sort((a, b) => {
    const ra = (severityRank[a.severity] ?? 9) * 2 + (modelIds.has(a.id) ? 0 : 1);
    const rb = (severityRank[b.severity] ?? 9) * 2 + (modelIds.has(b.id) ? 0 : 1);
    return ra - rb;
  });

  if (isBank) {
    notes.push('Bank balance sheets are unclassified (no current vs. noncurrent split) and Altman Z-Scores are not defined for financial institutions \u2014 this profile uses the bank credit lens instead: asset quality, reserves, capital, and funding. Zmijewski and Beneish models are likewise estimated on non-financial samples and are not applied.');
  }

  return {
    industry: { group, label: industryLabel(group), isFinancial, isBank },
    periods,
    zScore,
    models: { zmijewski, beneish },
    metrics,
    watchItems,
    notes,
  };
}

// Risk-language terms for the latest-10-K scan (used by the API route; kept
// here so the term list is unit-testable and visible in one place).
export const RISK_LANGUAGE_TERMS = [
  'going concern',
  'substantial doubt',
  'covenant',
  'event of default',
  'waiver',
  'downgrade',
  'material weakness',
  'restatement',
];

/** Scan filing text for literal risk-language terms; return counts + excerpts.
 *  Matching is case-insensitive and literal — no model judgment, just where the
 *  language appears, so the reader can open the source and decide. */
export function scanRiskLanguage(text, terms = RISK_LANGUAGE_TERMS, { maxExcerpts = 2, excerptChars = 380 } = {}) {
  const paragraphs = String(text || '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => {
      if (p.length < 60) return false;
      // Inline-XBRL hidden context blocks and dense numeric tables survive HTML
      // stripping as digit-heavy pseudo-paragraphs; they inflate counts and make
      // garbage excerpts. Real prose rarely exceeds ~20% digit density.
      const digits = (p.match(/[0-9]/g) || []).length;
      return digits / p.length <= 0.2;
    });

  // A paragraph can pass the density prefilter and still be inline-XBRL soup
  // (long CamelCase member names dilute digit share). Validate each match's
  // LOCAL window instead: 9+ consecutive digits (CIKs, raw fact values \u2014
  // prose always comma-formats), local digit density, or repeated CamelCase
  // \u2026Member tokens all mark machine context, never disclosure prose.
  const WINDOW = 150;
  const looksMachineContext = (paragraph, at, needleLen) => {
    const start = Math.max(0, at - WINDOW);
    const w = paragraph.slice(start, at + needleLen + WINDOW);
    if (/\d{9,}/.test(w)) return true;
    const digits = (w.match(/[0-9]/g) || []).length;
    if (digits / w.length > 0.2) return true;
    if ((w.match(/[a-z]Member\b/g) || []).length >= 2) return true;
    return false;
  };

  return terms.map((term) => {
    const needle = term.toLowerCase();
    let count = 0;
    const excerpts = [];
    for (const p of paragraphs) {
      const lower = p.toLowerCase();
      let idx = lower.indexOf(needle);
      let tookExcerptHere = false;
      while (idx !== -1) {
        if (!looksMachineContext(p, idx, needle.length)) {
          count += 1;
          if (!tookExcerptHere && excerpts.length < maxExcerpts) {
            const start = Math.max(0, idx - Math.floor((excerptChars - needle.length) / 2));
            let snippet = p.slice(start, start + excerptChars).trim();
            if (start > 0) snippet = '\u2026' + snippet;
            if (start + excerptChars < p.length) snippet = snippet + '\u2026';
            excerpts.push(snippet);
            tookExcerptHere = true;
          }
        }
        idx = lower.indexOf(needle, idx + needle.length);
      }
    }
    return { term, count, excerpts };
  });
}

// ============================================================================
// Research models — published academic formulas, fully stated, no black boxes.
//   Zmijewski (1984): probit distress probability, three accounting ratios.
//   Beneish (1999): M-Score earnings-manipulation screen (8- and 5-variable).
// Both estimated on non-financial samples; not applied to banks/insurers.
// ============================================================================

/** Abramowitz & Stegun 7.1.26 erf approximation (|error| < 1.5e-7). */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

/** Standard normal CDF. */
export function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export const ZMIJEWSKI = {
  coefficients: { intercept: -4.336, roa: -4.513, tlta: 5.679, cacl: 0.004 },
  formula: 'X = \u22124.336 \u2212 4.513\u00b7(NI/TA) + 5.679\u00b7(TL/TA) + 0.004\u00b7(CA/CL); P(distress) = \u03a6(X)',
  bands: { low: 0.05, moderate: 0.20, elevated: 0.50 },
};

export function computeZmijewski({ netIncome, totalAssets, totalLiabilities, currentAssets, currentLiabilities }) {
  const need = { netIncome, totalAssets, totalLiabilities, currentAssets, currentLiabilities };
  const missing = Object.entries(need)
    .filter(([, v]) => v == null || !Number.isFinite(v))
    .map(([k]) => k);
  if (missing.length > 0 || totalAssets === 0 || currentLiabilities === 0) {
    return { value: null, probability: null, zone: { level: 'na', label: 'N/A' }, missing, inputs: [] };
  }
  const c = ZMIJEWSKI.coefficients;
  const roa = netIncome / totalAssets;
  const tlta = totalLiabilities / totalAssets;
  const cacl = currentAssets / currentLiabilities;
  const value = c.intercept + c.roa * roa + c.tlta * tlta + c.cacl * cacl;
  const probability = normalCdf(value);
  const b = ZMIJEWSKI.bands;
  const zone =
    probability < b.low ? { level: 'low', label: 'Low' }
    : probability < b.moderate ? { level: 'moderate', label: 'Moderate' }
    : probability < b.elevated ? { level: 'elevated', label: 'Elevated' }
    : { level: 'high', label: 'High' };
  return {
    value,
    probability,
    zone,
    missing: [],
    inputs: [
      { id: 'roa', label: 'Net income / Total assets', ratio: roa, coefficient: c.roa, contribution: c.roa * roa },
      { id: 'tlta', label: 'Total liabilities / Total assets', ratio: tlta, coefficient: c.tlta, contribution: c.tlta * tlta },
      { id: 'cacl', label: 'Current assets / Current liabilities', ratio: cacl, coefficient: c.cacl, contribution: c.cacl * cacl },
    ],
  };
}

export const BENEISH = {
  eight: { intercept: -4.84, DSRI: 0.92, GMI: 0.528, AQI: 0.404, SGI: 0.892, DEPI: 0.115, SGAI: -0.172, TATA: 4.679, LVGI: -0.327 },
  five: { intercept: -6.065, DSRI: 0.823, GMI: 0.906, AQI: 0.593, SGI: 0.717, TATA: 4.679 },
  thresholds: { flag: -1.78, caution: -2.22 },
  formula8: 'M = \u22124.84 + 0.92\u00b7DSRI + 0.528\u00b7GMI + 0.404\u00b7AQI + 0.892\u00b7SGI + 0.115\u00b7DEPI \u2212 0.172\u00b7SGAI + 4.679\u00b7TATA \u2212 0.327\u00b7LVGI',
  formula5: 'M = \u22126.065 + 0.823\u00b7DSRI + 0.906\u00b7GMI + 0.593\u00b7AQI + 0.717\u00b7SGI + 4.679\u00b7TATA',
};

const BENEISH_LABELS = {
  DSRI: 'Days sales in receivables index',
  GMI: 'Gross margin index',
  AQI: 'Asset quality index',
  SGI: 'Sales growth index',
  DEPI: 'Depreciation index',
  SGAI: 'SG&A index',
  TATA: 'Total accruals / total assets',
  LVGI: 'Leverage index',
};

/**
 * Beneish M-Score from two consecutive fiscal years of inputs.
 * Each year: { receivables, revenue, cogs, currentAssets, ppe, securities,
 *              depreciation, sga, totalAssets, currentLiabilities, longTermDebt,
 *              netIncome, cfo }
 * Falls back to the published 5-variable model when DEPI/SGAI/LVGI inputs are
 * untagged; returns null with a missing list when the 5-variable core is short.
 */
export function computeBeneish(curr, prev) {
  const assumptions = [];
  const missing = [];
  const num = (v) => (v != null && Number.isFinite(v) ? v : null);
  const pos = (v) => (num(v) != null && v > 0 ? v : null);

  const ix = {};

  // DSRI
  {
    const rt = num(curr.receivables), rp = num(prev.receivables);
    const st = pos(curr.revenue), sp = pos(prev.revenue);
    ix.DSRI = rt != null && rp != null && st && sp && rp !== 0 ? (rt / st) / (rp / sp) : null;
    if (ix.DSRI == null) missing.push('DSRI (receivables or revenue)');
  }
  // GMI (requires positive gross margin both years)
  {
    const st = pos(curr.revenue), sp = pos(prev.revenue);
    const ct = num(curr.cogs), cp = num(prev.cogs);
    const gmT = st && ct != null ? (st - ct) / st : null;
    const gmP = sp && cp != null ? (sp - cp) / sp : null;
    ix.GMI = gmT != null && gmP != null && gmT > 0 && gmP > 0 ? gmP / gmT : null;
    if (ix.GMI == null) missing.push('GMI (gross margin unavailable or nonpositive)');
  }
  // AQI
  {
    const soft = (y) => {
      const ta = pos(y.totalAssets), ca = num(y.currentAssets), pp = num(y.ppe);
      if (!ta || ca == null || pp == null) return null;
      const sec = num(y.securities);
      if (sec == null && !assumptions.includes('Short-term securities treated as 0 (not tagged).')) {
        assumptions.push('Short-term securities treated as 0 (not tagged).');
      }
      return 1 - (ca + pp + (sec || 0)) / ta;
    };
    const aT = soft(curr), aP = soft(prev);
    ix.AQI = aT != null && aP != null && aP > 0 ? aT / aP : null;
    if (ix.AQI == null) missing.push('AQI (current assets / PP&E / total assets)');
  }
  // SGI
  {
    const st = pos(curr.revenue), sp = pos(prev.revenue);
    ix.SGI = st && sp ? st / sp : null;
    if (ix.SGI == null) missing.push('SGI (revenue)');
  }
  // TATA
  {
    const ni = num(curr.netIncome), cf = num(curr.cfo), ta = pos(curr.totalAssets);
    ix.TATA = ni != null && cf != null && ta ? (ni - cf) / ta : null;
    if (ix.TATA == null) missing.push('TATA (net income / operating cash flow)');
  }
  // DEPI / SGAI / LVGI — 8-variable extras
  {
    const rate = (y) => {
      const d = pos(y.depreciation), pp = pos(y.ppe);
      return d && pp ? d / (d + pp) : null;
    };
    const rT = rate(curr), rP = rate(prev);
    ix.DEPI = rT != null && rP != null && rT !== 0 ? rP / rT : null;
  }
  {
    const st = pos(curr.revenue), sp = pos(prev.revenue);
    const gt = num(curr.sga), gp = num(prev.sga);
    ix.SGAI = gt != null && gp != null && st && sp && gp !== 0 ? (gt / st) / (gp / sp) : null;
  }
  {
    const lev = (y) => {
      const ta = pos(y.totalAssets), cl = num(y.currentLiabilities);
      if (!ta || cl == null) return null;
      const ltd = num(y.longTermDebt);
      if (ltd == null && !assumptions.includes('Long-term debt treated as 0 in LVGI (not tagged).')) {
        assumptions.push('Long-term debt treated as 0 in LVGI (not tagged).');
      }
      return ((ltd || 0) + cl) / ta;
    };
    const lT = lev(curr), lP = lev(prev);
    ix.LVGI = lT != null && lP != null && lP > 0 ? lT / lP : null;
  }

  const core = ['DSRI', 'GMI', 'AQI', 'SGI', 'TATA'];
  if (core.some((k) => ix[k] == null)) {
    return {
      value: null,
      variant: null,
      zone: { level: 'na', label: 'N/A' },
      indices: [],
      assumptions,
      missing,
      thresholds: BENEISH.thresholds,
      formula: BENEISH.formula8,
    };
  }

  const hasExtras = ix.DEPI != null && ix.SGAI != null && ix.LVGI != null;
  let value;
  let variant;
  let formula;
  if (hasExtras) {
    const w = BENEISH.eight;
    value = w.intercept + w.DSRI * ix.DSRI + w.GMI * ix.GMI + w.AQI * ix.AQI + w.SGI * ix.SGI
      + w.DEPI * ix.DEPI + w.SGAI * ix.SGAI + w.TATA * ix.TATA + w.LVGI * ix.LVGI;
    variant = '8-variable';
    formula = BENEISH.formula8;
  } else {
    const w = BENEISH.five;
    value = w.intercept + w.DSRI * ix.DSRI + w.GMI * ix.GMI + w.AQI * ix.AQI + w.SGI * ix.SGI + w.TATA * ix.TATA;
    variant = '5-variable';
    formula = BENEISH.formula5;
    assumptions.push('DEPI / SGAI / LVGI inputs untagged \u2014 published 5-variable model used.');
  }

  const t = BENEISH.thresholds;
  const zone =
    value > t.flag ? { level: 'high', label: 'Flagged range' }
    : value > t.caution ? { level: 'elevated', label: 'Caution range' }
    : { level: 'low', label: 'Unlikely range' };

  const order = hasExtras ? ['DSRI', 'GMI', 'AQI', 'SGI', 'DEPI', 'SGAI', 'TATA', 'LVGI'] : core;
  return {
    value,
    variant,
    zone,
    indices: order.map((k) => ({ id: k, label: BENEISH_LABELS[k], value: ix[k] })),
    assumptions,
    missing,
    thresholds: t,
    formula,
  };
}

/**
 * Classify the trailing multi-year trajectory of a metric series
 * (oldest \u2192 newest). Research reads dynamics, not snapshots: a metric that is
 * still "moderate" but has worsened several consecutive years is a signal.
 * Returns null unless there is a streak of \u22652 consecutive steps one way.
 */
export function classifyTrajectory(seriesOldestFirst, goodWhenDown = false) {
  const vals = (seriesOldestFirst || [])
    .map((p) => p.value)
    .filter((v) => v != null && Number.isFinite(v));
  if (vals.length < 3) return null;
  const harmful = (a, b) => (goodWhenDown ? b > a : b < a); // step a -> b
  const beneficial = (a, b) => (goodWhenDown ? b < a : b > a);
  const lastA = vals[vals.length - 2];
  const lastB = vals[vals.length - 1];
  let type = null;
  if (harmful(lastA, lastB)) type = 'deteriorating';
  else if (beneficial(lastA, lastB)) type = 'improving';
  else return null;
  let steps = 0;
  for (let i = vals.length - 1; i > 0; i--) {
    const a = vals[i - 1], b = vals[i];
    const same = type === 'deteriorating' ? harmful(a, b) : beneficial(a, b);
    if (!same) break;
    steps += 1;
  }
  if (steps < 2) return null;
  const years = steps + 1;
  return {
    direction: type,
    steps,
    years,
    label: `${type === 'deteriorating' ? 'worsening' : 'improving'} ${years}y`,
  };
}
