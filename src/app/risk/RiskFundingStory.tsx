'use client';

import { useId, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { buildRiskFundingPresentation } from './riskFundingPresentation.js';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import type { RiskProfile, RiskSource } from './riskTypes';
import s from './RiskFundingStory.module.css';

type History = { end: string; label: string; [key: string]: number | string | null };
type RatioPoint = { end: string; label: string; value: number | null; sources: RiskSource[]; formula: string };
type Ratio = { id: string; label: string; format: string; value: number | null; prior: number | null; delta: number | null; end: string; formula: string; sources: RiskSource[]; series: RatioPoint[]; gap?: string | null; note?: string; metricId?: string | null };
type FundingView = {
  lens: 'corporate' | 'bank' | 'broker' | 'insurance' | 'financial'; history: History[];
  liquidity: { ratios: Ratio[] }; obligations: { ratios: Ratio[] };
  bank: { dimensions: { letter: string; label: string; description: string; metrics: Ratio[]; gap: string | null }[]; ratios: Ratio[] } | null;
  broker: { balances: Ratio[]; ratios: Ratio[] } | null; limitations: string[];
};
type PlotSeries = { key: string; label: string; color: 'teal' | 'gold' | 'blue' | 'muted'; dashed?: boolean };
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numberAt = (row: History | undefined, key: string) => isNumber(row?.[key]) ? row[key] as number : null;
const exact = (value: unknown, format = 'usd') => !isNumber(value) ? 'Unavailable' : format === 'usd' ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : formatRiskValue(value, format);
const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function ratioAt(ratio: Ratio, end: string) {
  const point = ratio.series.find(row => row.end === end);
  return point || { end, value: null, sources: [], formula: ratio.formula, label: end };
}

function Sources({ sources }: { sources: RiskSource[] }) {
  return <>{sources.map((source, index) => <p key={`${source.tag}:${source.end}:${index}`} className={s.source}>
    <strong>{source.label || source.tag}: {exact(source.value)} {source.unit}</strong>
    <span>{source.start ? `${source.start} → ` : ''}{source.end}{source.filed ? ` · Filed ${source.filed}` : ''}</span>
    {(source.documentUrl || source.url) && <a href={source.documentUrl || source.url} target="_blank" rel="noreferrer">{source.tag}<ArrowUpRight size={11}/></a>}
  </p>)}</>;
}

function Timeline({ history, series, selectedEnd, basis, label, format = 'usd' }: { history: History[]; series: PlotSeries[]; selectedEnd: string; basis: string; label: string; format?: string }) {
  const values = history.flatMap(row => series.map(item => numberAt(row, item.key))).filter(isNumber);
  if (!values.length) return <p className={s.empty}>No compatible observations are available for this history.</p>;
  const low = Math.min(0, ...values), high = Math.max(0, ...values), span = high - low || 1;
  const first = Date.parse(history[0]?.end), last = Date.parse(history.at(-1)?.end || '');
  const x = (row: History, index: number) => 87 + (last > first ? (Date.parse(row.end) - first) / (last - first) : index / Math.max(history.length - 1, 1)) * 639;
  const y = (value: number) => 229 - (value - low) / span * 192;
  const selected = history.findIndex(row => row.end === selectedEnd);
  return <div className={s.chartScroll} tabIndex={0} role="region" aria-label={`${label}. Scroll horizontally on narrow screens.`}>
    <svg className={s.timeline} viewBox="0 0 758 282" role="img" aria-label={`${label}. Exact observations are in the expandable history table.`}>
      {[0, .5, 1].map((fraction, index) => { const value = low + span * fraction; return <g key={index}><line x1="87" x2="731" y1={y(value)} y2={y(value)} className={s.grid}/><text x="76" y={y(value) + 4} textAnchor="end">{formatRiskValue(value, format)}</text></g>; })}
      {low < 0 && <line x1="87" x2="731" y1={y(0)} y2={y(0)} className={s.zero}/>}
      {selected >= 0 && <line x1={x(history[selected], selected)} x2={x(history[selected], selected)} y1="29" y2="237" className={s.selectionLine}/>}
      {series.map(item => {
        const segments: string[][] = []; let segment: string[] = [];
        history.forEach((row, index) => {
          const value = numberAt(row, item.key);
          const gap = index > 0 ? (Date.parse(row.end) - Date.parse(history[index - 1].end)) / 86400000 : 0;
          if ((gap > (basis === 'ttm' ? 145 : 460) || !isNumber(value)) && segment.length) { segments.push(segment); segment = []; }
          if (isNumber(value)) segment.push(`${x(row, index)},${y(value)}`);
        });
        if (segment.length) segments.push(segment);
        return <g key={item.key} className={s[item.color]}>{segments.map((points, index) => <polyline key={index} points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={item.dashed ? '6 5' : undefined}/>)}{history.map((row, index) => { const value = numberAt(row, item.key); return isNumber(value) && <circle key={row.end} cx={x(row, index)} cy={y(value)} r={row.end === selectedEnd ? 5 : 3} fill="var(--r-panel)" stroke="currentColor" strokeWidth="2"><title>{row.end} · {item.label}: {formatRiskValue(value, format)}</title></circle>; })}</g>;
      })}
      {history.map((row, index) => (index === 0 || index === history.length - 1 || history.length > 3 && index === Math.floor(history.length / 2)) && <text key={row.end} x={x(row, index)} y="264" textAnchor={index === 0 ? 'start' : index === history.length - 1 ? 'end' : 'middle'}>{dateLabel(row.end)}</text>)}
    </svg>
  </div>;
}

function Legend({ items, row }: { items: PlotSeries[]; row: History | undefined }) {
  return <dl className={s.legend}>{items.map(item => <div key={item.key}><dt><i className={s[item.color]} data-dashed={item.dashed}/>{item.label}</dt><dd>{formatRiskValue(numberAt(row, item.key))}</dd></div>)}</dl>;
}

function RatioStrip({ ratios, end, onInspect }: { ratios: Ratio[]; end: string; onInspect?: (id: string) => void }) {
  return <div className={s.ratioStrip}>{ratios.map(ratio => {
    const point = ratioAt(ratio, end);
    return <div key={ratio.id} className={s.ratio}><span>{ratio.label}</span><strong>{formatRiskValue(point.value, ratio.format)}</strong>
      <p>{point.value == null ? ratio.gap || 'Required inputs are unavailable for this date.' : ratio.note || ratio.formula}</p>
      {ratio.metricId && onInspect && <button onClick={() => onInspect(ratio.metricId!)}>Inspect metric<ArrowUpRight size={12}/></button>}
    </div>;
  })}</div>;
}

function ExactHistory({ history, columns, ratios, end, profile, title }: { history: History[]; columns: PlotSeries[]; ratios: Ratio[]; end: string; profile: RiskProfile; title: string }) {
  const balances = profile.reportedBalances || {};
  const flows = (profile.reportedFlows || {}) as Record<string, { end: string; sources: RiskSource[]; formula?: string }[]>;
  return <details className={s.details}><summary>{title}</summary>
    <div className={s.tableScroll} tabIndex={0} role="region" aria-label={`${title} table`}><table><caption>USD amounts; period-end balances and {profile.basis === 'ttm' ? 'trailing-twelve-month' : 'annual'} flows. Missing values remain unavailable.</caption><thead><tr><th>Period end</th>{columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{history.map(row => <tr key={row.end} data-selected={row.end === end}><th scope="row">{row.end}</th>{columns.map(column => <td key={column.key}>{exact(row[column.key])}</td>)}</tr>)}</tbody></table></div>
    <div className={s.sourceColumns}>{columns.map(column => { const point = [...(balances[column.key] || []), ...(flows[column.key] || [])].find(item => item.end === end); return point && <details key={column.key}><summary>{column.label} · {end}</summary>{point.formula && <p>{point.formula}</p>}<Sources sources={point.sources || []}/></details>; })}</div>
    {ratios.length > 0 && <details className={s.calculations}><summary>Ratio calculations & SEC inputs · {end}</summary>{ratios.map(ratio => { const point = ratioAt(ratio, end); return <div key={ratio.id} className={s.calculation}><strong>{ratio.label}: {formatRiskValue(point.value, ratio.format)}</strong><p>{point.formula}</p>{ratio.note && <p>{ratio.note}</p>}<Sources sources={point.sources}/></div>; })}</details>}
  </details>;
}

function CashBridge({ row, basis }: { row: History | undefined; basis: string }) {
  const operating = numberAt(row, 'operatingCashFlow'), capex = numberAt(row, 'capitalExpenditure'), free = numberAt(row, 'freeCashFlow');
  if (operating == null || capex == null || free == null) return <div className={s.bridgeEmpty}><h3>Cash remaining after investment</h3><p>A complete bridge requires operating cash flow and reported capital expenditure for the same {basis === 'ttm' ? 'twelve months' : 'year'}. Missing investment spending is not treated as zero.</p><dl><div><dt>Operating cash flow</dt><dd>{formatRiskValue(operating)}</dd></div><div><dt>Capital expenditure</dt><dd>{formatRiskValue(capex)}</dd></div></dl></div>;
  const dividends = numberAt(row, 'dividendsPaid'), remaining = numberAt(row, 'cashAfterDividends');
  const steps = [{ label: 'Operating cash', value: operating, from: 0, to: operating, color: 'teal' }, { label: 'Capital spend', value: -capex, from: operating, to: free, color: 'muted' }, { label: 'OCF − capex', value: free, from: 0, to: free, color: 'gold' }];
  if (dividends != null && remaining != null) steps.push({ label: 'Cash dividends', value: -dividends, from: free, to: remaining, color: 'muted' }, { label: 'After dividends', value: remaining, from: 0, to: remaining, color: 'blue' });
  const low = Math.min(0, ...steps.flatMap(step => [step.from, step.to])), high = Math.max(0, ...steps.flatMap(step => [step.from, step.to])), span = high - low || 1;
  const y = (value: number) => 223 - (value - low) / span * 170;
  const width = 560 / steps.length, x = (index: number) => 106 + width * index;
  return <div className={s.bridge}><h3>From operating cash to financial flexibility</h3><p>{basis === 'ttm' ? 'Trailing twelve months' : 'Annual flows'} ended {row?.end}. Capital expenditure and dividends retain their reported scope.</p><div className={s.chartScroll} tabIndex={0} role="region" aria-label="Cash generation bridge. Scroll horizontally on narrow screens."><svg className={s.bridgeSvg} viewBox="0 0 740 280" role="img" aria-label={steps.map(step => `${step.label}: ${formatRiskValue(step.value)}`).join('; ')}>
    <line x1="88" x2="713" y1={y(0)} y2={y(0)} className={s.zero}/>
    {[low, high].filter((value, index, items) => items.indexOf(value) === index).map(value => <text key={value} x="78" y={y(value) + 4} textAnchor="end">{formatRiskValue(value)}</text>)}
    {steps.map((step, index) => <g key={step.label} className={s[step.color]}><rect x={x(index)} y={Math.min(y(step.from), y(step.to))} width={width * .62} height={Math.max(Math.abs(y(step.from) - y(step.to)), 1)} fill="currentColor" opacity={step.color === 'muted' ? .5 : .85}/><text x={x(index) + width * .31} y={Math.min(y(step.from), y(step.to)) - 10} textAnchor="middle" className={s.bridgeValue}>{formatRiskValue(step.value)}</text><text x={x(index) + width * .31} y="259" textAnchor="middle">{step.label}</text>{(index === 0 || index === 2 && steps.length > 3) && <line x1={x(index) + width * .62} x2={x(index + 1)} y1={y(step.to)} y2={y(step.to)} className={s.connector}/>}</g>)}
  </svg></div><p className={s.caption}>This cash-flow proxy precedes debt repayment, repurchases and other financing uses. It does not establish cash available for every obligation or contractual debt-service coverage.</p></div>;
}

const fundingSeries: PlotSeries[] = [
  { key: 'cash', label: 'Cash & equivalents', color: 'teal' },
  { key: 'currentMarketableSecurities', label: 'Current securities', color: 'blue' },
  { key: 'noncurrentMarketableSecurities', label: 'Noncurrent securities', color: 'muted', dashed: true },
  { key: 'totalDebt', label: 'Total debt', color: 'gold' },
];
const maturitySeries: PlotSeries[] = [
  { key: 'cash', label: 'Cash & equivalents', color: 'teal' },
  { key: 'currentDebt', label: 'Current debt', color: 'gold' },
  { key: 'noncurrentDebt', label: 'Noncurrent debt', color: 'blue', dashed: true },
];
const workingCapitalSeries: PlotSeries[] = [
  { key: 'currentAssets', label: 'Current assets', color: 'teal' },
  { key: 'currentLiabilities', label: 'Current liabilities', color: 'gold' },
];
const earningsSeries: PlotSeries[] = [
  { key: 'netIncome', label: 'Net income', color: 'blue' },
  { key: 'operatingCashFlow', label: 'Operating cash flow', color: 'teal' },
  { key: 'freeCashFlow', label: 'OCF − capital expenditure', color: 'gold' },
];
const debtCapacitySeries: PlotSeries[] = [
  { key: 'operatingCashFlow', label: 'Operating cash flow', color: 'teal' },
  { key: 'freeCashFlow', label: 'OCF − capital expenditure', color: 'blue' },
  { key: 'totalDebt', label: 'Ending total debt', color: 'gold', dashed: true },
];
const bankEarningsSeries: PlotSeries[] = [{ key: 'netIncome', label: 'Net income', color: 'teal' }, { key: 'provision', label: 'Credit-loss provision', color: 'gold' }];
const allFundingColumns: PlotSeries[] = [...fundingSeries, ...maturitySeries.filter(column => column.key !== 'cash'), ...workingCapitalSeries];
const allEarningsColumns: PlotSeries[] = [...earningsSeries, { key: 'capitalExpenditure', label: 'Capital expenditure', color: 'muted' }, { key: 'dividendsPaid', label: 'Cash dividends', color: 'muted' }, { key: 'cashAfterDividends', label: 'OCF − capex − dividends', color: 'blue' }, { key: 'totalDebt', label: 'Ending total debt', color: 'gold' }];

function BrokerBalances({ view, end, profile }: { view: FundingView; end: string; profile: RiskProfile }) {
  const [selectedGroup, setSelectedGroup] = useState('assets');
  const uid = useId();
  const assetKeys = ['cash', 'customerReceivables', 'brokerReceivables', 'securitiesBorrowed', 'reverseRepos', 'financialInstrumentsOwned'];
  const fundingKeys = ['customerPayables', 'brokerPayables', 'securitiesLoaned', 'repos', 'segregatedAssets'];
  const balances = (view.broker?.balances || []).filter(item => (selectedGroup === 'assets' ? assetKeys : fundingKeys).includes(item.id));
  const values = balances.map(item => ratioAt(item, end).value).filter(isNumber);
  const low = Math.min(0, ...values), high = Math.max(0, ...values), span = high - low || 1;
  const x = (value: number) => 255 + (value - low) / span * 360;
  const columns = (view.broker?.balances || []).map(item => ({ key: item.id, label: item.label, color: 'teal' as const }));
  return <section className={s.brokerBalances}><div className={s.chartHeading}><h3>The balances behind asset quality and funding</h3><label className={s.selectLabel} htmlFor={`${uid}-balances`}>Show<select id={`${uid}-balances`} value={selectedGroup} onChange={event => setSelectedGroup(event.target.value)}><option value="assets">Asset exposures</option><option value="funding">Funding & customer protection</option></select></label></div><p className={s.caption}>Separate reported balances on one dollar scale. Categories may overlap; they are not added or netted and have no assumed collateral haircut.</p><div className={s.chartScroll} tabIndex={0} role="region" aria-label="Broker-dealer balance comparisons. Scroll horizontally on narrow screens."><svg className={s.brokerBars} viewBox={`0 0 750 ${balances.length * 52 + 42}`} role="img" aria-label={`Reported broker-dealer ${selectedGroup === 'assets' ? 'asset exposures' : 'funding and customer protection balances'} at ${end}`}>
    <line x1={x(0)} x2={x(0)} y1="12" y2={balances.length * 52 + 4} className={s.zero}/>
    {balances.map((item, index) => { const value = ratioAt(item, end).value; return <g key={item.id}><text x="0" y={index * 52 + 27}>{item.label}</text><line x1="255" x2="615" y1={index * 52 + 24} y2={index * 52 + 24} className={s.grid}/>{value != null && <rect x={Math.min(x(0), x(value))} y={index * 52 + 15} width={Math.max(Math.abs(x(value) - x(0)), 1)} height="17" className={item.id === 'segregatedAssets' ? s.muted : selectedGroup === 'assets' ? s.teal : s.gold} fill="currentColor" opacity=".85"><title>{item.label}: {exact(value)} USD</title></rect>}<text x="728" y={index * 52 + 27} textAnchor="end" className={s.barAmount}>{value == null ? 'Unavailable' : formatRiskValue(value)}</text></g>; })}
    <text x="255" y={balances.length * 52 + 28}>{formatRiskValue(low)}</text><text x="615" y={balances.length * 52 + 28} textAnchor="end">{formatRiskValue(high)}</text>
  </svg></div>{selectedGroup === 'funding' && <p className={s.caption}>Segregated assets are shown for customer protection context. They are not added to available corporate cash or netted against funding obligations.</p>}<ExactHistory history={view.history} columns={columns} ratios={view.broker?.balances || []} end={end} profile={profile} title="Broker balance history, definitions & source inputs"/></section>;
}

function FinancialInstitution({ view, profile, end, onInspect }: { view: FundingView; profile: RiskProfile; end: string; onInspect?: (id: string) => void }) {
  const ratios = view.lens === 'bank' ? view.bank?.ratios || [] : view.lens === 'broker' ? view.broker?.ratios || [] : [...view.liquidity.ratios, ...view.obligations.ratios];
  const [selectedMetric, setSelectedMetric] = useState('');
  const active = ratios.find(ratio => ratio.id === selectedMetric) || ratios.find(ratio => ratio.series.some(point => point.value != null)) || ratios[0];
  const uid = useId();
  const balanceSeries: PlotSeries[] = view.lens === 'bank' ? [{ key: 'loans', label: 'Net loans', color: 'gold' }, { key: 'deposits', label: 'Deposits', color: 'teal' }, { key: 'cash', label: 'Tagged cash', color: 'blue', dashed: true }] : [{ key: 'totalAssets', label: 'Total assets', color: 'blue' }, { key: 'totalLiabilities', label: 'Total liabilities', color: 'gold' }, { key: view.lens === 'broker' ? 'consolidatedEquity' : 'equity', label: view.lens === 'broker' ? 'Consolidated book equity' : 'Book equity', color: 'teal' }];
  const selected = view.history.find(row => row.end === end);
  return <>
    {view.lens === 'bank' && view.bank ? <section className={s.camels} aria-labelledby={`${uid}-earnings`}><div className={s.kicker}>BANK EARNINGS / CREDIT COSTS & CAPITAL</div><h2 id={`${uid}-earnings`}>Earnings, credit costs and the capital buffer.</h2><p className={s.intro}>Follow the earnings available to build capital alongside credit-loss provisions and funding needs.</p><RatioStrip ratios={view.bank.ratios.filter(ratio => ['bank_earnings_assets', 'bank_allowance_nonaccrual', 'bank_preprovision_credit_cost'].includes(ratio.id))} end={end} onInspect={onInspect}/><div className={s.chartHeading}><h3>Earnings and credit-loss expense through time</h3><span>{end}</span></div><Legend items={bankEarningsSeries} row={selected}/><Timeline history={view.history} series={bankEarningsSeries} selectedEnd={end} basis={profile.basis} label="Bank earnings and credit-loss provisions"/><p className={s.caption}>Net income includes tax and provision expense. Provisions are shown separately; these lines are not additive components of pretax earnings.</p><ExactHistory history={view.history} columns={bankEarningsSeries} ratios={[]} end={end} profile={profile} title="Earnings and provision history & source inputs"/></section> : <section className={s.institutionIntro}><div className={s.kicker}>{view.lens === 'broker' ? 'BROKER-DEALER / ASSET QUALITY & FUNDING' : view.lens === 'insurance' ? 'INSURER / CAPITAL & CLAIMS CAPACITY' : 'FINANCIAL COMPANY / ASSETS & FUNDING'}</div><h2>{view.lens === 'broker' ? 'Asset quality and usable liquidity come first.' : 'Connect asset quality to financial obligations.'}</h2><p className={s.intro}>{view.lens === 'broker' ? 'Customer receivables, collateral, settlement balances and secured funding have different liquidity characteristics. Segregated client money does not become corporate liquidity.' : 'Read capital and earnings alongside the nature, duration and quality of the financial assets and liabilities.'}</p>{view.broker && <RatioStrip ratios={view.broker.ratios.filter(ratio => ['broker_cash_liabilities', 'broker_equity_assets', 'broker_receivables_assets'].includes(ratio.id))} end={end} onInspect={onInspect}/>}</section>}
    {view.lens === 'broker' && <BrokerBalances view={view} end={end} profile={profile}/>}
    <section className={s.institutionHistory}><div><div className={s.chartHeading}><h3>{view.lens === 'bank' ? 'Loans and funding through time' : 'The balance-sheet funding structure'}</h3><span>{end}</span></div><Legend items={balanceSeries} row={selected}/><Timeline history={view.history} series={balanceSeries} selectedEnd={end} basis={profile.basis} label="Financial institution balance-sheet history"/><p className={s.caption}>{view.lens === 'bank' ? 'Loan and deposit totals do not reveal uninsured balances, concentration, collateral eligibility or unused borrowing capacity.' : 'Total assets and cash are not measures of unencumbered liquidity. Restricted and customer balances require separate treatment.'}</p></div>
      {active && <div><div className={s.chartHeading}><label htmlFor={`${uid}-metric`}>Risk ratio history</label><select id={`${uid}-metric`} value={active.id} onChange={event => setSelectedMetric(event.target.value)}>{ratios.map(ratio => <option key={ratio.id} value={ratio.id}>{ratio.label}</option>)}</select></div><div className={s.activeRatio}><span>{active.label}</span><strong>{formatRiskValue(ratioAt(active, end).value, active.format)}</strong><p>{active.note || active.formula}</p></div><Timeline history={active.series.map(point => ({ end: point.end, label: point.label, value: point.value }))} series={[{ key: 'value', label: active.label, color: 'teal' }]} selectedEnd={end} basis={profile.basis} label={`${active.label} history`} format={active.format}/>{active.metricId && onInspect && <button className={s.inspect} onClick={() => onInspect(active.metricId!)}>Inspect {active.label}<ArrowUpRight size={12}/></button>}</div>}
    </section>
    <ExactHistory history={view.history} columns={balanceSeries} ratios={ratios} end={end} profile={profile} title="Financial history, definitions & source inputs"/>
  </>;
}

export default function RiskFundingStory({ profile, company, onInspect }: { profile: RiskProfile; company: { sic?: string; ticker?: string }; onInspect?: (id: string) => void }) {
  const view = buildRiskFundingPresentation(profile, company) as unknown as FundingView;
  const [selectedDate, setSelectedDate] = useState('');
  const [fundingView, setFundingView] = useState('balances');
  const [capacityView, setCapacityView] = useState('generation');
  const uid = useId();
  const end = view.history.some(row => row.end === selectedDate) ? selectedDate : view.history.at(-1)?.end || '';
  const selected = view.history.find(row => row.end === end);
  const balances = fundingView === 'maturities' ? maturitySeries : fundingView === 'working' ? workingCapitalSeries : fundingSeries;
  const flows = capacityView === 'debt' ? debtCapacitySeries : earningsSeries;
  return <div className={s.story}>
    <div className={s.storyControl}><span>{profile.basis === 'ttm' ? 'Quarter-end balances · trailing-twelve-month flows' : 'Fiscal year-end balances · annual flows'}</span><label htmlFor={`${uid}-date`}>Reporting date<select id={`${uid}-date`} value={end} onChange={event => setSelectedDate(event.target.value)} disabled={!view.history.length}>{view.history.length ? [...view.history].reverse().map(row => <option key={row.end} value={row.end}>{row.end}{row.end === view.history.at(-1)?.end ? ' (latest)' : ''}</option>) : <option value="">Unavailable</option>}</select></label></div>
    {view.lens === 'corporate' ? <>
      <section className={s.section} aria-labelledby={`${uid}-liquidity`}><div className={s.sectionTitle}><div><div className={s.kicker}>02 / LIQUIDITY & REFINANCING</div><h2 id={`${uid}-liquidity`}>Liquidity on hand. Borrowing to fund.</h2><p className={s.intro}>Follow the buffers and the obligations together, then separate near-term debt from the wider working-capital requirement.</p></div><span className={s.dateStamp}>{end}</span></div>
        <RatioStrip ratios={view.liquidity.ratios} end={end} onInspect={onInspect}/>
        <div className={s.chartHeading}><h3>How liquidity and borrowing have changed</h3><label htmlFor={`${uid}-funding`} className={s.selectLabel}>Compare<select id={`${uid}-funding`} value={fundingView} onChange={event => setFundingView(event.target.value)}><option value="balances">Cash, investments & debt</option><option value="maturities">Current & noncurrent debt</option><option value="working">Current assets & liabilities</option></select></label></div>
        <Legend items={balances} row={selected}/><Timeline history={view.history} series={balances} selectedEnd={end} basis={profile.basis} label="Liquidity and borrowing history"/>
        <p className={s.caption}>{fundingView === 'working' ? 'Current liabilities include obligations beyond borrowings. Current assets may include inventory, prepayments and receivables whose timing and collectability differ from cash.' : 'Balances share a dollar scale. Investments carry credit, market and liquidity risk; noncurrent securities are shown separately from cash. Current debt reflects reported classification, not a complete contractual maturity schedule.'}</p>
        <ExactHistory history={view.history} columns={allFundingColumns} ratios={view.liquidity.ratios} end={end} profile={profile} title="Liquidity history, ratios & SEC evidence"/>
      </section>
      <section className={s.section} aria-labelledby={`${uid}-capacity`}><div className={s.sectionTitle}><div><div className={s.kicker}>03 / EARNINGS & FINANCIAL OBLIGATIONS</div><h2 id={`${uid}-capacity`}>How much borrowing can cash generation support?</h2><p className={s.intro}>Profit supports credit capacity when it converts to cash. Investment needs and financial commitments determine how much flexibility remains.</p></div><span className={s.dateStamp}>{end}</span></div>
        <RatioStrip ratios={view.obligations.ratios} end={end} onInspect={onInspect}/>
        <CashBridge row={selected} basis={profile.basis}/>
        <div className={s.chartHeading}><h3>Cash generation and the debt balance</h3><label htmlFor={`${uid}-capacity-view`} className={s.selectLabel}>Compare<select id={`${uid}-capacity-view`} value={capacityView} onChange={event => setCapacityView(event.target.value)}><option value="generation">Earnings & cash generation</option><option value="debt">Annual cash generation & debt</option></select></label></div>
        <Legend items={flows} row={selected}/><Timeline history={view.history} series={flows} selectedEnd={end} basis={profile.basis} label="Earnings, cash generation and debt history"/>
        <p className={s.caption}>{capacityView === 'debt' ? 'Cash generation is a flow over the selected year or trailing twelve months; debt is the balance at that period end. Comparing them measures repayment capacity, not the amount contractually due or a debt-service coverage ratio.' : 'Flows cover the same annual or trailing-twelve-month window. Overlapping TTM observations are not independent quarters. OCF less reported capital expenditure is a cash-flow proxy, not a forecast.'}</p>
        <ExactHistory history={view.history} columns={allEarningsColumns} ratios={view.obligations.ratios} end={end} profile={profile} title="Cash-generation history, coverage ratios & SEC evidence"/>
      </section>
    </> : <FinancialInstitution view={view} profile={profile} end={end} onInspect={onInspect}/>}
    <details className={s.details}><summary>Financial-risk coverage & interpretation</summary>{view.limitations.map(note => <p key={note}>{note}</p>)}</details>
  </div>;
}
