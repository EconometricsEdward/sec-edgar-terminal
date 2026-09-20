# Browser AI pilot verification

The pilot adds an optional local Qwen3-1.7B explanation to the existing Chat panel. Hosted AI remains a separate choice. A deterministic **Data answers** mode supplies facts or a selection/availability explanation without running an AI model. Browser AI must use that same bounded research snapshot and must not silently invoke Hosted AI when loading or generation fails.

This document distinguishes verification requirements from measured results. An unchecked or unmeasured entry is not evidence that the local model can answer accurately or quickly on a user's device. Browser inference removes provider inference charges for that mode; data retrieval, rate-limit operations, hosting and model delivery still use resources.

## Cost, privacy and storage boundaries

- Opening Chat or choosing Browser AI must not download model weights. **Download & enable** is the explicit action that starts the large external download.
- Questions, bounded recent conversation, current public page selection and any explicitly attached snapshot go to EDGAR Terminal for data retrieval. Local explanation generation stays in the browser. “Local” does not mean that the site receives no question or that SEC lookups work offline.
- Only model assets may be cached by the browser pilot. There must be no new transcript, prompt, answer, vector or embedding store in the browser or on the server. Clearing model files must not remove unrelated portfolio or site preferences.
- Unsupported devices, failed downloads, unavailable evidence and cancelled generation must not trigger a hosted inference request or consume a hosted model reservation.
- Research uses a separate short-lived rate limit: at most six requests per client per minute, 120 globally per minute, one active request per client and four globally. Limits may be lowered by private configuration. There is no browser-research daily/monthly model allowance. These are shared service limits, not a promise of unlimited requests.
- Same-origin checks, request shape and byte limits, source allowlists, entity identity validation and exact selected periods remain mandatory. An AI-generated URL or tool name must never grant arbitrary backend access.
- Release graphics memory after the panel's configured idle interval; release immediately when switching away from Browser AI. Stop and panel close must interrupt current generation. Download cancellation must leave a recoverable UI and bounded residual cache state.

## Candidate question matrix

Freeze the actual report selections and evidence for each comparison. Record the revision, browser version, device/GPU, WebGPU support, report dates and cold/warm cache state. Use the same question and selection for all three modes. The hosted mode may conduct additional research; record that difference rather than treating it as a speed-only comparison.

| Case | Page / selection | Question | Critical correctness checks |
| --- | --- | --- | --- |
| Company quarter | `/analysis/BOBS?basis=quarter`; capture exact selected quarter end | Summarize BOBS's latest quarterly financial results and explain its cash generation. | Preserve standalone-quarter start/end and balance-sheet date; distinguish net income, operating cash flow and free cash flow; missing comparison is not zero growth. |
| Company annual | `/analysis/AAPL?basis=annual`; capture exact selected annual end | Summarize Apple's annual revenue, earnings, cash generation and balance sheet. | Do not mix annual/TTM/quarter figures; preserve USD units; interpretation must be supported by the selected metrics. |
| 13F manager | `/fund?view=13f&managerCik=0001350694`; capture selected quarter | Summarize Bridgewater Associates' reported holdings and concentration. | Verify manager CIK and quarter; disclosed holdings value is not total manager AUM or performance; show partial coverage honestly. |
| N-PORT fund | `/fund/VTI`; capture selected accession and as-of date | Summarize VTI's reported portfolio and largest holdings. | Verify SEC series `S000002848`, CIK `0000036405` and selected accession; distinguish net assets, holdings fair value and weights; do not infer look-through or current exposures. |
| Market briefing | `/market`; capture basis and prepared snapshot time | Explain the market briefing and how broadly companies are growing and profitable. | Preserve each breadth denominator and financial basis; sector medians are not stock returns; individual company fiscal ends differ. |
| Sector performance | Market Sector Performance with an explicit sector and metric | Which companies in this selected sector have the strongest reported revenue growth, and what are the limitations? | Respect selected sector, metric, direction and coverage; do not call reported growth stock-price performance or rank a displayed subset as the entire market. |
| CFTC positioning | Market CFTC Positioning with an explicit prepared contract/group/date | Explain the selected CFTC positioning and its recent change. | Preserve report date, trader group and contracts/percentage units; aggregate positioning is not a particular company's futures position; avoid a mechanical price forecast. |

