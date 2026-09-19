"use client";

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronDown, RefreshCw } from 'lucide-react';
import { clearPreparedCftc, fetchPreparedCftc } from '../../../utils/cftcClient.js';
import { clearPortfolioMarketComparison, loadPortfolioMarketComparison } from '../../../utils/portfolioMarketComparisonClient.js';
import { loadClassifiedTickerMap } from '../../../utils/tickerMapLoader.js';
import { buildCompareMarketContext, compareMarketCompanies, compareMarketIdentity, compareMarketObservation } from '../../../utils/compareMarketContext.js';
import s from './CompareMarketContext.module.css';

type Company = { ticker: string; cik?: string | number; companyName?: string; name?: string; companyType?: string; businessModel?: string; secIdentity?: { ticker: string; cik: string | number; isFund?: boolean } | null };
type Props = { companies: Company[]; asOf?: string; basis?: string; initiallyOpen?: boolean };
type Result = { body?: any; error?: boolean; secIdentity?: { ticker: string; cik: string } | null };
const signed = (value: number, suffix = '%') => `${value > 0 ? '+' : ''}${value.toFixed(1)}${suffix}`;
const exposurePath = (ticker: string, asOf: string) => `/api/v1/cftc/company-exposures?${new URLSearchParams({ ticker, ...(asOf ? { asOf } : {}) })}`;

export default function CompareMarketContext({ companies, asOf = '', basis = 'annual', initiallyOpen = false }: Props) {
  const [open, setOpen] = useState(initiallyOpen);
  const issuers = compareMarketCompanies(companies);
  const identity = JSON.stringify(issuers);
  if (!issuers.length) return null;
  return <details className={s.root} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span><b>Shared market drivers</b><small>Company disclosures + CFTC positioning</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
    {open && <MarketDetails key={`${identity}:${asOf}:${basis}`} companies={issuers} asOf={asOf} basis={basis} />}
  </details>;
}

