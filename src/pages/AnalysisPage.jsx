import React, { useState, useContext, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { BarChart3, Download, TrendingUp, Wallet, ArrowRightLeft, Percent, Link as LinkIcon, GitCompare } from 'lucide-react';
import TickerSearchBar from '../components/TickerSearchBar.jsx';
import { MetricChart } from '../components/MetricChart.jsx';
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
  periodLabel,
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [statement, setStatement] = useState('income');
  const [periodType, setPeriodType] = useState('annual');

  const fetchFacts = async (entry) => {
    setLoading(true);
    setError(null);
    setFacts(null);

    // Update URL to the ticker (deep link)
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
          throw new Error('This company has no XBRL financial data available. Most likely a non-US entity or trust that does not file full financial statements.');
        }
        throw new Error(`XBRL API returned ${factsRes.status}`);
      }

      const submissions = await submissionsRes.json();
      const factsData = await factsRes.json();

      setCompany({
        name: submissions.name,
        cik: entry.cik,
        sic: submissions.sicDescription,
        exchanges: submissions.exchanges?.join(', ') || 'N/A',
        tickers: submissions.tickers?.join(', ') || entry.name,
        fiscalYearEnd: submissions.fiscalYearEnd,
        stateOfIncorporation: submissions.stateOfIncorporation,
        ein: submissions.ein,
      });

      setFacts(factsData.facts || {});
    } catch (err) {
      setError(`Failed to fetch financial data: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const periods = facts
    ? periodType === 'annual'
      ? extractAnnualPeriods(facts).slice(0, 10).map((fy) => ({ fy, fp: 'FY' }))
      : extractQuarterlyPeriods(facts).slice(0, 12)
    : [];

  const statementDef = STATEMENTS.find((s) => s.id === statement);
  const rows = useMemo(
    () => (facts && periods.length > 0 ? statementDef.build(facts, periods) : []),
    [facts, periods, statementDef]
  );

  const featuredRows = useMemo(
    () => rows.filter((r) => statementDef.featuredRows.includes(r.label)),
    [rows, statementDef]
  );

  const exportCsv = () => {
    if (!rows.length || !periods.length) return;
    const header = ['Metric', ...periods.map(periodLabel)].join(',');
    const lines = rows.map((r) => {
      const vals = r.values.map((v) => (v.value == null ? '' : v.value));
      return [`"${r.label}"`, ...vals].join(',');
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

  return (
    <>
      <TickerSearchBar
        onFetch={fetchFacts}
        loading={loading}
        error={error}
        setError={setError}
        initialTicker={urlTicker}
      />

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

          {/* Key metric charts */}
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

          {/* Full data table */}
          <div className="border-2 border-stone-800 bg-stone-900/30 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-stone-900 border-b-2 border-stone-800">
                <tr>
                  <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.25em] text-stone-400 sticky left-0 bg-stone-900 z-10 min-w-[220px]">
                    Metric
                  </th>
                  {periods.map((p) => (
                    <th
                      key={`${p.fy}-${p.fp}`}
                      className="text-right px-4 py-3 text-[10px] uppercase tracking-[0.2em] text-amber-400 font-black min-w-[90px]"
                    >
                      {periodLabel(p)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isHeader = ['Revenue', 'Gross Profit', 'Operating Income', 'Net Income', 'Total Assets', 'Total Liabilities', "Stockholders' Equity", 'Operating Cash Flow'].includes(row.label);
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
                            ? 'bg-stone-900/80 text-stone-100 font-bold'
                            : 'bg-stone-950/80 text-stone-300'
                        }`}
                      >
                        {row.label}
                      </td>
                      {row.values.map((v, i) => (
                        <td
                          key={i}
                          className={`px-4 py-2.5 text-right tabular-nums ${
                            v.value == null
                              ? 'text-stone-700'
                              : isHeader
                              ? 'text-stone-100 font-bold'
                              : 'text-stone-300'
                          }`}
                        >
                          {formatValue(v.value, row.format)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-[11px] text-stone-500 leading-relaxed">
            Source: SEC XBRL Company Facts. Values are as originally reported in 10-K / 10-Q filings.
            Empty cells (—) indicate the company did not report that specific concept for that period,
            or used a non-standard XBRL tag not yet mapped. Ratios computed from reported values.
          </p>
        </>
      )}

      {!loading && !facts && !error && (
        <div className="border-2 border-dashed border-stone-800 p-12 text-center">
          <BarChart3 className="w-12 h-12 text-stone-700 mx-auto mb-4" />
          <p className="text-stone-500 text-sm uppercase tracking-widest mb-2">Financial Analysis</p>
          <p className="text-stone-600 text-xs max-w-md mx-auto">
            Enter a ticker symbol above to load structured financial data (Income Statement, Balance Sheet,
            Cash Flow, Ratios) across all historical 10-K and 10-Q filings — with charts and CSV export.
          </p>
        </div>
      )}
    </>
  );
}
