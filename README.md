# rozo-checkout-mcp

A small remote [MCP](https://modelcontextprotocol.io) server that lets an AI agent help a user pay an
OpenRouter top-up (a Coinbase payment link, `payments.coinbase.com/payment-links/pl_*` or
`payment-sessions/paymentSession_*`) with the coin they already hold:

- USDC or USDT on Solana, BNB Chain, Ethereum, Polygon
- USDC on Base or Stellar
- BTC over Lightning

It runs as a Cloudflare Worker and speaks MCP streamable HTTP at `/mcp`.

## It never custodies funds

This server holds no private keys, signs nothing and sends nothing. It only:

1. reads a quote for the Coinbase link,
2. asks Rozo (through MPP Router) for a one-time deposit order, and
3. reads order status.

The user pays from their own wallet. An order that is never funded expires and costs nothing.
There are no secrets and no stored state; each request is handled statelessly. The two x402 tools
are the one exception to "no auth": they forward the caller's own agent key (see below) to Rozo and
nothing else.

## Tools

| Tool | Input | What it does |
| --- | --- | --- |
| `supported_coins` | none | Static list of supported chains and tokens (mirrors the `@rozoai/checkout` CLI). |
| `quote_invoice` | `{ url }` | Merchant, invoice amount, what the payer pays, link expiry, and whether the link is still payable. Creates nothing. |
| `create_deposit_order` | `{ url, chainId, tokenSymbol, email? }` | Creates a one-time deposit order; you pay from your own wallet. Returns the deposit address (or BOLT11 invoice for Lightning), the exact amount, any required memo, `expiresAt` and `rozoPaymentId`. The optional `email` is a contact address stored with the order so ROZO can reach the payer if the payment needs attention; an invalid one is refused with `INVALID_EMAIL` and nothing is created. |
| `payment_status` | `{ rozoPaymentId }` | Pay-in, bridging/payout progress, and whether the Coinbase invoice settled. |
| `x402_topup` | `{ amount, token, chain, agentKey? }` | Fund a prepaid Rozo x402 balance with the coin you hold (one-time deposit address, you pay from your own wallet). Without an agent key, one is created and returned once. |
| `x402_sign` | `{ accepts, budget, idempotencyKey, x402Version?, resource?, agentKey? }` | For one requirement from an x402 `402` challenge, returns the `PAYMENT-SIGNATURE` value paid from that balance. You make and replay the HTTP request yourself. |

### x402 tools

Same fields as the HTTP API (`POST /v1/x402/topup`, `POST /v1/x402/sign`). The **payment leg is USDC on
Base (`eip155:8453`) and USDC on Solana mainnet only**, x402 scheme `exact`; anything else is refused
with `X402_UNSUPPORTED` before Rozo is called. Native ETH (Ethereum, Base, Arbitrum), BNB and SOL, plus
USDT, can fund the balance but never pay a seller directly.

- Agent key: set it once on the connection as `Authorization: Bearer ak_...`
  (`claude mcp add --transport http rozo-checkout <url> --header "Authorization: Bearer ak_..."`), or pass
  `agentKey` per call. The server never stores it and never echoes it, except the one time
  `x402_topup` creates it.
- Idempotency: generate one UUID per payment and reuse it on every retry of `x402_sign`; the same key
  returns the same signature instead of charging twice. Error results carry the key back.
- A `503` from Rozo is reported as `X402_PAYER_DISABLED` ("x402 payer not enabled yet"): nothing was
  charged.
- `payTo` and topup deposit addresses are checked against the compromised-address list.

`create_deposit_order` applies the same guards as the CLI before it returns a deposit address:
link payability (not used, not expired, v3 session still `CREATED`), an existing order must be
`payment_unpaid` with no pay-in and the same coin, the address must not be on the
compromised-address list, and at least 10 minutes must remain on both the order and the link.

Upstream endpoints (identical request shapes to the CLI, all keyless):

- `POST https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/quote-invoice`
- `POST https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/create-invoice`
- `GET  https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/invoice-status?rozo_payment_id=...`
- `GET  https://intentapiv4.rozo.ai/functions/v1/payment-api/payments/<uuid>` (read-only)
- `POST https://apiserver.mpprouter.dev/v1/x402/keys`, `/v1/x402/topup`, `/v1/x402/sign` (x402 tools, Bearer agent key)

## Support

If an order is stuck or anything goes wrong: email hi@rozo.ai, X https://x.com/ROZOai, Discord https://discord.gg/EfWejgTbuU. Tool results carry the same channels in a `support` block.

## Channel attribution: `?src=`

Every `create-invoice` call carries

```json
{ "client": "rozo-checkout-mcp/<version>",
  "attribution": { "client": "rozo-checkout-mcp/<version>", "utm_source": "<src>" } }
```

`<src>` comes from the `src` query parameter of the MCP URL the client connected to. It is
lowercased, limited to `[a-z0-9._-]` and 100 characters, and defaults to `mcp`. Give each channel
its own URL so orders can be split by channel:

| Channel | URL |
| --- | --- |
| Official MCP registry | `https://mcp.rozo.ai/mcp?src=registry` |
| Docs / README | `https://mcp.rozo.ai/mcp?src=docs` |
| A directory or partner | `https://mcp.rozo.ai/mcp?src=<name>` |

## Connect

### Claude Desktop / Claude.ai

Settings, Connectors, Add custom connector, URL `https://mcp.rozo.ai/mcp?src=claude`.

For a local `claude_desktop_config.json` through the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "rozo-checkout": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.rozo.ai/mcp?src=claude-desktop"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http rozo-checkout "https://mcp.rozo.ai/mcp?src=claude-code"
```

### Cursor

`~/.cursor/mcp.json`:

```json
{ "mcpServers": { "rozo-checkout": { "url": "https://mcp.rozo.ai/mcp?src=cursor" } } }
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://127.0.0.1:8787/mcp?src=inspector (local) or the prod URL
```

## Develop

```bash
npm install
npm test            # vitest
npm run typecheck
npx wrangler dev    # http://127.0.0.1:8787/healthz and /mcp
```

Raw handshake with curl:

```bash
curl -s -X POST 'http://127.0.0.1:8787/mcp?src=dev' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -s -X POST 'http://127.0.0.1:8787/mcp?src=dev' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Deploy

Deployment and the `mcp.rozo.ai` custom domain need owner approval and are not automated here.
`wrangler.toml` pins the Cloudflare account that owns the `rozo.ai` zone and keeps the custom
domain route commented out until then.

## MCP registry

`server.json` describes this server for the official MCP registry as `io.github.RozoAI/checkout`, with the
remote `https://mcp.rozo.ai/mcp?src=registry`. Publishing under the `ai.rozo` namespace requires
proving control of `rozo.ai` (DNS or HTTP verification with `mcp-publisher`).
