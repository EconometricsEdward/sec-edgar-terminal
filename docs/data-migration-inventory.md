# Data migration inventory and measured baseline

Baseline source: `71dd98d673da0cb2c1967843cf4a07cb4bfa5016`. Audit captured 2026-09-13 03:02:51–03:03:13 UTC, before activating any new production reader. This document distinguishes existing behavior, measured samples, and proposed destinations. The rollout document records implementation and activation status.

## Main findings

- `warmSet` enforces an **application** cap of 900,000 UTF-8 JSON bytes. This is not a verified Upstash plan limit. Every sampled companyfacts document exceeds that cap, including the smaller Acme United issuer. JPMorgan's submissions document also exceeds it.
- `secResearchJson` retains raw JSON in `research-sec-v1` for 300 seconds. Large values fail the write and cannot benefit from that shared cache. Different readers separately retrieve the same SEC document through different namespaces or direct, gated `secFetch` calls.
- CFTC's measured prepared responses are much smaller: 137,842 bytes for TFF markets; 190,455 bytes for disaggregated markets. CFTC is a useful bounded publication pilot, but the sampled evidence supports prioritizing shared SEC documents and compact company data immediately afterward.
- The existing Market summary is already small: 4,013–4,301 bytes for these four companies. Preserve those validated calculations and serve prepared results. Moving raw companyfacts into a database JSON column would retain the expensive parse/compute path.
- No Redis credentials are configured in the audit process. Production Redis allocated bytes, commands, TTLs, hit ratios, actual traffic, billing, database/index size, and infrastructure egress remain **unmeasured here**. Source bytes and local gzip sizes are not billing measurements.

## Existing data paths

All keys below are prefixed `warm:`; `warmCache.js` uppercases the identifier after the namespace. Deployment-scoped namespaces include `production`, `preview-<commit>`, or `local`. Cap is 900,000 serialized bytes per Redis value unless a narrower producer bound is listed. Refresh cadence describes existing code, not a new freshness promise.

