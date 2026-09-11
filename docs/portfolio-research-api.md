# Portfolio Research format and API, version 1

The [Portfolio Research workspace](https://secedgarterminal.com/workspace) accepts company lists without holdings or allocation information. An AI application can prepare the same input or call the bounded public endpoint when it has an appropriate HTTP tool connection. No paid model, chatbot, asynchronous job service or automatic LLM discovery is implied.

## Files and input fields

Download the [blank CSV](https://secedgarterminal.com/portfolio/portfolio-template.csv), [blank XLSX with Instructions](https://secedgarterminal.com/portfolio/portfolio-template.xlsx), [fictional sample allocation CSV](https://secedgarterminal.com/portfolio/portfolio-example.csv), [JSON example](https://secedgarterminal.com/portfolio/portfolio-example.json), or [versioned input JSON schema](https://secedgarterminal.com/portfolio/portfolio-schema.json). The sample allocations are format examples, not recommended investments or actual holdings.

For a complete worked example, download the [hypothetical weighted CSV](https://secedgarterminal.com/portfolio/portfolio-demo-100.csv) or [hypothetical weighted XLSX](https://secedgarterminal.com/portfolio/portfolio-demo-100.xlsx), and [preview the captured research results](https://secedgarterminal.com/workspace/demo). The files contain 100 companies with fixed hypothetical weights totaling 100%. The demo can compare those inputs with equal weights or company counts; the selected basis carries into saved copies and reports. CSV/XLSX users select supplied weight percentages in Allocation settings after import; the [weighted JSON](https://secedgarterminal.com/portfolio/portfolio-demo-100.json) preserves that configuration. Weights are educational inputs, independent of the SEC evidence and not actual holdings. The results are a dated capture of actual public SEC evidence, preserving company reporting periods, retrieval times, source links, and incomplete coverage. They demonstrate the research workflow and are not an investment recommendation. A later refresh can change figures, filings, and coverage. Users can open a separate saved copy from the preview to explore the full workspace and refresh on request.

| Field          | Meaning                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `ticker`       | Security ticker. Tickers alone are sufficient for research.                                                  |
| `company_name` | Issuer name. Name-only entries require an exact, reviewable resolution; ambiguous matches remain unresolved. |
| `cik`          | Exact SEC issuer identifier; a quoted string preserves leading zeroes.                                       |
| `exchange`     | Optional identification context. It does not override a conflicting ticker or CIK.                           |
| `weight_pct`   | Optional weight in percentage points: `12.5` means 12.5%.                                                    |
| `market_value` | Optional total position value, not the price of one share.                                                   |
| `shares`       | Optional quantity. Shares alone do not establish position values or weights.                                 |
| `currency`     | Currency of the supplied total position value, for example `USD`.                                            |
| `as_of_date`   | Date represented by the supplied holding or allocation, `YYYY-MM-DD`.                                        |
| `notes`        | Optional private text. Browser imports keep it local; research exports exclude it by default.                |

The browser accepts CSV, XLSX and JSON, or a pasted list of tickers. Files and AI-generated inputs pass through the same row validation. Limits are displayed beside the importer. The maximum supported input is 100 rows; allocation fields are optional and the initial model is long-only. The template does not contain active formulas, macros or external workbook connections.

```json
{
  "schema_version": "edgar.portfolio.v1",
  "name": "Example company research universe",
  "holdings": [{ "ticker": "AAPL" }, { "ticker": "MSFT" }],
  "allocation": { "basis": "none", "normalize": false },
  "research": { "basis": "annual" }
}
```

## Bounded public endpoint

`POST https://secedgarterminal.com/api/v1/portfolio-research`

Send `Content-Type: application/json`. There is no account requirement or API key for this version. The endpoint uses the application's IP-based rate limiter: at most 60 requests per minute. Shared rate limiting is used when configured, with the existing instance-local fallback; it is not a reserved throughput guarantee. A rate-limited response includes `Retry-After`.

Add `"action":"resolve"` to resolve and validate at most 100 rows without retrieving full company financial facts. `"action":"research"` (the default) accepts at most **5 distinct resolved issuers** per request, while retaining multiple share-class position rows for the same issuer. Each body is limited to **256 KiB**, **100 rows**, and **2,000 characters per input cell**. The server function's maximum duration is 120 seconds; one issuer failure is reported separately and leaves other results usable. Requests are synchronous and return results directly; there are no job IDs.

```sh
curl --request POST \
  'https://secedgarterminal.com/api/v1/portfolio-research' \
  --header 'Content-Type: application/json' \
  --data '{"schema_version":"edgar.portfolio.v1","action":"research","name":"Example research universe","holdings":[{"ticker":"AAPL"},{"ticker":"MSFT"}],"allocation":{"basis":"none","normalize":false},"research":{"basis":"annual"}}'
```

`research.basis` is `annual` or `ttm`. Unsupported TTM observations stay unavailable; the service does not silently substitute annual figures. `allocation.basis` is `none`, `weights`, `market_value` or `equal`; equal weighting is an explicit model assumption. `normalize` defaults to false and must be explicitly enabled for supplied weights. Original values are retained.

Optional `row_choices` records explicit duplicate decisions, for example `[{"index":0,"duplicateChoice":"keep"},{"index":1,"duplicateChoice":"keep"}]` retains two identified duplicate position rows. Indices are zero-based and unique; supported choices are `keep` and `remove`. Merge compatible rows in the review workflow or in your input after checking their dates, currencies and allocation fields; the API does not silently merge them.

This illustrative response demonstrates shape, not live Apple or Microsoft financial figures. Actual responses contain complete retained provenance and additional coverage fields:

```json
{
  "schema_version": "edgar.portfolio.v1",
  "generated_at": "2026-09-07T16:00:00.000Z",
  "basis": "annual",
  "action": "research",
  "rows": [
    {
      "id": "example-row",
      "input": { "ticker": "EXAMPLE" },
      "resolution": {
        "status": "unresolved",
        "ticker": null,
        "cik": null,
        "reason": "No exact issuer match. Review this input."
      }
    }
  ],
  "companies": [],
  "coverage": {
    "inputRows": 1,
    "resolvedRows": 0,
    "uniqueIssuers": 0,
    "researchedIssuers": 0,
    "filingScope": "Recent SEC submissions only; up to 30 relevant filings per issuer. No archived submission files are scanned."
  },
  "allocation": { "mode": "universe", "basis": "none" }
}
```

Successful `companies` entries carry `cik`, `ticker`, `name`, `status`, `kind`, `lens`, `sic`, `sicDescription`, `industry`, `period`, `metrics`, `filings`, `filingCoverage`, `retrievedAt`, `cache`, and `warnings`. Status is `ready`, `partial`, `failed` or `unsupported`. Funds remain identifiable positions with a link to fund research; ordinary corporate metrics are not applied to them. Foreign issuers can have limited supported financial-fact coverage.

Each metric point includes `value` (a number or `null`), `unit`, `period`, `classification`, and `sources`. Classification distinguishes `reported`, `calculated`, `unavailable`, and `not_applicable`. Sources preserve filing accession, SEC document URL, form, filing date, period start/end, units, input values, taxonomy and tag. Calculated metrics also retain formula and calculation/input details where applicable. Missing values are never replaced with zero.

Cache state is explicit: `fresh`, `cached`, `stale`, or `unavailable` for failed retrievals. Public company data is reusable for five minutes; a failed refresh may return a labeled cached snapshot no more than 24 hours old. The retrieval timestamp identifies that snapshot, not the reporting period. Recent filing feeds include at most 30 relevant forms per issuer from the SEC recent submissions block; older archive files are not scanned.

## Combining batches without changing exposure

1. Resolve the entire input with `action: "resolve"`. Correct or explicitly exclude ambiguous, conflicting, duplicate and unsupported rows. Do not silently select the first name candidate.
2. Group the retained resolved rows by CIK and split the distinct issuers into batches of at most five. Retain all position rows for a share-class group together. Request batches serially, respecting `Retry-After` and cancellation.
3. Combine `companies` by normalized CIK, retaining each result's reporting and retrieval dates. Keep the original position list separately; a company response represents an issuer, not a merged security position.
4. Recompute coverage and allocation across the complete retained position list. **Do not add or average batch percentages, and do not treat each batch's equal-weight model as the final portfolio.** Use `basis: "none"` in retrieval batches and calculate the final requested allocation model only once over the complete input.
5. Retry only failed issuers if desired. A partial response does not invalidate other issuers, and incomplete coverage does not justify reweighting the covered subset.

For explicit weights, the analysis weight is the original `weight_pct` unless normalization was explicitly selected. Explicit normalization uses `100 × supplied_weight / total_supplied_weight` and preserves the original supplied values. Equal weighting uses `100 / eligible_position_count` only after it is explicitly selected; issuer weights sum its retained share-class positions. For comparable market values in one common currency, weights are `100 × position_value / total_comparable_position_value`. Missing/negative values, mixed currencies and incompatible holdings dates require review; there is no automatic FX or price conversion. Unspecified weight is not labeled cash.

Financial-evidence count coverage requires at least one finite supported company metric. A partial response containing filings alone remains useful research but does not count as financial coverage. Weighted financial coverage adds original/model weights of positions with that evidence, retaining the full original denominator. Metric coverage is separate because a partially researched company can still lack a particular field. Industry groups use SEC SIC-derived classifications, not GICS. No whole-company assets, revenues or debt are summed as the portfolio's economically owned totals. No returns, volatility, beta, Sharpe ratio, drawdown or VaR are derived from this input.

## Errors and privacy

| HTTP status | Behavior                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`       | Request processed. Inspect each row, each company and coverage; unresolved or failed individual companies can appear here.                    |
| `400`       | Invalid schema/action/basis/input, excessive rows/cell length, or more than five distinct issuers in a research request. Correct the request. |
| `413`       | Body exceeds 256 KiB. Split the request.                                                                                                      |
| `415`       | Unsupported request content type. Send JSON.                                                                                                  |
| `429`       | Rate limit reached. Respect `Retry-After`.                                                                                                    |
| `502`       | A required shared upstream service, such as the SEC issuer directory, is unavailable. Retry later.                                            |

CSV/XLSX/JSON parsing and saved portfolios use the browser where practical. The interactive research client sends identifiers needed to retrieve public company data, not private notes or allocation values. Browser-local portfolios do not automatically synchronize to other devices; include them in a Research Hub backup before clearing site data.

Programmatic request bodies may contain optional allocations or notes. They are processed for that request and are not stored in shared portfolio caches or routine application logs. Keep notes out of an API request unless needed: a remote request necessarily transmits any supplied field to the application. Shared caching contains public company facts only. This feature does not place private holdings in URLs, indexable pages or analytics events. It does not add background monitoring, emails or unattended notifications.

## Portable research snapshots

The UI exports a selected unique-issuer table to CSV, a seven-sheet XLSX workbook, structured JSON, and a source-backed Markdown brief. “Copy research context” produces the same evidence brief with context for another research tool; it does not call an LLM. XLSX sheets are Holdings, Company research, Portfolio summary, Sources, Coverage & methodology, Analytics, and Metric observations. The last sheet records the value, unit, reporting end, SEC source and evidence status for each issuer and tracked metric in a full-document export. Workbook cells are literal values, and CSV text is protected against spreadsheet formula injection.

The richer export schema is `edgar.portfolio.research.v1`, with `input_schema_version: "edgar.portfolio.v1"`, export generation time, research capture time, `positions`, `companies`, `allocation`, `coverage`, `analytics`, `sources`, `warnings`, `exclusions`, and `methodology`. It is an evidence package, not an import template. Reported public evidence, application calculations and user-entered positions remain distinct. Exported metrics retain units, reporting periods, source accessions/URLs and formula/input details. Notes are excluded by default with an explicit opt-in. Allocation values are included by default only under the visible export option; users can exclude allocations, quantities and holding dates to share company research alone.

A selected export preserves original/model weights calculated over the full saved document; it never silently reweights the selected subset. Full-document totals and selected coverage are labeled separately. Exported files are captured snapshots and do not update themselves.

## Portfolio analytics

The browser derives portfolio analytics from the reviewed input rows and captured company results; it does not retrieve prices or add recurring requests. The demo exposes the same analytics. `portfolioTab=analytics` opens the saved portfolio analytics area; scenario inputs and private positions are never placed in that URL.

Issuer concentration aggregates retained share classes by verified CIK. Known issuer weights remain original/model percentage points, even when incomplete. HHI (sum of squared percentage-point issuer weights) and effective issuer count (`10000 / HHI`) require reviewed, fully resolved allocations totaling 100%. These are direct-issuer concentration measures, without fund look-through or correlation assumptions.

Financial distributions use one observation per resolved operating issuer, supported classifications and compatible units/lenses. Missing values and not-applicable metrics are separate from measured observations. The median and interquartile range describe available issuer observations, not portfolio-owned financial totals or portfolio returns. Reporting-period differences remain visible. Condition exposure totals add known original weights of matching issuers without reweighting the covered subset.

Full-document research packages include derived analytics. Allocation opt-out produces count-only analytics from sanitized rows. Selected-subset exports omit portfolio-wide analytics with a scope explanation, preventing unselected issuer details from appearing or weights being renormalized. The separate analytics CSV and Analytics worksheet retain capture dates, calculation scope and coverage.

The interactive scenario lab applies explicit hypothetical price changes: contribution in percentage points = issuer weight percentage × assumed price change percentage / 100. Complete reviewed allocations totaling 100% are required. A user can explicitly select a transient equal-weight scenario without editing saved holdings. Resulting weights reflect mechanical price drift; they are unavailable when modeled ending value is zero. Scenarios are not forecasts, historical performance or statistical risk estimates and assume no correlation, spillover, trading cost or liquidity model. Scenario CSVs preserve the chosen assumptions and contributions separately from financial evidence.

### Investigation tools

The portfolio briefing summarizes captured conditions, known concentration and coverage, with direct navigation to supporting views. User-adjustable issuer and industry limits are research assumptions. Known breaches remain visible with incomplete allocation; an incomplete allocation cannot establish that a limit is satisfied. Cumulative exposure adds original issuer weights without normalizing a filtered group. Issuer HHI contribution is squared percentage weight divided by total HHI, available only for complete reviewed allocation.

Industry peer benchmarks recompute descriptive statistics within the selected cohort. Midrank percentiles account for ties and describe a company's numerical position, not investment quality. Reporting-date filters use each metric observation's end date. Two-metric charts intersect canonical issuer CIKs with both supported observations; a same-period option requires identical nonmissing reporting ends. The charts are cross-sectional financial comparisons, not return correlations. Side-by-side comparison accepts up to four identified issuers and retains each value's own period and SEC source.

Company screening combines up to four finite threshold rules with AND logic. Unsupported, missing or not-applicable values cannot pass a financial rule. Filtered counts, coverage and any known matching allocation retain their original portfolio denominator. Each metric includes canonical `eligibleCiks`, `missingCiks` and `notApplicableCiks` arrays for operating issuers, enabling exact cohort applicability without repeating financial-lens rules. Funds are separately not applicable to these company metrics. The coverage matrix and filtered CSV exports expose those states at issuer and metric level.

Sensitivity grids evaluate the existing price scenario engine across target and other-holding assumptions. The loss-target tool solves the required target shock using the selected allocation and fixed remainder shock, then checks the result through that engine. Zero target weight and shocks outside −100% to +100% are not feasible solutions. Up to four named cases retain compact assumption parameters in component state and recalculate against the current portfolio. Research tab switches preserve cases; reloading, editing rows or opening another portfolio clears them. Case comparisons and their assumptions can be exported to CSV. No hypothetical inputs are added to public URLs or transmitted to a pricing service.
