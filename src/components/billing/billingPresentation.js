/** Only server-confirmed payment state can be presented as fulfilled. */
export function paymentMessage(result) {
  if (result.code === 'BILLING_COUNTRY_UNAVAILABLE' || result.refundInitiated === true || result.refunded === true) return result.refundStatus === 'succeeded' || result.refunded === true
    ? 'This purchase cannot be fulfilled for that billing country. The payment service has processed the refund; your card issuer may take additional time to show it.'
    : 'This purchase cannot be fulfilled for that billing country. A refund has been initiated; your payment provider and card issuer may take time to process it. No AI responses were added.';
  if (result.fulfilled === true) return result.duplicate === true
    ? 'Your payment has already been recorded. Your current response balance is shown below.'
    : 'Payment confirmed. Your current response balance is shown below.';
  return 'Your payment is still processing. Use Check payment below to refresh; please do not buy again for this order.';
}

export function verifiedCheckoutUrl(value) {
  if (typeof value !== 'string') throw new Error('The checkout address could not be verified. Please try again.');
  const destination = new URL(value);
  if (destination.protocol !== 'https:' || destination.hostname !== 'checkout.stripe.com' || destination.port || destination.username || destination.password) {
    throw new Error('The checkout address could not be verified. Please try again.');
  }
  return destination.href;
}