| Dataset / existing namespace | Producer and consumers | Existing retention / refresh | Bounds and expensive work | Proposed first destination |
|---|---|---|---|---|
| SEC submissions: `submissions-cik:<CIK>` | `secPrewarm.js`, `/api/sec`; browser `secApi.js` clients | Redis 25 h; daily bounded prewarm; public SEC data proxy CDN generally 6 h | Prewarm at most 25 tickers, 3 workers, 12 s/issuer. JPM sample cannot fit Redis value cap. | One canonical source document per CIK/resource in private Storage, metadata/current pointer in Postgres; retain legacy cache for rollback where it fits. |
| SEC research documents: `research-sec-v1:<path>` | `secResearchData.js`; Risk, Analysis, Compare, portfolio, disclosures and company exposure research | Redis 300 s; misses retrieve source | Submissions + full companyfacts per company; `loadResearchCompany` optional history up to 8 archive parts. All sampled companyfacts exceed cap. | Share the canonical SEC document identity. Only approved submissions/companyfacts paths migrate. |
| Filings submissions: `filings-submissions-v1:<path>` | `filingsResearchServer.js`; `/api/filings-research`, filing feeds | Redis 300 s; request driven | Separate duplicate source cache; filing-history traversal bounded by caller | Incremental reader of canonical submissions; other filing archives remain legacy. |
| SEC direct Market/coverage retrieval | `marketResearchServer.js:secJson`, `quantCoverageServer.js:secJson`; old `/api/market-overview` calculation path | Direct source fetch when a scheduled company refresh needs it | Duplicates submissions/companyfacts used by research; shared `secFetch` still gates outbound starts | Move approved source reads incrementally; do not add another upstream transport. |
| CFTC markets: `edgar.cftc-positioning.v1:<scope>:markets:<family>:<date>` plus `markets-last-good` | `cftcServer.js`; `/api/v1/cftc/markets`, Market, Analysis/Risk company context | Freshness 26 h; primary 9 d; last-good 16 d; usable stale limit 15 d; daily 22:30 UTC check | Upstream JSON max 8 MiB, dataset max 10,000 rows; public response max 4 MiB. Normalize contracts/categories, verify completeness, compute rankings/percentiles. | Versioned prepared snapshot and source evidence; immutable objects plus atomic current/last-good publication. |
| CFTC raw history: same namespace, `raw-history:<family>:<contract>:<throughDate>` | CFTC launch refresh or `fetchCftcContractHistory`; prepared history reader | 16 d Redis retention | Contract history max 600 rows, pages of 200; launch history bounded at 5,000 rows, pages of 1,000. Raw envelope retains source URL, report basis, retrieval time, scope and completeness. | Compressed private source snapshot with explicit identity and hash; database manifest. |
| CFTC prepared history: same namespace, `history:<family>:<contract>:<group>:<date>:<window>` plus `history-last-good` | `/api/v1/cftc/history`; Market, Analysis, Risk CFTC views | Primary 9 d; last-good 16 d; 1/3/5-year views | Prepare normalized history and window statistics from raw-history evidence; one-year sample measured below | Compact prepared history, retaining existing staged/final publication semantics. |
| CFTC operational state: same namespace, `refresh-checkpoint`; transport namespace `edgar.cftc-transport.v1:<scope>` | `/api/cron/cftc`, `cftcTransport.js`; `/api/v1/cftc/status` reads prepared state | Checkpoint 3 d; resume window 48 h; 15 s outbound lease; provider Retry-After cooldown | Family-by-family resumable refresh, shared lease and bounded operation deadline | Durable run/checkpoint records for migrated jobs; keep provider locks and cooldowns in Redis. |
| CFTC FCM: `edgar.cftc-fcm.v1:<scope>:latest` | `cftcFcmServer.js`, `/api/v1/cftc/fcm` | Freshness 12 h; separate stale retention | Distinct FCM financial dataset, parser and source cadence | Outside this COT pilot; preserve current path. |
| Company CFTC/disclosure context: `edgar.company-cftc-context.v1:<scope>` and `edgar.company-exposure-sources.v1:<scope>` | `companyCftcServer.js`, `companyExposureServer.js`; company-context/company-exposures routes | Request-scoped company evidence cache; source-dependent TTL | SEC filing text selection, exposure extraction, mapping to CFTC market context | Keep derived context behavior. Company context is not a company's disclosed CFTC derivatives position. |
| Compact Analysis: `analysis-research:<analysis-version>:<ticker>:<basis>:<asOf>` | `/api/analysis-research`: `loadResearchCompany` → `buildAnalysisCompany` → `packAnalysisCompany`; Analysis page | Redis gzip/base64 envelope 300 s; CDN 300 s with 1 h stale-while-revalidate | Entire facts parse and period selection on miss; annual, quarter, YTD and TTM; provenance retained in packed response | First high-value prepared financial serving reader; version source inputs, basis, cutoff, parser/calculation version. |
| Compare: `compare-research:<version/selection>` | `/api/compare-research`, `compareResearch.js`; Compare page | Compressed response cache; source research TTL 300 s | Per-company fact selection and cross-company metric packing | Reuse canonical sources first; later prepared comparison inputs. |
| Risk: `risk-workspace-v4:<ticker>`; `risk-workspace-v4-scan:<accession>` | `/api/risk`; `assessRisk`, `decorateRiskProfile`, separate annual disclosure scan | Profile 900 s; scan 1 d; CDN 900 s | Annual and TTM financial models; SIC must exist; archive lookup max 4 parts if no recent original 10-K | Shared source documents now; keep model formulas and separate disclosure scans. |
| Portfolio company: `portfolio-company-v3-evidence-continuity:<identity/basis>` | `portfolioResearchServer.js`; `/api/v1/portfolio-research`, Research Hub | Freshness 5 min; gzip/base64 company data 24 h; local cache max 150 | Five companies per research batch; period/evidence reconciliation and verified predecessor chains | Public prepared company inputs may share storage. Portfolio weights, private notes and user-specific responses must not become public/shared cache data. |
| Market company: `market-research-v3:company:<scope>:<ticker>` | `loadMarketCompany`, `buildMarketCompany`; Market atlas and serving inputs | Freshness 25 h; Redis 7 d; local memory max 64 | Annual/TTM periods, point-in-time comparatives and source evidence | Compact serving record plus versioned source references; do not recalculate on every user read. |
| Market atlas: `market-research-v3:atlas`, `atlas-last-good`, `observations` | `loadMarketAtlas` scheduled prewarm; `/api/market-research`, overview readers | Complete atlas/last-good 7 d; observations 90 d; partial primary 300 s; freshness 25 h | Universe-wide aggregation; retain complete result when coverage deteriorates. Public callers do not trigger a universe rebuild. | Keep current pipeline initially; selected prepared snapshot later. Never import unverified retired-provider legacy `market-v2` payloads. |
| Quant coverage: `quant-coverage-v2:<scope>`; `quant-company-v2:<scope>`; `quant-atlas-v2:<scope>` | `quantCoverageServer.js`; membership job, 16 daily batches, factor/screener | Membership retained 90 d, refresh no more than weekly; company checkpoint 30 d; company checks skipped if <20 h; facts on fingerprint change/reconciliation or after 7 d | Approx. 1,450–1,600 member validation; 2 workers/shard. Bounded `warmGetMany`: 25 IDs/request, up to 3 requests at once. | Leave scheduled coverage capped; source reuse for selected cohort first. No all-company backfill during pilot. |
| Factor serving: `edgar.fundamental-universe.v2:<scope>` and `:chunks` | `marketUniverseServer.js`, `snapshotCache.js`; `/api/v2/factor-universe`, screener | 25 h freshness; current/last-good 7 d; chunks retained an extra hour | Gzip/base64 chunks 400,000 characters, source max 32 MiB; manifest hash; up to 100 chunks accepted, reads four at a time | Existing compact/chunked serving stays until measured migration benefit. Do not globally redirect warmCache. |
| Filing text, disclosure scans, fund research | `filingsReader.js`, `disclosureResearchServer.js`, `fundResearchServer.js` | Text commonly 7 d; disclosure history 300 s; scan 1,800 s; fund manifests 1 h/chunks 2 h | Existing gzip/base64 text and fund chunks, parser scans and evidence extraction | Outside first source slice; future objects must be selected by audited source identity. |

