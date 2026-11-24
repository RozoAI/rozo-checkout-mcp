/**
 * Sources this server accepts for create_deposit_order.
 *
 * Stablecoins mirror MPP Router STABLE_SOURCES; native coins mirror its
 * NATIVE_SOURCE_DEFS (ETH@1, ETH@8453, ETH@42161, BNB@56, POL@137, SOL@900),
 * which production payment-api lists in GET /payments/supported. Lightning is
 * carried locally because it lives outside the server's own SUPPORTED_SOURCE
 * payload. Web-only coins (ZEC on checkout.rozo.ai/zec, on-chain BTC on
 * checkout.rozo.ai/btc-onchain) are deliberately not listed here; see WEB_ONLY_ROUTES.
 *
 * `native` names the chain's native coin. A native order is exact-out like
 * Lightning: the order's source.amount is the exact coin amount, and its price
 * is locked only until quoteExpiresAt. It is offered for an invoice only when
 * that invoice's quote-invoice supportedSources lists it.
 *
 * `decimals` is the on-chain precision per token, used to express the deposit
 * amount in base units (wei, lamports, stroops, ...).
 */
export interface SourceRow {
  chainId: string;
  chain: string;
  tokens: readonly string[];
  native?: string;
  decimals?: Readonly<Record<string, number>>;
  /** Public Beta label (TRON). */
  beta?: boolean;
  /** Set when the order goes through a dedicated route instead of create-invoice. */
  route?: 'tron_ton_alpha';
  /** tron_ton_alpha only: the router's network key. */
  network?: 'tron' | 'ton';
  /** tron_ton_alpha only: the published fee wording; the exact fee comes with the order. */
  fee?: string;
}

export const SUPPORTED_SOURCES: readonly SourceRow[] = [
  { chainId: '1', chain: 'Ethereum', tokens: ['USDC', 'USDT', 'ETH'], native: 'ETH', decimals: { USDC: 6, USDT: 6, ETH: 18 } },
  { chainId: '56', chain: 'BNB Chain', tokens: ['USDC', 'USDT', 'BNB'], native: 'BNB', decimals: { USDC: 18, USDT: 18, BNB: 18 } },
  { chainId: '137', chain: 'Polygon', tokens: ['USDC', 'USDT', 'POL'], native: 'POL', decimals: { USDC: 6, USDT: 6, POL: 18 } },
  { chainId: '42161', chain: 'Arbitrum', tokens: ['USDC', 'USDT', 'ETH'], native: 'ETH', decimals: { USDC: 6, USDT: 6, ETH: 18 } },
  { chainId: '900', chain: 'Solana', tokens: ['USDC', 'USDT', 'SOL'], native: 'SOL', decimals: { USDC: 6, USDT: 6, SOL: 9 } },
  { chainId: '8453', chain: 'Base', tokens: ['USDC', 'ETH'], native: 'ETH', decimals: { USDC: 6, ETH: 18 } },
  { chainId: '1500', chain: 'Stellar', tokens: ['USDC'], decimals: { USDC: 7 } },
  { chainId: 'lightning', chain: 'Bitcoin Lightning', tokens: ['BTC'] },
];

/**
 * TRON and TON, served by the MPP Router tron-ton-alpha routes (the backend of
 * checkout.rozo.ai/tron and /ton), not by create-invoice. Chain ids match the
 * router's ALPHA_OPTIONS. Fixed exact amount per order, one shared deadline,
 * no price lock beyond it. Fee wording mirrors checkout.rozo.ai ("TRON Beta
 * charges 1% with a $0.30 minimum; TON charges 1% only"). TRON is public as
 * Beta; TON carries no Beta label on checkout.rozo.ai.
 */
export const ALPHA_SOURCES: readonly SourceRow[] = [
  { chainId: '728126428', chain: 'TRON', tokens: ['USDT', 'TRX'], decimals: { USDT: 6, TRX: 6 }, beta: true, route: 'tron_ton_alpha', network: 'tron', fee: '1% with a $0.30 minimum' },
  { chainId: '1600', chain: 'TON', tokens: ['USDT'], decimals: { USDT: 6 }, beta: false, route: 'tron_ton_alpha', network: 'ton', fee: '1%' },
];

/** Every source create_deposit_order accepts: the standard table plus TRON and TON. */
export const ALL_SOURCES: readonly SourceRow[] = [...SUPPORTED_SOURCES, ...ALPHA_SOURCES];

/**
 * Coins checkout.rozo.ai serves on its own pages that this server cannot
 * create orders for. Send a payer holding one of these to the page.
 */
export const WEB_ONLY_ROUTES: readonly { name: string; chain: string; tokens: readonly string[]; url: string; beta?: boolean }[] = [
  { name: 'ZEC on Zcash', chain: 'Zcash', tokens: ['ZEC'], url: 'https://checkout.rozo.ai/zec', beta: false },
  { name: 'USDC on Arc', chain: 'Arc', tokens: ['USDC'], url: 'https://checkout.rozo.ai/arc' },
  // Celo (Beta, founder 2026-11-23): USDT and USDC, each its own order; credits
  // arrive about 25 to 30 minutes after payment (the router waits for Celo
  // finality). Web only: create-invoice opens Celo only with ?beta=celo,
  // which this server does not send.
  { name: 'USDT or USDC on Celo (credits in about 25 to 30 minutes)', chain: 'Celo', tokens: ['USDT', 'USDC'], url: 'https://checkout.rozo.ai/celo', beta: true },
  // On-chain Bitcoin (chain 9000, Beta). Not Lightning. Web only until the
  // merchant API docs for it are published; then it moves to SUPPORTED_SOURCES
  // with CHAIN_IDS, NATIVE_MIN_USD_FALLBACK and its own cap (ainative
  // docs/design/20261118-btc-onchain-beta-plan.zh.md section 6).
  { name: 'BTC on Bitcoin (on-chain, not Lightning)', chain: 'Bitcoin', tokens: ['BTC'], url: 'https://checkout.rozo.ai/btc-onchain', beta: true },
];

