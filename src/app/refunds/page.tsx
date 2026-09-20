import Link from "next/link";
import { buildPageMetadata } from "../../utils/siteMetadata";
import LegalShell from "../terms/LegalShell";

export const dynamic = "force-dynamic";
export const metadata = buildPageMetadata({ title: "Hosted AI Refund Policy", description: "Unused-credit refunds, failed-response restoration and help with an EDGAR Terminal Hosted AI purchase.", path: "/refunds" });

export default function RefundsPage() {
  return <LegalShell title="Refunds and billing help" intro="No renewal to cancel. Each answer pack is a one-time purchase, and you control whether to buy another.">
    <section><h2>Unused credits: request within 14 days</h2>
      <p>You may request a refund within 14 days of purchasing an answer pack for the unused portion of that pack. The refund is based on the amount paid and the proportion of credits still unused when the refund is processed, with the associated tax adjusted where applicable.</p>
      <p>For example, if 80 of a $10 pack’s 100 credits remain unused, the unused service amount is $8. Refunded credits are removed from the account. Used credits ordinarily are not refundable under this voluntary policy, except for a billing or technical delivery error or where the law requires otherwise.</p>
      <p>Stop using the credits you want refunded while the request is reviewed so the unused balance can be reconciled. The 14-day period is our voluntary policy; it does not restrict other rights provided by applicable law.</p>
    </section>
    <section><h2>Failed responses and billing errors</h2>
      <p>Failed, empty or stopped generations restore the reserved answer credit automatically after the unsuccessful request is recorded. A completed model-generated answer, including general help or a clarification, uses one credit. If the service cannot retrieve the evidence needed for a research answer and displays its source-unavailable notice, it restores the credit. A credit already used by a completed answer is not restored simply by closing the panel.</p>
      <p>If you see a duplicate charge, a paid pack that was not added or a technical failure that incorrectly spent a credit, contact support with the purchase or request reference. Confirmed billing and delivery errors will be corrected through credit restoration or an appropriate refund. You do not need to send your conversation or payment-card number.</p>
      <p>Repeated unsuccessful requests may pause Hosted AI under account or service spending controls without removing unused credits. If access remains unavailable, contact support about restoring access or refund options for your unused balance.</p>
    </section>
    <section><h2>How to request help</h2>
      <p>Sign in to your <Link href="/ai#account" prefetch={false}>billing page</Link> and use the refund or support link for the relevant purchase. Send the request from your account email and include the purchase reference, purchase date and whether you are requesting an unused-credit refund or reporting an error.</p>
      <p>If you cannot access your account, use the seller’s support email below. We may need to verify ownership before discussing account details or changing a purchase. Never send a password, authentication code or full card number.</p>
      <p>A payment completed with an unsupported billing country is refunded without issuing credits. Approved refunds are returned through the original payment processor to the original payment method where possible. Your bank or payment provider controls when the refund appears. We do not promise an instant refund or a fixed review time.</p>
    </section>
    <section><h2>No recurring charges</h2>
      <p>There is no subscription to cancel, no automatic refill and no automatic charge when credits run out. Unused credits do not expire. If Hosted AI is permanently discontinued, unused purchased credits are eligible for a refund.</p>
      <p>Deleting or signing out of an account does not itself submit a refund request. Contact support about remaining credits before requesting account deletion. This policy does not limit mandatory consumer rights or your ability to raise a payment dispute.</p>
    </section>
  </LegalShell>;
}
