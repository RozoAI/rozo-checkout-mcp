/**
 * Stellar wallet funding tools (ROZO Funding API, keyless public app).
 *
 *   GET  {INTENTS}/funding/capabilities
 *   POST {INTENTS}/funding/quotes                              mode stellar_onboarding
 *   POST {INTENTS}/funding/orders                              Idempotency-Key header
 *   GET  {INTENTS}/funding/orders/{fundingId}
 *   POST {INTENTS}/funding/orders/{fundingId}/signing-requests { walletAddress }
 *   POST {INTENTS}/funding/signing-requests/{id}/submit        { signedXdr }
 *
 * Contract: rozo-intents-api docs/openapi-funding-v1.1.0.yaml. No API key is
 * sent: these calls run as the keyless app, rate limited per client IP. The
 * MCP caller's IP is forwarded when ROZO_PROXY_SECRET is bound (client-ip.ts).
 *
 * Custody: this server never asks for, receives or holds a Stellar secret key
 * or an EVM key. The caller's own wallet pays the deposit and signs the XDR.
 * Fees are never computed here: they are read from the quote.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { INTENTS_BASE, UpstreamError, type FetchLike } from './api';
import { withClientIp, type ClientForward } from './client-ip';
import { isBlacklisted } from './blacklist';
import { SUPPORT } from './support';
import { CLIENT_LABEL } from './version';

export const FUNDING_BASE = `${INTENTS_BASE}/funding`;
const TIMEOUT_MS = 20_000;
const STELLAR_CHAIN_ID = '1500';
export const STELLAR_PUBLIC_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/** Source chain names accepted by stellar_wallet_quote, mapped to ROZO chain ids. */
export const FUNDING_SOURCE_CHAINS = { base: '8453', ethereum: '1', arbitrum: '42161', polygon: '137' } as const;
type SourceChain = keyof typeof FUNDING_SOURCE_CHAINS;

/**
 * Tokens accepted 1:1 at the deposit address (docs/funding-dev-guide). The
 * quote is always priced in the chain's USDC; USDT is accepted at payment.
 */
export const ACCEPTED_DEPOSIT_TOKENS = [
  { chain: 'Base', chainId: '8453', USDC: '0x833589fCD6eDb6E08f4C7C32D4f71b54bdA02913', USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' },
  { chain: 'Ethereum', chainId: '1', USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  { chain: 'Arbitrum', chainId: '42161', USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' },
  { chain: 'Polygon', chainId: '137', USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
] as const;

const G_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const SECRET_SEED_RE = /S[A-Z2-7]{55}/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ORDER_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Every keyless caller shares one upstream app, and the Funding API enforces
 * uniqueness per app on both order_id and Idempotency-Key. A caller's orderId
 * is only unique to that caller, so it is never sent upstream as is: both
 * upstream identifiers are derived from (quoteId, orderId). The same call
 * retried gives the same identifiers (an idempotent replay); another caller,
 * or another quote, gives different ones. Output fits the upstream charset
 * [A-Za-z0-9_.:-] and length limits (orderId 1-128, Idempotency-Key 8-128).
 */
export async function upstreamOrderIds(quoteId: string, orderId: string): Promise<{ orderId: string; idempotencyKey: string }> {
  const data = new TextEncoder().encode(`rozo-mcp-funding-order:v1\n${quoteId.toLowerCase()}\n${orderId}`);
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { orderId: `mcp.o.${hex}`, idempotencyKey: `mcp.k.${hex}` };
}
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export const FUNDING_FACTS =
  'Fees come from the quote (fees and totals): never assume a fee. ' +
  'The receiving Stellar address signs ONE transaction (only when it is new or has no USDC trustline). ' +
  'The one-time deposit address is the same on Base, Ethereum, Arbitrum and Polygon; USDC or USDT is accepted 1:1. ' +
  'Follow deposit.amountPolicy: exact or missing means pay the EXACT deposit amount; any_amount uses the suggested amount and returned min/max bounds. Pay once, before payBefore. This server never holds keys: your own wallet pays and signs.';

/** ROZO claim custody: the only account the user's side of the signing template pays (the sponsor fee). */
export const CLAIM_CUSTODY_ADDRESS = 'GBLTI2TTQXUAYNKGCQ63YA55KTFEAOQJ3DPBPELNPWCJVE76ADWMXUAE';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

export const SIGNING_CHECKS =
  `Check the operations first, and decode the XDR locally to confirm it matches them exactly. The transaction source must NOT be your address (it is a ROZO channel account, so ROZO pays the network fee). ` +
  `Allowed, nothing else: ROZO-sourced beginSponsoringFutureReserves and createAccount for your address; from your address, changeTrust for USDC (issuer ${USDC_ISSUER}), endSponsoringFutureReserves, ` +
  `claimClaimableBalance, and at most one payment: the sponsor fee in USDC to ROZO claim custody ${CLAIM_CUSTODY_ADDRESS}; and a ROZO-sourced XLM payment to your address. Any other operation type or source (setOptions, extra payments): refuse. ` +
  `Amounts: the claimed USDC (gross) equals the current stable leg minimumAmount (order.legs, after repricing) plus the sponsor fee; ` +
  `the sponsor fee is fixed at quote time (0.0000001 USDC with a paid usdGas tier, the quoted stellar_sponsor_fee with usdGas "0", no fee payment if the address needed no onboarding); ` +
  `the XLM payment equals the native (XLM) leg minimumAmount. ` +
  `The XDR shows only the claimable balance id; its amount is in the operations list and on Horizon /claimable_balances/{id}.`;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code, message }, ...extra }, null, 2) }], isError: true };
}

