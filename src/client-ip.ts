/**
 * Forward the MCP caller's IP to payment-api /funding/*.
 *
 * Why: this Worker calls the Funding API keylessly, and payment-api keys the
 * keyless app's user_ref, open-order cap, daily per-user cap and request rate
 * limits on the client IP. A Worker subrequest arrives with the Worker egress
 * address, so before this every MCP user was one user (`ip:c867d92...`,
 * measured 2026-10-13) and one unpaid order blocked all of them.
 *
 * Same contract as rozo-intents-api cloudflare/intentapi-proxy/worker.js:
 * the caller's cf-connecting-ip goes in `x-rozo-client-ip` together with
 * `x-rozo-proxy-auth` = ROZO_PROXY_SECRET, and payment-api trusts the IP only
 * when the secret matches (supabase/functions/shared/client-ip.ts).
 *
 * These calls go straight to the Supabase host, not intentapiv4.rozo.ai: that
 * proxy deletes incoming trust headers and re-sets them from ITS caller's
 * cf-connecting-ip, which would be this Worker's egress address again.
 *
 * Without the secret binding nothing changes: no extra header, same URL.
 * The secret is never logged and never sent to any other host.
 */
import { INTENTS_BASE, type FetchLike } from './api';

export const CLIENT_IP_HEADER = 'x-rozo-client-ip';
export const PROXY_AUTH_HEADER = 'x-rozo-proxy-auth';
/** Origin behind intentapiv4.rozo.ai (UPSTREAM_HOST in intentapi-proxy). */
export const DIRECT_INTENTS_BASE = 'https://aozudqtlykbhzbuzalzz.supabase.co/functions/v1/payment-api';

export type ClientForward = { ip: string; secret: string } | null;

/** The caller IP to forward, or null when there is no IP or no secret. */
export function clientForwardFrom(request: Request, secret: string | undefined | null): ClientForward {
  const ip = (request.headers.get('cf-connecting-ip') ?? '').trim();
  return ip && secret ? { ip, secret } : null;
}

/**
 * Wrap fetch so payment-api calls carry the caller IP. Any other URL (and every
 * call when `fwd` is null) passes through unchanged.
 */
export function withClientIp(fetchFn: FetchLike, fwd: ClientForward): FetchLike {
  if (!fwd) return fetchFn;
  const prefix = `${INTENTS_BASE}/`;
  return (url, init) => {
    if (!url.startsWith(prefix)) return fetchFn(url, init);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      if (k !== CLIENT_IP_HEADER && k !== PROXY_AUTH_HEADER) headers[k] = v;
    });
    headers[CLIENT_IP_HEADER] = fwd.ip;
    headers[PROXY_AUTH_HEADER] = fwd.secret;
    // Never follow a redirect: the request carries the proxy secret.
    return fetchFn(`${DIRECT_INTENTS_BASE}${url.slice(INTENTS_BASE.length)}`, { ...init, headers, redirect: 'manual' });
  };
}