The generic SEC proxy also serves allowed archive/document paths. Its submissions-specific warm-cache behavior does **not** imply all proxy documents are durably cached. `secClient.js` defaults to a 40,000,000-byte response bound and two retries; individual callers narrow those settings.

## Measured SEC cohort

Exactly four public issuers were selected by business type and differing fiscal year ends, not by user analytics. Each submissions and companyfacts response was retrieved once using the unchanged `secFetch`, zero retries, sequential logical calls, 32 MiB/document and 100 MiB total audit bounds. No CIK lookup request or EDGAR archive crawl was necessary. The local process had no Redis credentials; `secFetch` used its existing local development pacer and default contact identity. A deployed process must preserve the shared gate and valid configured contact identity.

`Raw bytes` are decoded UTF-8 response bytes. `Gzip bytes` are local gzip level 6 over those exact bytes; SEC wire responses advertised gzip, but compressed wire bytes were not measured. Reserializing each sampled SEC response produced the same byte length. A positive over-cap finding is therefore directly comparable to `warmSet`'s size check.

| Issuer | Source resource | Raw bytes | Gzip bytes | >900,000 bytes? | Concepts / observations |
|---|---|---:|---:|---|---:|
| Apple, CIK 0000320193 | submissions | 164,091 | 27,913 | No | — |
| Apple | companyfacts | 3,789,099 | 269,991 | Yes | 505 / 25,135 |
| Microsoft, CIK 0000789019 | submissions | 184,700 | 20,581 | No | — |
| Microsoft | companyfacts | 4,881,196 | 333,527 | Yes | 565 / 32,671 |
| JPMorgan Chase, CIK 0000019617 | submissions | 4,608,297 | 472,209 | Yes | — |
| JPMorgan Chase | companyfacts | 7,935,919 | 532,584 | Yes | 936 / 53,666 |
| Acme United, CIK 0000002098 | submissions | 160,935 | 25,945 | No | — |
| Acme United | companyfacts | 2,513,049 | 178,335 | Yes | 389 / 16,931 |

