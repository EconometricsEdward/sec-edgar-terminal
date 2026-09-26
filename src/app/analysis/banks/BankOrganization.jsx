'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Building2, GitBranch, Landmark, MapPin } from 'lucide-react';
import { bankHref } from '../../../utils/bank/viewModel.js';
import { nicProfile, NIC_ABOUT, NIC_REPORTS, FDIC_DEFINITIONS } from '../../../utils/bank/organizationModel.js';
import { useSecFilerSearch } from '../../../utils/useSecFilerSearch.js';
import styles from './organization.module.css';

const number = value => value == null ? '—' : new Intl.NumberFormat('en-US').format(value);
const date = value => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Date unavailable';
const place = entity => [entity?.city, entity?.state].filter(Boolean).join(', ');

function useOrganization(rssd, part, enabled = true) {
  const [result, setResult] = useState(null), [error, setError] = useState(null), [attempt, setAttempt] = useState(0);
  const identity = `${rssd}:${part}:${attempt}`;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 45000);
    let disposed = false;
    fetch(`/api/banks/organization?${new URLSearchParams({ rssd: String(rssd), part })}`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Organization data could not be loaded.');
        if (Number(body.rssd) !== Number(rssd) || body.version !== 'bankscope-organization-1') throw new Error('Organization identity could not be checked.');
        if (!disposed) setResult({ identity, data: body });
      }).catch(failure => { if (!disposed) setError({ identity, message: failure.name === 'AbortError' ? 'Organization data timed out. Please retry.' : failure.message }); })
      .finally(() => clearTimeout(deadline));
    return () => { disposed = true; clearTimeout(deadline); controller.abort(); };
  }, [rssd, part, identity, enabled]);
  return { data: result?.identity === identity ? result.data : null, error: error?.identity === identity ? error.message : '', retry: () => setAttempt(n => n + 1) };
}
function External({ href, children, ...props }) { return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}<ArrowUpRight size={14} aria-hidden="true" /></a>; }
function Local({ href, onSelect, children, ...props }) { return <Link href={href} prefetch={false} scroll={false} {...props} onNavigate={event => { event.preventDefault(); onSelect(); }}>{children}</Link>; }
function Note({ title, children }) { return <details className={styles.note}><summary>{title}</summary>{children}</details>; }
function Failure({ error, retry }) { return <div className={styles.empty} role="alert"><p>{error}</p><button type="button" onClick={retry}>Retry organization data</button></div>; }

