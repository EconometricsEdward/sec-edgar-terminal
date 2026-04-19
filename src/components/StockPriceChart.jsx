import React, { useEffect, useState, useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceDot,
} from 'recharts';
import { Loader2, AlertCircle, LineChart as LineChartIcon } from 'lucide-react';

/**
 * Stock price chart with filing date markers AND insider transaction markers.
 *
 * Props:
 *   ticker:         Ticker symbol
 *   filings:        Array of { form, filingDate, documentUrl } for 10-K/10-Q markers
 *   insiderMarkers: Array of { date, direction, ownerName, shares, price, value, xmlUrl }
 *                   direction is 'buy' or 'sell'
 *   height:         Chart height (default 360)
 */
export default function StockPriceChart({ ticker, filings = [], insiderMarkers = [], height = 360 }) {
  const [prices, setPrices] = useState(null);
  const [source, setSource] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    const fetchPrices = async () => {
      setLoading(true);
      setError(null);
      setPrices(null);
      setSource(null);
      try {
        const res = await fetch(`/api/prices?ticker=${encodeURIComponent(ticker)}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Price API returned ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setPrices(data.prices);
          setSource(data.source);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchPrices();
    return () => { cancelled = true; };
  }, [ticker]);

  // Map filing dates to trading-day prices for 10-K / 10-Q markers
  const filingChartMarkers = useMemo(() => {
    if (!filings || !prices) return [];
    const priceDates = new Set(prices.map((p) => p.date));
    return filings
      .filter((f) => f.form === '10-K' || f.form === '10-Q')
      .map((f) => {
        let matched = f.filingDate;
        if (!priceDates.has(matched)) {
          for (let i = 0; i < 5; i++) {
            const d = new Date(matched);
            d.setDate(d.getDate() + 1);
            matched = d.toISOString().slice(0, 10);
            if (priceDates.has(matched)) break;
          }
        }
        const pricePoint = prices.find((p) => p.date === matched);
        if (!pricePoint) return null;
        return {
          date: matched,
          close: pricePoint.close,
          form: f.form,
          filingDate: f.filingDate,
          documentUrl: f.documentUrl,
        };
      })
      .filter(Boolean);
  }, [filings, prices]);

  // Map insider transaction dates to trading-day prices
  const insiderChartMarkers = useMemo(() => {
    if (!insiderMarkers || !prices) return [];
    const priceDates = new Set(prices.map((p) => p.date));
    return insiderMarkers
      .map((m) => {
        let matched = m.date;
        if (!priceDates.has(matched)) {
          for (let i = 0; i < 5; i++) {
            const d = new Date(matched);
            d.setDate(d.getDate() + 1);
            matched = d.toISOString().slice(0, 10);
            if (priceDates.has(matched)) break;
          }
        }
        const pricePoint = prices.find((p) => p.date === matched);
        if (!pricePoint) return null;
        return {
          date: matched,
          close: pricePoint.close,
          direction: m.direction,
          ownerName: m.ownerName,
          shares: m.shares,
          price: m.price,
          value: m.value,
          xmlUrl: m.xmlUrl,
        };
      })
      .filter(Boolean);
  }, [insiderMarkers, prices]);

  if (loading) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-6 h-[300px] flex items-center justify-center">
        <div className="flex items-center gap-2 text-stone-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading price history...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-6">
        <div className="flex items-start gap-2 text-rose-300 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold mb-1">Could not load stock prices</div>
            <div className="text-xs text-rose-400/80">{error}</div>
            <div className="text-xs text-stone-500 mt-2 leading-relaxed">
              Prices are pulled from Yahoo Finance and Stooq in order of fallback. Some tickers,
              foreign listings, or recent IPOs may not be available. Financial data is unaffected.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!prices || prices.length === 0) return null;

  const chartData = prices.map((p) => ({ date: p.date, close: p.close }));

  // Compute marker radius based on transaction value (so big trades stand out)
  const markerRadius = (value) => {
    if (!value) return 3;
    if (value >= 10_000_000) return 7;  // $10M+
    if (value >= 1_000_000) return 5;   // $1M+
    if (value >= 100_000) return 4;     // $100K+
    return 3;
  };

  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-2 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <LineChartIcon className="w-4 h-4 text-amber-400" />
          <span className="text-xs uppercase tracking-[0.2em] text-amber-400 font-bold">
            Stock Price · {ticker}
          </span>
          {source && (
            <span className="text-[10px] uppercase tracking-wider text-stone-500 ml-2">
              via {source}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-stone-500 flex-wrap">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500" /> 10-K
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500" /> 10-Q
          </span>
          {insiderChartMarkers.length > 0 && (
            <>
              <span className="text-stone-700">|</span>
              <span className="flex items-center gap-1 text-emerald-400">
                <span className="text-[14px] leading-none">▲</span> Insider Buy
              </span>
              <span className="flex items-center gap-1 text-rose-400">
                <span className="text-[14px] leading-none">▼</span> Insider Sell
              </span>
            </>
          )}
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#44403c" vertical={false} />
          <XAxis
            dataKey="date"
            stroke="#78716c"
            tick={{ fontSize: 10, fill: '#a8a29e', fontFamily: 'ui-monospace, monospace' }}
            tickLine={{ stroke: '#44403c' }}
            axisLine={{ stroke: '#44403c' }}
            tickFormatter={(d) => d.slice(0, 4)}
            minTickGap={40}
          />
          <YAxis
            stroke="#78716c"
            tick={{ fontSize: 11, fill: '#a8a29e', fontFamily: 'ui-monospace, monospace' }}
            tickLine={{ stroke: '#44403c' }}
            axisLine={{ stroke: '#44403c' }}
            tickFormatter={(v) => `$${v.toFixed(0)}`}
            width={65}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1c1917',
              border: '2px solid #44403c',
              fontFamily: 'ui-monospace, monospace',
              fontSize: '12px',
              color: '#f5f5f4',
            }}
            labelStyle={{ color: '#fbbf24', fontWeight: 'bold' }}
            formatter={(value) => [`$${value.toFixed(2)}`, 'Close']}
          />
          <Line type="monotone" dataKey="close" stroke="#f5f5f4" strokeWidth={1.5} dot={false} />

          {/* 10-K and 10-Q filing markers */}
          {filingChartMarkers.map((m, i) => (
            <ReferenceDot
              key={`filing-${m.date}-${i}`}
              x={m.date}
              y={m.close}
              r={3}
              fill={m.form === '10-K' ? '#f59e0b' : '#10b981'}
              stroke={m.form === '10-K' ? '#fde68a' : '#6ee7b7'}
              strokeWidth={1}
              onClick={() => m.documentUrl && window.open(m.documentUrl, '_blank')}
              style={{ cursor: 'pointer' }}
            />
          ))}

          {/* Insider transaction markers — triangles via larger dots with different stroke */}
          {insiderChartMarkers.map((m, i) => (
            <ReferenceDot
              key={`insider-${m.date}-${i}`}
              x={m.date}
              y={m.close}
              r={markerRadius(m.value)}
              fill={m.direction === 'buy' ? '#22c55e' : '#ef4444'}
              stroke={m.direction === 'buy' ? '#86efac' : '#fca5a5'}
              strokeWidth={2}
              fillOpacity={0.85}
              onClick={() => m.xmlUrl && window.open(m.xmlUrl, '_blank')}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      <p className="mt-2 px-2 text-[10px] text-stone-600 leading-relaxed">
        Prices via {source || 'public market data feeds'}. Dots: amber = 10-K, emerald = 10-Q
        {insiderChartMarkers.length > 0 && <>, green = insider buy, red = insider sell</>}.
        Insider marker size scales with transaction value. Click any dot to open the filing.
        Data for educational and research purposes only.
      </p>
    </div>
  );
}
