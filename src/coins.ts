/**
 * Sources this server accepts for create_deposit_order.
 *
 * Stablecoins mirror MPP Router STABLE_SOURCES; native coins mirror its
 * NATIVE_SOURCE_DEFS (ETH@1, ETH@8453, ETH@42161, BNB@56, POL@137, SOL@900),
 * which production payment-api lists in GET /payments/supported. Lightning is
 * carried locally because it lives outside the server's own SUPPORTED_SOURCE
 * payload. Beta-only native coins (ZEC) are deliberately not listed.
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

/** Upper bound on callerPays for a native order (backend NATIVE_MAX_USD default). */
export const NATIVE_MAX_USD = 2000;

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

export const CHAIN_IDS = SUPPORTED_SOURCES.map((s) => s.chainId) as unknown as [string, ...string[]];

function row(chainId: string): SourceRow | undefined {
  return SUPPORTED_SOURCES.find((s) => s.chainId === chainId);
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
