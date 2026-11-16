/**
 * Agent Checkout tools: agent_checkout_request_payment and
 * agent_checkout_request_status.
 *
 * Contract (rozo-mpprouter /v1/agent-checkout/*, branch feat/agent-checkout-requests):
 *
 *   POST /v1/agent-checkout/requests        { invoice, context, entry, fundingPreference? }
 *        Idempotency-Key: ^[A-Za-z0-9_.:-]{8,128}$ (required)
 *        201 created / 200 replay / 202 quote temporarily unavailable (retry the same key)
 *   GET  /v1/agent-checkout/requests/{id}   -> { request }
 *   Authorization: Bearer <ac_live_... | ac_test_...>
 *
 * Creating a request never moves money: the owner approves (or not) in
 * Discord, and only then is anything paid. The agent never gets a pay link,
 * an approval nonce or a balance.
 *
 * Credential rule (design impl-04 section 5.1): the agent credential comes
 * ONLY from the MCP connection's request headers (Authorization: Bearer ac_...
 * or X-Rozo-Agent-Checkout-Credential). It is never a tool parameter, never
 * returned in a tool result and never logged.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UpstreamError, rawRequest, type FetchLike, type RawResponse } from './api';
import { InputError, parseCoinbaseLink } from './ids';
import { atomicUsdc, formatAtomicUsdc } from './tools';
import { CLIENT_LABEL } from './version';

export const AC_BASE = 'https://apiserver.mpprouter.dev/v1/agent-checkout';
const AC_ORIGIN = 'https://apiserver.mpprouter.dev';
const AC_PATH_PREFIX = '/v1/agent-checkout/';
export const AC_CREDENTIAL_HEADER = 'x-rozo-agent-checkout-credential';

const CREDENTIAL_RE = /^ac_(?:live|test)_[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PL_ID_RE = /^pl_[0-9a-zA-Z]{1,128}$/;
const SESSION_ID_RE = /^paymentSession_[A-Za-z0-9_-]{1,128}$/;

/** What the connection carries for Agent Checkout. `malformed` = something ac_-like that does not validate. */
export type AcCredential = { state: 'ok'; value: string } | { state: 'missing' } | { state: 'malformed' };

/**
 * The Agent Checkout credential from an incoming MCP request. The dedicated
 * header wins (so a client can send an x402 ak_ key in Authorization at the
 * same time); otherwise "Authorization: Bearer ac_...". An ak_ bearer is left
 * to x402 (agentKeyFromRequest) and is never read here.
 */
export function acCredentialFromRequest(request: Request): AcCredential {
  const dedicated = (request.headers.get(AC_CREDENTIAL_HEADER) ?? '').trim();
  if (dedicated) {
    const v = dedicated.replace(/^Bearer\s+/i, '').trim();
    return CREDENTIAL_RE.test(v) ? { state: 'ok', value: v } : { state: 'malformed' };
  }
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '');
  const token = m?.[1] ?? '';
  if (!token.startsWith('ac_')) return { state: 'missing' };
  return CREDENTIAL_RE.test(token) ? { state: 'ok', value: token } : { state: 'malformed' };
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Strip control characters and anything that looks like a credential or x402 key. */
function clean(v: unknown, max = 300): string {
  return String(v ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\bac_[A-Za-z0-9_-]{6,}/g, 'ac_<redacted>')
    .replace(/\bak_[A-Za-z0-9_-]{8,}/g, 'ak_<redacted>')
    .slice(0, max);
}

function str(v: unknown, max = 200): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v ? clean(v, max) : null;
}

function render(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return render({ error: { code, message }, ...extra }, true);
}

export const NOT_BOUND =
  'This agent is not bound to a Rozo Agent Checkout owner. Ask the user to bind this agent in the Discord settings page, ' +
  'then set the agent credential in this MCP connector\'s configuration (header "Authorization: Bearer ac_..." or "X-Rozo-Agent-Checkout-Credential"). ' +
  'Never paste the credential into the chat or a tool argument.';