The N-PORT identity above was resolved from the live site's `/api/reports/search?q=VTI&kind=nport` on 2026-09-20. The API returned HTTP 200 with exactly one matching result, ticker `VTI`, CIK `0000036405`, series `S000002848`. This verifies a candidate identity only; it does not verify that a particular portfolio loaded or that either model answered correctly.

## Measured comparisons

Record model download/startup separately from research retrieval and answer generation. First-token time and total answer time should include source retrieval for the end-to-end user measurement. The time displayed beside an answer excludes any model download completed before submission. One run is a smoke test, not a representative benchmark.

| Case | Server snapshot preparation only | Browser model load | Browser answer total | Hosted answer total | Factual / usability result |
| --- | --- | --- | --- | --- | --- |
| BOBS quarter | 10.677 s | Not measured | Not measured | Blocked: shared allowance | Snapshot ready; initial review found balance-sheet amounts incorrectly labeled with a flow span, requiring a formatter correction. Hosted request returned HTTP 429 `CHAT_BUDGET_EXHAUSTED`. |
| AAPL annual | Not measured | Not measured | Not measured | Not measured | Pending |
| Bridgewater 13F | 9.324 s | Not measured | Not measured | Not measured | Snapshot ready; preserved manager, period, 997 positions, reported-value scope and source links. Local-model quality pending. |
| VTI N-PORT | 14.126 s | Not measured | Not measured | Not measured | Snapshot ready; matched series, portfolio date and source links. Local-model quality pending. |
| Market briefing | 1.983 s | Not measured | Not measured | Not measured | Snapshot ready; existing source includes a future period end, requiring an explicit data-quality flag. Local-model quality pending. |
| Sector performance | Not measured | Not measured | Not measured | Not measured | Pending |
| CFTC positioning | Not measured | Not measured | Not measured | Not measured | Pending |

If the environment has no usable WebGPU adapter, record **blocked: no compatible adapter** for local model execution; do not substitute a mock response and call it local-model validation. If Hosted AI's shared allowance is exhausted, record **blocked: shared allowance**. Do not raise or bypass spending controls merely to populate the comparison.

The BOBS hosted baseline attempt on 2026-09-20 returned the allowance error in 6,509 ms with a 68,476-second retry interval. That is an error-response measurement, **not hosted answer latency**. No limit reset, increased budget or additional baseline attempts are required to repeat the same known failure.

The four measured snapshots above were prepared once through real public site readers on 2026-09-20. These are server-side retrieval/formatting measurements, not browser end-to-end timings or model inference benchmarks. Cache warmth and consumer-device hardware were not controlled. The captured reports were BOBS quarter ending 2026-06-28, Bridgewater portfolio ending 2026-06-30 (`0001350694-26-000003`), and VTI portfolio ending 2026-06-30 (`0000036405-26-000480`). The Market TTM snapshot was prepared at `2026-09-20T04:02:30.362Z` and reported a period range through 2026-12-31, later than the snapshot date. This pilot must flag that upstream inconsistency; it does not establish that future results are valid or silently repair the underlying market dataset.

Independent code review identified and corrected routing that could substitute the current company when a question named another company, a selected-company starter parsed as a literal entity, and ambiguous pronoun follow-ups. The financial formatter now treats instant metrics as period-end observations and flags future Market fiscal ends. Runtime corrections cover timeout state recovery, duplicate load attempts, reopening during the close grace period, incomplete token-limited output, and cache-clear failure. The setup exposes model-file removal even after a partial download. These fixes improve the implementation's boundaries; they do not substitute for real model-answer evaluation.

The bounded pilot is intentionally less flexible than Hosted AI: it summarizes one fund report per request, asks users to select exact historical periods on the relevant page, and reports unsupported company YTD or fund comparison/change requests. It must not conceal these limits by presenting a different selection as the requested answer.

### Preview browser results — 2026-09-20

