import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UpstreamError, type Api } from './api';
import { isBlacklisted } from './blacklist';
import { CHAIN_IDS, SUPPORTED_SOURCES, chainName, isSupportedSource } from './coins';
import { InputError, assertRozoPaymentId, parseCoinbaseLink } from './ids';

/** Minimum time left on both the Rozo order and the Coinbase link before we hand out a deposit. */
export const MIN_REMAINING_MS = 10 * 60 * 1000;

export interface ToolContext {
  api: Api;
  src: string;
  now?: () => number;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code, message }, ...extra }, null, 2) }], isError: true };
}

function fromError(err: unknown): ToolResult {
  if (err instanceof InputError) return fail(err.code, err.message);
  if (err instanceof UpstreamError) return fail(err.code, err.message, { httpStatus: err.httpStatus });
  return fail('INTERNAL', 'Unexpected error.');
}

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v ? v.slice(0, max) : typeof v === 'number' ? String(v) : null;
}

function mask(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  return s.length <= 12 ? s : `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function parseTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    if (/^\d+$/.test(v)) return parseTime(Number(v));
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Whitelisted view of a quote-invoice response (mirrors the CLI's snapshotFromQuote). */
export function quoteSnapshot(quote: any) {
  const cb = quote?.coinbasePayment || quote?.paymentLink || null;
  return {
    linkId: str(quote?.linkId ?? quote?.paymentId),
    protocolVersion: str(quote?.protocolVersion),
    merchant: str(quote?.merchant),
    invoiceAmount: str(quote?.invoice?.amount),
    fiat: str(quote?.invoice?.fiat),
    callerPays: str(quote?.quote?.callerPays),
    coinbase: cb
      ? {
          status: str(cb.status),
          usageCount: cb.usageCount ?? null,
          maxUsage: cb.maxUsage ?? null,
          expiresAt: str(cb.preApprovalExpiry ?? cb.expiresAt),
        }
      : null,
  };
}

/** Same rules as the CLI's derivePayable. */
export function derivePayable(snap: ReturnType<typeof quoteSnapshot>, now: number) {
  const cb = snap.coinbase;
  if (!cb) return { payable: false, code: 'LINK_NO_LONGER_PAYABLE', reason: 'No Coinbase state in the quote.' };
  if (snap.protocolVersion === 'v3' && cb.status && cb.status !== 'PAYMENT_SESSION_STATUS_CREATED') {
    return { payable: false, code: 'LINK_NO_LONGER_PAYABLE', reason: `Payment Session status is ${cb.status}.` };
  }
  if (cb.usageCount !== null && cb.usageCount !== undefined) {
    const max = cb.maxUsage ?? 1;
    if (Number(cb.usageCount) >= Number(max)) {
      return { payable: false, code: 'LINK_NO_LONGER_PAYABLE', reason: `Link already used (${cb.usageCount}/${max}).` };
    }
  }
  const exp = parseTime(cb.expiresAt);
  if (exp === null) return { payable: false, code: 'EXPIRY_UNPARSABLE', reason: 'Coinbase expiry missing or unparsable.' };
  if (exp <= now) return { payable: false, code: 'LINK_NO_LONGER_PAYABLE', reason: 'This payment link has expired.' };
  return { payable: true, code: null, reason: null, expiryMs: exp };
}

function moneyDetected(source: any, status: unknown): boolean {
  const received = Number(source?.amountReceived ?? 0);
  return Boolean(
    (source?.txHash && String(source.txHash)) ||
      (source?.confirmedAt && String(source.confirmedAt)) ||
      (Number.isFinite(received) ? received > 0 : source?.amountReceived != null) ||
      (typeof status === 'string' && status !== 'payment_unpaid' && !['payment_expired', 'payment_bounced', 'payment_refunded'].includes(status)),
  );
}

const linkUrlSchema = z
  .string()
  .max(512)
  .describe('Coinbase link: https://payments.coinbase.com/payment-links/pl_... or https://payments.coinbase.com/payment-sessions/paymentSession_...');

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const now = ctx.now ?? (() => Date.now());

  server.registerTool(
    'supported_coins',
    {
      title: 'Supported coins',
      description: 'List the coins and chains you can pay an OpenRouter (Coinbase) invoice with through Rozo. Static list, no network call.',
      inputSchema: {},
      annotations: { title: 'Supported coins', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ok({ supportedSources: SUPPORTED_SOURCES }),
  );

  server.registerTool(
    'quote_invoice',
    {
      title: 'Quote a Coinbase invoice',
      description:
        'Look up a Coinbase payment link (e.g. an OpenRouter top-up) and return the merchant, invoice amount, what the payer pays, the link expiry and whether it is still payable. Creates nothing and moves no funds.',
      inputSchema: { url: linkUrlSchema },
      annotations: { title: 'Quote a Coinbase invoice', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const link = parseCoinbaseLink(url);
        const snap = quoteSnapshot(await ctx.api.quoteInvoice(link.url));
        const p = derivePayable(snap, now());
        return ok({
          payable: p.payable,
          ...(p.payable ? {} : { notPayable: { code: p.code, reason: p.reason } }),
          ...snap,
          linkId: snap.linkId ?? link.linkId,
          linkKind: link.kind,
          supportedSources: SUPPORTED_SOURCES,
          next: p.payable ? 'Call create_deposit_order with this url and the coin you hold.' : null,
        });
      } catch (err) {
        return fromError(err);
      }
    },
  );

  server.registerTool(
    'create_deposit_order',
    {
      title: 'Create a deposit order',
      description:
        'Creates a one-time deposit order; you pay from your own wallet. Returns the deposit address (or Lightning invoice), the exact amount to send, any required memo, the expiry and the rozoPaymentId. This server holds no keys and sends nothing. Send exactly the amount, on exactly that chain and token, before expiresAt. An unfunded order simply expires at no cost.',
      inputSchema: {
        url: linkUrlSchema,
        chainId: z.enum(CHAIN_IDS).describe('Source chain id from supported_coins, e.g. "900" (Solana), "8453" (Base), "lightning".'),
        tokenSymbol: z.string().min(2).max(8).describe('Token you will pay with, e.g. USDC, USDT, BTC.'),
      },
      annotations: { title: 'Create a deposit order', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, chainId, tokenSymbol }) => {
      try {
        const token = tokenSymbol.trim().toUpperCase();
        if (!isSupportedSource(chainId, token)) {
          return fail('UNSUPPORTED_SOURCE', `${token} on ${chainName(chainId) ?? chainId} is not supported.`, { supportedSources: SUPPORTED_SOURCES });
        }
        const link = parseCoinbaseLink(url);

        // 1. fresh quote + payability (same checks as the CLI)
        const quote = await ctx.api.quoteInvoice(link.url);
        const snap = quoteSnapshot(quote);
        const p = derivePayable(snap, now());
        if (!p.payable) return fail(p.code!, p.reason!);

        // 2. create (or reuse) the order through mpprouter
        const created = await ctx.api.createInvoice({
          url: link.url,
          chainId,
          tokenSymbol: token,
          quoteReceipt: typeof quote?.quoteReceipt === 'string' ? quote.quoteReceipt : null,
          src: ctx.src,
        });
        const rozoPaymentId = assertRozoPaymentId(created?.rozoPaymentId);

        // 3. authoritative deposit details
        const payment = await ctx.api.getPayment(rozoPaymentId);
        const source = payment?.source ?? {};
        const status = str(payment?.status);
        const base = { rozoPaymentId, reused: Boolean(created?.reused) };

        if (moneyDetected(source, status)) {
          return fail('ORDER_ALREADY_FUNDED', 'This link already has a funded or in-flight Rozo order. Do NOT pay again; check payment_status.', base);
        }
        if (status !== 'payment_unpaid') {
          return fail('ORDER_NOT_PAYABLE', `Order status is "${status ?? 'unknown'}", not payment_unpaid. Do not fund it.`, base);
        }
        const gotChain = String(source.chainId ?? '');
        const gotToken = String(source.tokenSymbol ?? '').toUpperCase();
        if (gotChain !== chainId || gotToken !== token) {
          return fail(
            'REUSED_SOURCE_MISMATCH',
            `An unpaid order for this link already exists for ${gotToken || '?'} on ${chainName(gotChain) ?? (gotChain || '?')}. Pay that coin or wait for it to expire; sending ${token} on ${chainName(chainId)} would likely be lost.`,
            base,
          );
        }

        const lightning = chainId === 'lightning';
        const address = str(source.receiverAddress, 128);
        const memo = str(source.receiverMemo, 128);
        const bolt11 = str(source.lnInvoice ?? payment?.lnInvoice, 4096);
        const amount = str(source.amount, 64);
        if (!amount || !(Number(amount) > 0)) return fail('DEPOSIT_INCOMPLETE', 'The order carries no positive deposit amount.', base);
        if (lightning && !bolt11) return fail('DEPOSIT_INCOMPLETE', 'The Lightning invoice is not ready yet. Retry in a few seconds.', base);
        if (!lightning && !address) return fail('DEPOSIT_INCOMPLETE', 'The order has no deposit address.', base);
        if (chainId === '1500' && !memo) return fail('DEPOSIT_INCOMPLETE', 'A Stellar deposit requires a memo, but none was returned.', base);
        if (isBlacklisted(address)) return fail('BLACKLIST_HIT', 'The deposit address matches a known compromised address. Do NOT send anything.', base);

        // 4. expiry floor on both clocks
        const intentExp = parseTime(payment?.expiresAt);
        const deadline = Math.min(intentExp ?? Infinity, p.expiryMs ?? Infinity);
        if (!Number.isFinite(deadline) || deadline - now() < MIN_REMAINING_MS) {
          return fail('NOT_ENOUGH_TIME', 'Less than 10 minutes remain on the order or the Coinbase link. Ask for a fresh link; do not fund this order.', base);
        }

        return ok({
          ...base,
          paymentLink: str(created?.paymentLink, 512),
          merchant: snap.merchant,
          invoiceAmount: snap.invoiceAmount,
          fiat: snap.fiat,
          deposit: {
            chainId,
            chain: chainName(chainId),
            tokenSymbol: token,
            payTo: lightning ? bolt11 : address,
            receiverAddress: lightning ? null : address,
            memo,
            memoType: memo ? 'text' : null,
            lnInvoice: lightning ? bolt11 : null,
            amount,
            amountUnit: str(source.amountUnit) ?? (lightning ? 'sats' : token),
          },
          expiresAt: new Date(deadline).toISOString(),
          instructions: [
            'Send EXACTLY deposit.amount of deposit.tokenSymbol on deposit.chain to deposit.payTo, from your own wallet.',
            memo ? 'Include the memo exactly as given (TEXT memo). Without it the funds will likely be lost.' : 'No memo is used for this deposit.',
            'The amount can exceed the invoice: it includes bridge and network fees.',
            'Then poll payment_status with rozoPaymentId. Never send a second time for the same order.',
          ],
        });
      } catch (err) {
        return fromError(err);
      }
    },
  );

  server.registerTool(
    'payment_status',
    {
      title: 'Payment status',
      description: 'Check a Rozo order by rozoPaymentId: whether the deposit arrived, bridging/payout progress, and whether the Coinbase invoice settled. Read-only.',
      inputSchema: { rozoPaymentId: z.string().max(64).describe('Order UUID returned by create_deposit_order.') },
      annotations: { title: 'Payment status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ rozoPaymentId }) => {
      try {
        const id = assertRozoPaymentId(rozoPaymentId);
        const payment = await ctx.api.getPayment(id);
        let router: any = null;
        try {
          router = await ctx.api.invoiceStatus(id);
        } catch {
          router = null;
        }
        const source = payment?.source ?? {};
        const status = str(payment?.status);
        const funded = moneyDetected(source, status);
        const settled = router?.coinbase?.settled === true;
        return ok({
          rozoPaymentId: id,
          status,
          moneyDetected: funded,
          coinbaseSettled: router ? Boolean(settled) : null,
          coinbaseStatus: str(router?.coinbase?.status),
          routerState: str(typeof router?.routerState === 'string' ? router.routerState : router?.routerState?.status),
          expiresAt: str(payment?.expiresAt),
          payin: {
            chainId: str(source.chainId),
            tokenSymbol: str(source.tokenSymbol),
            expected: str(source.amount),
            amountUnit: str(source.amountUnit),
            received: str(source.amountReceived),
            txHash: str(source.txHash, 200),
            confirmedAt: str(source.confirmedAt),
            senderAddressMasked: mask(source.senderAddress),
          },
          payout: { txHash: str(payment?.destination?.txHash, 200), confirmedAt: str(payment?.destination?.confirmedAt) },
          guidance: settled
            ? 'Done: the Coinbase invoice is settled.'
            : funded
              ? 'Funds detected. Do NOT pay again; poll again in about 10 seconds.'
              : status === 'payment_expired'
                ? 'Expired unfunded. Nothing was lost; create a fresh order if needed.'
                : 'Awaiting deposit. Poll again in about 10 seconds.',
        });
      } catch (err) {
        return fromError(err);
      }
    },
  );
}