const MALFORMED =
  'The Agent Checkout credential configured on this MCP connection is malformed. Ask the user to check the connector configuration (it starts with ac_live_ or ac_test_). Never paste it into the chat.';
export const NOT_ENABLED = 'Agent Checkout is not enabled yet. Nothing was created and nothing was paid.';
const UNAUTHORIZED =
  'The Agent Checkout credential is not valid or not yet confirmed. Ask the user to confirm the binding in Discord, or to bind this agent again and update the connector configuration.';
const NOTHING_PAID = 'This call paid nothing. Nothing is paid until the owner approves this request in Discord.';

const STATUS_SENTENCES: Record<string, string> = {
  created: 'Request recorded; the price quote is not ready yet. Nothing has been paid.',
  pending_approval: 'Waiting for the owner to approve in Discord. Nothing has been paid.',
  approved: 'The owner approved. Payment has not been made yet.',
  awaiting_payment: 'Approved and waiting for the owner to complete payment. Nothing has been paid yet.',
  paying: 'Payment is in progress.',
  succeeded: 'Payment to the merchant went through. Rozo does not verify merchant delivery; check with the merchant (for example the OpenRouter credit balance).',
  denied: 'The owner declined this request. Nothing was paid.',
  expired: 'The request expired before it was approved or paid. Nothing was paid. Create a new request if still needed.',
  canceled: 'The request was canceled. Nothing was paid.',
  failed: 'The payment failed. Ask the owner to check the request in Discord before trying again.',
  manual_review: 'The request is under manual review by Rozo. Do not create a duplicate; check again later.',
};

export function statusSentence(status: unknown): string {
  return STATUS_SENTENCES[String(status)] ?? 'Unknown status. Check again later; do not assume it was paid.';
}

function usdc(v: unknown): string | null {
  const a = atomicUsdc(v);
  return a === null ? null : `${formatAtomicUsdc(a)} USDC`;
}

/** The agent-facing summary of one spend request. Never includes the credential. */
export function summarizeRequest(r: any) {
  const status = str(r?.status, 40);
  return {
    spendRequestId: str(r?.spendRequestId, 64),
    displayRef: str(r?.displayRef, 64),
    status,
    statusMeaning: statusSentence(status),
    statusReason: str(r?.statusReason, 200),
    environment: str(r?.environment, 16),
    merchant: str(r?.merchantDisplay, 120),
    merchantVerified: typeof r?.merchantVerified === 'boolean' ? r.merchantVerified : null,
    invoiceAmount: str(r?.invoiceAmount, 40),
    invoiceCurrency: str(r?.invoiceCurrency, 16),
    fee: usdc(r?.feeAtomic),
    total: usdc(r?.totalDebitAtomic),
    approvalExpiresAt: str(r?.approvalExpiresAt, 40),
    quoteExpiresAt: str(r?.quoteExpiresAt, 40),
    updatedAt: str(r?.updatedAt, 40),
  };
}

/** Coinbase payment link URL or bare id -> canonical URL. Other inputs are refused. */
export function normalizeInvoice(raw: string): string {
  const s = raw.trim();
  if (PL_ID_RE.test(s)) return `https://payments.coinbase.com/payment-links/${s}`;
  if (SESSION_ID_RE.test(s)) return `https://payments.coinbase.com/payment-sessions/${s}`;
  try {
    return parseCoinbaseLink(s).url;
  } catch {
    throw new InputError(
      'INVOICE_UNSUPPORTED',
      'Only Coinbase payment links are supported here: https://payments.coinbase.com/payment-links/pl_... or /payment-sessions/paymentSession_... (or the bare pl_ / paymentSession_ id).',
    );
  }
}

function errorCode(json: any, status: number): string {
  const c = typeof json?.error?.code === 'string' ? json.error.code : typeof json?.code === 'string' ? json.code : '';
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(c) ? c : `HTTP_${status}`;
}

