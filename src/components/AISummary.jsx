'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Loader2, ExternalLink, X } from 'lucide-react';

// ============================================================================
// AISummary — per-filing AI summary toggle.
//
// Availability is probed ONCE per page load via /api/ai/status (module-level
// promise). If the deployment has no API key, this component renders nothing
// and the filings page is byte-for-byte the experience it was before.
// Summaries are cached server-side by accession, so repeat views are free.
// ============================================================================

let _statusPromise = null;
function aiEnabled() {
  if (!_statusPromise) {
    _statusPromise = fetch('/api/ai/status')
      .then((r) => r.json())
      .then((d) => Boolean(d?.enabled))
      .catch(() => false);
  }
  return _statusPromise;
}

export default function AISummary({ cik, accession, primaryDoc, ticker, form }) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    aiEnabled().then((ok) => alive && setEnabled(ok));
    return () => {
      alive = false;
    };
  }, []);

  if (!enabled || !cik || !accession || !primaryDoc) return null;

  const run = async () => {
    if (result) {
      setOpen(true);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/ai/summarize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cik, accession, primaryDoc, ticker, form }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(
          r.status === 429
            ? 'Rate limit reached — try again in a few minutes.'
            : data?.message || `Summary unavailable (${r.status}).`,
        );
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2">
      {!open && (
        <button
          type="button"
          onClick={run}
          className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-stone-700 text-stone-400 hover:border-amber-600 hover:text-amber-400 transition-colors"
        >
          <Sparkles className="w-3 h-3" />
          AI summary
        </button>
      )}

      {open && (
        <div className="border border-stone-700 bg-stone-950/80 p-3 relative">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute top-2 right-2 text-stone-600 hover:text-stone-300 transition-colors"
            aria-label="Close summary"
          >
            <X className="w-3.5 h-3.5" />
          </button>

          <div className="flex items-center gap-1.5 mb-2 text-[10px] font-bold uppercase tracking-wider text-amber-500">
            <Sparkles className="w-3 h-3" />
            AI summary
            {result?.cached && <span className="text-stone-600 font-normal">· cached</span>}
          </div>

          {loading && (
            <div className="flex items-center gap-2 text-xs text-stone-500 py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
              Reading the filing...
            </div>
          )}

          {error && <p className="text-xs text-rose-300 py-1">{error}</p>}

          {result && (
            <>
              <pre className="text-xs text-stone-300 leading-relaxed whitespace-pre-wrap font-sans">
                {result.summary}
              </pre>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3 pt-2 border-t border-stone-800 text-[10px] text-stone-600">
                <span>AI-generated — verify against the source. Not investment advice.</span>
                <a
                  href={result.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-amber-600 hover:text-amber-400 transition-colors"
                >
                  Source filing <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
