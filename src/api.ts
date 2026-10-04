/**
 * Backend contract, mirrored from @rozoai/checkout scripts/src/lib/api.mjs.
 *
 *   quote   POST  {MPP}/quote-invoice          keyless
 *   create  POST  {MPP}/create-invoice         keyless (IP rate-gated)
 *   status  GET   {MPP}/invoice-status         keyless
 *   deposit GET   {INTENTS}/payments/<uuid>    keyless, read-only
 *
 * No credential is ever attached: there is nowhere in this client to put one.
 * This server never writes to payment-api; order creation goes through
 * mpprouter only, exactly like the CLI.
 */
import { attributionFields } from './attribution';
import { CLIENT_LABEL } from './version';

export const MPP_BASE = 'https://apiserver.mpprouter.dev/v1/services/rozo-agent-api';
export const INTENTS_BASE = 'https://intentapiv4.rozo.ai/functions/v1/payment-api';
const TIMEOUT_MS = 20_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class UpstreamError extends Error {
  constructor(public code: string, message: string, public httpStatus: number | null) {
    super(message);
  }
}

function short(v: unknown, max = 300): string {
  return String(v ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, max);
}

async function request(fetchFn: FetchLike, method: 'GET' | 'POST', url: string, body?: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': CLIENT_LABEL,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    // The timer also covers reading the body: a stalled body must not hang the tool call.
    text = await res.text();
  } catch (err: any) {
    throw new UpstreamError(err?.name === 'AbortError' ? 'HTTP_TIMEOUT' : 'HTTP_UNREACHABLE', `${method} upstream request failed`, null);
  } finally {
    clearTimeout(timer);
  }
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const code =
      (typeof json?.code === 'string' && json.code) ||
      (typeof json?.error?.code === 'string' && json.error.code) ||
      `HTTP_${res.status}`;
    const message =
      (typeof json?.message === 'string' && json.message) ||
      (typeof json?.error === 'string' && json.error) ||
      (typeof json?.error?.message === 'string' && json.error.message) ||
      `HTTP ${res.status}`;
    throw new UpstreamError(short(code, 64), short(message), res.status);
  }
  if (json === null || typeof json !== 'object') {
    throw new UpstreamError('HTTP_BAD_JSON', 'Upstream returned a non-JSON body.', res.status);
  }
  return json;
}

export function makeApi(fetchFn: FetchLike) {
  return {
    quoteInvoice(url: string) {
      return request(fetchFn, 'POST', `${MPP_BASE}/quote-invoice`, { url });
    },
    createInvoice(args: { url: string; chainId: string; tokenSymbol: string; quoteReceipt?: string | null; src: string }) {
      return request(fetchFn, 'POST', `${MPP_BASE}/create-invoice`, buildCreateInvoiceBody(args));
    },
    invoiceStatus(rozoPaymentId: string) {
      const qs = new URLSearchParams({ rozo_payment_id: rozoPaymentId });
      return request(fetchFn, 'GET', `${MPP_BASE}/invoice-status?${qs.toString()}`);
    },
    getPayment(rozoPaymentId: string) {
      return request(fetchFn, 'GET', `${INTENTS_BASE}/payments/${encodeURIComponent(rozoPaymentId)}`);
    },
  };
}

export type Api = ReturnType<typeof makeApi>;

/** Same body shape as the CLI's createInvoice, with this server's labels. */
export function buildCreateInvoiceBody(args: {
  url: string;
  chainId: string;
  tokenSymbol: string;
  quoteReceipt?: string | null;
  src: string;
}) {
  return {
    url: args.url,
    source: { chainId: String(args.chainId), tokenSymbol: args.tokenSymbol },
    ...(args.quoteReceipt ? { quoteReceipt: args.quoteReceipt } : {}),
    ...attributionFields(args.src),
  };
}
