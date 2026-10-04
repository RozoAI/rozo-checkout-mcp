import { describe, expect, it } from 'vitest';
import { assertRozoPaymentId, parseCoinbaseLink } from '../src/ids';

describe('parseCoinbaseLink', () => {
  it('accepts payment links and sessions and canonicalizes', () => {
    expect(parseCoinbaseLink('https://payments.coinbase.com/payment-links/pl_01abcXYZ?foo=bar#x')).toEqual({
      linkId: 'pl_01abcXYZ',
      kind: 'payment_link',
      url: 'https://payments.coinbase.com/payment-links/pl_01abcXYZ',
    });
    expect(parseCoinbaseLink('https://payments.coinbase.com/payment-sessions/paymentSession_a-b_C').kind).toBe('payment_session');
  });
  it.each([
    'http://payments.coinbase.com/payment-links/pl_1',
    'https://evil.com/payment-links/pl_1',
    'https://payments.coinbase.com.evil.com/payment-links/pl_1',
    'https://user:pw@payments.coinbase.com/payment-links/pl_1',
    'https://payments.coinbase.com:8443/payment-links/pl_1',
    'https://payments.coinbase.com/payment-links/pl_1/../../x',
    'https://payments.coinbase.com/payment-links/pl_1%2F..',
    'https://payments.coinbase.com/other/pl_1',
    'https://commerce.coinbase.com/pay/abc',
    'pl_123',
    '',
  ])('rejects %s', (u) => {
    expect(() => parseCoinbaseLink(u)).toThrow();
  });
});

describe('assertRozoPaymentId', () => {
  it('accepts uuids only', () => {
    expect(assertRozoPaymentId('5F2B1C3D-1111-2222-3333-444455556666')).toBe('5f2b1c3d-1111-2222-3333-444455556666');
    expect(() => assertRozoPaymentId('../admin')).toThrow();
    expect(() => assertRozoPaymentId('x')).toThrow();
  });
});
