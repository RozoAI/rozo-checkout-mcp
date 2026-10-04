import { CLIENT_LABEL } from './version';

export const DEFAULT_SRC = 'mcp';
const SRC_MAX = 100;

/**
 * Channel tag from the `?src=` query of the MCP endpoint URL. Each listing
 * (registry, docs, a partner) gets its own URL so orders can be split by
 * channel. Lowercased, restricted to [a-z0-9._-], at most 100 chars; anything
 * empty after cleaning falls back to "mcp". Never throws.
 */
export function sanitizeSrc(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SRC;
  const cleaned = raw.slice(0, SRC_MAX * 4).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, SRC_MAX);
  return cleaned.length ? cleaned : DEFAULT_SRC;
}

export function srcFromRequestUrl(requestUrl: string): string {
  try {
    return sanitizeSrc(new URL(requestUrl).searchParams.get('src'));
  } catch {
    return DEFAULT_SRC;
  }
}

/**
 * Fields added to every create-invoice body. Shape matches the router's
 * order-attribution whitelist (client <= 64, utm_source <= 100).
 */
export function attributionFields(src: string): {
  client: string;
  attribution: { client: string; utm_source: string };
} {
  return {
    client: CLIENT_LABEL,
    attribution: { client: CLIENT_LABEL, utm_source: sanitizeSrc(src) },
  };
}
