import React, { useState, useContext, useMemo } from 'react';
import {
  FileText, ExternalLink, Calendar, Hash, Filter, ChevronDown, ChevronRight,
} from 'lucide-react';
import TickerSearchBar from '../components/TickerSearchBar.jsx';
import { TickerContext } from '../App.jsx';
import { secDataUrl } from '../utils/secApi.js';

export default function FilingsPage() {
  const { company, setCompany } = useContext(TickerContext);
  const [filings, setFilings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filterType, setFilterType] = useState('ALL');
  const [expandedYears, setExpandedYears] = useState({});
  const [expandedQuarters, setExpandedQuarters] = useState({});

  const fetchFilings = async (entry) => {
    setLoading(true);
    setError(null);
    setFilings([]);
    setExpandedYears({});
    setExpandedQuarters({});

    try {
      const res = await fetch(secDataUrl(`/submissions/CIK${entry.cik}.json`));
      if (!res.ok) throw new Error(`SEC API returned ${res.status}`);
      const data = await res.json();

      setCompany({
        name: data.name,
        cik: entry.cik,
        sic: data.sicDescription,
        exchanges: data.exchanges?.join(', ') || 'N/A',
        tickers: data.tickers?.join(', ') || entry.name,
        fiscalYearEnd: data.fiscalYearEnd,
        stateOfIncorporation: data.stateOfIncorporation,
        ein: data.ein,
      });

      const recent = data.filings.recent;
      const allFilings = recent.accessionNumber.map((acc, i) => {
        const filingDate = recent.filingDate[i];
        const date = new Date(filingDate);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const quarter = `Q${Math.ceil(month / 3)}`;
        const accessionClean = acc.replace(/-/g, '');
        const primaryDoc = recent.primaryDocument[i];
        return {
          accession: acc,
          form: recent.form[i],
          filingDate,
          reportDate: recent.reportDate[i],
          year,
          quarter,
          primaryDoc,
          primaryDescription: recent.primaryDocDescription?.[i] || '',
          size: recent.size?.[i],
          documentUrl: `https://www.sec.gov/Archives/edgar/data/${parseInt(entry.cik, 10)}/${accessionClean}/${primaryDoc}`,
        };
      });

      setFilings(allFilings);
      if (allFilings.length > 0) setExpandedYears({ [allFilings[0].year]: true });
    } catch (err) {
      setError(`Failed to fetch filings: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const formTypes = useMemo(() => {
    const set = new Set(filings.map((f) => f.form));
    return ['ALL', ...Array.from(set).sort()];
  }, [filings]);

  const grouped = useMemo(() => {
    const filtered = filterType === 'ALL' ? filings : filings.filter((f) => f.form === filterType);
    const byYear = {};
    filtered.forEach((f) => {
      if (!byYear[f.year]) byYear[f.year] = {};
      if (!byYear[f.year][f.quarter]) byYear[f.year][f.quarter] = [];
      byYear[f.year][f.quarter].push(f);
    });
    return byYear;
  }, [filings, filterType]);

  const sortedYears = useMemo(
    () => Object.keys(grouped).map(Number).sort((a, b) => b - a),
    [grouped]
  );

  const toggleYear = (y) => setExpandedYears((p) => ({ ...p, [y]: !p[y] }));
  const toggleQuarter = (k) => setExpandedQuarters((p) => ({ ...p, [k]: !p[k] }));

  const formColor = (form) => {
    if (form.startsWith('10-K')) return 'bg-amber-900/40 text-amber-200 border-amber-700/50';
    if (form.startsWith('10-Q')) return 'bg-emerald-900/40 text-emerald-200 border-emerald-700/50';
    if (form.startsWith('8-K')) return 'bg-rose-900/40 text-rose-200 border-rose-700/50';
    if (form.includes('DEF 14A') || form.includes('PRE 14A')) return 'bg-violet-900/40 text-violet-200 border-violet-700/50';
    if (form.startsWith('S-')) return 'bg-sky-900/40 text-sky-200 border-sky-700/50';
    if (form.startsWith('4') || form.startsWith('3') || form.startsWith('5')) return 'bg-teal-900/40 text-teal-200 border-teal-700/50';
    if (form.startsWith('SC 13')) return 'bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-700/50';
    return 'bg-stone-800/60 text-stone-300 border-stone-600/50';
  };

  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  return (
    <>
      <TickerSearchBar onFetch={fetchFilings} loading={loading} error={error} setError={setError} />

      {filings.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-stone-400" />
            <span className="text-[10px] uppercase tracking-[0.25em] text-stone-400">Form Type</span>
          </div>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="bg-stone-900 border-2 border-stone-800 hover:border-stone-700 focus:border-amber-500 outline-none px-3 py-2 text-sm font-bold transition-colors"
          >
            {formTypes.map((t) => (
              <option key={t} value={t}>
                {t}
                {t !== 'ALL' ? ` (${filings.filter((f) => f.form === t).length})` : ''}
              </option>
            ))}
          </select>
          <div className="text-xs text-stone-500 ml-auto">
            Showing {filterType === 'ALL' ? filings.length : filings.filter((f) => f.form === filterType).length} of{' '}
            {filings.length}
          </div>
        </div>
      )}

      {sortedYears.length > 0 && (
        <div className="space-y-3">
          {sortedYears.map((year) => {
            const quarters = grouped[year];
            const yearCount = Object.values(quarters).reduce((s, arr) => s + arr.length, 0);
            const isOpen = expandedYears[year];
            return (
              <div key={year} className="border-2 border-stone-800">
                <button
                  onClick={() => toggleYear(year)}
                  className="w-full flex items-center justify-between px-5 py-4 bg-stone-900 hover:bg-stone-800/80 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {isOpen ? (
                      <ChevronDown className="w-5 h-5 text-amber-500" />
                    ) : (
                      <ChevronRight className="w-5 h-5 text-amber-500" />
                    )}
                    <Calendar className="w-4 h-4 text-stone-400" />
                    <span className="text-2xl font-black tracking-wider">{year}</span>
                  </div>
                  <span className="text-xs uppercase tracking-widest text-stone-400">
                    {yearCount} {yearCount === 1 ? 'filing' : 'filings'}
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t-2 border-stone-800">
                    {['Q1', 'Q2', 'Q3', 'Q4'].filter((q) => quarters[q]).map((q) => {
                      const qKey = `${year}-${q}`;
                      const qOpen = expandedQuarters[qKey] ?? true;
                      const qFilings = quarters[q].sort(
                        (a, b) => new Date(b.filingDate) - new Date(a.filingDate)
                      );
                      return (
                        <div key={q} className="border-b border-stone-800 last:border-b-0">
                          <button
                            onClick={() => toggleQuarter(qKey)}
                            className="w-full flex items-center justify-between px-5 py-2.5 bg-stone-950 hover:bg-stone-900/60 transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              {qOpen ? (
                                <ChevronDown className="w-4 h-4 text-stone-500" />
                              ) : (
                                <ChevronRight className="w-4 h-4 text-stone-500" />
                              )}
                              <span className="text-sm font-bold text-amber-500">{q}</span>
                              <span className="text-xs text-stone-500">
                                {q === 'Q1' ? 'Jan–Mar' : q === 'Q2' ? 'Apr–Jun' : q === 'Q3' ? 'Jul–Sep' : 'Oct–Dec'}
                              </span>
                            </div>
                            <span className="text-xs text-stone-500">{qFilings.length}</span>
                          </button>

                          {qOpen && (
                            <div className="divide-y divide-stone-800/60">
                              {qFilings.map((f) => (
                                <a
                                  key={f.accession}
                                  href={f.documentUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-start gap-4 px-5 py-3.5 hover:bg-amber-500/5 transition-colors group"
                                >
                                  <div
                                    className={`shrink-0 px-2.5 py-1 text-[11px] font-black border tracking-wider ${formColor(
                                      f.form
                                    )} min-w-[80px] text-center`}
                                  >
                                    {f.form}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                      <span className="text-sm font-bold text-stone-100 truncate">
                                        {f.primaryDescription || f.primaryDoc || 'Filing Document'}
                                      </span>
                                      <ExternalLink className="w-3.5 h-3.5 text-stone-500 group-hover:text-amber-500 transition-colors shrink-0" />
                                    </div>
                                    <div className="flex items-center gap-4 text-[11px] text-stone-500 uppercase tracking-wider">
                                      <span className="flex items-center gap-1">
                                        <Calendar className="w-3 h-3" />
                                        Filed {f.filingDate}
                                      </span>
                                      {f.reportDate && <span>Period {f.reportDate}</span>}
                                      {f.size && <span>{formatSize(f.size)}</span>}
                                      <span className="flex items-center gap-1 truncate">
                                        <Hash className="w-3 h-3" />
                                        {f.accession}
                                      </span>
                                    </div>
                                  </div>
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && !company && !error && (
        <div className="border-2 border-dashed border-stone-800 p-12 text-center">
          <FileText className="w-12 h-12 text-stone-700 mx-auto mb-4" />
          <p className="text-stone-500 text-sm uppercase tracking-widest mb-2">Awaiting Query</p>
          <p className="text-stone-600 text-xs max-w-md mx-auto">
            Enter a publicly traded ticker symbol above to retrieve filings directly from SEC EDGAR.
          </p>
        </div>
      )}
    </>
  );
}
