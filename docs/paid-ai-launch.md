# Paid Hosted AI: operation and commercial activation

Policy version: `2026-09-20`. This document records implementation choices and the operator’s remaining activation work. It is not a legal opinion or a certification of compliance.

## Product and billing contract

- Public research, Data answers and optional Browser AI remain free. Only explicitly selected Hosted AI requires a verified account and purchased credits. There is no automatic paid fallback.
- A one-time pack costs **$10 USD for 100 completed Hosted AI responses**, plus applicable tax disclosed at checkout. No subscription, automatic renewal, automatic refill or overage charge. Credits do not expire, incur inactivity fees or transfer between accounts.
- Both Fast and Reasoning cost one credit for a successfully completed model response. Model-generated general help and clarifications count. When grounding requires research but no substantive evidence is available, the service's deterministic source-unavailable notice is free: restore the credit even if the stream ends with a `done` frame. The checkout/account page and `/terms` must disclose this before purchase.
- A request reserves one credit before paid inference. Failed, empty, token-limited/incomplete or user-stopped requests release the credit. A late stop after a completed response does not reverse that completion. Balances must survive retries, concurrent requests and duplicate webhooks.
- Keep the existing provider, source, token, tool, request-time and global spending controls. A purchase is not a promise of unlimited capacity or guaranteed financial accuracy. Limits blocking a request must not consume a credit. Per-account and aggregate inference reservations cannot exceed the applicable 60% allocation from eligible purchase revenue; failures and stops may spend provider resources even though the customer's credit is restored. Repeated unsuccessful attempts may pause access while preserving the purchased balance. Provide support and unused-credit refund options rather than asking the customer to purchase again to resolve a service problem.
- Initial checkout supports a United States billing address. Stripe collects the billing address; because Checkout does not provide a general `allowed_countries` restriction for billing addresses, fulfillment verifies it. Unsupported-country payments must be refunded idempotently before any credits are granted. Do not add shipping collection merely to imitate a billing restriction.
- Account management and purchase/refund references appear at `/ai#account`. The customer policies are `/terms`, `/privacy` and `/refunds`.

## Configuration and owner responsibilities

All readiness flags are private server settings. A flag records work actually completed; changing a flag is not a substitute for the underlying review or setup. Do not commit credentials or expose Stripe secret keys or Supabase privileged keys in browser code.

| Setting | Required action before enabling live sales |
| --- | --- |
| `BILLING_ENABLED=true` | Enable only after the remaining checks below are completed and live purchase delivery is ready. |
| `BILLING_AUTH_READY=true` | Confirm Supabase Auth email verification, permitted redirect URLs, account session handling and a working production email-delivery setup. |
| `BILLING_MERCHANT_READY=true` | Complete Stripe business/beneficial-owner verification and payment/payout activation. Verify that the published seller is the actual contracting seller; evaluate the financial-research product’s legal classification. |
| `BILLING_TAX_READY=true` | Complete a taxability, nexus and registration assessment for the actual product and customer geography; configure collection and filing/remittance responsibilities. |
| `BILLING_SELLER_NAME` | Actual individual or legal-entity seller name. Do not invent an LLC, registration or a business address. |
| `BILLING_SUPPORT_EMAIL` | A real monitored email authorized to handle billing/privacy requests. Staff it and test receiving requests. |
| `BILLING_APP_ORIGIN` | The production billing implementation accepts only `https://secedgarterminal.com`. Shared preview checkout and fulfillment remain disabled. |
| `STRIPE_SECRET_KEY` | The production merchant's live secret, supplied privately only to the production billing environment. The application rejects test keys and nonproduction payments; never copy a live credential into a shared preview. |
| `STRIPE_PRICE_ID` | Active one-time price for $10 USD/100 answers. Verify amount, currency, one-time mode and product description; do not trust client-supplied prices or credit quantities. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this environment’s endpoint. Verify signatures against the raw request body. |
| `BILLING_TAX_MODE` | `automatic` or `reviewed_exempt`. Automatic requires completed Stripe Tax configuration and relevant registrations. `reviewed_exempt` is only for a documented conclusion supporting no collection for the permitted sales; it is not a generic bypass. |

Seller/support details must appear on the policies and purchase interface before sales are enabled. Missing identity keeps checkout unavailable. Stripe-hosted Checkout must show the total, currency, product description, taxes if applicable, and links to the privacy/refund/terms pages. Configure a recognizable statement descriptor and receipts in the actual merchant account. Card processing is shared security responsibility; hosted Checkout does not eliminate the merchant’s applicable PCI duties.

Before commercial activation, obtain a securities-law assessment of the actual paid financial-research service. The Investment Advisers Act definition can reach compensated securities reports/analyses as well as individualized advice. Whether a publisher or other exclusion applies depends on facts and conduct. Do not represent the service as exempt, registered or legally compliant solely because a disclaimer exists. Keep system behavior within public-data research: no personalized trade recommendations, suitability decisions, asset management, order execution or return guarantees.

