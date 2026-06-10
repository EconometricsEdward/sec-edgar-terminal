'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, ExternalLink, ChevronDown, ChevronRight, Loader2, AlertCircle } from 'lucide-react';

// ============================================================================
// RedFlags — "did anything in the recent filings say the quiet part out loud?"
//
// Renders the /api/risk-scan result for a ticker. Design intent: the all-clear
// state should feel like information (it scanned N filings for these specific
// phrases), and every finding must carry its source link — a hit is a reading
// prompt, never a verdict.
// ============================================================================

const SEV_STYLE = {
  high: 'bg-rose-950/40 border-rose-800/50 text-rose-200',
  medium: 'bg-amber-950/40 border-amber-800/50 text-amber-200',
};

export default function RedFlags({ ticker }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [open, setOpen] = useState({});

  useEffect(() => {
    if (!ticker) return;
    let alive = true;
    setState({ status: 'loading', data: null, error: null });
    fetch(`/api/risk-scan?ticker=${encodeURIComponent(ticker)}`)
      .then(async (r) => {
        const data = await r.json();
        if (!alive) return;
        if (!r.ok) {
          setState({ status: 'error', data: null, error: data?.message || `Scan failed (${r.status})` });
          return;
        }
        // High-severity categories with findings start expanded
        const initial = {};
        (data.findings || []).forEach((f) => {
          if (f.severity === 'high') initial[f.categoryId] = true;
        });
        setOpen(initial);
        setState({ status: 'ready', data, error: null });
      })
      .catch((e) => alive && setState({ status: 'error', data: null, error: e.message }));
    return () => {
      alive = false;
    };
  }, [ticker]);

  if (state.status === 'loading') {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-6 flex items-center gap-3">
        <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />
        <span className="text-xs uppercase tracking-widest text-stone-500">
          Scanning recent filings for red-flag language...
        </span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-4 flex items-center gap-2">
        <AlertCircle className="w-4 h-4 text-stone-500 shrink-0" />
        <span className="text-xs text-stone-500">Red-flag scan unavailable: {state.error}</span>
      </div>
    );
  }

  const { data } = state;
  const findings = data.findings || [];
  const hitCats = (data.categories || []).filter((c) => c.count > 0);

  if (findings.length === 0) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-6">
        <div className="flex items-center gap-3 mb-2">
          <ShieldCheck className="w-5 h-5 text-emerald-500" />
          <span className="text-sm font-bold text-stone-200">No red-flag language detected</span>
        </div>
        <p className="text-xs text-stone-500 leading-relaxed">
          Screened the {data.filingsScanned} most recent core filings ({(data.formTypes || []).slice(0, 4).join(', ')}…)
          for going-concern doubt, restatements, material weaknesses, covenant defaults, investigations,
          impairments, liquidity stress, and late-filing notices. Absence of a phrase is not a clean bill of
          health — it just means none of these specific signals appeared.
        </p>
      </div>
    );
  }

  // Group findings by category
  const byCat = new Map();
  findings.forEach((f) => {
    if (!byCat.has(f.categoryId)) byCat.set(f.categoryId, []);
    byCat.get(f.categoryId).push(f);
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="w-5 h-5 text-rose-400" />
        <span className="text-sm font-bold text-stone-200">
          {findings.length} {findings.length === 1 ? 'finding' : 'findings'} in the last {data.filingsScanned} core filings
        </span>
        <span className="text-[10px] uppercase tracking-widest text-stone-600">
          screen, not a verdict — open the sources
        </span>
      </div>

      {hitCats
        .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1))
        .map((cat) => {
          const catFindings = byCat.get(cat.id) || [];
          if (catFindings.length === 0) return null;
          const isOpen = !!open[cat.id];
          return (
            <div key={cat.id} className="border-2 border-stone-800">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [cat.id]: !o[cat.id] }))}
                className="w-full flex items-center gap-3 px-4 py-3 bg-stone-900 hover:bg-stone-800/80 transition-colors text-left"
              >
                {isOpen ? (
                  <ChevronDown className="w-4 h-4 text-stone-500 shrink-0" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-stone-500 shrink-0" />
                )}
                <span className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-wider border ${SEV_STYLE[cat.severity] || SEV_STYLE.medium}`}>
                  {cat.label}
                </span>
                <span className="text-xs text-stone-500 flex-1 truncate">{cat.desc}</span>
                <span className="text-xs tabular-nums text-stone-400">{cat.count}×</span>
              </button>
              {isOpen && (
                <div className="divide-y divide-stone-800/60 border-t-2 border-stone-800">
                  {catFindings.map((f, i) => (
                    <div key={`${f.url}-${i}`} className="px-4 py-3">
                      <div className="flex items-center gap-3 mb-1.5 text-[11px] uppercase tracking-wider text-stone-500">
                        <span className="font-bold text-stone-300">{f.form}</span>
                        <span>Filed {f.filingDate}</span>
                        <a
                          href={f.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-amber-500 hover:text-amber-300 transition-colors ml-auto"
                        >
                          Source <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                      <p className="text-xs text-stone-400 leading-relaxed">
                        &ldquo;{f.excerpt}&rdquo;
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

      <p className="text-[10px] text-stone-600 leading-relaxed">
        Exact-phrase screen of {data.filingsScanned} recent filings. Companies sometimes quote these phrases while
        denying them — context matters. Last scanned {new Date(data.scannedAt).toLocaleString()}.
      </p>
    </div>
  );
}
