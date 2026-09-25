import styles from './banks.module.css';
export default function LoadingBanks() { return <div className={styles.page} role="status"><p className={styles.eyebrow}>BANKSCOPE · FFIEC</p><h1>Loading bank research…</h1></div>; }