Observed fiscal-year-end fields: Apple `0926` (week-based September year end; its prior annual report actually ended 2025-09-27), Microsoft `0630`, JPMorgan `1231`, Acme United `1231`. Do not infer report dates by copying a submissions fiscal-year-end label.

| Issuer | Latest original financial filing in retrieved recent submissions | Filing date | Reporting end | Existing selected annual period |
|---|---|---|---|---|
| AAPL | 10-Q `0000320193-26-000020` | 2026-07-31 | 2026-06-27 | 2024-09-29 to 2025-09-27, 10-K `0000320193-25-000079` |
| MSFT | 10-K `0001193125-26-323660` | 2026-07-29 | 2026-06-30 | 2025-07-01 to 2026-06-30, same 10-K |
| JPM | 10-Q `0001628280-26-054343` | 2026-08-06 | 2026-06-30 | 2025-01-01 to 2025-12-31, 10-K `0001628280-26-008131` |
| ACU | 10-Q `0001193125-26-338211` | 2026-08-06 | 2026-06-30 | 2025-01-01 to 2025-12-31, 10-K `0001193125-26-102079` |

This confirms distinct filing and reporting dates; it is not a complete restatement audit. The cohort contains valid facts for all four companies. Missing-facts behavior, same-period differing values, changed source versions, late amendments and restatements still require separate fixtures/acceptance evidence. Preserve all source observations, source hash, accession, concept/taxonomy, unit, instant/duration dates, fiscal labels and known filing/acceptance dates. Do not label comparative facts with the enclosing filing's year.

## Measured existing calculation and serving sizes

Using the same saved public samples, existing pure `buildMarketCompany`, `marketCompanySummary`, and `packAnalysisCompany(buildAnalysisCompany(...))` ran locally without additional upstream requests. Analysis used annual basis with no cutoff. These are single-process, single-run measurements, not Vercel latency, p95, a load test, or a before/after migration benchmark.

| Issuer | Full Market JSON / gzip bytes | Compact Market JSON / gzip bytes | Annual Analysis JSON / gzip bytes | Market compute ms | Annual Analysis compute ms |
|---|---:|---:|---:|---:|---:|
| AAPL | 143,791 / 8,346 | 4,301 / 1,286 | 434,218 / 30,182 | 234 | 83 |
| MSFT | 107,600 / 6,048 | 4,035 / 913 | 436,157 / 29,555 | 194 | 88 |
| JPM | 110,400 / 6,598 | 4,013 / 1,159 | 306,351 / 20,903 | 168 | 69 |
| ACU | 138,602 / 8,332 | 4,296 / 1,332 | 511,229 / 31,714 | 169 | 68 |

The full Market result includes evidence that the compact Market summary omits. These outputs serve different existing consumers and must not be substituted without preserving the reader's contract. Base64 Redis envelopes add approximately one third to compressed data before JSON wrapper overhead. The measured compressed Analysis values already fit the application cap; its operational issue is repeated full-source retrieval and computation after expiry, rather than oversized prepared values.

## Measured public CFTC responses

