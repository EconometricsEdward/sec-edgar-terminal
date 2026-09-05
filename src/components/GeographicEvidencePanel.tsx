'use client';

import React, { Component, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';

const Globe = dynamic(() => import('./SecGeoGlobeExplorer'), { ssr: false, loading: () => <p role="status">Loading optional globe…</p> });

class GlobeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <p role="status" className="rounded-xl border border-amber-400/30 p-4 text-sm text-amber-100">3D rendering is unavailable in this browser. The company and evidence table remains available below.</p>
      : this.props.children;
  }
}

export default function GeographicEvidencePanel({ regions, aggregate }: { regions: any[]; aggregate: any }) {
  const [showScenario, setShowScenario] = useState(false);
  const [scale, setScale] = useState(100);
  const scenarioRegions = regions.map((r) => {
    const metricByMode = Object.fromEntries(Object.entries(r.metricByMode || {}).map(([key, value]) => [key, typeof value === 'number' ? value * scale / 100 : value]));
    return { ...r, confidence: 'Illustrative', metricByMode, timeSeries: [{ label: 'Scenario', note: `User scenario: ${scale}% of the original illustrative allocation. These amounts are not reported geographic exposures.`, metricByMode }] };
  });
  return <section className="panel-card mb-8 rounded-2xl border border-white/10 p-5">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h2 className="text-lg font-bold text-white">Geographic research themes</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Curated company groups suggest where to investigate. Company membership does not establish the amount or location of an exposure.</p></div>
      <button type="button" className="secondary-button" aria-expanded={showScenario} onClick={() => setShowScenario(!showScenario)}>{showScenario ? 'Close scenario map' : 'Explore illustrative scenario'}</button>
    </div>
    {showScenario && <div className="my-5 space-y-4 rounded-xl border border-amber-400/30 bg-amber-400/5 p-4">
      <p className="text-sm text-amber-100"><strong>Illustrative scenario.</strong> Geographic allocations and flows use fixed assumptions applied to current company cohorts. They are not reported geographic amounts, historical trends, or forecasts.</p>
      <label className="flex flex-wrap items-center gap-3 text-sm text-slate-200">Scenario scale <input type="range" min="25" max="200" step="5" value={scale} onChange={(e) => setScale(Number(e.target.value))} /><output>{scale}%</output></label>
      <GlobeBoundary><Globe regions={scenarioRegions} aggregate={aggregate} /></GlobeBoundary>
    </div>}
    <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-white/10 text-slate-400"><th className="p-3">Research theme</th><th className="p-3">Research focus</th><th className="p-3">Companies</th></tr></thead><tbody>
      {regions.map((r) => <tr key={r.id} className="border-b border-white/5"><th scope="row" className="p-3 font-semibold text-slate-100">{r.shortName || r.name}<span className="mt-1 block text-xs font-normal text-slate-500">Illustrative geographic grouping</span></th><td className="max-w-lg p-3 text-slate-400">{r.description}</td><td className="p-3"><div className="flex min-w-40 flex-wrap gap-2">{(r.tickers || []).slice(0, 8).map((ticker) => <Link key={ticker} className="text-amber-300 underline underline-offset-4" href={`/analysis/${ticker}`}>{ticker}</Link>)}</div></td></tr>)}
    </tbody></table></div>
  </section>;
}