The terms and checkout say the offer is for adults aged 18 or older. Do not market it to children. An age term alone is not a complete COPPA compliance program if actual knowledge of child use arises.

## Stripe webhook setup

Register `https://secedgarterminal.com/api/billing/webhook` on the merchant account and subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`, `charge.dispute.created`, `charge.dispute.updated`, and `charge.dispute.closed`. Store its signing secret only in production. Configure hosted Checkout business/terms/privacy details and a tax-exclusive one-time $10 USD price.

Monitor failed deliveries in Stripe and the scrubbed `edgar_billing_refund_requires_review` application event. A failed or canceled refund needs operator review and, if necessary, another refund method; never treat a pending refund as money already returned. Reconcile Stripe receipts, refunds, disputes and the ledger before enabling purchases, and regularly afterward.

## Refund handling and support

The published voluntary policy accepts requests within 14 days of purchase for the unused portion of a pack. Prorate against that pack’s actual purchase amount and unused credits, with associated tax adjusted where applicable. Example: 80 unused credits from a $10/100-credit pack yields an $8 service refund. Duplicate billing and confirmed technical delivery errors are corrected separately; mandatory consumer rights are preserved. No promised support response time is published until the operator can meet one.

The signed-in purchase list provides a support-email link containing the purchase reference. Opening it drafts an email in the customer’s email client; the application does not silently send it. Verify the account/payment relationship before disclosing details. If the customer cannot sign in, allow a support request and verify ownership without asking for passwords, authentication codes or full card numbers.

Operator procedure:

1. Match the authenticated account and purchase reference to a paid Stripe transaction. Establish whether this is unused-credit policy, duplicate charge, delivery failure or a statutory claim.
2. Check the purchase date, consumed/reserved credits and existing refunds/disputes. Ask the customer to stop using credits pending a requested refund. Resolve any active reservation before determining the unused amount.
3. Refund through the original Stripe payment. Use a stable idempotency key for programmatic processing. Adjust associated taxes as the processor requires.
4. Confirm the refund webhook has reconciled the purchase ledger. Refund reconciliation revokes credits cumulatively from the original pack; rounding must not leave spendable credits from refunded value. A dispute holds the affected pack while pending. The webhook retrieves the current Stripe dispute status: a won or closed inquiry restores only the original entitlement net of refunds and prior usage; a lost dispute keeps it revoked. Stale pending events cannot override a terminal dispute state. Investigate unresolved or conflicting states before any manual adjustment.
5. Reply with the processor’s refund reference and clarify that bank posting timing is outside the site’s control. Do not promise an instant refund.

Account sign-out/deletion is not a refund request. Reconcile unused purchased credits before processing a deletion request. If Hosted AI is permanently discontinued, arrange refunds for unused purchased credits before winding down the seller/payment account. Never erase a balance merely by retiring a plan.

## Privacy and records

- Supabase stores account identities, verified email status and the billing/credit ledger. Browser session tokens persist in local storage under `edgar-paid-ai-auth-v1`, refresh as needed and clear on sign-out. Tokens are credentials and must not enter logs or URLs.
- Store purchase identifiers, amounts/currency/tax, payment/refund/dispute states, the terms version and consent evidence, plus request/credit status and timestamps necessary to reconcile billing. Do not store prompts, answers, raw model reasoning or full card numbers in billing rows or logs.
- Chat history/drafts are in tab memory. Each request sends bounded history and selected or attached context as described in `docs/chat-assistant.md`. Hosted generation sends it through Vercel AI Gateway/Mistral. The current provider request requires zero retention/no training; verify actual production provider eligibility and settings. Do not turn that request preference into an unconditional promise about all provider metadata.
- Browser AI downloads external model assets after explicit activation. Its generation runs locally, while questions/history/context still reach EDGAR Terminal for data retrieval. Keep this distinction in customer copy.
- Vercel Analytics/Speed Insights are disclosed. Review privacy copy before adding advertising, new analytics identifiers or a new provider.
- Keep purchase/refund/accounting records generally seven years, and longer where law or an unresolved matter requires. Review necessity and delete unnecessary operational/account data through a controlled process. No automatic retention/deletion system is claimed by this release; the operator must handle verified requests and maintain a record review process.
- Confirm provider contracts, security settings and actual logging practices match the published notice. Restrict privileged database access, use row-level security and narrow server-only billing functions; never trust a client-edited balance.

## Verification required before taking money

Verify payment scenarios through isolated test harnesses and mocked or Stripe-sandbox fixtures first. The deployed billing implementation accepts only live-mode payments on the canonical production origin; a test key in a cloned environment does not enable checkout. Shared previews remain closed to payment creation, fulfillment and production billing state. Do not weaken these fences for verification. Mark only observed results as passed:

- Missing seller/support/tax/auth/payment configuration leaves purchases disabled and hosted inference inaccessible without credit.
- Verified sign-in works on the canonical origin; unverified users and forged tokens cannot purchase or call paid inference. Sign-out clears client tokens.
- Checkout displays $10 USD/100 responses, applicable tax, no renewal, terms acceptance, refund link and actual seller/support. Tampered price/quantity/account fields cannot affect server fulfillment.
- A successful signed payment webhook grants exactly 100 credits once. Redirecting to a success URL, replaying webhooks or using another user’s payment ID cannot create or inspect credits.
- Pending/failed/unpaid payments grant no credits. An unsupported billing country receives a refund and no credits. Refund failure is retained for retry/operator investigation rather than hidden as successful fulfillment.
- A completed Fast or Reasoning model answer consumes one credit, including model-generated general help/clarifications. Empty/error/stopped and output-limited requests restore it. A deterministic missing-evidence limitation also restores it, including when rendered with a `done` frame. Parallel requests cannot overspend. A request at zero balance never reaches the provider.
- Failed/stopped requests retain their cost reservation while restoring the answer credit. Per-account and aggregate 60% funded-cost ceilings stop additional inference before the relevant allocation is exceeded, retain unused purchased credits and expose support/refund guidance.
- Duplicate refunds, partial refunds and disputes reconcile once without restoring already used or refunded value. Out-of-order events cannot revive a revoked pack.
- Paid-account pages and APIs return private/no-store responses and do not expose another account’s records.
- Model failure never invokes another paid provider without the existing policy, and free modes never invoke the paid route automatically.
- Keyboard/mobile use, clear balance/loading/error states and links to all policies work. The actual configured support email receives a manually sent test request by the operator.

## Unit economics

The gross sale price is $0.10 per included completed response before sales tax. At the current conservative $0.04 inference reservation per request, 100 successful responses reserve up to $4 of model spend, leaving $6 before payment processing, hosting/database usage, refunds, unsuccessful attempts, support and business taxes. The ledger allocates at most 60% of eligible net-of-refund/dispute purchase revenue toward inference reservations, both per account and in aggregate. A $10 eligible pack therefore funds at most $6 of reservations, allowing limited retry overhead beyond 100 successful responses. Failed/stopped requests retain their inference reservation while restoring customer credits; enough failures can cause a funded-cost pause before the answer balance reaches zero. Such pauses preserve unused credits and require support/refund handling. These controls and estimates do not guarantee profit or cap the provider's invoice independently. Reconcile actual provider invoices and reassess pricing if model rates or failed attempts change. A sales-tax collection is not revenue.

## Primary sources reviewed

These sources support the implementation approach, not a conclusion that every applicable law has been identified. Recheck them when changing the business model, countries, data practices or renewal behavior.

- [Stripe website checklist](https://docs.stripe.com/get-started/checklist/website): description, currency, support, fulfillment/refunds, privacy and payment-security disclosures.
- [ROSCA, section 4](https://www.ftc.gov/system/files/documents/statutes/restore-online-shoppers-confidence-act/online-shoppers-enrolled.pdf): material disclosures, express informed consent and simple cancellation for online negative-option charges. The current packs do not renew automatically.
- [FTC March 2026 negative-option update](https://www.ftc.gov/business-guidance/blog/2026/03/do-you-have-thoughts-negative-option-related-regulations-share-them-ftc): renewed rulemaking; do not cite the vacated 2024 federal click-to-cancel rule as the operative rule.
- [California BPC section 17602](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=17602.): if subscriptions are introduced, implement consent records, retainable acknowledgment, online cancellation and applicable reminders/change notices. A payment portal alone is insufficient.
- [California BPC section 22575](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=22575.): conspicuous privacy notice and required content for covered commercial online services; distinct from the CCPA’s applicability thresholds.
- [FTC privacy and security guidance](https://www.ftc.gov/business-guidance/privacy-security): honor actual privacy promises and use appropriate data/security practices.
- [CFPB Regulation E section 1005.20](https://www.consumerfinance.gov/rules-policy/regulations/1005/20/): distinction between service entitlements and monetary-value prepaid instruments. Account-bound service units/no expiration/no gift marketing reduce product complexity but do not establish exemption from all prepaid, refund or unclaimed-property law.
- [SEC Investor.gov investment-adviser definition](https://www.investor.gov/introduction-investing/investing-basics/glossary/investment-adviser): compensated securities advice/reports may require substantive regulatory assessment.
- [FTC AI claims enforcement](https://www.ftc.gov/news-events/news/press-releases/2024/09/ftc-announces-crackdown-deceptive-ai-claims-schemes): avoid unsupported professional-equivalence, accuracy and earnings claims.
- [Indiana DOR Sales Tax Bulletin 8](https://www.in.gov/dor/files/sib08.pdf): remotely accessed software is generally not subject to Indiana sales tax. This is not a determination of this product’s classification or taxes in other customer jurisdictions.
- [Stripe tax registration guidance](https://docs.stripe.com/tax/registering): tax settings do not by themselves resolve nexus, register a business or settle filing/remittance duties.
