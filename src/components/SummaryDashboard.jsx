import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatValue, formatGrowth, computeGrowth, buildMetricRow, periodLabel } from '../utils/xbrlParser.js';

/**
 * Headline summary cards at the top of the Analysis page.
 * Shows the 6 most important metrics with latest value, YoY, 5Y CAGR.
 */
export default function SummaryDashboard({ facts, periods, sicCode }) {
  if (!facts || !periods || periods.length === 0) return null;

  const isBank = () => {
    const sic = parseInt(sicCode, 10) || 0;
    return sic >= 6000 && sic <= 6299;
  };

  // Headline metrics — adjust if bank (since banks have different primary metrics)
  const metricsConfig = isBank()
    ? [
        { key: 'revenue', label: 'Revenue', format: 'currency' },
        { key: 'netIncome', label: 'Net Income', format: 'currency' },
        { key: 'totalAssets', label: 'Total Assets', format: 'currency' },
        { key: 'stockholdersEquity', label: "Stockholders' Equity", format: 'currency' },
        { key: 'epsDiluted', label: 'Diluted EPS', format: 'eps' },
        { key: 'operatingCashFlow', label: 'Operating Cash Flow', format: 'currency' },
      ]
    : [
        { key: 'revenue', label: 'Revenue', format: 'currency' },
        { key: 'netIncome', label: 'Net Income', format: 'currency' },
        { key: 'operatingIncome', label: 'Operating Income', format: 'currency' },
        { key: 'totalAssets', label: 'Total Assets', format: 'currency' },
        { key: 'epsDiluted', label: 'Diluted EPS', format: 'eps' },
        { key: 'operatingCashFlow', label: 'Operating Cash Flow', format: 'currency' },
      ];

  const cards = metricsConfig.map((m) => {
    const row = buildMetricRow(facts, m.key, m.label, periods, m.format, sicCode);
    const growth = computeGrowth(row);
    return { ...m, row, ...growth };
  });

  const latestPeriod = periods[0];

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] uppercase tracking-[0.25em] text-stone-400 font-bold">
          Key Metrics · {periodLabel(latestPeriod)}
        </h3>
        <div className="text-[10px] text-stone-600 uppercase tracking-wider">
          YoY · 5Y CAGR · 10Y CAGR
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {cards.map((card) => (
          <SummaryCard key={card.key} card={card} />
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ card }) {
  const latestText = card.latest != null ? formatValue(card.latest, card.format) : '—';
  const yoy = formatGrowth(card.yoy);
  const cagr5 = formatGrowth(card.cagr5y);
  const cagr10 = formatGrowth(card.cagr10y);

  return (
    <div className="border-2 border-stone-800 bg-stone-900/40 p-4 hover:border-stone-700 transition-colors">
      <div className="text-[10px] uppercase tracking-[0.2em] text-stone-500 mb-1.5">{card.label}</div>
      <div className="text-2xl font-black text-amber-400 mb-2 tabular-nums">{latestText}</div>
      <div className="flex items-center gap-3 text-[11px] font-bold tabular-nums">
        <GrowthPill icon label="YoY" data={yoy} />
        <GrowthPill label="5Y" data={cagr5} />
        <GrowthPill label="10Y" data={cagr10} />
      </div>
    </div>
  );
}

function GrowthPill({ label, data, icon }) {
  const colorClass =
    data.color === 'positive'
      ? 'text-emerald-400'
      : data.color === 'negative'
      ? 'text-rose-400'
      : 'text-stone-500';

  const Icon =
    data.color === 'positive' ? TrendingUp : data.color === 'negative' ? TrendingDown : Minus;

  return (
    <div className={`flex items-center gap-1 ${colorClass}`}>
      {icon && <Icon className="w-3 h-3" />}
      <span className="text-stone-500 text-[10px] uppercase">{label}</span>
      <span>{data.text}</span>
    </div>
  );
}