export default function BankOrganization({ rssd, bankName, options, href, onChange }) {
  const profile = useOrganization(rssd, 'profile');
  const network = useOrganization(rssd, 'network', options.org === 'network' && !!profile.data?.bank);
  const data = profile.data, bank = data?.bank, parent = bank?.parent;
  return <section className={styles.workspace} aria-label="Bank and parent research">
    <nav className={styles.lenses} aria-label="Organization views">{[['identity', 'The organization', GitBranch], ['network', 'Bank footprint', MapPin]].map(([key, label, Icon]) => <Local key={key} href={href({ org: key })} onSelect={() => onChange({ org: key })} aria-current={options.org === key ? 'page' : undefined}><Icon size={17} aria-hidden="true" />{label}</Local>)}</nav>
    {profile.error ? <Failure error={profile.error} retry={profile.retry} /> : !data ? <div className={styles.loading} role="status">Connecting the bank and its regulatory top holder…</div> : !bank ? <div className={styles.empty}><h3>No current FDIC institution match available</h3><p>{bankName} · RSSD {rssd}. Missing coverage does not establish that this bank has no parent.</p><External href={nicProfile(rssd)}>Research this institution in NIC</External><button onClick={profile.retry}>Check again</button></div> : <>
      <div className={styles.snapshot}><span><i />CURRENT ORGANIZATION SNAPSHOT</span><span>FDIC release {date(bank.snapshotDate || data.source.updatedAt)}{parent?.referenceDate ? ` · FDIC reference quarter ${date(parent.referenceDate)}` : ''}</span></div>
      {options.org === 'identity' ? <>
        <div className={styles.relationship} aria-label="Selected bank and reported regulatory top holder">
          <article className={styles.bankEntity}><div className={styles.entityLabel}><Landmark size={18} aria-hidden="true" />SELECTED LEGAL BANK</div><h3>{bankName}</h3>{bank.name.toUpperCase() !== bankName.toUpperCase() && <p className={styles.alias}>Current FDIC name: {bank.name}</p>}<p>{place(bank)}</p><div className={styles.ids}>RSSD {rssd}<span>FDIC {bank.cert}</span></div><External href={bank.nicUrl}>Bank in NIC</External></article>
          <div className={styles.connector} aria-hidden="true"><span /><GitBranch size={25} /><span /></div>
          <article className={styles.parentEntity}><div className={styles.entityLabel}><Building2 size={18} aria-hidden="true" />REGULATORY TOP HOLDER</div><h3>{parent?.name || 'No top holder reported'}</h3><p>{parent ? place(parent) || 'Location unavailable' : 'The source does not establish a parent relationship.'}</p>{parent && <><div className={styles.ids}>RSSD {parent.rssd}<span>May be a direct or indirect owner</span></div><External href={parent.nicUrl}>Parent hierarchy &amp; history in NIC</External></>}</article>
        </div>
        <p className={styles.scopeLine}><GitBranch size={14} aria-hidden="true" />{parent ? 'NIC regulatory relationship, published by FDIC. Intermediate entities are not expanded here.' : 'No relationship inferred from a shared name, ticker, or missing identifier.'}</p>
        <div className={styles.reportHeading}><span className={styles.kicker}>FOLLOW THE ENTITY</span><h3>Two scopes. Clear research paths.</h3></div>
        <div className={styles.reportLanes}>
          <article className={styles.bankLane}><div className={styles.laneHeading}><span>01</span><div><h4>The legal bank</h4><p>{bankName}</p></div></div><div className={styles.reportType}><strong>FFIEC Call Report</strong><span>{bank.form ? `Form ${bank.form}` : 'Form 031 / 041 / 051'} · Bank reporting scope</span></div><div className={styles.actions}><Local href={href({ view: 'overview' })} onSelect={() => onChange({ view: 'overview' })}>Bank financials <ArrowUpRight size={15} aria-hidden="true" /></Local><Local href={href({ view: 'exposures' })} onSelect={() => onChange({ view: 'exposures' })}>Loan, funding &amp; securities detail <ArrowUpRight size={15} aria-hidden="true" /></Local></div><Note title="What this statement covers"><p>Financial statements filed by the named legal bank under its Call Report consolidation rules. These figures do not represent the full holding-company group. BankScope retains the selected Call Report period when you open bank financials.</p></Note></article>
          <article className={styles.parentLane}><div className={styles.laneHeading}><span>02</span><div><h4>The holding company</h4><p>{parent?.name || 'Parent not identified in this source'}</p></div></div><div className={styles.reportType}><strong>FR Y-9C</strong><span>Consolidated holding-company report · Where filed</span></div><div className={styles.actions}>{parent && <External href={parent.nicUrl}>Parent profile &amp; available reports</External>}<External href={NIC_REPORTS}>Federal Reserve financial downloads</External></div><Note title="Y-9C, Y-9LP and Y-9SP are different scopes"><p>FR Y-9C consolidates the reporting holding company and its consolidated subsidiaries. FR Y-9LP and FR Y-9SP are parent-only, unconsolidated reports; Y-9SP is semiannual. Not every parent files every form.</p><p>Reports open at the official source. BankScope does not substitute bank balances or SEC figures for FR Y-9C values. Select the institution, form, and reporting date at NIC.</p></Note></article>
        </div>
        {parent && <ParentSec key={parent.rssd} rssd={rssd} parent={parent} />}
        <InstitutionRecord bank={bank} />
      </> : <Network bank={bank} bankName={bankName} result={network} />}
      <Note title="Sources, dates & relationship coverage"><p>Regulatory top-holder names and RSSD identifiers originate in the Federal Reserve National Information Center and are redistributed through the FDIC institution directory. This identifies the reported high holder, not necessarily the immediate parent or ultimate global owner. The full NIC hierarchy may include intermediate entities and additional ownership paths.</p><p>The relationship is the latest FDIC-published snapshot, with the FDIC reference quarter shown above. That quarter is the source’s financial reporting period, not an ownership effective date. Changing the Call Report quarter elsewhere in BankScope does not reconstruct historical ownership. Missing holding-company coverage, including some thrift structures, is not evidence of independence.</p><p>FDIC release: {date(bank.snapshotDate || data.source.updatedAt)} · Institution record updated: {date(bank.recordUpdated)} · Retrieved: {date(data.source.retrievedAt)}.</p><div className={styles.sourceLinks}><External href={data.source.url}>FDIC source JSON</External><External href={FDIC_DEFINITIONS}>Field definitions</External><External href={NIC_ABOUT}>About NIC</External></div><code className={styles.hash}>Source SHA-256: {data.source.sha256}</code></Note>
    </>}
  </section>;
}

