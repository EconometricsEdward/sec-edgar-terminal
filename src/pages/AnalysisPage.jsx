import React, { useState, useContext, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  BarChart3, Download, TrendingUp, Wallet, ArrowRightLeft, Percent,
  Link as LinkIcon, GitCompare, AlertTriangle, ExternalLink,
} from 'lucide-react';
import TickerSearchBar from '../components/TickerSearchBar.jsx';
import { MetricChart } from '../components/MetricChart.jsx';
import SummaryDashboard from '../components/SummaryDashboard.jsx';
import { TickerContext } from '../App.jsx';
import { secDataUrl } from '../utils/secApi.js';
import {
  extractAnnualPeriods,
  extractQuarterlyPeriods,
  buildIncomeStatement,
  buildBalanceSheet,
  buildCashFlow,
  buildRatios,
  formatValue,
  formatGrowth,
  computeGrowth,
  periodLabel,
  buildSourceUrl,
} from '../utils/xbrlParser.js';

const STATEMENTS = [
  { id: 'income', label: 'Income Statement', icon: TrendingUp, build: buildIncomeStatement,
    featuredRows: ['Revenue', 'Net Income', 'Operating Income', 'Gross Profit'] },
  { id: 'balance', label: 'Balance Sheet', icon: Wallet, build: buildBalanceSheet,
    featuredRows: ['Total Assets', 'Total Liabilities', "Stockholders' Equity", 'Cash & Equivalents'] },
  { id: 'cashflow', label: 'Cash Flow', icon: ArrowRightLeft, build: buildCashFlow,
    featuredRows: ['Operating Cash Flow', 'Capital Expenditures', 'Financing Cash Flow', 'Investing Cash Flow'] },
  { id: 'ratios', label: 'Ratios', icon: Percent, build: buildRatios,
    featuredRows: ['Gross Margin', 'Operating Margin', 'Net Margin', 'Return on Equity (ROE)'] },
];