function MarketDetails({ companies, asOf = '', basis = 'annual' }: Props) {
  const [responses, setResponses] = useState<Record<string, Result>>({});
  const [retry, setRetry] = useState(0);
  const [markets, setMarkets] = useState<any>(null);
  const [marketError, setMarketError] = useState(false);
  const [marketRetry, setMarketRetry] = useState(0);
  const [showCurrent, setShowCurrent] = useState(!asOf);
  const [selected, setSelected] = useState<{ key: string; cik: string } | null>(null);
  const companyKey = JSON.stringify(companies);
  useEffect(() => {
    const controller = new AbortController();
    const issuers: Company[] = JSON.parse(companyKey);
    let next = 0;
    let directory: ReturnType<typeof loadClassifiedTickerMap> | null = null;
    async function worker() {
      while (next < issuers.length && !controller.signal.aborted) {
        const company = issuers[next++];
        let secIdentity = compareMarketIdentity(company);
        try {
          if (!secIdentity && company.ticker.includes('.')) {
            directory ||= loadClassifiedTickerMap();
            secIdentity = compareMarketIdentity(company, await directory);
          }
          if (controller.signal.aborted) return;
          if (!secIdentity) throw new Error('The SEC issuer identity could not be verified.');
          const body = await fetchPreparedCftc(exposurePath(secIdentity.ticker, asOf), { signal: controller.signal, timeoutMs: 45_000 });
          if (!controller.signal.aborted) setResponses(current => ({ ...current, [company.ticker]: { body, secIdentity } }));
        } catch {
          if (!controller.signal.aborted) setResponses(current => ({ ...current, [company.ticker]: { error: true, secIdentity } }));
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(2, issuers.length) }, () => worker()));
    return () => controller.abort();
  }, [companyKey, asOf, retry]);
  const context = useMemo(() => buildCompareMarketContext(companies, responses, { basis, asOf }), [companies, responses, basis, asOf]);
  const hasConnections = context.rows.length > 0;
  useEffect(() => {
    if (!showCurrent || !hasConnections) return;
    const controller = new AbortController();
    setMarketError(false);
    loadPortfolioMarketComparison({ signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setMarkets(value);
    }).catch(() => { if (!controller.signal.aborted) setMarketError(true); });
    return () => controller.abort();
  }, [showCurrent, hasConnections, marketRetry]);
  const inspectedMarket = context.rows.find(row => row.key === selected?.key);
  const inspected = inspectedMarket?.members.find(member => member.cik === selected?.cik);
  function retryEvidence() {
    for (const company of companies) clearPreparedCftc(exposurePath(responses[company.ticker]?.secIdentity?.ticker || company.ticker, asOf));
    setResponses({}); setRetry(value => value + 1);
  }
  return <div className={s.body}>
    <div className={s.intro}>
      <p>{context.coverage.pending ? `Checking ${context.coverage.checked + context.coverage.failed} of ${context.coverage.total} companies…` : context.shared ? `${context.shared} market${context.shared === 1 ? '' : 's'} mentioned by multiple issuers.` : 'No unqualified shared contract connection established.'} {context.rows.length > 0 && 'Select a company connection to read its filing.'}</p>
      {(context.coverage.failed > 0 || context.coverage.partial > 0) && <button type="button" onClick={retryEvidence}><RefreshCw size={13} />Retry incomplete filings</button>}
    </div>
    {context.coverage.pending > 0 && <p className={s.note} role="status">Reading the selected annual{basis === 'annual' ? '' : ' and newer quarterly'} reports.</p>}
    {(context.coverage.failed > 0 || context.coverage.partial > 0) && <p className={s.note}>{context.coverage.failed} company scans unavailable{context.coverage.partial ? ` · ${context.coverage.partial} incomplete` : ''}. Missing connections are not treated as zero exposure.</p>}
    {!context.coverage.pending && !context.rows.length && <p className={s.note}>The available passages do not establish a supported futures benchmark{asOf ? ` in filings available by ${asOf}` : ''}. Generic rate or currency language is not assigned a specific contract.</p>}
    {context.rows.length > 0 && <>
      {asOf && <p className={s.historical}>SEC filings through {asOf}. {showCurrent ? 'The CFTC observations below are current context and are excluded from this historical comparison.' : <button type="button" onClick={() => setShowCurrent(true)}>View current market positioning<ArrowUpRight size={13} /></button>}</p>}
      <div className={s.scroll} role="region" aria-label="Company market connections" tabIndex={0}>
        <table className={s.table}>
          <thead><tr><th scope="col">Market</th>{context.companies.map(company => <th scope="col" key={company.cik}>{company.ticker}</th>)}{showCurrent && <th className={s.observationHeader} scope="col">Current CFTC positioning<small>Net / open interest · weekly change</small></th>}</tr></thead>
          <tbody>{context.rows.map(market => {
            const observation = compareMarketObservation(markets?.summaries?.[market.key], market);
            return <tr key={market.key}><th scope="row"><span>{market.label}</span><small>{market.groupLabel} · futures only</small></th>
              {context.companies.map(company => {
                const member = market.members.find(item => item.cik === company.cik);
                const status = context.states[company.ticker];
                return <td key={company.cik}>{member ? <button type="button" className={s.connection} data-fit={member.qualified ? 'review' : member.named ? 'named' : 'proxy'} aria-pressed={selected?.key === market.key && selected?.cik === company.cik} aria-label={`Read ${company.ticker} filing connection to ${market.label}`} onClick={() => setSelected(current => current?.key === market.key && current?.cik === company.cik ? null : { key: market.key, cik: company.cik })}>{member.qualified ? 'Review' : member.named ? 'Named' : 'Proxy'}</button> : <span className={s.absent} title={status === 'pending' ? 'Scan pending' : status === 'failed' ? 'Scan unavailable' : status === 'partial' ? 'Incomplete scan; no supported passage found' : 'No supported connection in the selected passages'}>{status === 'pending' ? '…' : status === 'failed' || status === 'partial' ? '?' : '—'}</span>}</td>;
              })}
              {showCurrent && <td className={s.observation}>{observation ? <><a href={observation.marketPath} className={s.position}><b>{signed(observation.netPctOi)}</b><span>{observation.weeklyChangePp === null ? 'Weekly change unavailable' : `${signed(observation.weeklyChangePp, ' pp')} this week`}</span><ArrowUpRight size={13} /></a><div className={s.track} aria-hidden="true"><i style={{ left: `${observation.netPctOi < 0 ? 50 + observation.netPctOi / 2 : 50}%`, width: `${Math.abs(observation.netPctOi) / 2}%` }} /></div><small>Positions {observation.reportDate}{observation.stale ? ' · Aged snapshot' : ''}{observation.incomplete ? ' · Partial history' : ''}</small></> : <span className={s.note}>{marketError || markets ? 'Positioning unavailable' : 'Loading positioning…'}</span>}</td>}
            </tr>;
          })}</tbody>
        </table>
      </div>
      {marketError && <button className={s.retry} type="button" onClick={() => { clearPortfolioMarketComparison(); setMarketRetry(value => value + 1); }}><RefreshCw size={13} />Retry CFTC positioning</button>}
      {inspected && inspectedMarket && <div className={s.passage}>
        <div><b>{inspected.ticker} · {inspectedMarket.label}</b><button type="button" onClick={() => setSelected(null)}>Close passages</button></div>
        <p>{inspected.channels.join(' · ')}{inspected.qualified ? ' · Includes a qualification or negative disclosure; review before inferring a connection.' : inspected.named ? ' · The filing names this benchmark.' : ' · Related benchmark; contract terms, regions or maturities may differ.'}</p>
        {inspected.evidence.map(item => <blockquote key={item.id}><p>{item.text}</p><cite><a href={item.url} target="_blank" rel="noreferrer">{item.form} · Filed {item.filed} · Period {item.reportDate}<ArrowUpRight size={12} /></a>{item.disclosureDirection === 'qualifying-or-negative' && <span> · Qualification / negative disclosure</span>}</cite></blockquote>)}
      </div>}
      <p className={s.legend}><span><i data-fit="named" />Named benchmark</span><span><i data-fit="proxy" />Related benchmark proxy</span><span><i data-fit="review" />Qualification in filing</span><span>— No mapped passage</span></p>
      <p className={s.note}>CFTC positions are market-wide trader totals, not company holdings or measured sensitivities.{context.totalMarkets > 4 ? ` Showing 4 of ${context.totalMarkets} mapped markets, ordered by issuer overlap.` : ''}{context.coverage.unmapped ? ' Other disclosed channels lack a supported contract.' : ''}</p>
    </>}
  </div>;
}
