'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { companyToolPath } from '../../utils/siteRoutes.js';
import type { Basis, Company } from './marketTypes';
import s from './marketSectorPerformance.module.css';

const PAGE_SIZE = 50;

export default function MarketCompanyDirectory({ companies, sectors, basis }: { companies: Company[]; sectors: { id: string; label: string }[]; basis?: Basis }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const rows = useMemo(() => companies.map(company => {
    const path = companyToolPath('analysis', company.ticker);
    return {
      ...company,
      sectorLabel: company.sector || sectors.find(sector => company.cohorts.includes(sector.id))?.label || 'Unclassified',
      href: path && basis ? `${path}?basis=${basis}` : path,
    };
  }), [companies, sectors, basis]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term ? rows.filter(company => `${company.ticker} ${company.name} ${company.sectorLabel}`.toLowerCase().includes(term)) : rows;
  }, [rows, query]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const start = currentPage * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  return <details className={s.companyDirectory} id="market-companies">
    <summary>Find a company <span>{companies.length.toLocaleString()} issuers · open company Analysis</span></summary>
    <div className={s.directoryControls}>
      <label htmlFor="market-company-search">Search covered companies</label>
      <input id="market-company-search" type="search" value={query} placeholder="Ticker, company or sector" onChange={event => { setQuery(event.target.value); setPage(0); }} />
      <p className={s.note}>Select a ticker or company name to open its financial statements, ratios, and SEC source evidence in Analysis.</p>
    </div>
    <div className={s.companyDirectoryScroll} tabIndex={0} aria-label="Covered company directory">
      <table><caption className={s.srOnly}>Companies included in the Market financial snapshot and their primary sectors</caption>
        <thead><tr><th scope="col">Ticker</th><th scope="col">Company</th><th scope="col">Primary sector</th></tr></thead>
        <tbody>{visible.map(company => <tr key={`${company.cik}-${company.ticker}`}>
          <th scope="row">{company.href ? <Link prefetch={false} href={company.href} aria-label={`Analyze ${company.ticker}`}>{company.ticker} ↗</Link> : company.ticker}</th>
          <td>{company.href ? <Link prefetch={false} href={company.href}>{company.name}</Link> : company.name}{company.revenueBasis && company.revenueBasis !== 'Reported total revenue' && <small className={s.directoryBasis}>{company.revenueBasis}</small>}</td>
          <td>{company.sectorLabel}</td>
        </tr>)}{!visible.length && <tr><td colSpan={3}>No covered companies match “{query}”. Try a ticker, company name, or sector.</td></tr>}</tbody>
      </table>
    </div>
    <div className={s.directoryPagination}>
      <span role="status">{filtered.length ? `${start + 1}–${start + visible.length} of ${filtered.length.toLocaleString()} companies` : '0 companies'}</span>
      <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous companies</button>
      <button type="button" disabled={start + PAGE_SIZE >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next companies</button>
    </div>
  </details>;
}
