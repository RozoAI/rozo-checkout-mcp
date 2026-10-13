import { describe, expect, it } from 'vitest';
import { handleMcp } from '../src/index';
import { FUNDING_BASE } from '../src/funding';
import { INTENTS_BASE, MPP_BASE } from '../src/api';
import { CLIENT_IP_HEADER, DIRECT_INTENTS_BASE, PROXY_AUTH_HEADER, clientForwardFrom, withClientIp } from '../src/client-ip';
import caps from './fixtures/funding-capabilities.json';

const SECRET = 's'.repeat(48);
const CALLER_IP = '203.0.113.7';

type Call = { url: string; init: RequestInit | undefined; headers: Record<string, string> };

function recorder() {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, init, headers });
    return new Response(JSON.stringify(caps), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function mcpRequest(extraHeaders: Record<string, string> = {}) {
  return new Request('https://mcp.rozo.ai/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'funding_capabilities', arguments: {} } }),
  });
}

describe('client IP forwarding to the Funding API', () => {
  it('sends the caller IP + proxy auth straight to the Supabase origin when the secret is bound', async () => {
    const { fn, calls } = recorder();
    const res = await handleMcp(mcpRequest({ 'cf-connecting-ip': CALLER_IP }), fn, { ROZO_PROXY_SECRET: SECRET });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${DIRECT_INTENTS_BASE}/funding/capabilities`);
    expect(calls[0]!.headers[CLIENT_IP_HEADER]).toBe(CALLER_IP);
    expect(calls[0]!.headers[PROXY_AUTH_HEADER]).toBe(SECRET);
    expect(calls[0]!.headers['user-agent']).toBeTruthy();
    expect(calls[0]!.init?.redirect).toBe('manual');
  });

  it('changes nothing without the secret binding', async () => {
    const { fn, calls } = recorder();
    await handleMcp(mcpRequest({ 'cf-connecting-ip': CALLER_IP }), fn, {});
    expect(calls[0]!.url).toBe(`${FUNDING_BASE}/capabilities`);
    expect(calls[0]!.headers[CLIENT_IP_HEADER]).toBeUndefined();
    expect(calls[0]!.headers[PROXY_AUTH_HEADER]).toBeUndefined();
  });

  it('changes nothing when the request has no cf-connecting-ip', async () => {
    const { fn, calls } = recorder();
    await handleMcp(mcpRequest(), fn, { ROZO_PROXY_SECRET: SECRET });
    expect(calls[0]!.url).toBe(`${FUNDING_BASE}/capabilities`);
    expect(calls[0]!.headers[PROXY_AUTH_HEADER]).toBeUndefined();
  });

  it('never relays caller-supplied trust headers', async () => {
    const { fn, calls } = recorder();
    await handleMcp(
      mcpRequest({ 'cf-connecting-ip': CALLER_IP, [CLIENT_IP_HEADER]: '198.51.100.1', [PROXY_AUTH_HEADER]: 'forged' }),
      fn,
      {},
    );
    expect(calls[0]!.headers[CLIENT_IP_HEADER]).toBeUndefined();
    expect(calls[0]!.headers[PROXY_AUTH_HEADER]).toBeUndefined();
  });

  it('only touches payment-api URLs: other hosts never see the secret', async () => {
    const { fn, calls } = recorder();
    const wrapped = withClientIp(fn, { ip: CALLER_IP, secret: SECRET });
    await wrapped(`${MPP_BASE}/quote-invoice`, { method: 'POST', headers: { a: 'b' } });
    await wrapped('https://apiserver.mpprouter.dev/v1/x402/x', {});
    await wrapped(`${INTENTS_BASE}evil.example/x`, {});
    for (const c of calls) {
      expect(c.url.startsWith(DIRECT_INTENTS_BASE)).toBe(false);
      expect(c.headers[PROXY_AUTH_HEADER]).toBeUndefined();
    }
  });

  it('clientForwardFrom needs both an IP and a secret', () => {
    const req = (ip?: string) => new Request('https://mcp.rozo.ai/mcp', { headers: ip ? { 'cf-connecting-ip': ip } : {} });
    expect(clientForwardFrom(req(CALLER_IP), SECRET)).toEqual({ ip: CALLER_IP, secret: SECRET });
    expect(clientForwardFrom(req(CALLER_IP), undefined)).toBeNull();
    expect(clientForwardFrom(req(CALLER_IP), '')).toBeNull();
    expect(clientForwardFrom(req(), SECRET)).toBeNull();
  });
});
