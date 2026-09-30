'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight, Building2, Cpu, Factory, FileText, Flame, FlaskConical, Landmark, Shield, ShoppingBag, Wallet, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import s from './RiskStart.module.css';

type Lens = {
  id: string;
  label: string;
  icon: LucideIcon;
  question: string;
  drivers: [string, string][];
  examples: [string, string][];
  context: string;
};

const LENSES: Lens[] = [
  {
    id: 'banks', label: 'Banks', icon: Landmark,
    question: 'Can capital and reliable funding support the loan book?',
    drivers: [['Capital', 'Compare capital strength with balance-sheet growth.'], ['Credit quality', 'Trace problem loans and the allowance that supports them.'], ['Funding', 'Examine deposits, wholesale borrowing and liquidity.']],
    examples: [['JPM', 'JPMorgan Chase'], ['BAC', 'Bank of America'], ['WFC', 'Wells Fargo']],
    context: 'Call Reports add regulatory capital and loan-quality detail for a selected legal bank. The SEC parent and its banking subsidiaries remain distinct.',
  },
  {
    id: 'brokers', label: 'Brokers & dealers', icon: Wallet,
    question: 'How much does the business depend on short-term secured funding?',
    drivers: [['Funding & collateral', 'Review repo, securities financing and collateral terms.'], ['Capital', 'Relate equity and reported regulatory capital to the business.'], ['Counterparties', 'Find clearing, settlement and customer concentrations.']],
    examples: [['IBKR', 'Interactive Brokers'], ['SCHW', 'Charles Schwab'], ['GS', 'Goldman Sachs']],
    context: 'SEC filings describe the listed group. Public broker-dealer reports and CFTC futures-broker capital have different entity boundaries and reporting coverage.',
  },
  {
    id: 'insurers', label: 'Insurers', icon: Shield,
    question: 'Can investments and capital support claims and policy obligations?',
    drivers: [['Reserves & claims', 'Review policy liabilities, reserve changes and claims trends.'], ['Investment exposure', 'Inspect portfolio concentration and asset sensitivity.'], ['Capital & liquidity', 'Separate group cash and debt from regulated subsidiaries.']],
    examples: [['MET', 'MetLife'], ['PRU', 'Prudential Financial'], ['TRV', 'Travelers']],
    context: 'SEC evidence covers the reported group. Corporate ratios alone do not measure insurance statutory solvency or policyholder protection.',
  },
  {
    id: 'reits', label: 'REITs', icon: Building2,
    question: 'Will property cash flows cover financing needs?',
    drivers: [['Refinancing', 'Place debt maturities beside cash and borrowing capacity.'], ['Property exposure', 'Inspect tenants, property types and geographic concentration.'], ['Cash & interest', 'Read operating cash flow and interest alongside property results.']],
    examples: [['AMT', 'American Tower'], ['PLD', 'Prologis'], ['SPG', 'Simon Property Group']],
    context: 'Property depreciation affects GAAP earnings. Use filing disclosures to interpret cash generation and any reported FFO or AFFO.',
  },
  {
    id: 'utilities', label: 'Utilities', icon: Zap,
    question: 'Can the company fund its investment program and service its debt?',
    drivers: [['Investment needs', 'Compare operating cash flow with capital spending.'], ['Debt & interest', 'Track leverage, interest coverage and scheduled maturities.'], ['Regulated exposure', 'Review jurisdictions, recovery mechanisms and fuel costs.']],
    examples: [['DUK', 'Duke Energy'], ['NEE', 'NextEra Energy'], ['SO', 'Southern Company']],
    context: 'Heavy capital spending can be part of a regulated investment cycle. Assess financing needs with the recovery terms described in filings.',
  },
  {
    id: 'energy', label: 'Energy', icon: Flame,
    question: 'How resilient are cash flows when commodity conditions change?',
    drivers: [['Commodity exposure', 'Read product mix, customer exposure and reported hedges.'], ['Cash generation', 'Compare operating cash flow, investment and distributions.'], ['Debt & obligations', 'Review maturities, commitments and long-term liabilities.']],
    examples: [['XOM', 'Exxon Mobil'], ['CVX', 'Chevron'], ['EOG', 'EOG Resources']],
    context: 'Commodity positioning can help frame the market backdrop. It does not reveal the selected issuer’s hedge book or trading positions.',
  },
  {
    id: 'industrials', label: 'Industrials & autos', icon: Factory,
    question: 'Can the balance sheet absorb a weaker demand cycle?',
    drivers: [['Operating resilience', 'Track margins and operating cash through the cycle.'], ['Working capital', 'Inspect inventory, receivables and cash conversion.'], ['Debt structure', 'Separate operating debt from captive-finance obligations.']],
    examples: [['CAT', 'Caterpillar'], ['F', 'Ford Motor'], ['DE', 'Deere & Company']],
    context: 'Captive-finance subsidiaries can change the meaning of consolidated leverage. Review segment and financing disclosures before comparing peers.',
  },
  {
    id: 'retail', label: 'Retail & consumer', icon: ShoppingBag,
    question: 'How well do sales and inventory turn into cash?',
    drivers: [['Margins & demand', 'Track profitability and revenue concentration.'], ['Cash conversion', 'Read inventory and supplier funding alongside cash flow.'], ['Fixed obligations', 'Review debt, leases and other committed payments.']],
    examples: [['WMT', 'Walmart'], ['COST', 'Costco Wholesale'], ['HD', 'Home Depot']],
    context: 'Supplier payment cycles can produce low or negative working capital in healthy retailers. Pair liquidity ratios with cash flow and inventory evidence.',
  },
  {
    id: 'technology', label: 'Technology', icon: Cpu,
    question: 'Does cash generation support investment and concentrated revenues?',
    drivers: [['Cash strength', 'Compare liquidity, operating cash flow and debt.'], ['Revenue exposure', 'Review products, customers and geographic dependence.'], ['Investment & capital', 'Track capital spending, acquisitions and shareholder payouts.']],
    examples: [['MSFT', 'Microsoft'], ['AAPL', 'Apple'], ['CRM', 'Salesforce']],
    context: 'Intangible assets and buybacks can distort book-equity measures. Interpret balance-sheet screens with cash generation and filing disclosures.',
  },
  {
    id: 'healthcare', label: 'Healthcare & biotech', icon: FlaskConical,
    question: 'Can liquidity fund operations through product and research cycles?',
    drivers: [['Funding runway', 'Read available cash against reported operating cash use.'], ['Product exposure', 'Inspect major products, customers and patent dependencies.'], ['Development needs', 'Review R&D, commitments and financing plans.']],
    examples: [['PFE', 'Pfizer'], ['MRNA', 'Moderna'], ['LLY', 'Eli Lilly']],
    context: 'A profitable drug maker and a research-stage biotech need different interpretations. Missing or negative earnings do not establish a clinical outcome.',
  },
];

