'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { companyToolPath } from '../../utils/siteRoutes.js';
import type { Basis, MarketDirectoryPage } from './marketTypes';
import s from './marketSectorPerformance.module.css';

const PAGE_SIZE = 50;
const CACHE_MS = 5 * 60 * 1000;
const pageCache = new Map<string, { at: number; value: MarketDirectoryPage }>();
const normalizeQuery = (query: string) => query.trim().replace(/\s+/g, ' ').toLowerCase();

export function isMarketDirectoryPage(value: unknown, expected: { query: string; sector: string; page: number }): value is MarketDirectoryPage {
  if (!value || typeof value !== 'object') return false;
  const result = value as MarketDirectoryPage;
  return result.version === 'market-directory-v1'
    && typeof result.generatedAt === 'string' && Number.isFinite(Date.parse(result.generatedAt))
    && result.query === expected.query && result.sector === expected.sector
    && Number.isSafeInteger(result.total) && result.total >= 0 && result.pageSize === PAGE_SIZE
    && result.page === Math.min(expected.page, Math.max(1, Math.ceil(result.total / PAGE_SIZE)))
    && Number.isSafeInteger(result.failureCount) && result.failureCount >= 0
    && Array.isArray(result.companies) && result.companies.length <= Math.min(PAGE_SIZE, result.total)
    && result.companies.every(company => company && typeof company.ticker === 'string' && Boolean(companyToolPath('analysis', company.ticker))
      && typeof company.name === 'string' && typeof company.cik === 'string' && /^\d{1,10}$/.test(company.cik) && Number(company.cik) > 0
      && typeof company.sector === 'string' && (company.revenueBasis === undefined || typeof company.revenueBasis === 'string'))
    && new Set(result.companies.map(company => Number(company.cik))).size === result.companies.length;
}

export default function MarketCompanyDirectory({ total, generatedAt, sectors, basis, active = true }: { total: number; generatedAt: string; sectors: { id: string; label: string }[]; basis?: Basis; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sector, setSector] = useState('all');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<MarketDirectoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const normalizedQuery = normalizeQuery(query);
  const pendingQuery = normalizedQuery !== debouncedQuery;
  const params = new URLSearchParams({ query: debouncedQuery, sector, page: String(page) });
  const path = `/api/market-companies?${params}`;
  const cacheKey = `${generatedAt}:${path}`;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(normalizedQuery), 250);
    return () => clearTimeout(timer);
  }, [normalizedQuery]);

  useEffect(() => {
    if (!open || !active || pendingQuery) return;
    const cached = pageCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MS) { setResult(cached.value); setLoading(false); setError(''); return; }
    let current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Company search is taking longer than expected. Please retry.')), 15_000);
    setLoading(true); setError('');
    void (async () => {
      try {
        const response = await fetch(path, { signal: controller.signal });
        const value = await response.json();
        if (!response.ok || !isMarketDirectoryPage(value, { query: debouncedQuery, sector, page })) throw new Error('Company search is temporarily unavailable. Please retry.');
        if (!current) return;
        pageCache.delete(cacheKey);
        pageCache.set(cacheKey, { at: Date.now(), value });
        while (pageCache.size > 12) pageCache.delete(pageCache.keys().next().value!);
        setResult(value);
        if (value.page !== page) setPage(value.page);
      } catch (reason) {
        if (current) setError(reason instanceof Error ? reason.message : 'Could not load company search.');
      } finally {
        clearTimeout(timeout);
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; clearTimeout(timeout); controller.abort(); };
  }, [open, active, pendingQuery, cacheKey, path, debouncedQuery, sector, page, attempt]);

  const visibleResult = !pendingQuery && result?.query === debouncedQuery && result.sector === sector && result.page === page ? result : null;
  const busy = loading || pendingQuery || (!visibleResult && !error);
  const start = (page - 1) * PAGE_SIZE;

  return <details className={s.companyDirectory} id="market-companies" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Find a company <span>{total.toLocaleString()} loaded issuers · open company Analysis</span></summary>
    {open && <>
      <div className={s.directoryControls}>
        <label htmlFor="market-company-search">Search covered companies</label>
        <div className={s.directorySearchRow}>
          <input id="market-company-search" type="search" value={query} maxLength={100} placeholder="Ticker or company name" autoComplete="off" aria-controls="market-company-results" onChange={event => { setQuery(event.target.value); setPage(1); }} />
          <label className={s.srOnly} htmlFor="market-company-sector">Filter company sector</label>
          <select id="market-company-sector" value={sector} onChange={event => { setSector(event.target.value); setPage(1); }}><option value="all">All sectors</option>{sectors.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        </div>
        <p className={s.note}>Search the loaded universe. Select a company to open its financial statements, ratios, and SEC sources.</p>
      </div>
      <div id="market-company-results" aria-busy={busy}>
        {error && !pendingQuery ? <div className={s.directoryError} role="alert"><span>{error}</span><button type="button" onClick={() => { pageCache.delete(cacheKey); setAttempt(value => value + 1); }}>Retry company search</button></div> : busy && !visibleResult ? <p className={s.directoryStatus} role="status">Searching covered companies…</p> : visibleResult && <>
          <div className={s.companyDirectoryScroll} tabIndex={0} aria-label="Covered company directory">
            <table><caption className={s.srOnly}>Companies included in the Market financial snapshot and their primary sectors</caption>
              <thead><tr><th scope="col">Ticker</th><th scope="col">Company</th><th scope="col">Primary sector</th></tr></thead>
              <tbody>{visibleResult.companies.map(company => {
                const analysisPath = companyToolPath('analysis', company.ticker)!;
                const href = basis ? `${analysisPath}?basis=${basis}` : analysisPath;
                return <tr key={company.cik}>
                  <th scope="row"><Link prefetch={false} href={href} aria-label={`Analyze ${company.ticker}`}>{company.ticker} ↗</Link></th>
                  <td><Link prefetch={false} href={href}>{company.name}</Link>{company.revenueBasis && company.revenueBasis !== 'Reported total revenue' && <small className={s.directoryBasis}>{company.revenueBasis}</small>}</td>
                  <td>{company.sector || 'Unclassified'}</td>
                </tr>;
              })}{!visibleResult.companies.length && <tr><td colSpan={3}>No covered companies match{query.trim() ? ` “${query.trim()}”` : ' these filters'}. Try a ticker, company name, or another sector.</td></tr>}</tbody>
            </table>
          </div>
          <div className={s.directoryPagination}>
            <span role="status">{visibleResult.companies.length ? `${start + 1}–${start + visibleResult.companies.length} of ${visibleResult.total.toLocaleString()} companies` : `${visibleResult.total.toLocaleString()} matching companies`}</span>
            <button type="button" disabled={busy || page === 1} onClick={() => setPage(page - 1)}>Previous companies</button>
            <button type="button" disabled={busy || start + PAGE_SIZE >= visibleResult.total} onClick={() => setPage(page + 1)}>Next companies</button>
          </div>
          {visibleResult.generatedAt !== generatedAt && <p className={s.note}>Company directory snapshot: {visibleResult.generatedAt.slice(0, 16).replace('T', ' ')} UTC.</p>}
        </>}
      </div>
    </>}
  </details>;
}
