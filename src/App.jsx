import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { TrendingUp, FileText, BarChart3, Info, GitCompare, Home, Wallet } from 'lucide-react';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import LandingPage from './pages/LandingPage.jsx';
import FilingsPage from './pages/FilingsPage.jsx';
import AnalysisPage from './pages/AnalysisPage.jsx';
import ComparePage from './pages/ComparePage.jsx';
import FundPage from './pages/FundPage.jsx';
import AboutPage from './pages/AboutPage.jsx';

export const TickerContext = React.createContext(null);

export default function App() {
  const [ticker, setTicker] = useState('');
  const [tickerMap, setTickerMap] = useState(null);
  const [company, setCompany] = useState(null);

  return (
    <HelmetProvider>
      <TickerContext.Provider value={{ ticker, setTicker, tickerMap, setTickerMap, company, setCompany }}>
        <BrowserRouter>
          <div className="min-h-screen bg-stone-950 text-stone-100 font-mono">
            <div
              className="fixed inset-0 opacity-[0.03] pointer-events-none"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
                backgroundSize: '40px 40px',
              }}
            />

            <div className="relative max-w-6xl mx-auto px-6 py-10">
              <header className="border-b-2 border-stone-800 pb-6 mb-8">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <NavLink to="/" className="group">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-10 h-10 bg-amber-500 flex items-center justify-center group-hover:bg-amber-400 transition-colors">
                        <TrendingUp className="w-6 h-6 text-stone-950" strokeWidth={3} />
                      </div>
                      <h1 className="text-3xl md:text-4xl font-black tracking-tight uppercase">
                        EDGAR<span className="text-amber-500">/</span>Terminal
                      </h1>
                    </div>
                    <p className="text-xs text-stone-400 uppercase tracking-[0.2em]">
                      SEC Public Filings Explorer · Live Data · Direct Source
                    </p>
                  </NavLink>
                  <div className="text-right text-[10px] text-stone-500 uppercase tracking-widest">
                    <div>Source: data.sec.gov</div>
                    <div>Rate: 10 req/sec max</div>
                  </div>
                </div>

                <nav className="mt-6 flex gap-1 flex-wrap">
                  <TabLink to="/" end icon={<Home className="w-4 h-4" />}>Home</TabLink>
                  <TabLink to="/filings" icon={<FileText className="w-4 h-4" />}>Filings</TabLink>
                  <TabLink to="/analysis" icon={<BarChart3 className="w-4 h-4" />}>Analysis</TabLink>
                  <TabLink to="/compare" icon={<GitCompare className="w-4 h-4" />}>Compare</TabLink>
                  <TabLink to="/fund" icon={<Wallet className="w-4 h-4" />}>Funds</TabLink>
                  <TabLink to="/about" icon={<Info className="w-4 h-4" />}>About</TabLink>
                </nav>
              </header>

              <Routes>
                <Route path="/" element={<LandingPage />} />
                <Route path="/filings" element={<FilingsPage />} />
                <Route path="/filings/:ticker" element={<FilingsPage />} />
                <Route path="/analysis" element={<AnalysisPage />} />
                <Route path="/analysis/:ticker" element={<AnalysisPage />} />
                <Route path="/compare" element={<ComparePage />} />
                <Route path="/compare/:tickers" element={<ComparePage />} />
                <Route path="/fund" element={<FundPage />} />
                <Route path="/fund/:ticker" element={<FundPage />} />
                <Route path="/about" element={<AboutPage />} />
                <Route path="*" element={<LandingPage />} />
              </Routes>

              <footer className="mt-12 pt-6 border-t-2 border-stone-800 text-[10px] uppercase tracking-widest text-stone-500 flex flex-wrap justify-between gap-2">
                <span>Data via SEC.gov · Public EDGAR APIs · XBRL Financial Facts</span>
                <span>For research use only · Not investment advice</span>
              </footer>
            </div>
          </div>
          <Analytics />
          <SpeedInsights />
        </BrowserRouter>
      </TickerContext.Provider>
    </HelmetProvider>
  );
}

function TabLink({ to, icon, children, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2 px-5 py-2.5 text-xs uppercase tracking-[0.2em] font-bold border-2 transition-colors ${
          isActive
            ? 'bg-amber-500 text-stone-950 border-amber-500'
            : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700 hover:text-stone-200'
        }`
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}
