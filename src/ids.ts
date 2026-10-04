const PL_RE = /^pl_[0-9a-zA-Z]{1,128}$/;
const SESSION_RE = /^paymentSession_[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class InputError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface ParsedLink {
  linkId: string;
  kind: 'payment_link' | 'payment_session';
  /** Canonical URL rebuilt from the id; query strings and fragments are dropped. */
  url: string;
}

/**
 * Accept only https://payments.coinbase.com/payment-links/pl_* or
 * .../payment-sessions/paymentSession_*. The URL is never fetched by this
 * Worker; it is re-built from the id so nothing else the caller typed (query,
 * fragment, extra path) is forwarded upstream.
 */
export function parseCoinbaseLink(raw: unknown): ParsedLink {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 512) {
    throw new InputError('BAD_LINK', 'A Coinbase payment link URL is required (max 512 chars).');
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new InputError('BAD_LINK', 'Not a valid URL.');
  }
  if (u.hostname === 'commerce.coinbase.com') {
    throw new InputError('LEGACY_COMMERCE_URL', 'commerce.coinbase.com charges use a legacy protocol and are not supported.');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'payments.coinbase.com' || u.port !== '' || u.username || u.password) {
    throw new InputError('BAD_LINK', 'Only https://payments.coinbase.com links are supported.');
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'payment-links' && PL_RE.test(parts[1]!)) {
    return { linkId: parts[1]!, kind: 'payment_link', url: `https://payments.coinbase.com/payment-links/${parts[1]}` };
  }
  if (parts.length === 2 && parts[0] === 'payment-sessions' && SESSION_RE.test(parts[1]!)) {
    return { linkId: parts[1]!, kind: 'payment_session', url: `https://payments.coinbase.com/payment-sessions/${parts[1]}` };
  }
  throw new InputError('BAD_LINK', 'Expected /payment-links/pl_* or /payment-sessions/paymentSession_*.');
}

export function assertRozoPaymentId(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!UUID_RE.test(s)) throw new InputError('BAD_ROZO_PAYMENT_ID', 'rozoPaymentId must be a UUID.');
  return s.toLowerCase();
}
