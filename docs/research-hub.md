# Research Hub

The Hub at `/workspace` connects five research workflows. Portfolios, private writing, review decisions, and saved views stay in the browser. Full backups include these stores; older backups remain compatible.

1. **Overview:** Resume portfolios, assess research coverage, search saved work, and follow concrete next steps. Search terms and private notes are not placed in URLs.
2. **Review inbox:** Triage coverage gaps, saved follow-ups, and filing evidence. Mark items reviewed, snooze them for seven days, or reopen them. Review state follows the underlying evidence, so changed evidence can require a fresh review. Acknowledging an item does not refresh research.
3. **What changed:** Compare public research against the previous successful capture. Same-period, same-unit, same-definition metrics may be compared numerically; new periods, newly observed filings, missing evidence, and incomplete refreshes remain distinct. Editing holdings or changing the research basis resets the comparison. A compact, validated checkpoint retains source links and capture dates.
4. **Company focus and saved views:** Open one issuer's metrics, filings, allocations, and evidence in a focused dialog. Choose an industry-appropriate preset or save a screening view with filters, columns, and sorting. The current view is restored per portfolio.
5. **Research briefs:** Turn selected SEC evidence into a named research question, thesis, risks, and next steps. Classify sources as supporting, contradicting, or contextual. Save, duplicate, and export Markdown or JSON. Private writing is excluded from exports unless explicitly included, and unsaved drafts are labeled as such.

## Navigation and persistence

Hub areas use `view=overview|portfolios|inbox|briefs|watchlist|library`. Optional portfolio, row, saved-view, and brief identifiers support deep links; private content never appears in those links. Draft editors survive navigation between Hub areas. Native company dialogs close when leaving portfolio research.

New browser stores are `edgar:research-inbox:v1`, `edgar:portfolio-views:v1`, and `edgar:research-briefs:v1`. Writes validate size and schema bounds and merge against fresh storage. Brief and review edits detect stale revisions. Existing portfolio snapshots remain the source for research values; review state does not alter SEC evidence.

## Verification

Pure-module tests cover navigation privacy, overview summaries, evidence-aware review states, baseline transitions through partial refreshes, saved-view validation, brief persistence and export privacy, and backup compatibility. Release verification also exercises navigation and the integrated workflows in a deployed preview.
