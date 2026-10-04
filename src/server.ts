import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeApi, type FetchLike } from './api';
import { registerTools } from './tools';
import { SERVER_NAME, VERSION } from './version';

export function buildServer(opts: { fetchFn: FetchLike; src: string; now?: () => number }): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION, title: 'Rozo Checkout' },
    {
      instructions:
        'Pay an OpenRouter (Coinbase payment link) top-up with USDC/USDT on Solana, BNB Chain, Ethereum, Polygon, Base, Stellar, or BTC over Lightning. ' +
        'Flow: quote_invoice -> create_deposit_order -> the user sends from their own wallet -> payment_status. This server never holds keys or funds.',
    },
  );
  registerTools(server, { api: makeApi(opts.fetchFn), src: opts.src, now: opts.now });
  return server;
}
