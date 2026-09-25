'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './AnalysisSections.module.css';
export default function AnalysisSections() {
  const bank = usePathname().startsWith('/analysis/banks');
  return <nav className={styles.nav} aria-label="Analysis sections">
    <Link href="/analysis" aria-current={!bank ? 'page' : undefined}>Company analysis</Link>
    <Link href="/analysis/banks" aria-current={bank ? 'page' : undefined}>BankScope <span>FFIEC</span></Link>
  </nav>;
}