const CREATE_ERRORS: Record<string, string> = {
  INVOICE_UNSUPPORTED: 'This invoice is not supported by Agent Checkout.',
  INVOICE_EXPIRING: 'The invoice expires too soon to be approved and paid. Get a fresh payment link.',
  CONTEXT_REQUIRED: 'A context (why you want to pay) is required.',
  INVALID_INPUT: 'The request was rejected as invalid.',
  LINE_ITEMS_MISMATCH: 'The line items do not match the invoice.',
  OWNER_NOT_ALLOWED: 'The bound owner is not allowed to use Agent Checkout.',
  INVOICE_IN_PROGRESS: 'A spend request for this invoice is already in progress. Check its status instead of creating another.',
  IDEMPOTENCY_CONFLICT: 'This idempotencyKey was already used for a different request. Use a new key only if this is a different payment.',
  RATE_LIMITED: 'Too many requests. Wait and retry later with the same idempotencyKey.',
  AC_UNAVAILABLE: 'Agent Checkout is temporarily unavailable. Retry later with the same idempotencyKey.',
  RETRY_LATER: 'Agent Checkout is temporarily unavailable. Retry later with the same idempotencyKey.',
};

const UNKNOWN_CREATE =
  'The outcome is UNKNOWN: Agent Checkout could not be reached or gave an answer that could not be confirmed. The spend request may already exist. ' +
  'Retry agent_checkout_request_payment with the SAME idempotencyKey (and the same invoice and context); do not use a new key.';
const UNKNOWN_STATUS =
  'The state could not be read: Agent Checkout could not be reached or gave an answer that could not be confirmed. Do not assume it is unpaid or unchanged; check again later.';

/**
 * Map a non-2xx Agent Checkout response to a tool error. Only definite,
 * documented refusals get a specific message; anything else (5xx, unknown
 * codes) is OUTCOME_UNKNOWN, because the request may have been recorded.
 */
function fromResponse(kind: 'create' | 'status', status: number, json: any, extra: Record<string, unknown> = {}): ToolResult {
  const code = errorCode(json, status);
  if (status === 401) return fail('AC_UNAUTHORIZED', UNAUTHORIZED, extra);
  if (status === 503 && (code === 'AC_DISABLED' || code === 'AC_NOT_CONFIGURED')) return fail('AC_DISABLED', NOT_ENABLED, extra);
  const more: Record<string, unknown> = { ...extra, httpStatus: status };
  const known = kind === 'create' && CREATE_ERRORS[code] !== undefined && (status < 500 || RETRYABLE_503.has(code));
  if (!known) return unknown(kind, { ...more, cause: code });
  if (code === 'INVOICE_IN_PROGRESS') {
    const id = str(json?.spendRequestId ?? json?.error?.spendRequestId, 64);
    const ref = str(json?.displayRef ?? json?.error?.displayRef, 64);
    if (id) more.spendRequestId = id;
    if (ref) more.displayRef = ref;
  }
  return fail(code, CREATE_ERRORS[code]!, more);
}

const RETRYABLE_503 = new Set(['AC_UNAVAILABLE', 'RETRY_LATER']);

function unknown(kind: 'create' | 'status', extra: Record<string, unknown>): ToolResult {
  return fail('OUTCOME_UNKNOWN', kind === 'create' ? UNKNOWN_CREATE : UNKNOWN_STATUS, extra);
}

function fromThrown(err: unknown, kind: 'create' | 'status', extra: Record<string, unknown> = {}): ToolResult {
  if (err instanceof InputError) return fail(err.code, err.message, extra);
  if (err instanceof UpstreamError) {
    return unknown(kind, { ...extra, cause: clean(err.code, 64) });
  }
  return fail('INTERNAL', 'Unexpected error.', extra);
}

/**
 * Every call that carries the credential goes here: the URL must be on the
 * pinned https origin and path, and redirects are refused (fetch would follow
 * them and forward the Authorization header).
 */
