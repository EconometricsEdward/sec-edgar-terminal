'use client';
import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import styles from './banks.module.css';
export default function BankSearch({ onSelect, exclude = [], label = 'Find a bank', compact = false }) {
  const id = useId();
  const [query, setQuery] = useState(''), [result, setResult] = useState({ banks: [] }), [status, setStatus] = useState('');
  useEffect(() => {
    if (query.trim().length < 2) { setResult({ banks: [] }); setStatus(''); return; }
    const controller = new AbortController();
    setStatus('Searching…');
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/banks?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Bank search is temporarily unavailable.');
        setResult(body); setStatus(body.banks.length ? '' : 'No matches. Try a legal bank name, RSSD, FDIC certificate, city or state.');
      } catch (error) { if (error.name !== 'AbortError') { setResult({ banks: [] }); setStatus(error.message); } }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  const banks = (result.banks || []).filter(b => !exclude.map(String).includes(String(b.id_rssd)));
  return <div className={`${styles.search} ${compact ? styles.compactSearch : ''}`}>
    <label htmlFor={id}>{label}</label>
    <div className={styles.searchInput}><span aria-hidden="true">⌕</span><input id={id} type="search" autoComplete="off" maxLength={100} placeholder="Bank name, RSSD, FDIC certificate, city or state" value={query} onChange={e => setQuery(e.target.value)} aria-describedby={`${id}-hint`} /></div>
    <p id={`${id}-hint`} className={styles.searchHint}>Search legal bank entities, including banks without a stock ticker.</p>
    <div role="status" aria-live="polite" className={styles.searchStatus}>{status || (query.trim().length >= 2 && banks.length === 0 && result.banks?.length ? 'All matching banks are already selected.' : '')}</div>
    {query.trim().length >= 2 && banks.length > 0 && !status && <div className={styles.searchResults}>
      <p>{banks.length === 25 ? 'First 25 matches — refine your search' : `${banks.length} matching ${banks.length === 1 ? 'bank' : 'banks'}`}</p>
      <ul>{banks.map(b => <li key={b.id_rssd}>{onSelect ? <button type="button" onClick={() => { onSelect(b); setQuery(''); }}><SearchResult bank={b} /><span aria-hidden="true">＋</span></button> : <Link href={`/analysis/banks/${b.id_rssd}`} prefetch={false}><SearchResult bank={b} /><span aria-hidden="true">→</span></Link>}</li>)}</ul>
    </div>}
  </div>;
}
function SearchResult({ bank: b }) { return <span><strong>{b.legal_name}</strong><small>{[b.city, b.state].filter(Boolean).join(', ')} · RSSD {b.id_rssd}{b.fdic_certificate ? ` · FDIC ${b.fdic_certificate}` : ''} · FFIEC {b.form_type || 'Call Report'}{Number(b.prepared_quarters) > 0 ? ` · ${b.prepared_quarters} quarters ready` : ''}</small></span>; }
