'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowUpRight, Building2, Cpu, Factory, FileText, Flame, FlaskConical, Landmark, Shield, ShoppingBag, Wallet, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import s from './RiskStart.module.css';

type Lens = {
  id: string;
  label: string;
  icon: LucideIcon;
  drivers: string[];
  examples: [string, string][];
  context: string;
};

const LENSES: Lens[] = [
  {
    id: 'banks', label: 'Banks', icon: Landmark,
    drivers: ['Capital', 'Credit quality', 'Deposit funding'],
    examples: [['JPM', 'JPMorgan Chase'], ['BAC', 'Bank of America'], ['WFC', 'Wells Fargo']],
    context: 'Call Reports cover a selected legal bank. The SEC parent and its banking subsidiaries remain distinct.',
  },
  {
    id: 'brokers', label: 'Brokers & dealers', icon: Wallet,
    drivers: ['Collateral & repo', 'Capital', 'Counterparties'],
    examples: [['IBKR', 'Interactive Brokers'], ['SCHW', 'Charles Schwab'], ['GS', 'Goldman Sachs']],
    context: 'SEC filings describe the listed group. Public broker-dealer reports and CFTC futures-broker capital have separate entity boundaries and coverage.',
  },
  {
    id: 'insurers', label: 'Insurers', icon: Shield,
    drivers: ['Reserves & claims', 'Investments', 'Capital & liquidity'],
    examples: [['MET', 'MetLife'], ['PRU', 'Prudential Financial'], ['TRV', 'Travelers']],
    context: 'SEC evidence covers the reported group. Corporate ratios alone do not measure insurance statutory solvency.',
  },
  {
    id: 'reits', label: 'REITs', icon: Building2,
    drivers: ['Refinancing', 'Property exposure', 'Cash & interest'],
    examples: [['AMT', 'American Tower'], ['PLD', 'Prologis'], ['SPG', 'Simon Property Group']],
    context: 'Property depreciation affects GAAP earnings. Interpret cash generation with filing disclosures and any reported FFO or AFFO.',
  },
  {
    id: 'utilities', label: 'Utilities', icon: Zap,
    drivers: ['Capital spending', 'Debt & interest', 'Regulatory exposure'],
    examples: [['DUK', 'Duke Energy'], ['NEE', 'NextEra Energy'], ['SO', 'Southern Company']],
    context: 'Heavy capital spending can reflect a regulated investment cycle. Assess financing needs with the recovery terms described in filings.',
  },
  {
    id: 'energy', label: 'Energy', icon: Flame,
    drivers: ['Commodities', 'Cash generation', 'Debt & obligations'],
    examples: [['XOM', 'Exxon Mobil'], ['CVX', 'Chevron'], ['EOG', 'EOG Resources']],
    context: 'Commodity positioning describes the market backdrop. It does not reveal the issuer’s hedge book or trading positions.',
  },
  {
    id: 'industrials', label: 'Industrials & autos', icon: Factory,
    drivers: ['Margins', 'Working capital', 'Debt structure'],
    examples: [['CAT', 'Caterpillar'], ['F', 'Ford Motor'], ['DE', 'Deere & Company']],
    context: 'Captive-finance subsidiaries can change consolidated leverage. Review operating and financing segments before comparing peers.',
  },
  {
    id: 'retail', label: 'Retail & consumer', icon: ShoppingBag,
    drivers: ['Margins & demand', 'Cash conversion', 'Debt & leases'],
    examples: [['WMT', 'Walmart'], ['COST', 'Costco Wholesale'], ['HD', 'Home Depot']],
    context: 'Supplier payment cycles can produce low or negative working capital in healthy retailers. Pair liquidity ratios with cash flow and inventory evidence.',
  },
  {
    id: 'technology', label: 'Technology', icon: Cpu,
    drivers: ['Cash strength', 'Revenue exposure', 'Investment'],
    examples: [['MSFT', 'Microsoft'], ['AAPL', 'Apple'], ['CRM', 'Salesforce']],
    context: 'Intangible assets and buybacks can affect book-equity measures. Interpret screens with cash generation and filing disclosures.',
  },
  {
    id: 'healthcare', label: 'Healthcare & biotech', icon: FlaskConical,
    drivers: ['Funding runway', 'Product exposure', 'R&D spending'],
    examples: [['PFE', 'Pfizer'], ['MRNA', 'Moderna'], ['LLY', 'Eli Lilly']],
    context: 'Profitable drug makers and research-stage biotech need different interpretations. Financial screens do not establish clinical outcomes.',
  },
];

export default function RiskStart({ onExplore, cftcEnabled }: { onExplore: (ticker: string) => void; cftcEnabled: boolean }) {
  const [selected, setSelected] = useState('banks');
  const panelId = useId();
  const lens = LENSES.find(item => item.id === selected) || LENSES[0];
  const Icon = lens.icon;

  return <section className={s.start} aria-labelledby={`${panelId}-title`}>
    <div className={s.heading}><h2 id={`${panelId}-title`}>Explore by industry</h2><span>Choose a company to open its metrics</span></div>
    <div className={s.types} role="group" aria-label="Choose a company industry">
      {LENSES.map(item => <button key={item.id} type="button" aria-pressed={selected === item.id} aria-controls={panelId} onClick={() => setSelected(item.id)}><item.icon size={22} aria-hidden="true" /><span>{item.label}</span></button>)}
    </div>
    <div className={s.lens} id={panelId}>
      <div className={s.lensHeading}><h3><Icon size={19} aria-hidden="true" />{lens.label}</h3><ul className={s.drivers} aria-label={`${lens.label} risk drivers`}>{lens.drivers.map(driver => <li key={driver}>{driver}</li>)}</ul></div>
      <div className={s.examples}>{lens.examples.map(([ticker, name]) => <button key={ticker} type="button" onClick={() => onExplore(ticker)} aria-label={`Explore ${name} (${ticker}) risk profile`}><span className={s.symbol}>{ticker}</span><ArrowUpRight size={22} className={s.tileArrow} aria-hidden="true" /><span className={s.company}>{name}</span><span className={s.open}>Open profile</span></button>)}</div>
    </div>
    <div className={s.footer}>
      <div className={s.sources} aria-label="Evidence sources"><span><FileText size={15} aria-hidden="true" />SEC</span>{lens.id === 'banks' && <span><Landmark size={15} aria-hidden="true" />FFIEC</span>}<span><Activity size={15} aria-hidden="true" />NY Fed{cftcEnabled ? ' · CFTC' : ''}</span></div>
      <details className={s.scope}><summary>Source scope</summary><div><p>{lens.context}</p><p>Coverage and reporting dates vary. New York Fed and CFTC market data do not identify issuer positions. DTCC / FICC references open at the publisher.</p><Link prefetch={false} href="/about">About the sources <ArrowUpRight size={14} aria-hidden="true" /></Link></div></details>
    </div>
  </section>;
}
