import React from 'react';
import { FileText, BarChart3, Shield, Info, ExternalLink } from 'lucide-react';

export default function AboutPage() {
  return (
    <div className="max-w-3xl">
      <h2 className="text-2xl md:text-3xl font-black tracking-tight uppercase mb-6">
        About <span className="text-amber-500">/</span> Disclaimer
      </h2>

      <Section icon={Info} title="What this is">
        <p>
          EDGAR Terminal is a free, open tool for exploring public SEC filings. Enter any publicly
          traded U.S. company's ticker or CIK number and instantly browse its complete filing history,
          or view its financial statements as structured tables across multiple years.
        </p>
        <p className="mt-3">
          All data comes directly from the U.S. Securities and Exchange Commission's public EDGAR
          database via their official, free APIs. Nothing is scraped, manipulated, or interpreted —
          what you see is what the company filed.
        </p>
      </Section>

      <Section icon={FileText} title="Filings page">
        <p>
          Every filing the company has submitted to SEC in recent years, grouped by year and
          quarter. Click any filing to open the raw document on SEC.gov in a new tab. Filter by
          form type (10-K, 10-Q, 8-K, Form 4, etc.) to narrow the view.
        </p>
      </Section>

      <Section icon={BarChart3} title="Analysis page">
        <p>
          Structured financial data pulled from SEC's XBRL "Company Facts" API. Four views:
          Income Statement, Balance Sheet, Cash Flow, and calculated Ratios. Toggle between
          Annual (from 10-K) and Quarterly (from 10-Q) views. Export any view as CSV for
          further analysis.
        </p>
        <p className="mt-3 text-stone-400">
          Empty cells mean the company did not report that concept for that period, or used a
          non-standard XBRL tag that isn't mapped yet.
        </p>
      </Section>

      <Section icon={Shield} title="Disclaimer" highlight>
        <p className="font-bold text-stone-100 mb-2">
          This is a research and educational tool. It is not investment advice.
        </p>
        <p>
          Nothing on this site constitutes a recommendation to buy, sell, or hold any security.
          The operators of this site are not registered financial advisors or broker-dealers.
          Always consult a qualified professional before making investment decisions.
        </p>
        <p className="mt-3">
          While data is sourced directly from SEC.gov, we make no warranty regarding accuracy,
          completeness, or timeliness. XBRL data can contain reporting errors, restatements, or
          non-standard tagging that may affect how values display. Always verify critical numbers
          against the original filing.
        </p>
      </Section>

      <Section icon={ExternalLink} title="Sources & credits">
        <ul className="space-y-2">
          <li>
            <a
              href="https://www.sec.gov/edgar/sec-api-documentation"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
            >
              SEC EDGAR API documentation
            </a>
          </li>
          <li>
            <a
              href="https://www.sec.gov/os/accessing-edgar-data"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
            >
              SEC fair access policy
            </a>
          </li>
          <li>
            <a
              href="https://www.sec.gov/structureddata/osd_xbrl"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
            >
              SEC XBRL financial reporting overview
            </a>
          </li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ icon: Icon, title, children, highlight }) {
  return (
    <div
      className={`mb-6 border-2 ${
        highlight ? 'border-amber-500/40 bg-amber-950/10' : 'border-stone-800 bg-stone-900/30'
      } p-6`}
    >
      <h3 className="flex items-center gap-2 text-sm uppercase tracking-[0.2em] font-bold text-stone-100 mb-4">
        <Icon className={`w-4 h-4 ${highlight ? 'text-amber-400' : 'text-amber-500'}`} />
        {title}
      </h3>
      <div className="text-sm text-stone-300 leading-relaxed font-sans">{children}</div>
    </div>
  );
}
