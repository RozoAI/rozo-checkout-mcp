/**
 * x402 payer tools: x402_topup and x402_sign.
 *
 * Contract (rozo-mpprouter /v1/x402/*, same as the @rozoai/checkout CLI):
 *
 *   POST /v1/x402/keys    {}                                       -> { key }  (returned once)
 *   POST /v1/x402/topup   { amount, token, chain }                 -> one-time deposit order
 *   POST /v1/x402/sign    { accepts, budget, idempotencyKey, ... } -> { paymentSignature } (PAYMENT-SIGNATURE value)
 *   Authorization: Bearer <agent key ak_...>
 *   503 = the payer switch is off ("x402 payer not enabled yet").
 *
 * This server stores nothing. The agent key comes from the MCP connection's
 * Authorization header, or the tool's agentKey argument, and is forwarded to
 * Rozo only. It is never echoed back except once, when x402_topup creates it.
 *
 * Payment leg: USDC on Base (eip155:8453) and USDC on Solana mainnet, x402
 * scheme "exact". Native coins and USDT are topup-only.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UpstreamError, type FetchLike } from './api';
import { isBlacklisted } from './blacklist';
import { SUPPORT } from './support';
import { CLIENT_LABEL } from './version';

export const X402_BASE = 'https://apiserver.mpprouter.dev/v1/x402';
const TIMEOUT_MS = 20_000;

export const NETWORK_BASE = 'eip155:8453';
export const NETWORK_SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const USDC_ASSET: Record<string, string> = {
  [NETWORK_BASE]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [NETWORK_SOLANA]: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};
const V1_ALIASES: Record<string, string> = { base: NETWORK_BASE, solana: NETWORK_SOLANA };

/** Topup coins: the checkout stablecoin set plus the native-coin beta set. */
export const TOPUP_SOURCES = [
  { chain: '1', name: 'Ethereum', tokens: ['USDC', 'USDT', 'ETH'] },
  { chain: '56', name: 'BNB Chain', tokens: ['USDC', 'USDT', 'BNB'] },
  { chain: '137', name: 'Polygon', tokens: ['USDC', 'USDT'] },
  { chain: '900', name: 'Solana', tokens: ['USDC', 'USDT', 'SOL'] },
  { chain: '8453', name: 'Base', tokens: ['USDC', 'ETH'] },
  { chain: '42161', name: 'Arbitrum', tokens: ['ETH'] },
  { chain: '1500', name: 'Stellar', tokens: ['USDC'] },
  { chain: 'lightning', name: 'Bitcoin Lightning', tokens: ['BTC'] },
] as const;
const TOPUP_CHAINS = TOPUP_SOURCES.map((s) => s.chain) as unknown as [string, ...string[]];
export const TOPUP_MIN_USD = 5;

const DISABLED = 'x402 payer not enabled yet. Rozo has not switched on x402 payments; nothing was charged. Try again later.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^ak_[A-Za-z0-9_-]{8,200}$/;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code, message }, ...extra }, null, 2) }], isError: true };
}

function short(v: unknown, max = 300): string {
  return String(v ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\bak_[A-Za-z0-9_-]{8,}/g, 'ak_<redacted>')
    .slice(0, max);
}

function maskKey(key: string): string {
  return key.length <= 10 ? '<redacted>' : `${key.slice(0, 3)}...${key.slice(-4)}`;
}

