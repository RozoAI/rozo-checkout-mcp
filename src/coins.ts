/**
 * Mirrored from @rozoai/checkout scripts/src/lib/amounts.mjs SUPPORTED_SOURCES.
 * Lightning is carried locally because it lives outside the server's own
 * SUPPORTED_SOURCE payload.
 */
export const SUPPORTED_SOURCES = [
  { chainId: '1', chain: 'Ethereum', tokens: ['USDC', 'USDT'] },
  { chainId: '56', chain: 'BNB Chain', tokens: ['USDC', 'USDT'] },
  { chainId: '137', chain: 'Polygon', tokens: ['USDC', 'USDT'] },
  { chainId: '900', chain: 'Solana', tokens: ['USDC', 'USDT'] },
  { chainId: '8453', chain: 'Base', tokens: ['USDC'] },
  { chainId: '1500', chain: 'Stellar', tokens: ['USDC'] },
  { chainId: 'lightning', chain: 'Bitcoin Lightning', tokens: ['BTC'] },
] as const;

export const CHAIN_IDS = SUPPORTED_SOURCES.map((s) => s.chainId) as unknown as [string, ...string[]];

export function isSupportedSource(chainId: string, tokenSymbol: string): boolean {
  const row = SUPPORTED_SOURCES.find((s) => s.chainId === chainId);
  return Boolean(row && (row.tokens as readonly string[]).includes(tokenSymbol.toUpperCase()));
}

export function chainName(chainId: unknown): string | null {
  return SUPPORTED_SOURCES.find((s) => s.chainId === String(chainId))?.chain ?? null;
}
