'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RefinancingWall, { type RefinancingWallData } from './RefinancingWall';
import s from '../research/research.module.css';

export default function RefinancingLoader({ cftcEnabled = true }: { cftcEnabled?: boolean }) {
  const [data, setData] = useState<RefinancingWallData | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let active = true;
    fetch('/api/market-refinancing', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Snapshot unavailable');
        const value = await response.json();
        if (!Array.isArray(value?.companies) || !value?.coverage || !value?.generatedAt) throw new Error('Invalid snapshot');
        if (active) setData(value);
      })
      .catch(() => { if (active) setError(true); })
      .finally(() => clearTimeout(timer));
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [attempt]);

  if (data) return <RefinancingWall data={data} cftcEnabled={cftcEnabled} />;

  return <div className={s.page}>
    <nav className={s.nav} aria-label="Market sections">
      <Link href="/market">Market Briefing</Link>
      {cftcEnabled && <Link href="/market?tab=positioning">CFTC Positioning</Link>}
      <Link href="/market?tab=sectors">Sector Performance</Link>
      <Link href="/market/funding">Funding &amp; Clearing</Link>
      <Link href="/market/derivatives">Derivatives</Link>
      <Link href="/market/refinancing" aria-current="page">Refinancing Wall</Link>
    </nav>
    <header className={s.header} style={{ marginTop: 38 }}><div>
      <h1>Refinancing Wall</h1>
      <p>Debt coming due. Resources to meet it.</p>
    </div></header>
    <p>Explore reported corporate debt maturities by sector, then examine an issuer’s cash, annual cash generation, interest coverage, and SEC filing evidence.</p>
    <div className={s.status} role="status" style={{ marginTop: 36, minHeight: 160 }}>
      <span>{error ? 'The prepared maturity snapshot is temporarily unavailable. Please try again shortly.' : 'Loading the latest prepared maturity schedules…'}</span>
      {error && <button type="button" onClick={() => { setError(false); setAttempt(value => value + 1); }}>Try again</button>}
    </div>
    <p>Looking at banks? <Link href="/analysis/banks">Explore BankScope funding and borrowing disclosures</Link>.</p>
    <noscript>This interactive chart requires JavaScript. Each maturity schedule comes from a company’s annual SEC filing; reporting periods differ by issuer.</noscript>
  </div>;
}
