import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { srcFromRequestUrl } from './attribution';
import { buildServer } from './server';
import { clientForwardFrom } from './client-ip';
import { agentKeyFromRequest } from './x402';
import { SERVER_NAME, VERSION } from './version';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

function json(body: unknown, status = 200): Response {
  return withCors(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

export interface Env {
  /** Same value as the Supabase secret and the intentapiv4 proxy (see client-ip.ts). Optional. */
  ROZO_PROXY_SECRET?: string;
  /** "1" / "true" registers the two x402 tools (x402_topup, x402_sign). Unset = hidden: the server then
   *  lists only the checkout and Stellar wallet tools, which create orders the user pays from their own
   *  wallet. Kept off by default for directory submissions (founder decision 2026-10-21). */
  EXPOSE_X402_TOOLS?: string;
}

export function x402ToolsEnabled(env: Env): boolean {
  const v = (env.EXPOSE_X402_TOOLS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

export async function handleMcp(request: Request, fetchFn: typeof fetch = fetch, env: Env = {}): Promise<Response> {
  // Stateless: a fresh server + transport per request, no session ids.
  // The optional x402 agent key travels as "Authorization: Bearer ak_..." on the
  // MCP request. It is forwarded to Rozo's x402 API only and never stored.
  const server = buildServer({
    fetchFn: (u, i) => fetchFn(u, i),
    src: srcFromRequestUrl(request.url),
    agentKey: agentKeyFromRequest(request),
    forward: clientForwardFrom(request, env.ROZO_PROXY_SECRET),
    x402: x402ToolsEnabled(env),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(request));
  } finally {
    // JSON response mode has fully produced the body by now.
    void server.close();
  }
}

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
    if (pathname === '/healthz') return json({ ok: true, name: SERVER_NAME, version: VERSION });
    if (pathname === '/mcp') {
      // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
      if (request.method !== 'POST') {
        return withCors(
          new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }), {
            status: 405,
            headers: { 'content-type': 'application/json', allow: 'POST, OPTIONS' },
          }),
        );
      }
      return handleMcp(request, fetch, env);
    }
    if (pathname === '/') {
      return json({
        name: SERVER_NAME,
        version: VERSION,
        mcp: '/mcp',
        docs: 'https://github.com/RozoAI/rozo-checkout-mcp',
        custody: 'none: this server never holds keys or funds',
      });
    }
    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;
