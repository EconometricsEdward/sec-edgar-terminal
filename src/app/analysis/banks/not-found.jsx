import Link from 'next/link';
import styles from './banks.module.css';
export default function BankNotFound() { return <div className={styles.page}><h1>Bank not found</h1><p className={styles.basis}>Choose an institution from the FFIEC Call Report directory.</p><Link className={styles.textLink} href="/analysis/banks">Search BankScope →</Link></div>; }
