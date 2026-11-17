/**
 * TRON / TON pay-in through the MPP Router "tron-ton-alpha" routes, the same
 * keyless backend checkout.rozo.ai/tron and /ton use.
 *
 *   capability GET  {MPP}/tron-ton-alpha/capability -> { enabled, options[] }
 *   option     POST {MPP}/tron-ton-alpha/option     { url, network, token }
 *   status     GET  {MPP}/invoice-status?payment_id=<link id>
 *
 * The router keys the order by the Coinbase invoice id, so asking again for
 * the same link and coin returns the same amount, address, TON code and
 * deadline. Nothing here computes an amount: every value comes from the
 * router and is validated with the same rules as the web client
 * (rozo-rescue-landing site/assets/js/tron-ton.js alphaOptionFromBody,
 * alphaErrorKey, alphaStatusPhase). A response that fails any rule is never
 * shown as a payment instruction.
 */

export type AlphaNetwork = 'tron' | 'ton';

export const ALPHA_TOKENS: Readonly<Record<AlphaNetwork, readonly string[]>> = {
  tron: ['USDT', 'TRX'],
  ton: ['USDT'],
};

/** On-chain precision of every alpha token (TRC20 USDT, TRX in sun, TON USDT jetton). */
export const ALPHA_DECIMALS = 6;

export interface AlphaOption {
  network: AlphaNetwork;
  token: string;
  amount: string;
  atomic: string;
  address: string;
  /** TON only: USDT jetton master (wallet form). Empty on TRON. */
  jetton: string;
  /** TON only, shared-address mode: the six digit comment the payment must carry. Empty otherwise. */
  memo: string;
  perOrder: boolean;
  expiresAtMs: number;
  serverTimeMs: number | null;
  linkExpiresAtMs: number | null;
  orderState: string;
  expired: boolean;
  linkId: string | null;
  reused: boolean;
  fees: { invoiceUsd: string | null; serviceFeeUsd: string | null; networkFeeUsd: string | null; totalUsd: string | null };
}

function decimalToAtomic(amount: string, decimals: number): string | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return (m[1] + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
}

const USD_RE = /^\d{1,12}(?:\.\d{1,6})?$/;
function usd(v: unknown): string | null {
  const s = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : '';
  return USD_RE.test(s) ? s : null;
}

