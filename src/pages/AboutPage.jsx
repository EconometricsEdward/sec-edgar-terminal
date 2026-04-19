import React from 'react';
import { Link } from 'react-router-dom';
import {
  Info, FileText, BarChart3, GitCompare, Users, Percent, LineChart,
  AlertTriangle, ExternalLink, Code, Database, Mail,
} from 'lucide-react';

export default function AboutPage() {
  return (
    <>
      {/* Header */}
      <div className="mb-8 pb-4 border-b-2 border-stone-800">
        <h1 className="text-3xl md:text-4xl font-black tracking-tight text-stone-100 mb-2">
          About <span className="text-amber-400">/ Methodology</span>
        </h1>
        <p className="text-sm text-stone-400">
          How this site works, where the data comes from, and what you can (and can't) trust.
        </p>
      </div>

      {/* Use full-width two-column grid on desktop for dense info */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* LEFT: main content (2 columns) */}
        <div className="lg:col-span-2 space-y-6">

          {/* What this is */}
          <section className="border-2 border-stone-800 bg-stone-900/30 p-5">
            <SectionHeader icon={Info} title="What this is" />
            <div className="space-y-3 text-sm text-stone-300 leading-relaxed">
              <p>
                EDGAR Terminal is a free, open tool for exploring U.S. SEC filings and financial data.
                It's built for people who want to check the footnotes — students, analysts, journalists,
                curious investors — not for high-frequency traders or institutional users.
              </p>
              <p>
                <span className="text-amber-400 font-bold">All data comes directly from the SEC's
                official public APIs.</span> Nothing is scraped, manipulated, or interpreted through
                a third-party layer. What you see is what the company filed.
              </p>
              <p>
                The site is intentionally free, lightweight, accountless, and ad-free.
                There is no login, no email capture, no cookie tracking.
              </p>
            </div>
          </section>

          {/* Features deep dive */}
          <section className="border-2 border-stone-800 bg-stone-900/30 p-5">
            <SectionHeader icon={Code} title="What the tool does" />
            <div className="space-y-4">
              <FeatureBlock
                icon={FileText}
                title="Filings Browser"
                path="/filings/:ticker"
                text="Every filing a company has submitted to SEC, grouped by year and quarter, filterable by form type (10-K, 10-Q, 8-K, Form 4, proxy, etc.). Each filing links to the original document on SEC.gov. Form badges are color-coded to help distinguish periodic reports from material events."
              />
              <FeatureBlock
                icon={BarChart3}
                title="Financial Analysis"
                path="/analysis/:ticker"
                text="Structured financial data pulled from SEC's XBRL 'Company Facts' API. Five tabs: Overview, Stock Chart, Insiders, Financials, Ratios. Toggle between annual (10-K) and quarterly (10-Q) views. Growth columns (YoY, 5Y CAGR, 10Y CAGR) on every metric."
              />
              <FeatureBlock
                icon={Percent}
                title="Industry-Specific Ratios"
                path="/analysis/JPM"
                text="Ratios automatically adapt to each company's SIC classification. Banks get NIM, Efficiency Ratio, Loan-to-Deposit, Allowance Coverage. Tech gets R&D Intensity, FCF Margin, Rule of 40. Retail gets Inventory Turnover, Days Inventory, DSO. REITs, oil & gas, and airlines receive warnings for metrics XBRL doesn't support."
              />
              <FeatureBlock
                icon={LineChart}
                title="Stock Price + Filing Markers"
                path="/analysis/AAPL"
                text="10-year daily stock price history from Yahoo Finance (primary) with Stooq fallback. 10-K filings marked amber, 10-Q filings emerald. Click a marker to open that filing. Insider buys and sells overlaid as colored dots scaled by transaction value."
              />
              <FeatureBlock
                icon={Users}
                title="Insider Activity"
                path="/analysis/NVDA"
                text="Form 4 XML filings parsed to show insider transactions. Summary cards for buys, sells, net flow, and unique insiders. Full transaction table with filter tabs (All / Buys / Sells). Chart markers link to the original Form 4 XML."
              />
              <FeatureBlock
                icon={GitCompare}
                title="Peer Comparison"
                path="/compare/:tickers"
                text="Up to 5 companies side-by-side across 10 fiscal years. Head-to-head snapshot table with color-coded best/worst per metric. Normalization modes: Absolute, Indexed to 100, Per Share, % of Revenue. Ratio overlays (ROE, ROA, margins). Growth rate bar charts. 12 pre-defined peer groups for one-click comparison."
              />
            </div>
          </section>

          {/* Methodology */}
          <section className="border-2 border-stone-800 bg-stone-900/30 p-5">
            <SectionHeader icon={Database} title="Methodology" />
            <div className="space-y-4 text-sm text-stone-300 leading-relaxed">
              <div>
                <h4 className="text-stone-100 font-bold mb-1">Source of financial data</h4>
                <p className="text-stone-400">
                  Financial values come from SEC's XBRL Company Facts API
                  (<code className="text-amber-400 text-xs">data.sec.gov/api/xbrl/companyfacts/CIKxxxxxxxxxx.json</code>).
                  The XBRL parser uses period-end date matching and a latest-filed priority
                  to select the correct value when the same fiscal period has been reported multiple times.
                </p>
              </div>

              <div>
                <h4 className="text-stone-100 font-bold mb-1">Industry classification</h4>
                <p className="text-stone-400">
                  SIC (Standard Industrial Classification) codes drive industry-specific logic.
                  For example, SIC 6020-6299 triggers banking ratios; SIC 7370-7379 triggers
                  tech-oriented ratios like Rule of 40. The classification is automatic but not
                  always precise for conglomerates.
                </p>
              </div>

              <div>
                <h4 className="text-stone-100 font-bold mb-1">Calculated ratios</h4>
                <p className="text-stone-400">
                  Some ratios (ROE, ROA, margins) are computed from reported XBRL values rather than
                  taken directly from company press releases. These may differ slightly from
                  company-published non-GAAP numbers. The formulas are documented inline in tooltips.
                </p>
              </div>

              <div>
                <h4 className="text-stone-100 font-bold mb-1">Stock price data</h4>
                <p className="text-stone-400">
                  Stock prices use Yahoo Finance's public chart endpoint as primary source, Stooq as
                  fallback. Prices are adjusted for splits and dividends. Some tickers (especially
                  recent IPOs or foreign listings) may have incomplete history or fail to load.
                  Financial data from SEC is unaffected when price data is unavailable.
                </p>
              </div>

              <div>
                <h4 className="text-stone-100 font-bold mb-1">Form 4 parsing</h4>
                <p className="text-stone-400">
                  The most recent 20 Form 4 XML documents per company are parsed on demand.
                  Transaction codes follow SEC convention: P=purchase, S=sale, A=award, M=exercise,
                  F=tax withholding, G=gift, D=dispose. Only "open-market" buys (P) and sells (S)
                  are highlighted on the chart; compensation-related transactions are shown but
                  marked differently.
                </p>
              </div>
            </div>
          </section>

          {/* Disclaimer */}
          <section className="border-2 border-rose-800/40 bg-rose-950/20 p-5">
            <SectionHeader icon={AlertTriangle} title="Disclaimer" accentClass="text-rose-400" />
            <div className="space-y-3 text-sm text-stone-300 leading-relaxed">
              <p className="font-bold text-rose-300">
                This is a research and educational tool. It is not investment advice.
              </p>
              <p>
                Nothing on this site constitutes a recommendation to buy, sell, or hold any security.
                The operator is not a registered financial advisor or broker-dealer. Always consult
                a qualified professional before making investment decisions.
              </p>
              <p>
                While data comes directly from SEC.gov, no warranty is made regarding accuracy,
                completeness, or timeliness. XBRL filings can contain reporting errors, restatements,
                or non-standard tagging that affects how values display. Stock price data from
                Yahoo and Stooq is believed accurate but not verified.
              </p>
              <p className="text-rose-300 font-bold">
                Always verify critical numbers against the original filing before making any decision.
              </p>
            </div>
          </section>
        </div>

        {/* RIGHT: sidebar (1 column) */}
        <aside className="space-y-4">

          {/* Quick facts */}
          <div className="border-2 border-stone-800 bg-stone-900/40 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-amber-400 font-bold mb-3">
              Quick Facts
            </div>
            <dl className="space-y-2.5 text-xs">
              <FactRow term="Data source" def="SEC.gov public APIs" />
              <FactRow term="Update frequency" def="Live (cached ≤6hr)" />
              <FactRow term="Rate limit" def="10 req/sec to SEC" />
              <FactRow term="Companies covered" def="~10,000 U.S. public" />
              <FactRow term="History depth" def="10 fiscal years" />
              <FactRow term="Cost" def="Free forever" />
              <FactRow term="Account required" def="No" />
              <FactRow term="Tracking" def="None" />
            </dl>
          </div>

          {/* Data sources */}
          <div className="border-2 border-stone-800 bg-stone-900/40 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-amber-400 font-bold mb-3">
              Data Sources
            </div>
            <ul className="space-y-2.5 text-xs">
              <SourceLink
                href="https://www.sec.gov/edgar/sec-api-documentation"
                title="SEC EDGAR API"
                desc="Filings, submissions, XBRL facts"
              />
              <SourceLink
                href="https://www.sec.gov/oit/announcement/new-rate-control-limits"
                title="SEC Fair Access Policy"
                desc="Compliance with public API limits"
              />
              <SourceLink
                href="https://www.sec.gov/structureddata"
                title="SEC XBRL Reporting"
                desc="Structured financial data standard"
              />
              <SourceLink
                href="https://finance.yahoo.com"
                title="Yahoo Finance (public endpoint)"
                desc="Historical stock prices"
              />
              <SourceLink
                href="https://stooq.com"
                title="Stooq"
                desc="Price data fallback"
              />
            </ul>
          </div>

          {/* What's not here */}
          <div className="border-2 border-stone-800 bg-stone-900/40 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-amber-400 font-bold mb-3">
              What's Not Here (Yet)
            </div>
            <ul className="space-y-2 text-xs text-stone-400">
              <NotHereItem>Segment breakdowns (e.g. iPhone vs Services)</NotHereItem>
              <NotHereItem>Analyst estimates / consensus</NotHereItem>
              <NotHereItem>Real-time quotes or intraday data</NotHereItem>
              <NotHereItem>Options flow or derivatives</NotHereItem>
              <NotHereItem>Earnings call transcripts</NotHereItem>
              <NotHereItem>13F holdings (institutions)</NotHereItem>
              <NotHereItem>Private companies or pre-IPO</NotHereItem>
            </ul>
          </div>

          {/* Credits */}
          <div className="border-2 border-stone-800 bg-stone-900/40 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-amber-400 font-bold mb-3">
              Built With
            </div>
            <ul className="space-y-1.5 text-xs text-stone-400">
              <li>React + Vite</li>
              <li>Tailwind CSS</li>
              <li>Recharts + hand-rolled SVG</li>
              <li>Vercel (hosting + edge functions)</li>
              <li>lucide-react (icons)</li>
            </ul>
          </div>

          {/* Feedback */}
          <div className="border-2 border-amber-700/30 bg-amber-950/10 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Mail className="w-4 h-4 text-amber-400" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-amber-400 font-bold">
                Feedback
              </span>
            </div>
            <p className="text-xs text-stone-300 leading-relaxed">
              Found a bug? Have a data quality issue? Suggestion for a new feature?
              Open an issue on GitHub or reach out directly.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function SectionHeader({ icon: Icon, title, accentClass = 'text-amber-400' }) {
  return (
    <div className="flex items-center gap-2 mb-3 pb-2 border-b border-stone-800">
      <Icon className={`w-4 h-4 ${accentClass}`} />
      <h2 className="text-sm uppercase tracking-[0.2em] font-black text-stone-100">{title}</h2>
    </div>
  );
}

function FeatureBlock({ icon: Icon, title, path, text }) {
  return (
    <div className="flex gap-3">
      <Icon className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap mb-1">
          <h4 className="text-sm font-bold text-stone-100">{title}</h4>
          <code className="text-[10px] text-stone-500 font-mono">{path}</code>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed">{text}</p>
      </div>
    </div>
  );
}

function FactRow({ term, def }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-stone-500">{term}</dt>
      <dd className="text-stone-200 font-bold text-right">{def}</dd>
    </div>
  );
}

function SourceLink({ href, title, desc }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block hover:bg-stone-800/50 -mx-2 px-2 py-1 rounded transition-colors group"
      >
        <div className="flex items-center gap-1 text-amber-400 group-hover:text-amber-300 font-bold">
          {title}
          <ExternalLink className="w-2.5 h-2.5" />
        </div>
        <div className="text-[10px] text-stone-500">{desc}</div>
      </a>
    </li>
  );
}

function NotHereItem({ children }) {
  return (
    <li className="flex items-start gap-1.5">
      <span className="text-stone-600 shrink-0">·</span>
      <span>{children}</span>
    </li>
  );
}