Actual market query parameter is `family=tff|disaggregated`, not `report`. Four fixed HTTPS reads used existing application routes, with no direct new CFTC transport. Public routes may perform their existing bounded cache work; the history sample reported computation from already prepared raw data.

| Existing endpoint | Status / report date | Raw bytes | Gzip bytes | Reported cache source | One observed duration ms |
|---|---|---:|---:|---|---:|
| `/api/v1/cftc/markets?family=tff` | ready / 2026-09-08 | 137,842 | 15,174 | prepared | 7,325 |
| `/api/v1/cftc/markets?family=disaggregated` | ready / 2026-09-08 | 190,455 | 18,112 | prepared | 274 |
| `/api/v1/cftc/history?family=tff&contract=13874A&group=leveraged-funds&window=1y` | ready / 2026-09-08 | 55,095 | 6,925 | computed-from-prepared-raw | 301 |
| `/api/v1/cftc/status` | ready | 544 | 249 | not supplied | 1,176 |

The sample API wire responses advertised Brotli; the table's gzip values are local storage-compression comparisons. One slow first request cannot isolate origin compute, network setup, or CDN behavior. These are not p95 values. No raw CFTC source-history payload was downloaded in this audit; its production object size and Redis footprint are unmeasured. Existing COT source identities are TFF `gpe5-46if` and disaggregated `72hh-3qpy`, futures-only. The migration must not merge those identities with combined-basis reports.

## Source hashes

SHA-256 is computed from each complete decoded response, without injecting a new timestamp. These identify the sampled source/response versions, not current future source content. Public CFTC response hashes can change when response metadata changes; durable source deduplication must use the raw source observations rather than treating every generated response timestamp as a new source revision.

| Sample | SHA-256 |
|---|---|
| AAPL submissions | `cb90ffafc5b6f997b60aa109e07008223ad35abe896ec7918fd43652b4057329` |
| AAPL companyfacts | `73a86c6aedc31f77cac2ea4df5f80f0b3bd7e6eb58bb4e01444fbedf3afb9c43` |
| MSFT submissions | `6fe5c233fd41818614d0d1663ee39f7c033d5ea669fc6c39f45563f555e158ad` |
| MSFT companyfacts | `f8aae2965b20ad0df44bdf7ccbedf797d275b6b8dc030154a7a311361bb7246f` |
| JPM submissions | `b84e49bedf485f2e47eb83ee4dc0795f9425db06c8c0408e96bffe3774cbcf10` |
| JPM companyfacts | `15370a4150dad20644e9827dca3ce1465d8b8ad8bd9862fd372bf1ba7c7e7fa6` |
| ACU submissions | `1f8ea700a01e7fc4c3d0c88f11bd3db0f5bc09d30b54a1cf37c67a14309e53e8` |
| ACU companyfacts | `06951158c151bcf8f37297593ceee4916d4d357dcfc6e8b24f66d74ba2a6b0e3` |
| CFTC TFF markets response | `3d456f57b1829af093dce78f10f4d9ea14640c8df5f5deeca5deada8f240e1b6` |
| CFTC disaggregated markets response | `b7861c12a1b07753b45020313c2baad603a309ce9387bd920926853b15def5b0` |
| CFTC one-year history response | `44a78e097a59c48e00d93f4bdbf01a19abee268bfebc8b2db901a3aab5d8ee0d` |

## Existing scheduler and coordination baseline

`vercel.json` declares 21 daily triggers (all UTC). This is repository scheduling configuration; deployed schedule status and plan entitlement require platform verification.