function isoMs(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** Coinbase v3 session ids compare case-insensitively after the prefix (as the web client does). */
export function canonicalLinkId(id: string): string {
  return id.startsWith('paymentSession_') ? `paymentSession_${id.slice(15).toLowerCase()}` : id;
}

const TRON_ADDR = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TON_FRIENDLY = /^[A-Za-z0-9_-]{48}$/;

/**
 * Router answer -> a payment option, or null when it does not look exactly
 * like one. Same rules as the web client's alphaOptionFromBody.
 */
export function alphaOptionFromBody(d: any, net: AlphaNetwork, token: string): AlphaOption | null {
  if (!d || typeof d !== 'object' || d.ok !== true || d.alpha !== true || d.network !== net || d.tokenSymbol !== token) return null;
  if (!ALPHA_TOKENS[net].includes(token)) return null;
  const dec = token === 'TRX' ? 1 : 2;
  const amount = typeof d.expectedAmount === 'string' ? d.expectedAmount : '';
  if (!new RegExp(`^\\d{1,12}\\.\\d{${dec}}$`).test(amount) || !(Number(amount) > 0)) return null;
  const atomic = typeof d.expectedAmountAtomic === 'string' ? d.expectedAmountAtomic : '';
  if (!/^\d+$/.test(atomic) || atomic !== decimalToAtomic(amount, ALPHA_DECIMALS)) return null;
  const address = typeof d.receivingAddressDisplay === 'string' ? d.receivingAddressDisplay : '';
  if (net === 'tron' ? !TRON_ADDR.test(address) : !TON_FRIENDLY.test(address)) return null;
  const ref = d.paymentReference == null ? '' : String(d.paymentReference);
  // Per-order TON address: the code is no longer what matches the payment, so
  // it may be absent; when present it must still be six digits. TRON never
  // carries a reference.
  const perOrder = net === 'ton' && d.addressPerOrder === true;
  if (net === 'ton' ? !(/^\d{6}$/.test(ref) || (perOrder && ref === '')) : ref !== '') return null;
  const jetton = net === 'ton' ? (typeof d.tokenIdentityDisplay === 'string' ? d.tokenIdentityDisplay : '') : '';
  if (net === 'ton' && !TON_FRIENDLY.test(jetton)) return null;
  const expiresAtMs = isoMs(d.expiresAt);
  if (expiresAtMs === null) return null;
  // Optional fields: when present they must be well formed.
  if (d.linkExpiresAt != null && isoMs(d.linkExpiresAt) === null) return null;
  if (d.linkId != null && typeof d.linkId !== 'string') return null;
  if (d.orderState != null && typeof d.orderState !== 'string') return null;
  const f = d.fees && typeof d.fees === 'object' ? d.fees : {};
  return {
    network: net,
    token,
    amount,
    atomic,
    address,
    jetton,
    memo: perOrder ? '' : ref,
    perOrder,
    expiresAtMs,
    serverTimeMs: isoMs(d.serverTime),
    linkExpiresAtMs: isoMs(d.linkExpiresAt),
    orderState: typeof d.orderState === 'string' ? d.orderState : 'open',
    expired: d.expired === true,
    linkId: typeof d.linkId === 'string' ? d.linkId : null,
    reused: d.reused === true,
    fees: { invoiceUsd: usd(f.invoiceUsd), serviceFeeUsd: usd(f.serviceFeeUsd), networkFeeUsd: usd(f.networkFeeUsd), totalUsd: usd(f.totalUsd) },
  };
}

export interface AlphaFailure {
  code: string;
  message: string;
  /** True when the caller must not pay this link again through any coin before checking payment_status. */
  doNotPay: boolean;
}

/** Router error code -> MCP failure. Groups follow the web client's alphaErrorKey. */
export function alphaFailure(upstreamCode: string): AlphaFailure {
  switch (upstreamCode) {
    case 'ALPHA_UNAVAILABLE':
    case 'UNSUPPORTED_SOURCE':
    case 'UNSUPPORTED_INVOICE':
      return { code: 'ROUTE_UNAVAILABLE', message: 'TRON and TON payments are not available for this link right now. Pay with another coin from supported_coins.', doNotPay: false };
    case 'ALPHA_CAPACITY':
      return { code: 'ROUTE_AT_CAPACITY', message: 'TRON and TON payments are full or temporarily unavailable. Pay with another coin, or retry later.', doNotPay: false };
    case 'ALPHA_PRICE_UNAVAILABLE':
      return { code: 'PRICE_UNAVAILABLE', message: 'The TRX price is unavailable right now. Retry later or pay with USDT.', doNotPay: false };
    case 'ALPHA_AMOUNT_TOO_HIGH':
      return { code: 'AMOUNT_TOO_HIGH', message: 'This invoice is above the TRON / TON limit. Pay with another coin.', doNotPay: false };
    case 'LINK_EXPIRES_TOO_SOON':
      return { code: 'NOT_ENOUGH_TIME', message: 'The payment link expires before a TRON / TON payment could finish. Ask for a fresh link or pay with another coin.', doNotPay: false };
    case 'PAYMENT_ALREADY_PAID':
      return { code: 'LINK_ALREADY_PAID', message: 'This payment link has already been paid. Do NOT pay again; check payment_status with this url.', doNotPay: true };
    case 'ALPHA_ORDER_EXPIRED':
      return { code: 'ORDER_EXPIRED', message: 'The TRON / TON order for this link has expired. Do NOT send to its old address. If you already paid, check payment_status with this url; otherwise ask for a fresh link.', doNotPay: true };
    case 'LINK_USED_OR_EXPIRED':
      return { code: 'LINK_NO_LONGER_PAYABLE', message: 'This payment link has already been used or has expired. If you already paid, check payment_status with this url. Do not pay again.', doNotPay: true };
    case 'ALPHA_ORDER_CONFLICT':
    case 'ALPHA_ORDER_CLOSED':
      return { code: 'ORDER_NEEDS_REVIEW', message: 'This link already has a TRON / TON order that needs review. Do NOT pay; contact ROZO support.', doNotPay: true };
    case 'RATE_LIMITED':
      return { code: 'RATE_LIMITED', message: 'Too many requests. Retry in a minute.', doNotPay: false };
    case 'LINK_NOT_FOUND':
      return { code: 'LINK_NOT_FOUND', message: 'No such payment link.', doNotPay: false };
    case 'LINK_NOT_PAYABLE':
      return { code: 'LINK_NO_LONGER_PAYABLE', message: 'This payment link cannot be quoted.', doNotPay: false };
    case 'MALFORMED':
      return { code: 'DEPOSIT_INCOMPLETE', message: 'The TRON / TON order details failed validation. Do NOT send anything; retry later or pay with another coin.', doNotPay: false };
    default:
      return { code: 'ROUTE_FAILED', message: 'TRON / TON payments are temporarily unavailable. Retry later or pay with another coin.', doNotPay: false };
  }
}

export type AlphaPhase = 'settled' | 'paid' | 'review' | '';

/**
 * invoice-status (by link id) -> phase, as the web client's alphaStatusPhase:
 * settled = the Coinbase invoice is settled (v3 only at CAPTURE_SUCCEEDED);
 * review  = router manual review / provider failure / amount mismatch;
 * paid    = the pay-in is confirmed; '' = nothing seen.
 */
export function alphaStatusPhase(d: any, linkId: string): AlphaPhase {
  if (!d || d.ok !== true || typeof d.pl_id !== 'string' || canonicalLinkId(d.pl_id) !== canonicalLinkId(linkId)) return '';
  const cb = d.coinbase;
  if (cb && cb.settled === true && (!linkId.startsWith('paymentSession_') || cb.status === 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED')) return 'settled';
  const rs = d.routerState && d.routerState.status;
  const rp = d.rozoPayment;
  if (rs === 'manual_review' || rs === 'failed_provider' || (rp && rp.amountMismatch)) return 'review';
  if (d.payin && d.payin.confirmed === true) return 'paid';
  return '';
}

/** Which network/token pairs the capability answer enables. Empty when disabled or malformed. */
export function capabilityPairs(d: any): { network: AlphaNetwork; token: string }[] {
  if (!d || d.enabled !== true || !Array.isArray(d.options)) return [];
  const out: { network: AlphaNetwork; token: string }[] = [];
  for (const o of d.options) {
    const net = o?.network;
    if ((net === 'tron' || net === 'ton') && typeof o?.token === 'string' && ALPHA_TOKENS[net as AlphaNetwork].includes(o.token)) {
      if (!out.some((p) => p.network === net && p.token === o.token)) out.push({ network: net, token: o.token });
    }
  }
  return out;
}
