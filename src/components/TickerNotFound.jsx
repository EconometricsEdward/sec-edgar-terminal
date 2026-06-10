'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SearchX } from 'lucide-react';
import { loadClassifiedTickerMap } from '../utils/tickerMapLoader.js';

// ============================================================================
// TickerNotFound — an error state that gives direction instead of mood.
// Suggests close matches from the ticker map (prefix > substring > name match)
// so a typo'd or delisted ticker becomes a one-click recovery.
// ============================================================================

function score(query, ticker, name) {
  const q = query.toUpperCase();
  const t = (ticker || '').toUpperCase();
  const n = (name || '').toUpperCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80 - (t.length - q.length);
  if (q.startsWith(t)) return 60;
  if (t.includes(q)) return 40;
  if (n.includes(q)) return 20;
  return -1;
}

export default function TickerNotFound({ query }) {
  const router = useRouter();
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    let alive = true;
    if (!query || query.length < 1) return undefined;
    loadClassifiedTickerMap()
      .then((map) => {
        if (!alive || !map) return;
        const entries = Object.entries(map);
        const ranked = [];
        for (const [ticker, info] of entries) {
          if (info?.type === 'crypto') continue;
          const s = score(query, ticker, info?.name);
          if (s > 0) ranked.push({ ticker, name: info?.name || '', type: info?.type || 'company', s });
        }
        ranked.sort((a, b) => b.s - a.s);
        setSuggestions(ranked.slice(0, 5));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [query]);

  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 p-6 mt-2">
      <div className="flex items-center gap-3 mb-2">
        <SearchX className="w-5 h-5 text-stone-500" />
        <span className="text-sm font-bold text-stone-200">
          No SEC-registered company matches &ldquo;{query?.toUpperCase()}&rdquo;
        </span>
      </div>
      <p className="text-xs text-stone-500 mb-3 leading-relaxed">
        This can mean a typo, a delisted or private company, or a fund ticker.
        {suggestions.length > 0 ? ' Closest matches in the SEC registry:' : ''}
      </p>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button
              key={s.ticker}
              type="button"
              onClick={() => router.push(s.type === 'fund' ? `/fund/${s.ticker}` : `/analysis/${s.ticker}`)}
              className="flex items-center gap-2 px-3 py-1.5 border-2 border-stone-800 bg-stone-900 hover:border-amber-600 hover:text-amber-400 transition-colors text-xs"
            >
              <span className="font-black tracking-wider">{s.ticker}</span>
              <span className="text-stone-500 max-w-[180px] truncate">{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