| Job | Schedule UTC | Existing work / guard |
|---|---|---|
| `/api/cron/prewarm` | 04:00 daily | Concurrent Market atlas build and ≤25 selected submissions; `CRON_SECRET`, production-only, shared cache required; maxDuration 300 s, internal ~280–285 s bound |
| `/api/cron/factor-universe` | 09:00 daily | Prepared factor refresh; maxDuration 300 s |
| `/api/cron/provider-retirement` | 09:30 daily | Existing separately authorized provider cleanup workflow. This audit does not invoke it. |
| `/api/cron/cftc` | 22:30 daily | Both COT families, revision/failed-release checks; maxDuration 300 s. A daily check does not imply daily COT observations. |
| `/api/cron/quant-coverage?membership=1` | 23:00 daily | Weekly-age check before three bounded existing holdings downloads |
| `/api/cron/quant-coverage?batch=0..15` | Every 30 min from 00:00 to 07:30 daily | Each shard 2 workers; company freshness/fingerprint reuse and resumable checkpoints |
| GitHub `cftc-live-source-smoke.yml` | Saturday 02:17 UTC, or manual | Advisory read-only official-source smoke; separate from refresh publishing, 10 min workflow timeout |

Prewarm and quant batch 8 overlap at 04:00. They have different job leases but share the SEC provider-wide gate. Preserve that gate during migration/backfill. `secClient.js` caps starts at 7/sec, requires deployed contact identity, validates redirect hosts and paces redirects, honors Retry-After, and fails closed for deployed missing/unavailable shared coordination. Local audit uses only its already-existing development fallback. Redis cache read failure in `warmGet` is a cache miss; coordination failure is not permission to launch a new unrestricted download path.

CFTC has its own provider transport gate and cooldown. Do not silently remove or replace it with database-only job leases. One authoritative refresh scheduler per migrated job must be selected before replacing production schedules. The pilot must not leave old and new scheduled refreshes both publishing the same data.

Existing `.github/workflows/quality-gates.yml` runs tests, lint, typecheck and build on pull requests and main pushes. Build runs `assert-provider-free.mjs` and `prepare-factor-universe.mjs`; migration must keep provider-boundary checks. No migration belongs in the application build. Provider-retirement and security/transport regression tests remain gates.

## Migration order and expected benefit

1. **CFTC pilot:** bounded, already typed/versioned, source evidence and staged/last-good publication offer a useful end-to-end failure/recovery test. Benefit: retained evidence and durable last-good; largest cash savings are not established.
2. **Canonical SEC source documents for the four-company cohort:** highest measured avoidable data pressure. Five of eight source documents cannot enter existing raw Redis caches; shared identity removes namespace duplication while preserving the existing transport. Storage compression has measured potential, but real egress and source change frequency still need observation.
3. **Prepared company financial consumer:** persist the existing validated packed Analysis response with source lineage and meaningful version/cutoff identity. Existing Market summaries demonstrate small batchable downstream inputs; avoid full-facts downloads for ordinary prepared reads.
4. **Expand only after acceptance:** bounded resumable cohort expansion, then additional serving namespaces based on measured reuse and costs. Leave unrelated Redis callers untouched. No whole-market source import or new public source is part of this phase.

## Rerunning the bounded audit

```sh
node scripts/data-migration-audit.mjs --help
node scripts/data-migration-audit.mjs
node scripts/data-migration-audit.mjs --sec --cftc --redis --out=/absolute/scratch/audit.json --save-samples=/absolute/scratch/public-samples
```

No network occurs by default. `--sec` allows at most eight logical calls through `secFetch` with zero retries and no alternative fetch implementation; transport may pace approved redirects. It stops that source group after an error other than a missing issuer resource. `--cftc` allows four fixed public application reads. `--redis` uses one 22-command `STRLEN`/`PTTL` pipeline on 11 explicit selected keys, maximum 64 KiB response, and never downloads their values, enumerates keys, deletes values, or prints credentials. It distinguishes absent configuration from an unavailable metadata request. These counters describe the audit, not historical Redis billing. Existing SEC gate coordination and ordinary application caching side effects are retained.

Raw samples must be outside the repository. Reports contain public source URLs, identity, hashes, byte counts, timestamps and durations only. The reusable script also recomputes existing Market full/compact sizes and selected periods; annual Analysis single-run measurements above were obtained independently from the same saved samples. Do not rerun source downloads solely to reproduce pure calculations. Use the saved source version for shadow comparison and round-trip acceptance whenever available.

