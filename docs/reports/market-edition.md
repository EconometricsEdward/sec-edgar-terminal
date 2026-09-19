# Market report edition

The market PDF, Excel workbook and Reports preview follow the Market page’s sections. Both exports use one prepared snapshot; downloading a second format does not retrieve or recompute a different market universe.

| Market page | Report content |
| --- | --- |
| Market Briefing | Covered issuers, sectors and SIC industries; growth, profitability and operating-cash-flow breadth; highest and lowest sector growth medians |
| CFTC Positioning | The same six fixed macro observations, independent family dates, comparable weekly shifts, all participant-group heatmaps, prepared historical ranks and contract detail |
| Sector Performance | All five sector financial measures, metric-specific counts, sector rankings, industry composition and company membership |

`buildMarketMacroSummary` and `buildMarketMacroPositioning` are shared with the Market page. Company sector membership uses the existing sector-company projection. SEC report-age classifications use the snapshot clock so the report and page remain consistent. The file generation time is separate.

`marketReportBriefing.js` provides the presentation model and additional flat export tables. Its rich sector statistics, growth leaders and CFTC card percentages retain the Market page’s percentage-point scale (12.5 means 12.5%). `breadth.share` and flat table percentage values are fractions (0.125 means 12.5%). Weekly changes labeled `pp` remain numeric percentage points.

`marketReportPdf.js` renders the market edition. The PDF includes every classified sector; its compact industry and company profiles clearly identify their selection rules. `reportMarketWorkbook.js` arranges the workbook around the same sections and retains all available company, industry and CFTC detail. Excel has no source, methodology-reference or chart-data worksheets. Original references remain available in the PDF.

Only the existing prepared SEC overview and two CFTC family snapshots are loaded. The report does not fetch every company again, trigger a universe rebuild or request contract histories. Historical ranks appear only when prepared observations verify the required prior-report window. Missing comparisons remain unavailable. The PDF is a snapshot, so interactive history selection remains on the Market page.

Regression checks compare report breadth and sector statistics with the shared Market helpers; verify percentage units, dates, industry membership and withheld CFTC ranks; and retain all detail rows in Excel. Visual checks use real prepared inputs to inspect the briefing, CFTC cards, sector matrix, sector profiles and workbook tabs. Company and fund export routes retain their existing presentation.
