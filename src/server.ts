import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeApi, type FetchLike } from './api';
import { registerTools } from './tools';
import { registerX402Tools } from './x402';
import { SERVER_NAME, VERSION } from './version';

export function buildServer(opts: { fetchFn: FetchLike; src: string; now?: () => number; agentKey?: string | null }): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION, title: 'Rozo Checkout' },
    {
      instructions:
        'Pay an OpenRouter (Coinbase payment link) top-up with USDC/USDT on Ethereum, BNB Chain, Polygon, Arbitrum, Solana, USDC on Base or Stellar, native ETH (Ethereum, Base, Arbitrum), BNB, POL or SOL, or BTC over Lightning. ' +
        'Flow: quote_invoice -> create_deposit_order -> the user sends from their own wallet -> payment_status. This server never holds keys or funds. ' +
        'Offer a native coin only when quote_invoice lists it in supportedSources for that invoice; a native order is exact-out, priced until quoteExpiresAt, max $2000. ' +
        'x402 APIs: x402_topup funds a prepaid Rozo balance with USDC or USDT only (native coins and Lightning are for create_deposit_order); x402_sign returns a PAYMENT-SIGNATURE for one 402 requirement (USDC on Base only; Solana later). You make the paid HTTP request yourself.',
    },
  );
  registerTools(server, { api: makeApi(opts.fetchFn), src: opts.src, now: opts.now });
  registerX402Tools(server, { fetchFn: opts.fetchFn, connectionKey: opts.agentKey ?? null });
  return server;
}
