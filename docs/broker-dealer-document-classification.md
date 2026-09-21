# Broker-dealer document classification

Form X-17A-5 identifies a form family. It does not by itself establish whether an attachment is a periodic FOCUS report, an annual report, audited, or a complete set of public financial statements.

## Independent dimensions

| Field | Meaning |
| --- | --- |
| `family` | `annual-report`, `periodic-focus`, or `unknown`, determined from document evidence |
| `parts` | Identified Part III, Part II, Part IIA, or Schedule I headings |
| `audit.status` | Auditor report present, explicitly unaudited, or not established |
| `audit.scope` | Financial condition or financial statements, when supported by the auditor report |
| `period` | Disclosed start, end, and frequency; annual, quarterly, monthly, other, or unknown |
| `components` | Statements, notes, auditor report, and schedules identified in the attachment |
| `evidence` | Classification excerpts with original document URL and page |

An annual reporting frequency does not turn Schedule I into an annual audited report. A Part II report is not automatically unaudited. A Part III facing page does not establish that an auditor report or every statement on its checklist is available. Auditor identification alone is insufficient. A financial-condition audit does not establish that income or cash-flow statements were publicly filed.

## Processing boundaries

`brokerDealerForms.js` recognizes the raw form family. `brokerDealerClassification.js` classifies source content separately from numerical mapping. The document loader classifies the selected attachment; filing-envelope metadata has its own classification and cannot override a conflicting attachment.

Cached extracted pages are reusable. Classification and financial mapping run against those pages when research is requested, so mapping changes do not require downloading every PDF again. Cheap filing-history discovery does not parse PDFs merely to assign a type; unread records remain unclassified.

Financial mapping preserves document family and source period. Periodic schedules may contain field identifiers and allowable/nonallowable/total columns. Those identifiers are not financial values, and unresolved column layouts are withheld. Missing disclosures remain unavailable.

## Comparisons and delivery

Annual and periodic reports do not share an automatic comparison cohort. Periodic comparisons also require compatible parts and reporting frequencies. Unknown reports remain readable individually. Duration measures require compatible disclosed periods; no annualization or quarterly reconstruction is performed.

Identical period-end dates alone do not establish that two reports are versions of the same document. Different report families, parts, or periods remain separate. The default selects five reports, with up to ten selectable.

The annual PDF/Excel export workflow requires a classified annual attachment and preserves its actual audit status, public coverage, duration, and source evidence. Periodic FOCUS material and unclassified documents are not relabeled to fit the annual export workflow. Public JSON includes the document classification and actual reporting basis.

Only publicly accessible sources are used. These classifications do not imply access to confidential periodic FOCUS submissions. CFTC positioning remains separate, dated market context.

## SEC references

- [Form X-17A-5 Part III — Annual Reports](https://www.sec.gov/files/formx-17a-5_3.pdf)
- [Form X-17A-5 Part II — FOCUS Report](https://www.sec.gov/files/formx-17a-5_2.pdf)
- [Form X-17A-5 Part IIA](https://www.sec.gov/files/formx-17a-5_2a.pdf)
