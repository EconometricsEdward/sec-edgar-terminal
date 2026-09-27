# BankScope navigation, SEO and performance

## Navigation

The URL is the source of truth for the active view, period, metric, earnings basis,
CAMELS category and exposure lens. The workspace reads validated options from
`useSearchParams`. Changes within the already loaded bank selection use Next's
native History API integration; they preserve reloadable links and Back/Forward
without repeating the server-side Call Report read. Bank-selection changes still
use the router so the server supplies the new banks' validated reports.

Links retain real `href` values and normal modified-click/new-tab behavior.
Selected-bank loads announce their pending state. Clipboard feedback is scoped to
the copied URL and expires after three seconds. Peer components remain keyed to
bank and period, and exposure requests remain pinned to bank, period and source
hash, preventing stale data from appearing under a new selection.

## SEO

Bank pages identify the legal bank by name, location and RSSD in their metadata.
All filter combinations canonicalize to the bank's stable `/analysis/banks/RSSD`
page. Metadata and the page share a request-memoized store read. Validated public
profile responses also share a bounded per-instance cache: 30 seconds for ready
reports, three seconds for pending, missing or incomplete preparations. Report
dates and source hashes are preserved; expired figures are not an outage fallback.
Pages without a validated report for the
selected bank, or with a service error, are marked `noindex, follow`.

Breadcrumb structured data matches the visible Analysis / BankScope hierarchy.
The directory renders on the server, with search as its interactive client island.
`/analysis/banks/sitemap.xml` advertises the directory's ready-to-explore banks
(up to 25), with canonical URLs only. It is declared in `robots.txt` and cached at
the CDN for an hour. Store failures return an uncached 503 instead of an empty
successful sitemap. This is a discovery sitemap, not an exhaustive bank catalog.

## Loading

Trend, peer and selected-bank comparison panels load on demand. The collapsed
individual-metric trend drawer does not mount an invisible chart. The production
build's BankWorkspace entry chunks fell from 277,920 to 189,060 bytes (88,099 to
62,563 gzip bytes, 29% less compressed) compared with commit `0996c52`. These are
build artifact sizes, not a whole-site speed score or field Core Web Vitals.

Profile reads coalesce concurrent identical selections, with a five-second
failure cooldown. The cache retains at most 32 responses of at most 512 KiB each.
Ordered bank selections and deployment environments remain isolated. Preparation
and publication invalidate local reads before and after writes; older in-flight
responses cannot repopulate the cache. Other instances see changes after the short
TTL. These are workload reductions, not a shared durable cache or an outage fix.

Preparation polling backs off to once per minute, stops after three consecutive
failures or 15 minutes, and offers a manual resume. Hidden pages make no new
status checks. Each read has a 30-second deadline, and reported retry timing is
honored. Changing an already loaded tab still requires no new profile read.

Peer, peer-history and exposure requests reuse successful public responses in
browser memory for 30 seconds, keyed by bank and period plus the peer snapshot or
exposure source hash. Completed reuse is limited to 16 entries, 2 MiB total and
512 KiB per result; no more than eight transports run concurrently, each with a
30-second deadline. Navigation cancels the subscriber while allowing an existing
read to finish for reuse. Pending preparation, missing exposure history, invalid
identity and failed responses are not reused, and manual retries refresh the data.
History remains loaded for the visible trend visuals, but is skipped when no
matching bank exists in the quarterly peer universe.

Official UBPR preparation checks run only while its reference drawer is open and
the document is visible. They run at 30-second intervals for at most eight checks,
then offer a manual check. The first failed check pauses further automatic
requests. Closing the drawer or leaving the comparison view stops its checks.

## Verification

The BankScope regression suite covers URL state, metric basis, source validation,
peer statistics, exposure calculations, metadata eligibility and sitemap identity
filtering. Deployment verification should exercise search, adding/removing peers,
CAMELS and peer controls, report dates, exposure lenses, trend drawers, clipboard,
reloads and Back/Forward. Check page metadata and sitemap HTTP responses as well
as the visible UI; no database or gateway-access changes are required.
