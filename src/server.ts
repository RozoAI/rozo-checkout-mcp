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
        'Pay an OpenRouter (Coinbase payment link) top-up with USDC/USDT on Solana, BNB Chain, Ethereum, Polygon, Base, Stellar, or BTC over Lightning. ' +
        'Flow: quote_invoice -> create_deposit_order -> the user sends from their own wallet -> payment_status. This server never holds keys or funds. ' +
        'x402 APIs: x402_topup funds a prepaid Rozo balance with any supported coin; x402_sign returns a PAYMENT-SIGNATURE for one 402 requirement (USDC on Base or Solana only). You make the paid HTTP request yourself.',
    },
  );
  registerTools(server, { api: makeApi(opts.fetchFn), src: opts.src, now: opts.now });
  registerX402Tools(server, { fetchFn: opts.fetchFn, connectionKey: opts.agentKey ?? null });
  return server;
}
