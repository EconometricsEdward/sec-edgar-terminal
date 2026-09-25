'use client';
import Link from 'next/link';
import BankSearch from './BankSearch';
import { quarterLabel } from '../../../utils/bank/viewModel.js';
import styles from './banks.module.css';
export default function BankDirectory({ directory }) {
  return <div className={styles.page}>
    <div className={styles.eyebrow}>ANALYSIS <span>BANK REGULATORY RESEARCH</span></div>
    <header className={styles.header}><div><h1>BankScope<span className={styles.titleDot}>.</span></h1><p>A clearer view of the bank. Capital, credit, funding and earnings — from the Call Report.</p></div><span className={styles.badge}>FFIEC · 031 / 041 / 051</span></header>
    <BankSearch />
    {directory.unavailable && <p role="alert" className={styles.notice}>The bank directory is temporarily unavailable. Please reload to try again.</p>}
    <div className={styles.directoryFacts}><span><strong>{Number(directory.bankCount || 0).toLocaleString('en-US')}</strong> banks in the directory</span><span><strong>{directory.periods?.length || 0}</strong> recent reporting quarters</span><span><strong>35</strong> source-linked metrics</span></div>
    <div className={styles.featureGrid}><section><span>01 / OVERVIEW</span><h2>Understand the bank</h2><p>Follow each figure to its reported item, calculation and original XBRL source.</p></section><section><span>02 / COMPARE</span><h2>Find its financial peers</h2><p>Discover similar banks, explore peer distributions and compare up to four banks side by side.</p></section><section><span>03 / TRENDS</span><h2>See what changed</h2><p>Explore quarter-end balances, capital ratios and quarterly or year-to-date earnings.</p></section></div>
    {!!directory.banks?.length && <section className={styles.prepared}><div className={styles.sectionHeading}><h2>Ready to explore</h2><span>Latest available period · {quarterLabel(directory.periods?.[0])}</span></div><div className={styles.banks}>{directory.banks.map(b => <Link key={b.id_rssd} href={`/analysis/banks/${b.id_rssd}`} prefetch={false}><strong>{b.legal_name}</strong><small>{[b.city, b.state].filter(Boolean).join(', ')} · RSSD {b.id_rssd}</small><span>{b.prepared_quarters} quarters ready <span aria-hidden="true">→</span></span></Link>)}</div></section>}
    <footer className={styles.footer}><div><strong>Bank-level financials. Public regulatory sources.</strong><p>Coverage follows FFIEC Call Report reporters. A bank’s legal entity can differ from its listed holding company. Search results identify the entity by RSSD and FDIC certificate.</p><p>Newly selected banks are prepared on request. The directory is refreshed daily; historical coverage currently includes the four latest available quarters.</p></div><a href="https://cdr.ffiec.gov/public/" target="_blank" rel="noreferrer">About the source ↗</a></footer>
  </div>;
}