/** The tron-ton-alpha row for chainId, if any. */
export function alphaRow(chainId: string): SourceRow | undefined {
  return ALPHA_SOURCES.find((s) => s.chainId === chainId);
}

/** Upper bound on callerPays (service fee included) for a native ETH, BNB or SOL order (amount <= cap is allowed).
 * Mirrors the customer cap on checkout.rozo.ai, MPP Router and the intents app_config knob
 * NATIVE_MAX_ORDER_USD_merchant_openrouter: $1,200 (founder 2026-11-24 "maybe update to 1200 first"; backend
 * hard cap $13,500). Payers are promised up to 1,100 OpenRouter credits ($1,155 invoice, $1,166.55 with the fee,
 * about $1,178 with the 1% quote buffer), so a 1,100-credit order is not refused.
 * History: $12,750 from 2026-11-18 (promise 10,000 credits), $3,500 from 2026-10-23, $3,200 from 2026-10-20,
 * $2,000 before. */
export const NATIVE_MAX_USD = 1200;

/** Credits promised to payers for a native order (NATIVE_MAX_USD with the fee and quote buffer). */
export const NATIVE_MAX_CREDITS = 1100;

/** POL's own backend cap ($3,500: a larger POL order exceeds the 100,000 coin NEAR conversion limit). */
export const POL_MAX_USD = 3500;

/** Customer cap on callerPays (service fee included) for the native coin tokenSymbol: the lower of the coin cap
 * and the app cap, as the backend does (nativeOrderUsdBounds). With the app cap at $1,200, POL is $1,200 too. */
export function nativeMaxUsdFor(tokenSymbol: string): number {
  return tokenSymbol.toUpperCase() === 'POL' ? Math.min(POL_MAX_USD, NATIVE_MAX_USD) : NATIVE_MAX_USD;
}

/**
 * Built-in per-chain USD minimum for a native order, mirrored from MPP Router
 * NATIVE_MIN_USD. Used only when a quote carries no nativeMinUsd; the backend
 * stays the final gate.
 */
export const NATIVE_MIN_USD_FALLBACK: Readonly<Record<string, number>> = {
  '1': 1,
  '8453': 0.1,
  '42161': 0.1,
  '56': 0.1,
  '137': 0.1,
  '900': 1,
};

export const CHAIN_IDS = ALL_SOURCES.map((s) => s.chainId) as unknown as [string, ...string[]];

function row(chainId: string): SourceRow | undefined {
  return ALL_SOURCES.find((s) => s.chainId === chainId);
}

export function isSupportedSource(chainId: string, tokenSymbol: string): boolean {
  const r = row(chainId);
  return Boolean(r && r.tokens.includes(tokenSymbol.toUpperCase()));
}

/** True when tokenSymbol is the native coin of chainId (ETH on 1/8453/42161, BNB, POL, SOL). */
export function isNativeSource(chainId: string, tokenSymbol: string): boolean {
  const r = row(chainId);
  return Boolean(r?.native && r.native === tokenSymbol.toUpperCase());
}

export function tokenDecimals(chainId: string, tokenSymbol: string): number | null {
  return row(chainId)?.decimals?.[tokenSymbol.toUpperCase()] ?? null;
}

export function chainName(chainId: unknown): string | null {
  return row(String(chainId))?.chain ?? null;
}

/**
 * Convert a positive decimal string to base units. Returns null when the value
 * is not a plain decimal or carries more fractional digits than the token has
 * (a wallet could not send that amount exactly).
 */
export function toBaseUnits(amount: string, decimals: number): string | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return null;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) return null;
  const digits = (m[1] + frac.padEnd(decimals, '0')).replace(/^0+/, '');
  return digits || '0';
}

/**
 * The sources a specific invoice can be paid with: every stablecoin and
 * Lightning from the static table, plus each native coin only when the
 * invoice's quote-invoice `supportedSources` ({ chainId: string[] }) lists it.
 * A quote without that object offers no native coin.
 */
export function offeredSources(quoteSupported: unknown): SourceRow[] {
  const listed = (chainId: string, symbol: string): boolean => {
    if (!quoteSupported || typeof quoteSupported !== 'object') return false;
    const tokens = (quoteSupported as Record<string, unknown>)[chainId];
    return Array.isArray(tokens) && tokens.some((t) => typeof t === 'string' && t.toUpperCase() === symbol);
  };
  return SUPPORTED_SOURCES.map((r) => {
    const tokens = r.tokens.filter((t) => t !== r.native || listed(r.chainId, t));
    const out: SourceRow = { ...r, tokens };
    if (r.native && !tokens.includes(r.native)) delete out.native;
    return out;
  });
}
