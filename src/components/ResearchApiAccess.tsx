import styles from './ResearchApiAccess.module.css';

type Props = { context: 'disclosures' | 'risk' | 'bank'; rssd?: string; period?: string };

/** Static links expose relevant machine workflows without starting a purchase or data read. */
export default function ResearchApiAccess({ context, rssd, period }: Props) {
  const bankSelection = rssd && /^[1-9]\d{0,9}$/.test(rssd) && period && /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(period)
    ? new URLSearchParams({ product: 'bank-risk-batch', rssds: rssd, period }).toString() : null;
  const choices = context === 'disclosures'
    ? [{ id: 'disclosure-topic-packet', label: 'Company disclosure packets' }, { id: 'disclosure-evidence', label: 'Exact passage search' }]
    : context === 'bank'
      ? [{ id: 'bank-risk-batch', label: 'Bank risk batches' }]
      : [{ id: 'disclosure-topic-packet', label: 'Liquidity & covenant evidence' }, { id: 'bank-risk-batch', label: 'Bank capital & funding batches' }, { id: 'credit-screen', label: 'Debt & liquidity screens' }];
  const detail = context === 'bank'
    ? 'Compare prepared Call Report measures and prior-quarter changes across up to four legal banks, with reporting dates, calculation inputs and original source references.'
    : context === 'disclosures'
      ? 'Retrieve original paragraphs across selected research topics in one company packet, or run an exact passage search. Source links and prepared coverage travel with the evidence.'
      : 'Bring disclosure evidence, legal-bank regulatory measures and debt screens into your research workflow with source context and explicit data gaps.';
  return <aside className={styles.panel} aria-label='Data products for this research'>
    <div><p className={styles.eyebrow}>For agents & developers</p><h2>Use this research in your workflow.</h2><p>{detail}</p></div>
    <div className={styles.actions}>
      {choices.map(choice => <a key={choice.id} href={`/data-access#${choice.id}`}>{choice.label}<span aria-hidden='true'> ↗</span></a>)}
      {bankSelection ? <a href={`/api/x402/availability?${bankSelection}`}>Check this bank’s prepared coverage free<span aria-hidden='true'> ↗</span></a> : null}
      <p>JSON & CSV · 0.01 USDC per successful paid request · Coverage checks are free</p>
    </div>
  </aside>;
}