class FundingInputError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function fromError(err: unknown): ToolResult {
  if (err instanceof FundingInputError) return fail(err.code, err.message);
  if (err instanceof UpstreamError) return fail(err.code, err.message, { httpStatus: err.httpStatus, support: SUPPORT });
  return fail('INTERNAL', 'Unexpected error.');
}

/** Redacts anything credential-shaped from upstream text before it reaches the conversation. */
export function sanitize(v: unknown): string {
  return String(v ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/S[A-Z2-7]{55}/g, 'S<redacted>')
    .replace(/\b(0x)?[0-9a-fA-F]{64}\b/g, '<redacted-hex>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\b(ak|sk|pk|rk)_[A-Za-z0-9_-]{8,}/g, '$1_<redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>');
}

function short(v: unknown, max = 300): string {
  return sanitize(v).slice(0, max);
}

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v ? v.slice(0, max) : typeof v === 'number' ? String(v) : null;
}

/** Rejects anything that looks like a Stellar secret seed, without echoing it. */
function refuseSecret(v: string, field: string): void {
  if (SECRET_SEED_RE.test(v)) {
    throw new FundingInputError(
      'SECRET_KEY_REFUSED',
      `${field} looks like a Stellar SECRET key (S...). Never share it. Pass the public G... address, or the XDR your own wallet signed.`,
    );
  }
}

function gAddress(raw: string, field: string): string {
  const s = raw.trim();
  refuseSecret(s, field);
  if (!G_ADDRESS_RE.test(s)) throw new FundingInputError('BAD_STELLAR_ADDRESS', `${field} must be a Stellar public address (G followed by 55 characters).`);
  return s;
}

function uuid(raw: string, field: string): string {
  const s = raw.trim();
  if (!UUID_RE.test(s)) throw new FundingInputError('BAD_ID', `${field} must be a UUID.`);
  return s.toLowerCase();
}

