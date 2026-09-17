'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Globe2 } from 'lucide-react';
import { buildMarketMacroSummary } from '../../utils/marketMacroSummary.js';
import type { MarketData } from './marketTypes';
import s from './marketSectorPerformance.module.css';

export function MarketUniverseCoverage({ data }: { data: MarketData }) {
  const summary = useMemo(() => buildMarketMacroSummary(data), [data]);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const target = data.coverage?.target_issuers ?? data.requested;
  return <details className={s.coverage}>
    <summary className={s.coverageSummary}><span className={s.coverageTitle}><Globe2 size={19} /><span>Market universe<small>Calculated {data.generatedAt.slice(0, 16).replace('T', ' ')} UTC</small></span></span><span className={s.coverageCounts}><span><b>{summary.companyCount.toLocaleString()}</b> companies</span><span><b>{summary.sectorCount}</b> sectors</span><span><b>{summary.industryCount}</b> industries</span></span><ChevronDown className={s.coverageChevron} size={18} /></summary>
    <div className={s.coverageBody}>
      <p className={s.description}>{summary.companyCount.toLocaleString()} of {target.toLocaleString()} target issuers have loaded financial data. Sector and industry counts describe these loaded companies. Industries are distinct reported SEC SIC codes; primary sectors use the published coverage classification.</p>
      <div className={s.coverageColumns}>
        <section><h3>Primary sectors <small>{summary.sectorCount} represented</small></h3><div className={s.sectorList}>{summary.sectors.map(sector => <div key={sector.id}><span>{sector.label}</span><b>{sector.count.toLocaleString()}</b></div>)}</div><p className={s.note}>{summary.missingSectorCount ? `${summary.missingSectorCount} companies have no primary-sector classification and are excluded from the sector count.` : 'Every loaded company has a primary sector. Each issuer counts once.'}</p></section>
        <section><h3>SEC industries <small>{summary.industryCount} represented</small></h3><div className={s.industryDirectory} tabIndex={0} aria-label="Covered SEC industries and company counts">{summary.industries.map(industry => <div key={industry.code}><code>{industry.code}</code><span>{industry.label}</span><b>{industry.count}</b></div>)}</div><p className={s.note}>{summary.missingIndustryCount} companies with missing or invalid SIC codes are excluded from the industry count. {summary.unknownIndustryCount > 0 && `${summary.unknownIndustryCount} reported codes (${summary.unknownIndustryCompanyCount} companies) have no label in the SEC reference. `}<a href={summary.classificationSource} target="_blank" rel="noreferrer">SEC SIC definitions</a></p></section>
      </div>
      <details className={s.companyDirectory} onToggle={event => setDirectoryOpen(event.currentTarget.open)}><summary>View the covered companies <span>{summary.companyCount.toLocaleString()} issuers</span></summary>{directoryOpen && <div className={s.companyDirectoryScroll} tabIndex={0} aria-label="Covered company directory"><table><caption className={s.srOnly}>Companies included in the Market financial snapshot and their primary sectors</caption><thead><tr><th scope="col">Ticker</th><th scope="col">Company</th><th scope="col">Primary sector</th></tr></thead><tbody>{data.companies.map(company => <tr key={`${company.cik}-${company.ticker}`}><th scope="row">{company.ticker}</th><td>{company.name}</td><td>{company.sector || summary.sectors.find(sector => company.cohorts.includes(sector.id))?.label || 'Unclassified'}</td></tr>)}</tbody></table></div>}</details>
      <div className={s.coverageSources}><b>Coverage sources</b>{data.coverage?.sources.length ? data.coverage.sources.map(source => <a key={`${source.fund}-${source.as_of}`} href={source.url} target="_blank" rel="noreferrer">{source.fund} · {source.as_of}</a>) : <span>Curated SEC filing universe</span>}<span>Calculated {data.generatedAt.slice(0, 16).replace('T', ' ')} UTC</span></div>
      <p className={s.note}>Fund holdings define research coverage, not the whole economy. This sample is not a market-cap-weighted index; classifications and coverage may change.</p>
      {data.failures.length > 0 && <details className={s.unavailable}><summary>{data.failures.length} unavailable companies</summary><ul>{data.failures.map(failure => <li key={failure.ticker}><b>{failure.ticker}</b> · {failure.reason}</li>)}</ul></details>}
    </div>
  </details>;
}

export default MarketUniverseCoverage;
