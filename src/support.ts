/**
 * How a payer reaches ROZO, and the optional contact email that lets ROZO
 * reach the payer when an order needs attention. Same rules as the
 * rozo-checkout CLI and the MPP Router create-invoice route.
 */

export const SUPPORT = Object.freeze({
  email: 'hi@rozo.ai',
  x: 'https://x.com/ROZOai',
  discord: 'https://discord.gg/EfWejgTbuU',
});

export const CONTACT_EMAIL_MAX_LENGTH = 254;

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Trimmed lowercase address, null when absent/blank, undefined when invalid. */
export function normalizeContactEmail(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const email = raw.trim().toLowerCase();
  if (email.length === 0) return null;
  if (email.length > CONTACT_EMAIL_MAX_LENGTH) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(email) || !EMAIL_RE.test(email)) return undefined;
  return email;
}