async function acCall(fetchFn: FetchLike, method: 'GET' | 'POST', url: string, credential: string, body?: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('agent checkout url invalid');
  }
  if (u.origin !== AC_ORIGIN || !u.pathname.startsWith(AC_PATH_PREFIX) || u.username || u.password) {
    throw new Error('agent checkout url not on the pinned origin');
  }
  const res = await rawRequest(fetchFn, method, url, body, { ...authHeaders(credential), ...headers }, { redirect: 'error' });
  // Defence in depth for fetch implementations that ignore redirect: 'error'.
  if (res.status >= 300 && res.status < 400) throw new UpstreamError('HTTP_REDIRECT_REFUSED', 'redirect refused', res.status);
  return res;
}

const NEXT_BY_STATUS: Record<string, string> = {
  created: 'The quote is not ready yet. Retry agent_checkout_request_payment later with the SAME idempotencyKey, or check agent_checkout_request_status.',
  pending_approval: 'Tell the user the owner must approve in Discord. Check progress with agent_checkout_request_status using spendRequestId.',
  approved: 'The owner approved; payment is not made yet. Check progress with agent_checkout_request_status.',
  awaiting_payment: 'The owner approved and must complete payment. Check progress with agent_checkout_request_status.',
  paying: 'Payment is in progress. Check again with agent_checkout_request_status.',
  succeeded: 'Payment went through. Merchant delivery is not verified by Rozo; check with the merchant. Do not create another request for this invoice.',
  denied: 'The owner declined. Do not retry this request; ask the user before creating a new one.',
  expired: 'The request expired unpaid. Create a new request with a NEW idempotencyKey only if the user still wants to pay.',
  canceled: 'The request was canceled. Ask the user before creating a new one.',
  failed: 'The payment failed. Ask the owner to check the request in Discord before trying again.',
  manual_review: 'Under manual review by Rozo. Do not create a duplicate; check again later with agent_checkout_request_status.',
};

export function nextForStatus(status: unknown): string {
  return NEXT_BY_STATUS[String(status)] ?? 'Check progress with agent_checkout_request_status; do not assume it was paid.';
}

export interface AgentCheckoutContext {
  fetchFn: FetchLike;
  credential: AcCredential;
  /** Idempotency key generator (tests override it). */
  newKey?: () => string;
}

function authHeaders(credential: string): Record<string, string> {
  return { authorization: `Bearer ${credential}`, 'x-rozo-client': CLIENT_LABEL };
}

function credentialGate(ctx: AgentCheckoutContext): ToolResult | string {
  if (ctx.credential.state === 'ok') return ctx.credential.value;
  return ctx.credential.state === 'malformed' ? fail('AC_CREDENTIAL_MALFORMED', MALFORMED) : fail('AC_NOT_BOUND', NOT_BOUND);
}