export default function AnalysisPage() {
  const { ticker: urlTicker } = useParams();
  const navigate = useNavigate();
  const { company, setCompany } = useContext(TickerContext);
  const [facts, setFacts] = useState(null);
  const [sicCode, setSicCode] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [statement, setStatement] = useState('income');
  const [periodType, setPeriodType] = useState('annual');
  const [showGrowth, setShowGrowth] = useState(true);

  const fetchFacts = async (entry) => {
    setLoading(true);
    setError(null);
    setFacts(null);

    if (urlTicker !== entry.ticker) {
      navigate(`/analysis/${entry.ticker}`, { replace: false });
    }

    try {
      const [submissionsRes, factsRes] = await Promise.all([
        fetch(secDataUrl(`/submissions/CIK${entry.cik}.json`)),
        fetch(secDataUrl(`/api/xbrl/companyfacts/CIK${entry.cik}.json`)),
      ]);

      if (!submissionsRes.ok) throw new Error(`Submissions API returned ${submissionsRes.status}`);
      if (!factsRes.ok) {
        if (factsRes.status === 404) {
          throw new Error('This company has no XBRL financial data available.');
        }
        throw new Error(`XBRL API returned ${factsRes.status}`);
      }

      const submissions = await submissionsRes.json();
      const factsData = await factsRes.json();

      setCompany({
        name: submissions.name,
        cik: entry.cik,
        sic: submissions.sicDescription,
        sicNumber: submissions.sic,
        exchanges: submissions.exchanges?.join(', ') || 'N/A',
        tickers: submissions.tickers?.join(', ') || entry.name,
        fiscalYearEnd: submissions.fiscalYearEnd,
        stateOfIncorporation: submissions.stateOfIncorporation,
        ein: submissions.ein,
      });

      setSicCode(submissions.sic);
      setFacts(factsData.facts || {});
    } catch (err) {
      setError(`Failed to fetch financial data: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const periods = facts
    ? periodType === 'annual'
      ? extractAnnualPeriods(facts).slice(0, 10)
      : extractQuarterlyPeriods(facts).slice(0, 12)
    : [];

  const statementDef = STATEMENTS.find((s) => s.id === statement);
  const rows = useMemo(
    () => (facts && periods.length > 0 ? statementDef.build(facts, periods, sicCode) : []),
    [facts, periods, statementDef, sicCode]
  );

  const featuredRows = useMemo(
    () => rows.filter((r) => statementDef.featuredRows.includes(r.label)),
    [rows, statementDef]
  );

  // Show growth columns only for annual view + when toggle is on
  const growthVisible = showGrowth && periodType === 'annual';

  const exportCsv = () => {
    if (!rows.length || !periods.length) return;
    const header = ['Metric', ...periods.map(periodLabel), 'YoY %', '5Y CAGR %', '10Y CAGR %'].join(',');
    const lines = rows.map((r) => {
      const g = computeGrowth(r);
      const vals = r.values.map((v) => (v.value == null ? '' : v.value));
      return [
        `"${r.label}"`,
        ...vals,
        g.yoy != null ? g.yoy.toFixed(2) : '',
        g.cagr5y != null ? g.cagr5y.toFixed(2) : '',
        g.cagr10y != null ? g.cagr10y.toFixed(2) : '',
      ].join(',');
    });
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${company?.name || 'financials'}_${statement}_${periodType}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyShareLink = () => {
    const url = `${window.location.origin}/#/analysis/${company?.tickers?.split(',')[0]?.trim() || urlTicker}`;
    navigator.clipboard.writeText(url);
  };

  const goToCompare = () => {
    const t = urlTicker || company?.tickers?.split(',')[0]?.trim();
    if (t) navigate(`/compare/${t}`);
    else navigate('/compare');
  };

  const sic = parseInt(sicCode, 10) || 0;
  const isBank = sic >= 6000 && sic <= 6299;
  const isInsurance = sic >= 6300 && sic <= 6411;

  return (
    <>
      <TickerSearchBar
        onFetch={fetchFacts}
        loading={loading}
        error={error}
        setError={setError}
        initialTicker={urlTicker}
      />

      {facts && (
        <div className="mb-6 border-2 border-amber-700/40 bg-amber-950/20 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-100/90 leading-relaxed">
            <span className="font-bold text-amber-300">Experimental — verify before relying on these numbers.</span>{' '}
            Financial data is parsed from SEC's XBRL API. Click any value to see the exact SEC source tag and filing.
            {isBank && (
              <div className="mt-2 text-amber-200/80">
                <strong>Banking company (SIC {sic}).</strong> Revenue uses interest + non-interest income tags.
                Cost of Revenue and Gross Profit are not applicable.
              </div>
            )}
            {isInsurance && (
              <div className="mt-2 text-amber-200/80">
                <strong>Insurance company (SIC {sic}).</strong> Revenue is primarily premium income.
              </div>
            )}
          </div>
        </div>
      )}

      {facts && periods.length > 0 && periodType === 'annual' && (
        <SummaryDashboard facts={facts} periods={periods} sicCode={sicCode} />
      )}

      {facts && periods.length > 0 && (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap gap-1">
              {STATEMENTS.map((s) => {
                const Icon = s.icon;
                const active = statement === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => setStatement(s.id)}
                    className={`flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-[0.15em] font-bold border-2 transition-colors ${
                      active
                        ? 'bg-amber-500 text-stone-950 border-amber-500'
                        : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700 hover:text-stone-200'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {s.label}
                  </button>
                );
              })}
            </div>

            <div className="flex ml-auto gap-1">
              <button
                onClick={() => setPeriodType('annual')}
                className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
                  periodType === 'annual'
                    ? 'bg-stone-100 text-stone-950 border-stone-100'
                    : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
                }`}
              >
                Annual (10-K)
              </button>
              <button
                onClick={() => setPeriodType('quarterly')}
                className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
                  periodType === 'quarterly'
                    ? 'bg-stone-100 text-stone-950 border-stone-100'
                    : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
                }`}
              >
                Quarterly (10-Q)
              </button>
            </div>

            {periodType === 'annual' && (
              <button
                onClick={() => setShowGrowth((s) => !s)}
                className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
                  showGrowth
                    ? 'bg-emerald-500 text-stone-950 border-emerald-500'
                    : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
                }`}
                title={showGrowth ? 'Hide growth columns' : 'Show growth columns'}
              >
                Growth {showGrowth ? 'ON' : 'OFF'}
              </button>
            )}

            <button
              onClick={copyShareLink}
              className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 transition-colors"
              title="Copy shareable link"
            >
              <LinkIcon className="w-3.5 h-3.5" />
              Share
            </button>

            <button
              onClick={goToCompare}
              className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 transition-colors"
              title="Compare with peers"
            >
              <GitCompare className="w-3.5 h-3.5" />
              Compare
            </button>

            <button
              onClick={exportCsv}
              className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 transition-colors"
              title="Download current view as CSV"
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </button>
          </div>

          {featuredRows.length > 0 && (
            <div className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
              {featuredRows.map((row) => (
                <MetricChart
                  key={row.label}
                  title={row.label}
                  data={row.values}
                  format={row.format}
                  chartType={row.format === 'percent' || row.format === 'decimal' ? 'line' : 'bar'}
                />
              ))}
            </div>
          )}

          <div className="border-2 border-stone-800 bg-stone-900/30 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-stone-900 border-b-2 border-stone-800">
                <tr>
                  <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.25em] text-stone-400 sticky left-0 bg-stone-900 z-20 min-w-[220px]">
                    Metric
                  </th>
                  {periods.map((p) => (
                    <th
                      key={`${p.fy}-${p.fp}-${p.end}`}
                      className="text-right px-4 py-3 text-[10px] uppercase tracking-[0.2em] text-amber-400 font-black min-w-[90px]"
                    >
                      {periodLabel(p)}
                    </th>
                  ))}
                  {growthVisible && (
                    <>
                      <th className="text-right px-3 py-3 text-[10px] uppercase tracking-[0.2em] text-emerald-400 font-black min-w-[80px] sticky right-[160px] bg-stone-900 z-20 border-l-2 border-stone-800">
                        YoY
                      </th>
                      <th className="text-right px-3 py-3 text-[10px] uppercase tracking-[0.2em] text-emerald-400 font-black min-w-[80px] sticky right-[80px] bg-stone-900 z-20">
                        5Y CAGR
                      </th>
                      <th className="text-right px-3 py-3 text-[10px] uppercase tracking-[0.2em] text-emerald-400 font-black min-w-[80px] sticky right-0 bg-stone-900 z-20">
                        10Y CAGR
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isHeader = ['Revenue', 'Gross Profit', 'Operating Income', 'Net Income', 'Total Assets', 'Total Liabilities', "Stockholders' Equity", 'Operating Cash Flow'].includes(row.label);
                  const growth = computeGrowth(row);
                  return (
                    <tr
                      key={row.label}
                      className={`border-b border-stone-800/60 hover:bg-amber-500/5 transition-colors ${
                        isHeader ? 'bg-stone-900/40' : ''
                      }`}
                    >
                      <td
                        className={`px-4 py-2.5 sticky left-0 z-10 ${
                          isHeader
                            ? 'bg-stone-900/95 text-stone-100 font-bold'
                            : 'bg-stone-950/95 text-stone-300'
                        }`}
                      >
                        {row.label}
                      </td>
                      {row.values.map((v, i) => (
                        <ValueCell
                          key={i}
                          value={v.value}
                          source={v.source}
                          cik={company?.cik}
                          format={row.format}
                          isHeader={isHeader}
                        />
                      ))}
                      {growthVisible && (
                        <>
                          <GrowthCell pct={growth.yoy} isHeader={isHeader} stickyRight={160} borderLeft />
                          <GrowthCell pct={growth.cagr5y} isHeader={isHeader} stickyRight={80} />
                          <GrowthCell pct={growth.cagr10y} isHeader={isHeader} stickyRight={0} />
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-[11px] text-stone-500 leading-relaxed">
            Source: SEC XBRL Company Facts. Hover any value for the source XBRL tag; click to open SEC's concept endpoint.
            Growth columns: YoY = latest vs. prior year. CAGR = compounded annual growth.
            Empty cells indicate missing data or values where growth is not meaningful (e.g., sign changes).
          </p>
        </>
      )}

      {!loading && !facts && !error && (
        <div className="border-2 border-dashed border-stone-800 p-12 text-center">
          <BarChart3 className="w-12 h-12 text-stone-700 mx-auto mb-4" />
          <p className="text-stone-500 text-sm uppercase tracking-widest mb-2">Financial Analysis</p>
          <p className="text-stone-600 text-xs max-w-md mx-auto">
            Enter a ticker symbol above to load structured financial data across all historical 10-K and 10-Q filings.
          </p>
        </div>
      )}
    </>
  );
}

function ValueCell({ value, source, cik, format, isHeader }) {
  const sourceUrl = source && cik ? buildSourceUrl(cik, source) : null;
  const tooltip = source
    ? `Tag: ${source.tag}\nUnit: ${source.unit}\nPeriod: ${source.end}\nFiled: ${source.filed}\nAccession: ${source.accession}\nClick to open SEC source`
    : value == null
    ? 'No data reported for this concept'
    : 'Computed value';

  const cellClasses = `px-4 py-2.5 text-right tabular-nums group ${
    value == null
      ? 'text-stone-700'
      : isHeader
      ? 'text-stone-100 font-bold'
      : 'text-stone-300'
  }`;

  if (!sourceUrl || value == null) {
    return (
      <td className={cellClasses} title={tooltip}>
        {formatValue(value, format)}
      </td>
    );
  }

  return (
    <td className={cellClasses} title={tooltip}>
      <a
        href={sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 hover:text-amber-400 transition-colors"
      >
        {formatValue(value, format)}
        <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity" />
      </a>
    </td>
  );
}

function GrowthCell({ pct, isHeader, borderLeft, stickyRight }) {
  const g = formatGrowth(pct);
  const colorClass =
    g.color === 'positive'
      ? 'text-emerald-400'
      : g.color === 'negative'
      ? 'text-rose-400'
      : 'text-stone-600';
  const bg = isHeader ? 'bg-stone-900/95' : 'bg-stone-950/95';
  const sticky = stickyRight !== undefined ? `sticky z-10` : '';
  const styleObj = stickyRight !== undefined ? { right: `${stickyRight}px` } : undefined;

  return (
    <td
      style={styleObj}
      className={`px-3 py-2.5 text-right tabular-nums ${bg} ${sticky} ${colorClass} ${
        isHeader ? 'font-bold' : ''
      } ${borderLeft ? 'border-l-2 border-stone-800' : ''}`}
    >
      {g.text}
    </td>
  );
}