/** One call to Rozo's x402 API. A 503 becomes X402_PAYER_DISABLED. */
export async function x402Request(fetchFn: FetchLike, method: 'GET' | 'POST', path: string, key: string | null, body?: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(`${X402_BASE}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': CLIENT_LABEL,
        'x-rozo-client': CLIENT_LABEL,
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err: any) {
    throw new UpstreamError(err?.name === 'AbortError' ? 'HTTP_TIMEOUT' : 'HTTP_UNREACHABLE', `${method} ${path} failed`, null);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 503) throw new UpstreamError('X402_PAYER_DISABLED', DISABLED, 503);
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
      (typeof json?.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(json.error) && json.error) ||
      `HTTP_${res.status}`;
    const message =
      (typeof json?.message === 'string' && json.message) ||
      (typeof json?.error === 'string' && json.error) ||
      (typeof json?.error?.message === 'string' && json.error.message) ||
      `HTTP ${res.status}`;
    throw new UpstreamError(short(code, 64), short(message), res.status);
  }
  if (json === null || typeof json !== 'object') throw new UpstreamError('HTTP_BAD_JSON', 'Upstream returned a non-JSON body.', res.status);
  return json;
}

function pick(obj: any, ...paths: string[]): any {
  for (const p of paths) {
    const v = p.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/** Classify one accepts entry; returns a reason string when this payer cannot sign it. */
export function unsupportedReason(req: any): string | null {
  const reason = rawUnsupportedReason(req);
  // Reasons quote caller-supplied fields; never let one echo a key or control characters.
  return reason === null ? null : short(reason, 160);
}

function rawUnsupportedReason(req: any): string | null {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return 'not an object';
  if (req.scheme !== 'exact') return `scheme ${String(req.scheme)} (only exact)`;
  const network = V1_ALIASES[req.network] ?? req.network;
  const usdc = USDC_ASSET[network];
  if (!usdc) return `network ${String(req.network)} (only Base USDC and Solana USDC)`;
  const assetOk = network === NETWORK_BASE ? String(req.asset ?? '').toLowerCase() === usdc.toLowerCase() : String(req.asset ?? '') === usdc;
  if (!assetOk) return `asset ${String(req.asset)} is not USDC`;
  const amount = String(req.amount ?? req.maxAmountRequired ?? '');
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) return 'missing or invalid amount';
  const payTo = typeof req.payTo === 'string' ? req.payTo.trim() : '';
  const payToOk = network === NETWORK_BASE ? /^0x[0-9a-fA-F]{40}$/.test(payTo) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo);
  if (!payToOk) return 'payTo is not a valid address for that network';
  return null;
}

export interface X402Context {
  fetchFn: FetchLike;
  /** Agent key from the MCP connection's Authorization header, if any. */
  connectionKey: string | null;
}

/** Bearer ak_... from an incoming request, or null. */
export function agentKeyFromRequest(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(ak_[A-Za-z0-9_-]{8,200})\s*$/i.exec(h);
  return m?.[1] ?? null;
}

function resolveKey(ctx: X402Context, arg: string | undefined): { key: string | null; bad: boolean } {
  if (arg !== undefined && arg !== '') {
    return KEY_RE.test(arg) ? { key: arg, bad: false } : { key: null, bad: true };
  }
  return { key: ctx.connectionKey, bad: false };
}

function fromError(err: unknown): ToolResult {
  if (err instanceof UpstreamError) return fail(err.code, err.message, { httpStatus: err.httpStatus });
  return fail('INTERNAL', 'Unexpected error.');
}

const PAY_LEG = 'The x402 payment leg is USDC on Base (eip155:8453) or USDC on Solana mainnet only, scheme "exact". Native coins and USDT can fund the balance (x402_topup) but never pay a seller directly.';

const agentKeySchema = z
  .string()
  .max(220)
  .optional()
  .describe('Agent key (ak_...). Prefer setting it once as "Authorization: Bearer ak_..." on the MCP connection; this argument overrides that. Never share it.');

export function registerX402Tools(server: McpServer, ctx: X402Context): void {
  server.registerTool(
    'x402_topup',
    {
      title: 'Top up the x402 balance',
      description:
        'Fund a prepaid Rozo x402 balance with the coin you hold, through a one-time deposit address you pay from your own wallet. ' +
        'Same fields as POST /v1/x402/topup: amount (USD), token, chain. Topup coins: USDC/USDT on Ethereum, BNB Chain, Polygon, Solana; USDC on Base, Stellar; BTC on Lightning; ' +
        'native ETH (Ethereum, Base, Arbitrum), BNB and SOL in beta. ' +
        PAY_LEG +
        ' Without an agent key, one is created and returned ONCE in this result: store it, it owns the balance. Minimum $5.',
      inputSchema: {
        amount: z.string().max(16).describe('USD amount to credit, e.g. "20". Minimum 5.'),
        token: z.string().min(2).max(8).describe('Coin you will send: USDC, USDT, BTC, ETH, BNB or SOL.'),
        chain: z.enum(TOPUP_CHAINS).describe('Chain id: "1" Ethereum, "56" BNB Chain, "137" Polygon, "900" Solana, "8453" Base, "42161" Arbitrum, "1500" Stellar, "lightning".'),
        agentKey: agentKeySchema,
      },
      annotations: { title: 'Top up the x402 balance', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ amount, token, chain, agentKey }) => {
      try {
        const amt = amount.trim();
        if (!/^\d+(\.\d{1,2})?$/.test(amt)) return fail('BAD_VALUE', 'amount must be a USD amount like "20" or "20.50".');
        if (Number(amt) < TOPUP_MIN_USD) return fail('BAD_VALUE', `Minimum topup is $${TOPUP_MIN_USD}.`);
        const tok = token.trim().toUpperCase();
        const row = TOPUP_SOURCES.find((s) => s.chain === chain);
        if (!row || !(row.tokens as readonly string[]).includes(tok)) {
          return fail('UNSUPPORTED_SOURCE', `${tok} on ${row?.name ?? chain} is not a topup coin.`, { topupSources: TOPUP_SOURCES });
        }
        const resolved = resolveKey(ctx, agentKey);
        if (resolved.bad) return fail('BAD_KEY', 'agentKey must look like ak_...');
        let key = resolved.key;
        let createdKey: string | null = null;
        if (!key) {
          const k = await x402Request(ctx.fetchFn, 'POST', '/keys', null, {});
          const newKey = pick(k, 'key', 'agentKey', 'apiKey');
          if (typeof newKey !== 'string' || !KEY_RE.test(newKey)) return fail('X402_BAD_KEY', 'Rozo did not return an agent key.');
          key = newKey;
          createdKey = newKey;
        }
        const resp = await x402Request(ctx.fetchFn, 'POST', '/topup', key, { amount: amt, token: tok, chain });
        const address = pick(resp, 'depositAddress', 'receiverAddress', 'address', 'deposit.address');
        const lnInvoice = pick(resp, 'lnInvoice', 'invoice', 'deposit.lnInvoice');
        if (!address && !lnInvoice) return fail('X402_BAD_TOPUP', 'Rozo returned a topup order without a deposit address.');
        if (address && isBlacklisted(address)) {
          return fail('BLACKLIST_HIT', 'The deposit address matches a known compromised address. Do NOT send anything.');
        }
        const memo = pick(resp, 'memo', 'receiverMemo', 'deposit.memo');
        return ok({
          ...(createdKey
            ? {
                agentKey: createdKey,
                agentKeyNotice: 'New agent key, shown only this once. Store it securely (it owns your x402 balance) and pass it as "Authorization: Bearer <key>" on the MCP connection from now on.',
              }
            : { agentKeyMasked: maskKey(key) }),
          orderId: pick(resp, 'orderId', 'rozoPaymentId', 'paymentId', 'id'),
          deposit: {
            chain: pick(resp, 'chain', 'chainId', 'deposit.chain') ?? chain,
            token: pick(resp, 'token', 'tokenSymbol', 'deposit.token') ?? tok,
            amount: pick(resp, 'payAmount', 'amountToSend', 'deposit.amount', 'amount'),
            address,
            memo,
            lnInvoice,
          },
          creditUsd: pick(resp, 'creditUsd', 'credit', 'amountUsd') ?? amt,
          expiresAt: pick(resp, 'expiresAt', 'deposit.expiresAt'),
          instructions: [
            'Send exactly deposit.amount of deposit.token on deposit.chain to deposit.address (or pay deposit.lnInvoice), once, from your own wallet.',
            memo ? 'Include the memo exactly as given.' : 'No memo is used for this deposit.',
            'The balance is credited after the deposit confirms. Then pay x402 endpoints with x402_sign.',
          ],
          support: SUPPORT,
        });
      } catch (err) {
        return fromError(err);
      }
    },
  );

  server.registerTool(
    'x402_sign',
    {
      title: 'Sign an x402 payment',
      description:
        'Pay an x402 endpoint from the prepaid Rozo balance. You make the HTTP request yourself; when it answers 402, pass the payment requirement you chose from its "accepts" list here. ' +
        'Returns the value to send in the PAYMENT-SIGNATURE header (x402 v1: X-PAYMENT); replay the same request with it. ' +
        'Same fields as POST /v1/x402/sign: accepts, budget, idempotencyKey. ' +
        PAY_LEG +
        ' Generate one idempotencyKey (UUID) per payment and reuse it on every retry: the same key returns the same signature instead of charging twice. ' +
        'Never send Rozo your request body, headers or the seller API keys; only the accepts entry. A 503 means the x402 payer is not enabled yet.',
      inputSchema: {
        accepts: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .max(8)
          .describe('Payment requirement(s) copied verbatim from the 402 challenge "accepts" list. Pass the one you chose.'),
        budget: z.string().max(16).describe('Most this one payment may cost, in USD, e.g. "0.50". Rozo refuses to sign above it.'),
        idempotencyKey: z.string().max(64).describe('UUID you generate once per payment and reuse on retries.'),
        x402Version: z.number().int().min(1).max(9).optional().describe('x402Version from the challenge (2 if it came in the PAYMENT-REQUIRED header).'),
        resource: z.record(z.string(), z.unknown()).optional().describe('The "resource" object from the challenge, if present.'),
        agentKey: agentKeySchema,
      },
      annotations: { title: 'Sign an x402 payment', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ accepts, budget, idempotencyKey, x402Version, resource, agentKey }) => {
      try {
        if (!UUID_RE.test(idempotencyKey)) return fail('BAD_VALUE', 'idempotencyKey must be a UUID. Generate one per payment and reuse it on retries.');
        if (!/^\d+(\.\d{1,6})?$/.test(budget.trim())) return fail('BAD_VALUE', 'budget must be a USD amount like "0.50".');
        const reasons = accepts.map(unsupportedReason);
        const bad = reasons.find((r) => r !== null);
        if (bad) {
          return fail('X402_UNSUPPORTED', `Rozo cannot sign this requirement: ${bad}. ${PAY_LEG}`, { offered: reasons });
        }
        for (const req of accepts) {
          if (isBlacklisted((req as any).payTo)) return fail('BLACKLIST_HIT', 'payTo matches a known compromised address. Refusing to pay.');
        }
        const resolved = resolveKey(ctx, agentKey);
        if (resolved.bad) return fail('BAD_KEY', 'agentKey must look like ak_...');
        if (!resolved.key) {
          return fail('X402_NO_KEY', 'No agent key. Call x402_topup first (it creates one), then send it as "Authorization: Bearer ak_..." or the agentKey argument.');
        }
        const body = {
          ...(x402Version !== undefined ? { x402Version } : {}),
          ...(resource !== undefined ? { resource } : {}),
          accepts,
          budget: budget.trim(),
          idempotencyKey,
        };
        const resp = await x402Request(ctx.fetchFn, 'POST', '/sign', resolved.key, body);
        const signature =
          pick(resp, 'paymentSignature', 'PAYMENT-SIGNATURE', 'signature', 'headerValue', 'header.value') ??
          (resp?.paymentPayload && typeof resp.paymentPayload === 'object' ? btoa(JSON.stringify(resp.paymentPayload)) : null);
        if (typeof signature !== 'string' || !signature) return fail('X402_BAD_SIGNATURE', 'Rozo answered without a PAYMENT-SIGNATURE value.', { idempotencyKey });
        const headerName =
          (typeof resp?.headerName === 'string' && resp.headerName) || ((x402Version ?? 2) >= 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT');
        return ok({
          headerName,
          paymentSignature: signature,
          paymentId: pick(resp, 'paymentId', 'id'),
          idempotencyKey,
          balanceUsd: pick(resp, 'balanceUsd', 'remainingUsd'),
          next: `Replay your original request with header "${headerName}: <paymentSignature>". If it fails on the network, retry the replay with the same value; if /sign itself fails, retry with the same idempotencyKey.`,
        });
      } catch (err) {
        // Hand the key back so the caller retries /sign with the SAME one.
        if (err instanceof UpstreamError && err.code !== 'X402_PAYER_DISABLED') {
          return fail(err.code, err.message, { httpStatus: err.httpStatus, idempotencyKey, retry: 'Retry x402_sign with the same idempotencyKey.' });
        }
        return fromError(err);
      }
    },
  );
}