export function registerAgentCheckoutTools(server: McpServer, ctx: AgentCheckoutContext): void {
  const newKey = ctx.newKey ?? (() => `mcp-${crypto.randomUUID()}`);

  server.registerTool(
    'agent_checkout_request_payment',
    {
      title: 'Ask the owner to pay an invoice',
      description:
        'Create a spend request asking the bound owner to pay a Coinbase payment link invoice (for example an OpenRouter top-up). ' +
        'Nothing is paid by this call: the owner approves or declines in Discord, and only then is anything paid. ' +
        'Requires this agent to be bound; the credential is configured on the MCP connection, never passed as an argument. ' +
        'Reuse the same idempotencyKey on every retry of the same request; if you omit it one is generated and returned. ' +
        'Then poll agent_checkout_request_status with the returned spendRequestId.',
      inputSchema: {
        invoice: z.string().min(1).max(512).describe('Coinbase payment link URL (payments.coinbase.com/payment-links/pl_... or /payment-sessions/paymentSession_...) or the bare id.'),
        context: z.string().min(1).max(2000).describe('Why you want to pay this, in one or two sentences. Shown to the owner when they approve.'),
        fundingPreference: z.enum(['auto', 'per_payment']).optional().describe('How the owner funds it: "auto" (default) or "per_payment".'),
        idempotencyKey: z
          .string()
          .max(128)
          .optional()
          .describe('8 to 128 chars of A-Z a-z 0-9 _ . : -. Same key + same request = same spend request. Omit on the first try; reuse the returned one on retries.'),
      },
      annotations: { title: 'Ask the owner to pay an invoice', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ invoice, context, fundingPreference, idempotencyKey }) => {
      const gate = credentialGate(ctx);
      if (typeof gate !== 'string') return gate;
      let key: string;
      if (idempotencyKey !== undefined && idempotencyKey !== '') {
        if (!IDEMPOTENCY_RE.test(idempotencyKey)) return fail('BAD_VALUE', 'idempotencyKey must be 8 to 128 chars of A-Z a-z 0-9 _ . : -');
        key = idempotencyKey;
      } else {
        key = newKey();
      }
      const keyInfo = { idempotencyKey: key };
      try {
        const url = normalizeInvoice(invoice);
        const ctxText = context.trim();
        if (!ctxText) return fail('CONTEXT_REQUIRED', 'A context (why you want to pay) is required.', keyInfo);
        const body = { invoice: url, context: ctxText, entry: 'mcp', ...(fundingPreference ? { fundingPreference } : {}) };
        const res = await acCall(ctx.fetchFn, 'POST', `${AC_BASE}/requests`, gate, body, { 'idempotency-key': key });
        if (res.status === 404) return fail('AC_DISABLED', NOT_ENABLED, keyInfo);
        if (!res.ok) return fromResponse('create', res.status, res.json, keyInfo);
        if (!res.json || typeof res.json !== 'object' || !res.json.request) return unknown('create', { ...keyInfo, httpStatus: res.status, cause: 'HTTP_BAD_JSON' });
        const summary = summarizeRequest(res.json.request);
        const pending = res.status === 202;
        return render({
          notice: NOTHING_PAID,
          ...summary,
          replay: res.json.replay === true,
          ...keyInfo,
          ...(pending
            ? {
                quoteError: str(res.json.quoteError, 40) ?? 'QUOTE_UNAVAILABLE',
                next: 'The price quote is temporarily unavailable. Retry agent_checkout_request_payment later with the SAME idempotencyKey and the same invoice and context.',
              }
            : { next: nextForStatus(summary.status) }),
        });
      } catch (err) {
        return fromThrown(err, 'create', keyInfo);
      }
    },
  );

  server.registerTool(
    'agent_checkout_request_status',
    {
      title: 'Spend request status',
      description:
        'Read the status of a spend request this agent created with agent_checkout_request_payment. Read only. ' +
        'Payment success does not mean the merchant delivered; Rozo does not verify delivery.',
      inputSchema: {
        spendRequestId: z.string().max(64).describe('spendRequestId (UUID) returned by agent_checkout_request_payment.'),
      },
      annotations: { title: 'Spend request status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ spendRequestId }) => {
      const gate = credentialGate(ctx);
      if (typeof gate !== 'string') return gate;
      const id = spendRequestId.trim();
      if (!UUID_RE.test(id)) return fail('BAD_VALUE', 'spendRequestId must be a UUID.');
      try {
        const res = await acCall(ctx.fetchFn, 'GET', `${AC_BASE}/requests/${encodeURIComponent(id.toLowerCase())}`, gate);
        if (res.status === 404) {
          return fail('NOT_FOUND', 'No spend request with this id for this agent (or Agent Checkout is not enabled yet).', { httpStatus: 404 });
        }
        if (!res.ok) return fromResponse('status', res.status, res.json);
        if (!res.json || typeof res.json !== 'object' || !res.json.request) return unknown('status', { httpStatus: res.status, cause: 'HTTP_BAD_JSON' });
        return render(summarizeRequest(res.json.request));
      } catch (err) {
        return fromThrown(err, 'status');
      }
    },
  );
}