function ParentSec({ rssd, parent }) {
  const discovery = useOrganization(rssd, 'sec');
  const sec = discovery.data?.parentRssd === parent.rssd ? discovery.data.sec : null;
  const [expanded, setExpanded] = useState(false), [query, setQuery] = useState(parent.name.replace(/\bBCORP\b/g, 'BANCORP').replace(/\bBSHRS\b/g, 'BANCSHARES').replace(/\bFINL\b/g, 'FINANCIAL').replace(/\bHLDGS\b/g, 'HOLDINGS').replaceAll('&', ' & '));
  const search = useSecFilerSearch(query, expanded);
  const candidates = sec?.candidates || [];
  return <section className={styles.secResearch} aria-label="Holding company SEC research"><div><span className={styles.kicker}>CONTINUE IN EDGAR</span><h3>Parent company research</h3><p>{parent.name} · Regulatory RSSD {parent.rssd}</p></div>
    <div className={styles.secContent}>{candidates.length ? <><span className={styles.matchLabel}>SEC DIRECTORY NAME MATCH{candidates.length > 1 ? 'ES' : ''} · CONFIRM REGISTRANT IDENTITY</span>{candidates.map(candidate => <SecCandidate key={candidate.cik} candidate={candidate} />)}<p className={styles.caption}>SEC statements belong to the named SEC registrant and its reporting scope. Check the identity before comparing with the bank.</p></> : !discovery.data && !discovery.error ? <p className={styles.caption} role="status">Checking the SEC company directory…</p> : <p className={styles.caption}>{sec?.status === 'ready' ? 'No exact name candidate in the SEC ticker directory. The parent may still file with the SEC without a listed ticker.' : 'A current SEC directory match could not be established. You can search the SEC filer index below.'}</p>}
      <details className={styles.note} onToggle={event => setExpanded(event.currentTarget.open)}><summary>{candidates.length ? 'Find another SEC registrant or share class' : 'Search parent SEC filings'}</summary><label className={styles.searchLabel}>SEC legal name or CIK<input value={query} maxLength={160} onChange={event => setQuery(event.target.value)} autoComplete="off" /></label><p className={styles.caption}>Name-search results are possible matches, not verified parent links.</p>{search.status === 'loading' && <p role="status">Searching SEC registrants…</p>}{search.error && <p role="alert">{search.error} <button onClick={search.retry}>Retry SEC search</button></p>}{search.warning && <p role="status">{search.warning}</p>}{search.results.length > 0 && <ul className={styles.searchResults}>{search.results.map(filer => <li key={filer.cik}><Link href={`/filings/${filer.cik}`} prefetch={false}><span>{filer.name}<small>CIK {filer.cik} · Open this registrant’s filings</small></span><ArrowUpRight size={16} aria-hidden="true" /></Link></li>)}</ul>}{search.status === 'ready' && !search.results.length && <p>No matching registrants in these results. Try a shorter name or exact CIK.</p>}{search.truncated && <p>Results are limited. Refine the name or enter a CIK.</p>}</details>
    </div>
  </section>;
}

function SecCandidate({ candidate }) {
  const ordinary = candidate.tickers.filter(ticker => /^[A-Z]{1,6}$/.test(ticker));
  const [ticker, setTicker] = useState(candidate.tickers.length === 1 ? candidate.tickers[0] : ordinary.length === 1 ? ordinary[0] : '');
  return <div className={styles.secMatch}><strong>{candidate.name}</strong><span>CIK {candidate.cik}</span>{candidate.tickers.length > 1 && <label className={styles.symbolLabel}>SEC-listed symbol<select value={ticker} onChange={event => setTicker(event.target.value)}><option value="">Select a symbol</option>{candidate.tickers.map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}</select></label>}<div className={styles.actions}><Link href={`/filings/${candidate.cik}`} prefetch={false}>SEC filings <ArrowUpRight size={15} aria-hidden="true" /></Link>{ticker && <Link href={`/analysis/${encodeURIComponent(ticker)}`} prefetch={false}>{ticker} company analysis <ArrowUpRight size={15} aria-hidden="true" /></Link>}<External href={`https://www.sec.gov/edgar/browse/?CIK=${candidate.cik}&owner=exclude`}>Verify SEC registrant</External></div></div>;
}

function InstitutionRecord({ bank }) {
  return <section className={styles.record}><div><span className={styles.kicker}>INSTITUTION RECORD</span><h3>The bank through time</h3><External href={bank.nicUrl}>Open full NIC history</External></div><ol className={styles.timeline}><li><i /><span>Established</span><strong>{date(bank.established)}</strong></li><li><i /><span>FDIC insured since</span><strong>{date(bank.insuredSince)}</strong></li><li><i /><span>FDIC status in this release</span><strong>{bank.active ? 'Active' : 'Inactive'}</strong></li></ol>{bank.formerNames.length > 0 && <Note title="Names in the FDIC institution record"><ul>{bank.formerNames.map(name => <li key={name}>{name}</li>)}</ul><p>Source-listed names, without effective dates. They are not presented as a dated merger or ownership history.</p></Note>}</section>;
}

