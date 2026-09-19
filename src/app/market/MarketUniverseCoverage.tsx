'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { ChevronDown, Globe2 } from 'lucide-react';
import type { Basis, MarketBriefingData, MarketSummary } from './marketTypes';
import s from './marketSectorPerformance.module.css';

const MarketCompanyDirectory = dynamic(() => import('./MarketCompanyDirectory'), { loading: () => <p role="status">Loading company search…</p> });

export function MarketUniverseCoverage({ data, summary, basis }: { data: MarketBriefingData; summary: MarketSummary; basis: Basis }) {
  const [opened, setOpened] = useState(false);
  const [active, setActive] = useState(false);
  const target = data.coverage?.target_issuers ?? data.requested;
  const unsupported = Math.min(data.failureCount, data.coverage?.unsupported_issuers ?? 0);
  const awaiting = data.failureCount - unsupported;
  return <details className={s.coverage} onToggle={event => { setActive(event.currentTarget.open); if (event.currentTarget.open) setOpened(true); }}>
    <summary className={s.coverageSummary}><span className={s.coverageTitle}><Globe2 size={19} /><span>Market universe<small>Calculated {data.generatedAt.slice(0, 16).replace('T', ' ')} UTC</small></span></span><span className={s.coverageCounts}><span><b>{summary.companyCount.toLocaleString()}</b> companies</span><span><b>{summary.sectorCount}</b> sectors</span><span><b>{summary.industryCount}</b> industries</span></span><ChevronDown className={s.coverageChevron} size={18} /></summary>
    {opened && <div className={s.coverageBody}>
      <p className={s.description}>{summary.companyCount.toLocaleString()} of {target.toLocaleString()} candidate issuers have loaded financial data. Sector and industry counts describe these loaded companies. Industries are distinct reported SEC SIC codes; each company is counted once.</p>
      <MarketCompanyDirectory total={summary.companyCount} generatedAt={data.generatedAt} sectors={summary.sectors} basis={basis} active={active} />
      <div className={s.coverageColumns}>
        <section><h3>Primary sectors <small>{summary.sectorCount} represented</small></h3><div className={s.sectorList}>{summary.sectors.map(sector => <div key={sector.id}><span>{sector.label}</span><b>{sector.count.toLocaleString()}</b></div>)}</div><p className={s.note}>{summary.missingSectorCount ? `${summary.missingSectorCount} companies have no primary-sector classification and are excluded from the sector count.` : 'Every loaded company has a primary sector. Each issuer counts once.'}</p></section>
        <section><h3>SEC industries <small>{summary.industryCount} represented</small></h3><div className={s.industryDirectory} tabIndex={0} aria-label="Covered SEC industries and company counts">{summary.industries.map(industry => <div key={industry.code}><code>{industry.code}</code><span>{industry.label}</span><b>{industry.count}</b></div>)}</div><p className={s.note}>{summary.missingIndustryCount} companies with missing or invalid SIC codes are excluded from the industry count. {summary.unknownIndustryCount > 0 && `${summary.unknownIndustryCount} reported codes (${summary.unknownIndustryCompanyCount} companies) have no label in the SEC reference. `}<a href={summary.classificationSource} target="_blank" rel="noreferrer">SEC SIC definitions</a></p></section>
      </div>
      <div className={s.coverageSources}><b>Coverage sources</b>{data.coverage?.sources.length ? data.coverage.sources.map(source => <a key={`${source.fund}-${source.as_of}`} href={source.url} target="_blank" rel="noreferrer">{source.fund} · {source.as_of}</a>) : <span>Prepared SEC filing universe</span>}<span>Calculated {data.generatedAt.slice(0, 16).replace('T', ' ')} UTC</span></div>
      {data.coverage?.grouping && <p className={s.note}><b>Classification.</b> {data.coverage.grouping}</p>}
      {data.coverage?.membership_warning && <p className={s.note}><b>Coverage update.</b> {data.coverage.membership_warning}</p>}
      <p className={s.note}>Coverage describes the prepared research sample, not the whole economy or a market-cap-weighted index. Classifications and coverage may change.</p>
      {data.failureCount > 0 && <p className={s.note}>{awaiting > 0 && `${awaiting.toLocaleString()} candidates are awaiting financial data or a successful refresh. `}{unsupported > 0 && `${unsupported.toLocaleString()} candidates have unsupported reporting data. `}These candidates are excluded from the figures and company search.</p>}
    </div>}
  </details>;
}

export default MarketUniverseCoverage;
