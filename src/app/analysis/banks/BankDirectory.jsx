'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import BankSearch from './BankSearch';
import { isBankDirectory, loadBankDirectory } from './directoryRecovery.js';
import { quarterLabel } from '../../../utils/bank/viewModel.js';
import styles from './banks.module.css';
export default function BankDirectory({ directory }) {
  const [data, setData] = useState(() => isBankDirectory(directory) ? directory : null);
  const [recoverOnMount] = useState(() => !isBankDirectory(directory));
  const [status, setStatus] = useState(() => recoverOnMount ? 'loading' : 'ready');
  const request = useRef(null);
  const reload = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setStatus('loading');
    try {
      const next = await loadBankDirectory({ signal: controller.signal });
      if (!controller.signal.aborted) { setData(next); setStatus('ready'); }
    } catch {
      if (!controller.signal.aborted) setStatus('unavailable');
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, []);
  useEffect(() => {
    // One automatic recovery after a failed server read; further attempts are user initiated.
    // Let the server's brief failure cooldown expire before trying again.
    const timer = recoverOnMount ? setTimeout(reload, 6000) : null;
    return () => {
      clearTimeout(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [recoverOnMount, reload]);
  const savedDate = typeof data?.cachedAt === 'number' ? new Date(data.cachedAt)
    : typeof data?.cachedAt === 'string' ? new Date(Date.parse(data.cachedAt)) : null;
  const savedAt = savedDate && Number.isFinite(savedDate.getTime()) ? savedDate.toISOString() : null;
  return <div className={styles.page}>
    <div className={styles.eyebrow}>ANALYSIS <span>BANK REGULATORY RESEARCH</span></div>
    <header className={styles.header}><div><h1>BankScope<span className={styles.titleDot}>.</span></h1><p>A clearer view of the bank. Capital, credit, funding and earnings — from the Call Report.</p></div><span className={styles.badge}>FFIEC · 031 / 041 / 051</span></header>
    <BankSearch />
    {status !== 'ready' && <div className={styles.directoryRecovery}>
      <p role="status" aria-live="polite">{status === 'loading' ? 'Reconnecting to the bank directory…' : 'The directory could not be loaded. Try again, or search for a bank above.'}</p>
      <button type="button" onClick={reload} disabled={status === 'loading'}>{status === 'loading' ? 'Retrying…' : 'Retry directory'}</button>
    </div>}
    {data?.stale && <p className={styles.directoryStale}>Showing the last available directory{savedAt && <> · saved <time dateTime={savedAt}>{savedAt.slice(0, 16).replace('T', ' ')} UTC</time></>}.</p>}
    <div className={styles.directoryFacts}><span><strong>{data ? data.bankCount.toLocaleString('en-US') : '—'}</strong> banks in the directory</span><span><strong>{data ? data.periods.length : '—'}</strong> recent reporting quarters</span><span><strong>35</strong> source-linked metrics</span></div>
    <div className={styles.featureGrid}><section><span>01 / OVERVIEW</span><h2>Understand the bank</h2><p>Follow each figure to its reported item, calculation and original XBRL source.</p></section><section><span>02 / COMPARE</span><h2>Find its financial peers</h2><p>Discover similar banks, explore peer distributions and compare up to four banks side by side.</p></section><section><span>03 / TRENDS</span><h2>See what changed</h2><p>Explore quarter-end balances, capital ratios and quarterly or year-to-date earnings.</p></section></div>
    {!!data?.banks.length && <section className={styles.prepared}><div className={styles.sectionHeading}><h2>Ready to explore</h2><span>Latest available period · {quarterLabel(data.periods[0])}</span></div><div className={styles.banks}>{data.banks.map(b => <Link key={b.id_rssd} href={`/analysis/banks/${b.id_rssd}`} prefetch={false}><strong>{b.legal_name}</strong><small>{[b.city, b.state].filter(Boolean).join(', ')} · RSSD {b.id_rssd}</small><span>{b.prepared_quarters} quarters ready <span aria-hidden="true">→</span></span></Link>)}</div></section>}
    <footer className={styles.footer}><div><strong>Bank-level financials. Public regulatory sources.</strong><p>Coverage follows FFIEC Call Report reporters. Use Bank & Parent to follow the bank’s regulatory top holder, explore its offices and open parent SEC research. Search results identify the entity by RSSD and FDIC certificate.</p><p>Newly selected banks are prepared on request. The directory is refreshed daily; historical coverage currently includes the four latest available quarters.</p></div><a href="https://cdr.ffiec.gov/public/" target="_blank" rel="noreferrer">About the source ↗</a></footer>
  </div>;
}
