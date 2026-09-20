import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentMessage, verifiedCheckoutUrl } from '../src/components/billing/billingPresentation.js';

test('payment return presentation requires actual server fulfillment rather than redirect flags', () => {
  assert.match(paymentMessage({ fulfilled: true, remaining: 100 }), /Payment confirmed/);
  assert.match(paymentMessage({ fulfilled: true, duplicate: true, remaining: 0 }), /already been recorded/);
  assert.match(paymentMessage({ fulfilled: false, pending: true }), /still processing/);
  assert.match(paymentMessage({ checkout: 'success', status: 'paid' }), /still processing/);
  assert.match(paymentMessage({ fulfilled: 'true' }), /still processing/);
  assert.match(paymentMessage({ fulfilled: false, refunded: true }), /processed the refund/);
  assert.match(paymentMessage({ fulfilled: false, refundInitiated: true, refundStatus: 'pending', refunded: false, code: 'BILLING_COUNTRY_UNAVAILABLE' }), /refund has been initiated/);
  assert.doesNotMatch(paymentMessage({ code: 'BILLING_COUNTRY_UNAVAILABLE', refundStatus: 'pending' }), /Payment confirmed|payment is still processing/);
});

test('checkout navigation accepts only HTTPS Stripe checkout without credentials or alternative ports', () => {
  assert.equal(verifiedCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test_123'), 'https://checkout.stripe.com/c/pay/cs_test_123');
  for (const value of ['http://checkout.stripe.com/pay', 'https://checkout.stripe.com.attacker.test/pay', 'https://user@checkout.stripe.com/pay', 'https://checkout.stripe.com:8443/pay', 'javascript:alert(1)', '//checkout.stripe.com/pay', undefined]) {
    assert.throws(() => verifiedCheckoutUrl(value));
  }
});