export default function RiskStart({ onExplore, cftcEnabled }: { onExplore: (ticker: string) => void; cftcEnabled: boolean }) {
  const [selected, setSelected] = useState('banks');
  const panelId = useId();
  const lens = LENSES.find(item => item.id === selected) || LENSES[0];
  const Icon = lens.icon;

  return <section className={s.start} aria-labelledby={`${panelId}-title`}>
    <div className={s.heading}>
      <div><span className={s.eyebrow}><Activity size={15} aria-hidden="true" /> Research by business model</span><h2 id={`${panelId}-title`}>Start with the risks that matter to the company.</h2></div>
      <p>Choose a lens, then open a company. Reported figures, changes and source evidence stay together.</p>
    </div>
    <div className={s.types} role="group" aria-label="Choose a company business model">
      {LENSES.map(item => <button key={item.id} type="button" aria-pressed={selected === item.id} aria-controls={panelId} onClick={() => setSelected(item.id)}><item.icon size={19} aria-hidden="true" /><span>{item.label}</span></button>)}
    </div>
    <div className={s.lens} id={panelId}>
      <div className={s.questions}>
        <div className={s.lensHeading}><Icon size={24} aria-hidden="true" /><div><span>{lens.label}</span><h3>{lens.question}</h3></div></div>
        <div className={s.drivers}>{lens.drivers.map(([title, detail], index) => <div key={title}><span className={s.number} aria-hidden="true">0{index + 1}</span><div><h4>{title}</h4><p>{detail}</p></div></div>)}</div>
      </div>
      <div className={s.launch}>
        <p className={s.launchLabel}>Open a risk profile</p>
        <div className={s.examples}>{lens.examples.map(([ticker, name]) => <button key={ticker} type="button" onClick={() => onExplore(ticker)} aria-label={`Explore ${name} (${ticker}) risk profile`}><span className={s.symbol}>{ticker}</span><span>{name}</span><ArrowRight size={17} aria-hidden="true" /></button>)}</div>
        <p className={s.exampleNote}>Examples to get started. Search above for another company.</p>
        <div className={s.interpretation}><span>What to keep in view</span><p>{lens.context}</p></div>
      </div>
    </div>
    <div className={s.sources}>
      <div className={s.source}><FileText size={17} aria-hidden="true" /><div><strong>SEC filings</strong><span>Company financials & disclosures</span></div></div>
      {lens.id === 'banks' && <div className={s.source}><Landmark size={17} aria-hidden="true" /><div><strong>FFIEC Call Reports</strong><span>Selected legal bank · coverage varies</span></div></div>}
      <div className={s.source}><Activity size={17} aria-hidden="true" /><div><strong>New York Fed{cftcEnabled ? ' & CFTC' : ''}</strong><span>Funding{cftcEnabled ? ', positioning & swaps' : ' conditions'} · market context</span></div></div>
      <Link href="/about" className={s.sourceLink}>Understand the sources <ArrowRight size={15} aria-hidden="true" /></Link>
    </div>
    <p className={s.scope}>Coverage and reporting dates vary by company and source. Market-wide data does not identify issuer positions. DTCC / FICC references open at the publisher.</p>
  </section>;
}