## Local load rehearsal: actual result and limits

`scripts/data-migration-load.mjs` uses the captured public source/response bytes and all 16 prepared Analysis results. It runs actual `createDataStore` hash verification/gzip decode, `readPreparedSecDocument`, `readPreparedAnalysis`, and CFTC persistence reads behind a **local harness HTTP server**, with an injected read-only Data API/Storage fixture. The load driver and server share one process. It does not execute production Next.js routes, rate limits, UI, Redis networking, PostgreSQL/RLS, Vercel or a CDN.

The configured mix is two CFTC markets reads, one CFTC history read, four Analysis basis reads, one SEC submissions read and two five-company fan-out reads per simulated client. Fan-out deliberately returns five full Analysis snapshots including repeated AAPL: it stresses prepared-helper reuse and serialization, and is **not the actual compact portfolio API response**. No request-level deduplication was invented for the test. Data API and object fetches each have an assumed 20 ms delay; in-memory hot cache has no simulated network delay. HTTP response bodies are uncompressed. Source/report dates remain intact, but fixture expiry and CFTC replay time are controlled test clocks.

The 2026-09-13 03:14:11–03:15:02 UTC run completed 1,800 normal requests plus three fault probes, with no attempted public upstream fetch and no normal-request error. It **did not meet the proposed 50-client latency targets**.

| Concurrent clients | Warm mix p95 ms | Prepared-miss mix p95 ms | Normal errors |
|---:|---:|---:|---:|
| 5 | 335 | 296 | 0 |
| 10 | 1,067 | 415 | 0 |
| 25 | 1,672 | 1,139 | 0 |
| 50 | 2,794 | 2,515 | 0 |

Warm means existing gzip Analysis hot values are present; CFTC and raw submissions still traverse their durable fixture paths. Prepared miss means those Analysis hot values are absent while prepared durable snapshots exist; it does not mean missing source data. The 750 ms warm and 2,000 ms prepared-miss goals therefore remain open at 50 concurrent clients. Per-route p95 at 50 included 4,262 ms for warm Analysis and 5,891 ms for prepared-miss full-Analysis fan-out. Do not interpret a lower cold aggregate in this one run as evidence that cold reads are faster in production.

Each 500-request, 50-client stage serialized 814,632,072 uncompressed response bytes on loopback. Warm stage: 700 Analysis hot hits, 200 Data API fixture reads, 150 object fixture reads, 11,113,094 fixture response bytes, approximately 540 MiB process RSS at stage end. Forced prepared misses: 900 Data API reads, 850 object reads, 56,034,019 fixture response bytes, approximately 572 MiB RSS. These are local counters, not provider billing, external egress or isolated server capacity. The generated object/read ratio is useful for follow-up: warm public/CDN prepared responses matter, and a five-item raw fan-out must not be treated as one database read.

Injected Redis failure returned a valid Analysis response via durable prepared data (200). Injected durable-store outage and a missing prepared record each returned controlled unavailable (503), without an SEC download attempt. The test makes no production failover or full-site availability claim.

```sh
node scripts/data-migration-load.mjs --help
node scripts/data-migration-load.mjs --samples=/absolute/scratch/public-samples --out=/absolute/scratch/load.json --max-concurrency=50 --latency-ms=20
```

An optional `--prepared=/absolute/scratch/financial-prepared-snapshots.json` reuses the 16 saved prepared results; otherwise existing preparation functions build them once from saved samples before timing. The script permits only fixture Data API version reads and known object reads, blocks global external fetch, starts at 5 clients and increases through 10/25/50, and stops escalation for overall p95 above 5 seconds, >10% errors or process RSS above 1,200 MiB. This is a reproducible local performance finding, not acceptance of the production growth target.
