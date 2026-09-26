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
page. Metadata and the page share a request-memoized store read; financial data is
not cached across server requests. Pages without a validated report for the
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

## Verification

The BankScope regression suite covers URL state, metric basis, source validation,
peer statistics, exposure calculations, metadata eligibility and sitemap identity
filtering. Deployment verification should exercise search, adding/removing peers,
CAMELS and peer controls, report dates, exposure lenses, trend drawers, clipboard,
reloads and Back/Forward. Check page metadata and sitemap HTTP responses as well
as the visible UI; no database or gateway-access changes are required.
