import React, { useEffect, useState, useMemo } from 'react';
import {
  Loader2, AlertCircle, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight,
  Gift, Banknote, ExternalLink, Users, ChevronDown, ChevronUp,
} from 'lucide-react';

/**
 * InsiderActivity — displays Form 4 insider transactions for a company.
 *
 * Props:
 *   cik:       Padded 10-digit CIK string
 *   filings:   array of all filings from submissions API (we filter for form==='4')
 *   onMarkersReady: callback({ markers: [] }) invoked when chart markers are computed,
 *                   so the parent StockPriceChart can overlay them.
 *
 * Fetches up to 20 most recent Form 4s, parses XML, displays transactions table.
 */
export default function InsiderActivity({ cik, filings, onMarkersReady }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('all'); // all | buy | sell

  // Collect the Form 4 accessions from the filings list
  const form4Accessions = useMemo(() => {
    if (!filings) return [];
    return filings
      .filter((f) => f.form === '4')
      .slice(0, 20) // most recent 20
      .map((f) => f.accession || f.accessionNumber)
      .filter(Boolean);
  }, [filings]);

  useEffect(() => {
    if (!cik || form4Accessions.length === 0) {
      setData(null);
      return;
    }

    let cancelled = false;
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const accessionsParam = form4Accessions.join(',');
        const res = await fetch(
          `/api/insiders?cik=${encodeURIComponent(cik)}&accessions=${encodeURIComponent(accessionsParam)}`
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Insiders API returned ${res.status}`);
        }
        const result = await res.json();
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => { cancelled = true; };
  }, [cik, form4Accessions.join(',')]);

  // Compute chart markers whenever data changes, pass up to parent
  useEffect(() => {
    if (!onMarkersReady) return;
    if (!data?.transactions) {
      onMarkersReady([]);
      return;
    }
    // Filter to open-market buys/sells only (P and S codes) — other codes are noise on a chart
    const markers = data.transactions
      .filter((tx) => tx.direction === 'buy' || tx.direction === 'sell')
      .filter((tx) => tx.value && tx.value > 10000) // filter tiny transactions
      .map((tx) => ({
        date: tx.date,
        direction: tx.direction,
        ownerName: tx.ownerName,
        relationship: tx.relationship,
        shares: tx.shares,
        price: tx.price,
        value: tx.value,
        accession: tx.accession,
        xmlUrl: tx.xmlUrl,
      }));
    onMarkersReady(markers);
  }, [data, onMarkersReady]);

  if (form4Accessions.length === 0) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-6 text-center">
        <Users className="w-8 h-8 text-stone-700 mx-auto mb-2" />
        <p className="text-stone-500 text-xs uppercase tracking-widest">No Form 4 filings found for this company</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-6 h-[200px] flex items-center justify-center">
        <div className="flex items-center gap-2 text-stone-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Parsing {form4Accessions.length} Form 4 filings...
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
            <div className="font-bold mb-1">Could not load insider activity</div>
            <div className="text-xs text-rose-400/80">{error}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!data || !data.transactions || data.transactions.length === 0) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-6 text-center">
        <Users className="w-8 h-8 text-stone-700 mx-auto mb-2" />
        <p className="text-stone-500 text-xs uppercase tracking-widest">No parseable transactions in recent Form 4s</p>
      </div>
    );
  }

  // Filter transactions based on user selection
  const displayTransactions = data.transactions.filter((tx) => {
    if (filter === 'all') return true;
    if (filter === 'buy') return tx.direction === 'buy';
    if (filter === 'sell') return tx.direction === 'sell';
    return true;
  });

  // Stats for the summary
  const totalBuys = data.transactions.filter((tx) => tx.direction === 'buy');
  const totalSells = data.transactions.filter((tx) => tx.direction === 'sell');
  const totalBuyValue = totalBuys.reduce((sum, tx) => sum + (tx.value || 0), 0);
  const totalSellValue = totalSells.reduce((sum, tx) => sum + (tx.value || 0), 0);

  const displayedLimit = expanded ? displayTransactions.length : 10;
  const visibleTransactions = displayTransactions.slice(0, displayedLimit);

  return (
    <div className="border-2 border-stone-800 bg-stone-900/30">
      {/* Header with summary stats */}
      <div className="p-4 border-b-2 border-stone-800">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-amber-400" />
            <span className="text-xs uppercase tracking-[0.2em] text-amber-400 font-bold">
              Insider Activity
            </span>
            <span className="text-[10px] uppercase tracking-wider text-stone-500 ml-2">
              last {data.filings?.length || 0} Form 4 filings
            </span>
          </div>
        </div>

        {/* Summary stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Open-Market Buys"
            count={totalBuys.length}
            value={totalBuyValue}
            accent="emerald"
            icon={TrendingUp}
          />
          <StatCard
            label="Open-Market Sells"
            count={totalSells.length}
            value={totalSellValue}
            accent="rose"
            icon={TrendingDown}
          />
          <StatCard
            label="Net Flow"
            count={null}
            value={totalBuyValue - totalSellValue}
            accent={totalBuyValue > totalSellValue ? 'emerald' : 'rose'}
            icon={totalBuyValue > totalSellValue ? TrendingUp : TrendingDown}
          />
          <StatCard
            label="Unique Insiders"
            count={new Set(data.transactions.map((tx) => tx.ownerName)).size}
            value={null}
            accent="stone"
            icon={Users}
          />
        </div>
      </div>

      {/* Filter tabs */}
      <div className="px-4 py-3 border-b border-stone-800 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500 mr-2">Filter</span>
        {[
          { id: 'all', label: 'All', count: data.transactions.length },
          { id: 'buy', label: 'Buys', count: totalBuys.length },
          { id: 'sell', label: 'Sells', count: totalSells.length },
        ].map((opt) => (
          <button
            key={opt.id}
            onClick={() => setFilter(opt.id)}
            className={`px-3 py-1 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
              filter === opt.id
                ? 'bg-amber-500 text-stone-950 border-amber-500'
                : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
            }`}
          >
            {opt.label} ({opt.count})
          </button>
        ))}
      </div>

      {/* Transaction table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-stone-900/50">
            <tr>
              <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] text-stone-400">Date</th>
              <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] text-stone-400">Insider</th>
              <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] text-stone-400">Role</th>
              <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] text-stone-400">Action</th>
              <th className="text-right px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] text-stone-400">Shares</th>
              <th className="text-right px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] text-stone-400">Price</th>
              <th className="text-right px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] text-stone-400">Value</th>
              <th className="text-center px-3 py-2.5 text-[10px] uppercase tracking-[0.2em] text-stone-400"></th>
            </tr>
          </thead>
          <tbody>
            {visibleTransactions.map((tx, i) => (
              <TransactionRow key={`${tx.accession}-${i}`} tx={tx} />
            ))}
          </tbody>
        </table>
      </div>

      {displayTransactions.length > 10 && (
        <div className="p-3 border-t border-stone-800 flex justify-center">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1 text-xs uppercase tracking-widest text-stone-400 hover:text-amber-400 transition-colors"
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3 h-3" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="w-3 h-3" />
                Show all {displayTransactions.length} transactions
              </>
            )}
          </button>
        </div>
      )}

      <p className="p-4 text-[10px] text-stone-600 leading-relaxed border-t border-stone-800">
        Parsed from SEC Form 4 XML filings. Only the {form4Accessions.length} most recent Form 4s are shown.
        Open-market buys (code P) and sells (code S) are highlighted; awards, gifts, tax withholdings, and
        option exercises are shown but marked separately. Chart markers above show buys/sells only.
      </p>
    </div>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function StatCard({ label, count, value, accent, icon: Icon }) {
  const accentClass =
    accent === 'emerald' ? 'text-emerald-400'
    : accent === 'rose' ? 'text-rose-400'
    : 'text-stone-300';

  const valueText = value == null ? '' : formatMoney(value);
  const countText = count == null ? '' : `${count}`;

  return (
    <div className="border-2 border-stone-800 bg-stone-950/40 p-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`w-3.5 h-3.5 ${accentClass}`} />
        <span className="text-[9px] uppercase tracking-[0.2em] text-stone-500">{label}</span>
      </div>
      <div className={`text-lg font-black tabular-nums ${accentClass}`}>
        {countText && <span>{countText}</span>}
        {countText && valueText && <span className="text-stone-600 mx-1">·</span>}
        {valueText && <span>{valueText}</span>}
      </div>
    </div>
  );
}

function TransactionRow({ tx }) {
  const isBuy = tx.direction === 'buy';
  const isSell = tx.direction === 'sell';

  let actionLabel = tx.code || '';
  let actionColor = 'text-stone-400';
  let ActionIcon = null;

  if (isBuy) {
    actionLabel = 'BUY';
    actionColor = 'text-emerald-400';
    ActionIcon = ArrowUpRight;
  } else if (isSell) {
    actionLabel = 'SELL';
    actionColor = 'text-rose-400';
    ActionIcon = ArrowDownRight;
  } else if (tx.direction === 'exercise') {
    actionLabel = 'EXERCISE';
    ActionIcon = Banknote;
    actionColor = 'text-sky-400';
  } else if (tx.direction === 'gift') {
    actionLabel = 'GIFT';
    ActionIcon = Gift;
    actionColor = 'text-violet-400';
  } else if (tx.direction === 'tax') {
    actionLabel = 'TAX WH.';
    actionColor = 'text-stone-500';
  } else {
    actionLabel = tx.code || 'OTHER';
    actionColor = 'text-stone-500';
  }

  return (
    <tr className={`border-b border-stone-800/60 hover:bg-amber-500/5 transition-colors ${
      isBuy ? 'bg-emerald-500/5' : isSell ? 'bg-rose-500/5' : ''
    }`}>
      <td className="px-4 py-2 text-stone-400 text-xs tabular-nums">{tx.date}</td>
      <td className="px-4 py-2 text-stone-200 text-xs font-bold truncate max-w-[200px]">{tx.ownerName || '—'}</td>
      <td className="px-4 py-2 text-stone-400 text-[11px] truncate max-w-[200px]">{tx.relationship || '—'}</td>
      <td className={`px-4 py-2 text-xs font-black tracking-wider ${actionColor}`}>
        <span className="inline-flex items-center gap-1">
          {ActionIcon && <ActionIcon className="w-3 h-3" />}
          {actionLabel}
        </span>
      </td>
      <td className="px-4 py-2 text-right text-stone-300 text-xs tabular-nums">
        {tx.shares ? tx.shares.toLocaleString() : '—'}
      </td>
      <td className="px-4 py-2 text-right text-stone-300 text-xs tabular-nums">
        {tx.price ? `$${tx.price.toFixed(2)}` : '—'}
      </td>
      <td className={`px-4 py-2 text-right text-xs tabular-nums font-bold ${
        isBuy ? 'text-emerald-400' : isSell ? 'text-rose-400' : 'text-stone-400'
      }`}>
        {tx.value ? formatMoney(tx.value) : '—'}
      </td>
      <td className="px-3 py-2 text-center">
        {tx.xmlUrl && (
          <a
            href={tx.xmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-stone-500 hover:text-amber-400 transition-colors"
            title="View Form 4 on SEC"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </td>
    </tr>
  );
}

function formatMoney(value) {
  if (value == null) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
