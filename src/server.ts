import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeApi, type FetchLike } from './api';
import { registerTools } from './tools';
import { registerX402Tools } from './x402';
import { registerFundingTools } from './funding';
import type { ClientForward } from './client-ip';
import { SERVER_NAME, VERSION } from './version';

export function buildServer(opts: { fetchFn: FetchLike; src: string; now?: () => number; agentKey?: string | null; forward?: ClientForward; x402?: boolean }): McpServer {
  const x402 = opts.x402 === true;
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION, title: 'Rozo Checkout' },
    {
      instructions:
        'Pay an OpenRouter (Coinbase payment link) top-up with USDC/USDT on Ethereum, BNB Chain, Polygon, Arbitrum, Solana, USDC on Base or Stellar, native ETH (Ethereum, Base, Arbitrum), BNB, POL or SOL, or BTC over Lightning. ' +
        'Flow: quote_invoice -> create_deposit_order -> the user sends from their own wallet -> payment_status. This server never holds keys or funds. ' +
        'Offer a native coin only when quote_invoice lists it in supportedSources for that invoice; a native order is exact-out, priced until quoteExpiresAt, max $2000. ' +
        (x402
          ? 'x402 APIs: x402_topup funds a prepaid Rozo balance with USDC or USDT only (native coins and Lightning are for create_deposit_order); x402_sign returns a PAYMENT-SIGNATURE for one 402 requirement (USDC on Base only; Solana later). You make the paid HTTP request yourself. '
          : 'x402 APIs are not available through this server; use the Rozo Checkout skill or CLI (https://checkout.rozo.ai/x402). ') +
        'Stellar wallet: funding_capabilities -> stellar_wallet_quote -> stellar_wallet_create_order -> the user follows deposit.amountPolicy and min/max bounds, paying once before payBefore (USDC or USDT, same deposit address on Base, Ethereum, Arbitrum, Polygon) -> stellar_wallet_order_status -> if asked, stellar_wallet_get_signing_request, the receiver wallet signs once, stellar_wallet_submit_signed. Fees come from the quote. Never ask for a secret key.',
    },
  );
  registerTools(server, { api: makeApi(opts.fetchFn), src: opts.src, now: opts.now });
  if (x402) registerX402Tools(server, { fetchFn: opts.fetchFn, connectionKey: opts.agentKey ?? null });
  registerFundingTools(server, { fetchFn: opts.fetchFn, now: opts.now, forward: opts.forward ?? null });
  return server;
}