Preview code revision `5404afa30ac28953166adb257367d94588b4c3cb` built successfully on Vercel. The cloud browser has no compatible graphics adapter. Browser AI displayed that limitation and supplied a clearly labeled data snapshot without a model download. Actual Qwen download, graphics-memory use, cache removal after a real download, local answer quality and inference speed remain **blocked: no compatible adapter**. The hosted comparison remains **blocked: shared allowance**. Neither blocked path is recorded as a successful model benchmark.

Four questions were submitted through the actual Chat interface from the About page, exercising retrieval beyond the current page. These single-run end-to-end times are the values displayed by the UI; they include retrieval and formatting but no model inference. Cache warmth was not controlled.

| Question | Mode / outcome | Displayed elapsed time | Checked result |
| --- | --- | --- | --- |
| Summarize BOBS's quarterly results | Browser AI unavailable → Data snapshot | 3.2 s | Correct quarter, whole-dollar amounts, instant balance-sheet dates and three sources. |
| Summarize Bridgewater Associates' reported holdings | Data answers | 3.1 s | Correct 13F manager, portfolio date, 997 positions and three sources. |
| Explain the market briefing | Data answers | 1.9 s | TTM breadth and sector facts; explicit warning for the upstream future fiscal end. |
| Summarize N-PORT fund VTI | Data answers | 4.1 s | Correct fund series, 2026-06-30 portfolio, 3,546 positions and two sources; fund-series holdings distinguished from ticker-specific assets. |

The desktop drawer rendered without horizontal overflow. Close and Escape preserved the URL and restored focus to Chat after the closing transition. Reopening retained the conversation; New chat cleared it. Stop during retrieval left a stopped message and restored the composer. Mobile hardware and real local generation lifecycle checks remain unmeasured.

The production build, TypeScript check, scoped lint and all **255 focused chat/runtime tests** passed. The complete PR CI suite reported 3,664 passed, nine failed and six skipped. The nine failures match existing unrelated baseline failures in chart-cache stale handling/TTL, CFTC and Market source-shape assertions, and the disposable cache-key family assertion. No test gate or spending limit was disabled. A green focused suite and successful deployment build do not mean the complete repository suite passed.

## Acceptance review

1. **Financial integrity:** Every stated numerical fact must match evidence in value, sign, scale, unit and period. Missing values remain missing. Historical selections cannot fall back silently to newer data. Sources must open the supplied original filing or exact research selection. Unavailable evidence leads to a limitation, not a speculative answer.
2. **Scope integrity:** Check an ambiguous name, an unsupported request, a follow-up after navigating to a different company, a stale assistant statement in history, and an instruction embedded in retrieved text. The local model must not invent fetched research or claim to have inspected pages that were not retrieved. Do not expose raw chain-of-thought as an answer.
3. **Lifecycle:** Open/close never changes the page. Verify Escape, focus restoration, repeated reopen during a close transition, Stop during retrieval, Stop during local generation, close during model download, New chat, engine switching, idle GPU release and cache removal. A late response must not repopulate cleared or stopped content.
4. **Compatibility and fallback:** Test without WebGPU and with a simulated model-download failure. Show a useful data answer, exact limitation or selection request with an honest label. Keep Hosted AI selectable; there must be no automatic paid fallback. Mark partial AI text incomplete if the user stops it.
5. **Storage and network:** Compare site storage before/after model download and cache removal. Check that the only persistent additions are model-related assets. Inspect network traffic: Data answers and Browser AI send no requests to the hosted `/api/chat` path or an AI inference provider. External model file downloads disclose the visitor's connection to those hosts; question text must not be embedded in those asset requests.
6. **Abuse and cost controls:** Reject a foreign/missing origin and oversized or malformed requests before research. Verify Redis failures fail closed, client/global limits stay independent of paid-chat keys, and cancellation/completion releases the active lease or lets its short TTL expire. Retrieval deadlines and size caps remain in force.

The pilot should remain optional until real supported-device checks establish acceptable accuracy and speed for company, fund and market questions. Safe deterministic fallback and clear limitations can be verified independently from model quality.