function Network({ bank, bankName, result }) {
  const data = result.data;
  if (result.error) return <Failure error={result.error} retry={result.retry} />;
  if (!data) return <div className={styles.loading} role="status">Reading the bank’s offices and related institutions…</div>;
  const offices = data.offices, rows = offices?.regions || [], top = rows.slice(0, 8), rest = rows.slice(8).reduce((total, row) => total + row.offices, 0);
  const bars = rest ? [...top, { region: 'Other locations', offices: rest }] : top;
  const max = Math.max(1, ...bars.map(row => row.offices));
  const consistentParent = data.parentRssd === (bank.parent?.rssd || null);
  return <>
    {data.missing.length > 0 && <p className={styles.caption} role="status">Some network data is unavailable. <button onClick={result.retry}>Retry network data</button></p>}
    <div className={styles.networkGrid}><section><span className={styles.kicker}>SELECTED LEGAL BANK · FDIC {bank.cert}</span><h3>Where the bank operates</h3><p className={styles.caption}>{bankName}</p>{offices ? <><div className={styles.officeTotal}><strong>{number(offices.total)}</strong><span>listed offices<small>FDIC location release {date(offices.source.updatedAt)}</small></span></div><div className={styles.regionBars} aria-label="Office counts by source state or location code">{bars.map(row => <div key={row.region}><span>{row.region}</span><span className={styles.track}><i style={{ width: `${row.offices / max * 100}%` }} /></span><strong>{number(row.offices)}</strong></div>)}</div>{!offices.total && <p className={styles.caption}>No offices returned in the FDIC locations source.</p>}<Note title="All location counts & coverage"><p>Office counts include the main office and reported service locations. State/location codes follow FDIC. Counts do not measure deposit market share and do not cover all subsidiaries of the parent.</p><div className={styles.tableWrap}><table><caption>Selected legal bank · FDIC {bank.cert}</caption><thead><tr><th scope="col">Location code</th><th scope="col">Offices</th><th scope="col">Share of listed offices</th></tr></thead><tbody>{rows.map(row => <tr key={row.region}><th scope="row">{row.region}</th><td>{number(row.offices)}</td><td>{offices.total ? `${(row.offices / offices.total * 100).toFixed(1)}%` : '—'}</td></tr>)}</tbody></table></div><External href={offices.source.url}>FDIC office source</External></Note></> : <p className={styles.empty}>Office data is unavailable; no zero count is assumed.</p>}<External href={bank.fdicUrl}>Explore individual offices in BankFind</External></section>
      <section className={styles.related}><span className={styles.kicker}>REGULATORY TOP-HOLDER GROUP</span><h3>Other banks in the organization</h3><p className={styles.caption}>{bank.parent?.name || 'No top holder reported'}</p>{!consistentParent ? <p className={styles.empty}>The top-holder record changed between reads. Reload to see a consistent organization snapshot.</p> : data.peers ? <><p className={styles.groupCount}><strong>{number(data.peers.banks.length)}</strong> active FDIC institutions, including the selected bank</p><ul className={styles.relatedList}>{data.peers.banks.map(peer => <li key={peer.rssd}><span className={peer.selected ? styles.selectedDot : styles.peerDot} /><div>{peer.selected ? <strong>{peer.name}</strong> : peer.eligible ? <Link href={bankHref(peer.rssd, { view: 'organization' })} prefetch={false}>{peer.name}<ArrowUpRight size={13} aria-hidden="true" /></Link> : <External href={peer.nicUrl}>{peer.name}</External>}<small>{peer.selected ? 'Selected bank · ' : ''}RSSD {peer.rssd} · {place(peer)}{peer.referenceDate ? ` · Reference quarter ${date(peer.referenceDate)}` : ''}</small></div></li>)}</ul><Note title="What belongs to this group"><p>Active FDIC institutions with the same reported regulatory top-holder RSSD. This is a group of legal banks, not the complete corporate hierarchy. Nonbank subsidiaries, intermediate holding companies, and entities outside FDIC coverage are not listed. Financial amounts are not added together.</p><External href={data.peers.source.url}>FDIC group source</External></Note></> : <p className={styles.empty}>{bank.parent ? 'Related-bank data is temporarily unavailable.' : 'A group cannot be assembled without a reported top-holder identifier.'}</p>}{bank.parent && <External href={bank.parent.nicUrl}>Full organization hierarchy in NIC</External>}</section></div>
  </>;
}
