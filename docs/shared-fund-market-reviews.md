# Shared full 13F market reviews

The Funds Market connections tab offers **Review all holdings** for any supported manager and explicit reporting quarter. The initial twenty-holding preview remains available before a shared review starts. Starting a review saves the full verified report on the server; another visitor joins the same manager-quarter job. Neither a browser tab nor an individual user's session owns its progress.

## Publication and freshness

Every disclosed position receives a status: queued, supported market connection, partial filing review, disclosure without a supported benchmark, no qualifying passage, no eligible filing, unverified issuer, or unavailable evidence. Finishing the report means every position has a terminal review status, not that every issuer or market connection could be established. Unavailable and partial attempts retry up to three times per cycle. The final state distinguishes completion with coverage gaps.

The database stores evidence separately from compact holding summaries. Read requests return aggregates and at most fifty status rows; selecting one holding retrieves its original saved evidence. Percentages retain the full reconciled 13F denominator. They describe associated disclosed holdings, not economic exposure or the manager's futures positions. Incomplete public reports have no portfolio percentages.

A report hash binds the ordered holdings, quantities, values, completeness, denominator and actual filing chain. Source check timestamps do not alter that hash. The worker checks the selected report through the existing source freshness policy before each batch; an amendment replaces the job revision and fences older workers. Completed jobs become eligible for a fresh review after twenty-four hours. Prior evidence remains readable with its original dates and stale labels while a new cycle runs or a source fails. When capacity is needed, completed reviews that were not explicitly requested for thirty days become eligible for cleanup.

Verified issuer source documents can remain in the existing bounded research cache for twenty-five hours. Freshness remains six hours for ready discoveries, one hour for no matches and fifteen minutes for missing filings. A due discovery checks current SEC submissions and bounded archive manifests before reusing an unchanged annual or quarterly document. Retrieval dates are preserved; only successful current manifest checks advance check dates. Changed filings are downloaded, and incomplete searches remain explicit.

## Work and cost bounds

The existing signed five-minute SEC coverage schedule runs a bounded review task alongside its normal work. This adds no scheduler or paid service. POST also schedules one bounded kickoff after its response. Both paths compete for the same database lease, so only one shared review worker runs at a time. Each invocation handles at most twelve positions with two source workers, a seventy-five-second work deadline and a ninety-second fenced lease. Each successful save is acknowledged separately; interrupted work resumes from the database.

Production limits admit twenty manager-quarter jobs, up to twenty thousand distinct holdings per job and eight MiB per frozen report. Result payloads are bounded to one MiB each, summaries to sixty-four KiB, and total saved result JSON to 512 MiB. A global daily allowance bounds processing to 14,400 reserved worker seconds and 6,000 saved attempts; an acknowledged early release returns unused seconds, while interrupted invocations retain their reservation. The existing SEC dispatch gate and Vercel spend cap remain in effect. These are workload limits, not a dollar-cost guarantee. A cold review of thousands of holdings can span multiple processing days, depending on source latency, retries, queue demand and the allowance. Available results appear progressively throughout.

## API and operations

- `POST /api/fund-13f/market-review` accepts only JSON `{ "cik": "0002012383", "period": "2026-06-30" }`. The server retrieves and validates the full report. Clients cannot submit holdings, source URLs, budgets or results.
- `GET` on that path accepts `cik`, `period`, optional `reportHash`, `market`, `status`, `query`, `offset` and `limit` (maximum fifty). GET never starts research. Public responses have a short shared CDN lifetime.
- `GET` with `cik`, `period`, `reportHash` and `key` returns one saved holding's evidence. Its exact report revision prevents mixing amendments.
- Private `edgar_private.fund_review_*` tables have RLS enabled. Only the production workload gateway can invoke the bounded service-role RPCs. Preview and browser credentials cannot mutate jobs. `EDGAR_FUND_REVIEW_MODE=off` disables the adapter; the existing CFTC switch also disables review APIs and workers.

Deploy the migration before the gateway and application. The `thirteenFReview` field in the SEC coverage response records bounded worker progress or deferral. Inspect job state, last saved timestamps, current-cycle terminal counts and the daily allowance when diagnosing slow progress. Do not restart jobs or remove SEC coordination to accelerate a backfill.

The kickoff uses Next.js [`after`](https://nextjs.org/docs/app/api-reference/functions/after), bounded by the route's duration. Durable continuation comes from the existing authenticated scheduler and SQL checkpoints, not an unbounded background promise.