/** One call to the Funding API. Error bodies are { code, message, retryable, nextAction }. */
export async function fundingRequest(
  fetchFn: FetchLike,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ json: any; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(`${FUNDING_BASE}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': CLIENT_LABEL,
        ...extraHeaders,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err: any) {
    throw new UpstreamError(err?.name === 'AbortError' ? 'HTTP_TIMEOUT' : 'HTTP_UNREACHABLE', `${method} funding request failed`, null);
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
    const code = (typeof json?.code === 'string' && json.code) || (typeof json?.error?.code === 'string' && json.error.code) || `HTTP_${res.status}`;
    const message =
      (typeof json?.message === 'string' && json.message) ||
      (typeof json?.error?.message === 'string' && json.error.message) ||
      (typeof json?.error === 'string' && json.error) ||
      `HTTP ${res.status}`;
    const next = typeof json?.nextAction === 'string' ? ` (nextAction: ${short(json.nextAction, 40)})` : '';
    throw new UpstreamError(short(code, 64), short(message) + next, res.status);
  }
  if (json === null || typeof json !== 'object') throw new UpstreamError('HTTP_BAD_JSON', 'Upstream returned a non-JSON body.', res.status);
  return { json, status: res.status };
}

function feeLines(fees: unknown) {
  return Array.isArray(fees)
    ? fees.slice(0, 20).map((f: any) => ({ kind: str(f?.kind, 64), usd: str(f?.usd, 32), appliesTo: str(f?.appliesTo, 32), refundable: f?.refundable ?? null }))
    : [];
}

function legView(l: any) {
  return {
    legId: str(l?.legId, 64),
    kind: str(l?.kind, 32),
    symbol: str(l?.symbol, 16),
    chainId: str(l?.chainId, 16),
    receiverAddress: str(l?.receiverAddress, 64),
    minimumAmount: str(l?.minimumAmount, 40),
    status: str(l?.status, 32),
    deliveredAmount: str(l?.deliveredAmount, 40),
    txHash: str(l?.txHash, 128),
  };
}

function actions(list: unknown) {
  return Array.isArray(list) ? list.slice(0, 10).map((a: any) => ({ kind: str(a?.kind, 64), legIds: Array.isArray(a?.legIds) ? a.legIds.slice(0, 5).map((x: unknown) => str(x, 64)) : [], dueBy: str(a?.dueBy, 40) })) : [];
}

function totals(t: any) {
  if (!t || typeof t !== 'object') return null;
  const out: Record<string, string | null> = {};
  for (const k of ['sourceValueUsd', 'nativeBudgetsUsd', 'stableDeliveryUsd', 'sharedFeesUsd', 'totalFeesUsd', 'roundingRemainderUsd']) out[k] = str(t[k], 32);
  return out;
}

function amountPolicyView(d: any) {
  const decimal = (v: unknown): string | null => typeof v === 'string' && v.length <= 40 && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? v : null;
  return {
    amountPolicy: d?.amountPolicy === 'any_amount' ? 'any_amount' : 'exact',
    minAcceptedAmount: decimal(d?.minAcceptedAmount),
    maxPricedAmount: decimal(d?.maxPricedAmount),
  };
}

function paymentInstruction(d: ReturnType<typeof depositView>): string {
  if (d?.amountPolicy === 'any_amount' && d.minAcceptedAmount && d.maxPricedAmount) {
    return `Suggested amount: ${d.amount}. Send once before ${d.payBefore ?? 'payBefore'}. Payments from ${d.minAcceptedAmount} are priced on the amount received up to ${d.maxPricedAmount}; the XLM tier stays the same and USDC adjusts after frozen fees. Below the minimum needs manual handling; excess above the maximum needs manual handling. Some amounts may require recovery if output constraints cannot be met. Do not pay twice.`;
  }
  if (d?.amountPolicy === 'any_amount') return 'The payment range is incomplete. Do not pay; poll the order or contact ROZO for the current payment instructions.';
  return `Send EXACTLY ${d?.amount ?? 'deposit.amount'} once, before ${d?.payBefore ?? 'payBefore'}. Do not pay twice.`;
}

function repricingView(r: any) {
  if (!r || typeof r !== 'object') return null;
  const out: Record<string, string | null> = {};
  for (const k of ['quotedAmount', 'receivedAmount', 'pricedAmount', 'excessAmount', 'quotedPlanDigest']) out[k] = str(r[k], k === 'quotedPlanDigest' ? 64 : 40);
  return out;
}

function depositView(d: any) {
  if (!d || typeof d !== 'object') return null;
  return {
    ...amountPolicyView(d),
    address: str(d.address, 128),
    amount: str(d.amount, 40),
    symbol: str(d.symbol, 16),
    chainId: str(d.chainId, 16),
    assetId: str(d.assetId, 128),
    memo: str(d.memo, 128),
    payBefore: str(d.payBefore, 40),
  };
}

function orderGuidance(status: string | null, pending: ReturnType<typeof actions>, deposit?: ReturnType<typeof depositView>): string {
  if (pending.some((a) => a.kind === 'sign_stellar_onboarding')) {
    return 'Signature needed: call stellar_wallet_get_signing_request with fundingId and the receiving G address, sign the XDR with that wallet (do not modify it), then stellar_wallet_submit_signed.';
  }
  switch (status) {
    case 'awaiting_payment':
      return `Awaiting the deposit. If you have not paid, ${paymentInstruction(deposit ?? null)} Poll again in about 15 seconds.`;
    case 'source_confirming':
    case 'funds_confirmed':
    case 'executing':
      return 'Payment detected and being processed. Do NOT pay again. Poll again in about 15 seconds.';
    case 'completed':
      return 'Done: every leg is confirmed on chain.';
    case 'expired_unpaid':
    case 'cancelled_unpaid':
      return 'Closed unpaid. Nothing was lost; quote again for a new order.';
    case 'recovery_required':
      return `The order needs manual handling by ROZO. Do not pay again. Contact ${SUPPORT.email} with the fundingId.`;
    default:
      return 'Poll again in about 15 seconds.';
  }
}

export function registerFundingTools(server: McpServer, opts: { fetchFn: FetchLike; now?: () => number; forward?: ClientForward }): void {
  const f = withClientIp(opts.fetchFn, opts.forward ?? null);
  const now = opts.now ?? (() => Date.now());

  server.registerTool(
    'funding_capabilities',
    {
      title: 'Stellar wallet funding capabilities',
      description:
        'What the keyless ROZO Funding API supports right now: whether stellar_onboarding is on, the source chains and USDC assets, the Stellar USDC output, the usdGas options (XLM amounts) and per-order limits. Read-only, creates nothing. ' +
        FUNDING_FACTS,
      inputSchema: {},
      annotations: { title: 'Stellar wallet funding capabilities', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const { json: c } = await fundingRequest(f, 'GET', '/capabilities');
        const mode = Array.isArray(c.modes) ? c.modes.find((m: any) => m?.mode === 'stellar_onboarding') : null;
        return ok({
          enabled: c.enabled === true,
          stellarOnboarding: mode ? { status: str(mode.status, 32), reason: str(mode.reason, 64) } : { status: 'disabled', reason: 'not_listed' },
          sourceAssets: Array.isArray(c.sourceAssets)
            ? c.sourceAssets.map((a: any) => ({ chainId: str(a?.chainId, 16), symbol: str(a?.symbol, 16), assetId: str(a?.assetId, 128), minAmount: str(a?.minAmount, 32), maxAmount: str(a?.maxAmount, 32), status: str(a?.status, 32) }))
            : [],
          stellarUsdc: Array.isArray(c.stableOutputs) ? (c.stableOutputs.find((s: any) => String(s?.chainId) === STELLAR_CHAIN_ID) ?? null) : null,
          gasOptions: c.gasOptions?.[STELLAR_CHAIN_ID] ?? null,
          limits: c.limits ?? null,
          acceptedDepositTokens: ACCEPTED_DEPOSIT_TOKENS,
          validUntil: str(c.validUntil, 40),
          notes: FUNDING_FACTS,
        });
      } catch (err) {
        return fromError(err);
      }
    },
  );

  server.registerTool(
    'stellar_wallet_quote',
    {
      title: 'Quote: fund a Stellar wallet',
      description:
        'Price sending USDC/USDT from Base, Ethereum, Arbitrum or Polygon to USDC on a Stellar address. If the address is new or has no USDC trustline, the same plan opens the account, adds the trustline and (with usdGas) gives XLM, in one transaction the address signs once. ' +
        'Returns quoteId and planDigest (needed by stellar_wallet_create_order), the USDC and XLM amounts the receiver gets, every fee line and totals, and whether a signature will be needed. Valid about 10 minutes. Read-only: no deposit address, nothing reserved. ' +
        'usdGas: "0" no XLM, "0.5" or "1" buys XLM (see funding_capabilities for amounts); omitted = the server default. ' +
        FUNDING_FACTS,
      inputSchema: {
        receiverAddress: z.string().max(80).describe('Stellar PUBLIC address (G...) that receives the USDC. Never a secret key.'),
        sourceChain: z.enum(['base', 'ethereum', 'arbitrum', 'polygon']).describe('Chain you will pay from.'),
        amountUsd: z.string().max(16).describe('Amount you will send, as a decimal string in USD, e.g. "10" or "10.50". Limits come from funding_capabilities (1 to 1000 today).'),
        usdGas: z.enum(['0', '0.5', '1']).optional().describe('USD of XLM for fees. Omit to use the server default.'),
      },
      annotations: { title: 'Quote: fund a Stellar wallet', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ receiverAddress, sourceChain, amountUsd, usdGas }) => {
      try {
        const addr = gAddress(receiverAddress, 'receiverAddress');
        if (isBlacklisted(addr)) return fail('BLACKLIST_HIT', 'receiverAddress matches a known compromised address. Do not fund it.');
        const amount = amountUsd.trim();
        if (!/^\d{1,7}(\.\d{1,6})?$/.test(amount) || !(Number(amount) > 0)) {
          return fail('BAD_AMOUNT', 'amountUsd must be a positive decimal string such as "10" or "10.50".');
        }
        const chainId = FUNDING_SOURCE_CHAINS[sourceChain as SourceChain];

        // Asset ids come from capabilities, never hardcoded.
        const { json: caps } = await fundingRequest(f, 'GET', '/capabilities');
        const mode = Array.isArray(caps.modes) ? caps.modes.find((m: any) => m?.mode === 'stellar_onboarding') : null;
        if (caps.enabled !== true || mode?.status !== 'supported') {
          return fail('FUNDING_UNAVAILABLE', `Stellar wallet funding is not available right now (${short(mode?.reason ?? 'disabled', 64)}).`);
        }
        const src = Array.isArray(caps.sourceAssets)
          ? caps.sourceAssets.find((a: any) => String(a?.chainId) === chainId && String(a?.symbol).toUpperCase() === 'USDC' && a?.status === 'supported')
          : null;
        if (!src?.assetId) return fail('UNSUPPORTED_SOURCE', `${sourceChain} is not an available source right now. Check funding_capabilities.`);
        const out = Array.isArray(caps.stableOutputs)
          ? caps.stableOutputs.find((s: any) => String(s?.chainId) === STELLAR_CHAIN_ID && String(s?.symbol).toUpperCase() === 'USDC' && s?.status === 'supported')
          : null;
        if (!out?.assetId) return fail('UNSUPPORTED_TARGET', 'Stellar USDC output is not available right now.');

        const { json: q } = await fundingRequest(f, 'POST', '/quotes', {
          mode: 'stellar_onboarding',
          reserveMode: 'sponsored',
          source: { chainId, assetId: src.assetId, amount },
          outputs: [{ id: 'stable', kind: 'stable', chainId: STELLAR_CHAIN_ID, assetId: out.assetId, receiverAddress: addr, allocation: 'remainder' }],
          ...(usdGas !== undefined ? { usdGas } : {}),
        });
        const legs = Array.isArray(q.legs) ? q.legs.map(legView) : [];
        const userActions = actions(q.userActions);
        const stable = legs.find((l: any) => l.kind === 'stable');
        const native = legs.find((l: any) => l.kind === 'native');
        return ok({
          quoteId: str(q.quoteId, 64),
          planDigest: str(q.planDigest, 64),
          expiresAt: str(q.expiresAt, 40),
          sourceChain,
          source: { ...amountPolicyView(q.source), chainId, amount: str(q.source?.amount, 32), symbol: str(q.source?.symbol, 16), valuationUsd: str(q.source?.valuationUsd, 32) },
          receiverAddress: addr,
          receives: {
            usdcMinimum: stable?.minimumAmount ?? null,
            xlm: str(q.gasAmount, 32) ?? native?.minimumAmount ?? '0',
          },
          usdGas: str(q.usdGas, 8),
          gasDefaulted: q.gasDefaulted ?? null,
          fees: feeLines(q.fees),
          totals: totals(q.totals),
          legs,
          signatureNeeded: userActions.some((a) => a.kind === 'sign_stellar_onboarding'),
          userActions,
          next: 'Show the plan to the user. If approved, call stellar_wallet_create_order with quoteId, planDigest and your own orderId before expiresAt.',
          notes: FUNDING_FACTS,
        });
      } catch (err) {
        return fromError(err);
      }
    },
  );

  server.registerTool(
    'stellar_wallet_create_order',
    {
      title: 'Create a Stellar wallet funding order',
      description:
        'Turn an approved quote into a payable order. Returns fundingId (keep it private: it is the only handle to the order), the one-time deposit address, the suggested amount and amountPolicy with minAcceptedAmount/maxPricedAmount when any_amount, payBefore and the accepted chains and tokens. ' +
        'orderId is your own reference: the server derives the upstream order id and Idempotency-Key from quoteId plus orderId, so it only has to be unique among your own orders. Retrying with the same quoteId and orderId returns the same order instead of a second one. Creates an order but moves no funds; an unpaid order expires at no cost. ' +
        FUNDING_FACTS,
      inputSchema: {
        quoteId: z.string().max(64).describe('quoteId from stellar_wallet_quote.'),
        planDigest: z.string().max(64).describe('planDigest from the same quote.'),
        orderId: z.string().max(128).describe('Your own order reference, 8 to 128 chars of A-Z a-z 0-9 _ . : -, unique among your orders (for example agent-order-0001). Reuse it with the same quoteId to retry safely.'),
      },
      annotations: { title: 'Create a Stellar wallet funding order', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ quoteId, planDigest, orderId }) => {
      try {
        const qid = uuid(quoteId, 'quoteId');
        const digest = planDigest.trim().toLowerCase();
        if (!DIGEST_RE.test(digest)) return fail('BAD_PLAN_DIGEST', 'planDigest must be the 64-character hex value from the quote.');
        const oid = orderId.trim();
        refuseSecret(oid, 'orderId');
        if (/(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)/.test(oid)) {
          return fail('SECRET_KEY_REFUSED', 'orderId looks like a private key (64 hex characters). Never share keys; use a plain reference such as agent-order-0001.');
        }
        if (!ORDER_ID_RE.test(oid)) return fail('BAD_ORDER_ID', 'orderId must be 8 to 128 characters of A-Z a-z 0-9 _ . : -');
        const up = await upstreamOrderIds(qid, oid);
        const { json: o, status } = await fundingRequest(f, 'POST', '/orders', { quoteId: qid, planDigest: digest, orderId: up.orderId }, { 'idempotency-key': up.idempotencyKey });
        const deposit = depositView(o.deposit);
        const base = { fundingId: str(o.fundingId, 64), orderId: oid, upstreamOrderId: up.orderId, replayed: status === 200, support: SUPPORT };
        if (!deposit?.address || !deposit.amount || !(Number(deposit.amount) > 0)) return fail('DEPOSIT_INCOMPLETE', 'The order carries no deposit address or amount. Do not pay.', base);
        if (deposit.amountPolicy === 'any_amount' && (!deposit.minAcceptedAmount || !deposit.maxPricedAmount)) return fail('DEPOSIT_INCOMPLETE', 'The actual-amount payment range is missing or invalid. Do not pay; poll the order or contact ROZO.', base);
        if (isBlacklisted(deposit.address)) return fail('BLACKLIST_HIT', 'The deposit address matches a known compromised address. Do NOT send anything.', base);
        const orderStatus = str(o.status, 32);
        const payBeforeMs = deposit.payBefore ? Date.parse(deposit.payBefore) : NaN;
        if (orderStatus !== 'awaiting_payment' || !Number.isFinite(payBeforeMs) || payBeforeMs <= now()) {
          // An idempotent replay of an order that is already paid, processing, closed or past payBefore.
          return fail('ORDER_NOT_PAYABLE', `This order is "${orderStatus ?? 'unknown'}"${Number.isFinite(payBeforeMs) && payBeforeMs <= now() ? ' and past payBefore' : ''}. Do NOT send a deposit. Poll stellar_wallet_order_status; for a new funding, quote again with a new orderId.`, {
            ...base,
            status: orderStatus,
            guidance: orderGuidance(orderStatus, actions(o.pendingActions), deposit),
          });
        }
        return ok({
          ...base,
          status: orderStatus,
          deposit: {
            ...amountPolicyView(deposit),
            address: deposit.address,
            amount: deposit.amount,
            payBefore: deposit.payBefore,
            quotedAsset: { chainId: deposit.chainId, symbol: deposit.symbol, assetId: deposit.assetId },
            memo: deposit.memo,
            acceptedChains: ACCEPTED_DEPOSIT_TOKENS.map((t) => t.chain),
            acceptedTokens: ACCEPTED_DEPOSIT_TOKENS,
          },
          legs: Array.isArray(o.legs) ? o.legs.map(legView) : [],
          fees: feeLines(o.fees),
          totals: totals(o.totals),
          pendingActions: actions(o.pendingActions),
          instructions: [
            `${paymentInstruction(deposit)} Use USDC or USDT (1:1) to ${deposit.address} from your own wallet on ONE of Base, Ethereum, Arbitrum or Polygon.`,
            'Other chains or tokens, late payments and second payments need manual handling. Follow the returned amountPolicy and bounds.',
            'Save fundingId and orderId before paying. After a crash, poll stellar_wallet_order_status; never create a new order for the same intent.',
            'Then poll stellar_wallet_order_status. If it asks for a signature, use stellar_wallet_get_signing_request.',
          ],
        });
      } catch (err) {
        return fromError(err);
      }
    },
  );

  server.registerTool(
    'stellar_wallet_order_status',
    {
      title: 'Stellar wallet funding order status',
      description:
        'Read a funding order by fundingId: status, pendingActions (sign_stellar_onboarding means the receiver must sign), the deposit, and each leg (USDC, XLM) with its own status, delivered amount and tx hash. Read-only. Poll about every 15 seconds; completed only when every leg is confirmed.',
      inputSchema: { fundingId: z.string().max(64).describe('fundingId from stellar_wallet_create_order.') },
      annotations: { title: 'Stellar wallet funding order status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ fundingId }) => {
      try {
        const id = uuid(fundingId, 'fundingId');
        const { json: o } = await fundingRequest(f, 'GET', `/orders/${id}`);
        const status = str(o.status, 32);
        const pendingActions = actions(o.pendingActions);
        const dep = depositView(o.deposit);
        const payBeforeMs = dep?.payBefore ? Date.parse(dep.payBefore) : NaN;
        const windowClosed = status === 'awaiting_payment' && (!Number.isFinite(payBeforeMs) || payBeforeMs <= now());
        return ok({
          fundingId: id,
          upstreamOrderId: str(o.orderId, 128),
          status,
          stateVersion: o.stateVersion ?? null,
          pendingActions,
          signatureNeeded: pendingActions.some((a) => a.kind === 'sign_stellar_onboarding'),
          deposit: dep,
          paymentWindowClosed: windowClosed,
          source: o.source && typeof o.source === 'object'
            ? { status: str(o.source.status, 32), receivedAmount: str(o.source.receivedAmount ?? o.source.amountReceived, 40), txHash: str(o.source.txHash, 128), chainId: str(o.source.chainId, 16), symbol: str(o.source.symbol, 16) }
            : null,
          legs: Array.isArray(o.legs) ? o.legs.map(legView) : [],
          repricing: repricingView(o.repricing),
          recovery: o.recovery ?? null,
          updatedAt: str(o.updatedAt, 40),
          guidance: windowClosed
            ? 'The payment window (payBefore) has closed. Do NOT send a deposit now: a late payment is not delivered automatically. If you already sent one, keep polling; otherwise quote again with a new orderId.'
            : orderGuidance(status, pendingActions, dep),
          support: SUPPORT,
        });
      } catch (err) {
        return fromError(err);
      }
    },
  );

  server.registerTool(
    'stellar_wallet_get_signing_request',
    {
      title: 'Get the Stellar transaction to sign',
      description:
        'When an order shows sign_stellar_onboarding, build the one transaction the receiving address must sign (creates the account if needed, adds the USDC trustline, claims the USDC, delivers XLM). ' +
        'Returns signingRequestId, the unsigned XDR, networkPassphrase, a readable operations list and expiresAt (at most 5 minutes). ' +
        'Sign it with the receiver wallet YOU control (Stellar SDK, Freighter, any wallet); do not modify it. ' +
        SIGNING_CHECKS + ' ' +
        'Expired, or submit failed: just call this tool again; it supersedes the old request and returns a fresh XDR (only refused while a signed one is still submitting). This server never sees your key. Then call stellar_wallet_submit_signed.',
      inputSchema: {
        fundingId: z.string().max(64).describe('fundingId of the order.'),
        walletAddress: z.string().max(80).describe('The order\'s receiving Stellar PUBLIC address (G...).'),
      },
      annotations: { title: 'Get the Stellar transaction to sign', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ fundingId, walletAddress }) => {
      try {
        const id = uuid(fundingId, 'fundingId');
        const addr = gAddress(walletAddress, 'walletAddress');
        const { json: r } = await fundingRequest(f, 'POST', `/orders/${id}/signing-requests`, { walletAddress: addr });
        const passphrase = str(r.networkPassphrase, 120);
        if (passphrase !== STELLAR_PUBLIC_PASSPHRASE) {
          return fail('UNEXPECTED_NETWORK', 'The signing request is not for Stellar mainnet (Public network). Do not sign it.', { support: SUPPORT });
        }
        if (str(r.fundingId, 64)?.toLowerCase() !== id) return fail('UNEXPECTED_ORDER', 'The signing request belongs to a different order. Do not sign it.');
        return ok({
          signingRequestId: str(r.signingRequestId, 64),
          fundingId: id,
          status: str(r.status, 32),
          walletAddress: addr,
          networkPassphrase: passphrase,
          xdr: str(r.xdr, 20000),
          txHash: str(r.txHash, 64),
          expiresAt: str(r.expiresAt, 40),
          accountState: str(r.accountState, 32),
          templateVersion: str(r.templateVersion, 64),
          operations: Array.isArray(r.operations) ? r.operations.slice(0, 30) : [],
          instructions: [
            SIGNING_CHECKS + ' Refuse anything else.',
            'Sign the XDR unchanged with the walletAddress key, on the Public network, before expiresAt. If it expired, call stellar_wallet_get_signing_request again for a fresh one.',
            'Then call stellar_wallet_submit_signed with signingRequestId and the signed XDR (base64). Never paste a secret key anywhere.',
          ],
        });
      } catch (err) {
        return fromError(err);
      }
    },
  );

  server.registerTool(
    'stellar_wallet_submit_signed',
    {
      title: 'Submit the signed Stellar transaction',
      description:
        'Submit the XDR your own wallet signed for a signing request. This is the claim: the account, trustline, USDC and XLM land in that one transaction. Submitting the same signed XDR again is safe (idempotent). ' +
        'Accepts only the signed transaction envelope, never a secret key. "submitted" is not delivery: poll stellar_wallet_order_status until completed. ' +
        'If it answers template_expired or failed, call stellar_wallet_get_signing_request again and sign the new XDR.',
      inputSchema: {
        signingRequestId: z.string().max(64).describe('signingRequestId from stellar_wallet_get_signing_request.'),
        signedXdr: z.string().max(20000).describe('Signed transaction envelope, base64, as returned by your wallet. NOT a secret key.'),
      },
      annotations: { title: 'Submit the signed Stellar transaction', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ signingRequestId, signedXdr }) => {
      try {
        const id = uuid(signingRequestId, 'signingRequestId');
        const xdr = signedXdr.trim();
        refuseSecret(xdr, 'signedXdr');
        if (xdr.length < 100 || !BASE64_RE.test(xdr)) return fail('BAD_SIGNED_XDR', 'signedXdr must be the base64 transaction envelope your wallet returned.');
        const { json: r, status } = await fundingRequest(f, 'POST', `/signing-requests/${id}/submit`, { signedXdr: xdr });
        const st = str(r.status, 32);
        return ok({
          signingRequestId: id,
          fundingId: str(r.fundingId, 64),
          status: st,
          confirmed: status === 200 || st === 'confirmed',
          txHash: str(r.submittedTxHash, 128) ?? str(r.txHash, 64),
          lastError: r.lastError == null ? null : short(r.lastError, 300),
          guidance:
            st === 'failed'
              ? 'The submit failed. Get a new signing request and sign again.'
              : 'Submitted. Do not re-sign while it is submitting. Poll stellar_wallet_order_status until the order is completed.',
          support: SUPPORT,
        });
      } catch (err) {
        return fromError(err);
      }
    },
  );
}
