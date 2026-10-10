import { describe, expect, it } from 'vitest';
import { handleMcp } from '../src/index';
import { X402_BASE, NETWORK_BASE, NETWORK_SOLANA, USDC_ASSET } from '../src/x402';

const KEY = 'ak_test_0123456789abcdef';
const IDEM = '11111111-2222-4333-8444-555555555555';
const SELLER = '0x1111111111111111111111111111111111111111';
const SOL_DEPOSIT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

type Call = { url: string; method: string; body: any; headers: Record<string, string> };

function reply(j: unknown, status = 200) {
  return new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(routes: Record<string, (body: any) => Response>) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? 'GET', body, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = url.startsWith(X402_BASE) ? url.slice(X402_BASE.length) : url;
    const route = routes[`${init?.method ?? 'GET'} ${path}`];
    return route ? route(body) : reply({ error: 'unexpected' }, 500);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

async function call(name: string, args: unknown, fetchFn: typeof fetch, authKey?: string) {
  const req = new Request('https://mcp.rozo.ai/mcp?src=test', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(authKey ? { authorization: `Bearer ${authKey}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await handleMcp(req, fetchFn);
  expect(res.status).toBe(200);
  const out = (await res.json()) as any;
  return { isError: Boolean(out.result.isError), text: out.result.content[0].text as string, payload: JSON.parse(out.result.content[0].text) };
}

const baseReq = {
  scheme: 'exact',
  network: NETWORK_BASE,
  amount: '10000',
  asset: USDC_ASSET[NETWORK_BASE],
  payTo: SELLER,
  maxTimeoutSeconds: 60,
};

describe('tool descriptions', () => {
  it('state the Base USDC only payment leg, Solana coming later', async () => {
    const { fn } = mockFetch({});
    const req = new Request('https://mcp.rozo.ai/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const tools = ((await (await handleMcp(req, fn)).json()) as any).result.tools as any[];
    for (const name of ['x402_topup', 'x402_sign']) {
      const t = tools.find((x) => x.name === name);
      expect(t.description).toMatch(/USDC on Base \(eip155:8453\) only/);
      expect(t.description).not.toMatch(/USDC on Solana/);
      expect(t.description).toMatch(/Solana payment leg is coming later/);
    }
    const sign = tools.find((x) => x.name === 'x402_sign');
    expect(sign.inputSchema.required.sort()).toEqual(['accepts', 'budget', 'idempotencyKey']);
    const topup = tools.find((x) => x.name === 'x402_topup');
    expect(topup.inputSchema.required.sort()).toEqual(['amount', 'chain', 'token']);
  });
});

describe('x402_sign', () => {
  it('forwards accepts, budget and idempotencyKey with the connection key and returns the header value', async () => {
    const { fn, calls } = mockFetch({ 'POST /sign': () => reply({ paymentSignature: 'SIGNED', paymentId: 'xp_1' }) });
    const out = await call('x402_sign', { accepts: [baseReq], budget: '0.05', idempotencyKey: IDEM, x402Version: 2 }, fn, KEY);
    expect(out.isError).toBe(false);
    expect(out.payload.paymentSignature).toBe('SIGNED');
    expect(out.payload.headerName).toBe('PAYMENT-SIGNATURE');
    expect(out.payload.idempotencyKey).toBe(IDEM);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toEqual({ x402Version: 2, accepts: [baseReq], budget: '0.05', maxAmountUsd: '0.05', idempotencyKey: IDEM });
    expect(out.text).not.toContain(KEY);
  });

  it('accepts v1 short names for Base; v1 uses X-PAYMENT', async () => {
    const { fn } = mockFetch({ 'POST /sign': () => reply({ paymentSignature: 'S' }) });
    const v1 = { ...baseReq, network: 'base', amount: undefined, maxAmountRequired: '500' };
    const out = await call('x402_sign', { accepts: [v1], budget: '1', idempotencyKey: IDEM, x402Version: 1, agentKey: KEY }, fn);
    expect(out.isError).toBe(false);
    expect(out.payload.headerName).toBe('X-PAYMENT');
  });

  it('refuses Solana USDC (v2 CAIP-2 and v1 short name) as coming later, without calling Rozo', async () => {
    const { fn, calls } = mockFetch({ 'POST /sign': () => reply({ paymentSignature: 'S' }) });
    for (const sol of [
      { ...baseReq, network: NETWORK_SOLANA, asset: USDC_ASSET[NETWORK_SOLANA], payTo: SOL_DEPOSIT },
      { ...baseReq, network: 'solana', asset: USDC_ASSET[NETWORK_SOLANA], payTo: SOL_DEPOSIT, amount: undefined, maxAmountRequired: '500' },
    ]) {
      const out = await call('x402_sign', { accepts: [sol], budget: '1', idempotencyKey: IDEM, agentKey: KEY }, fn);
      expect(out.isError).toBe(true);
      expect(out.payload.error.code).toBe('X402_UNSUPPORTED');
      expect(out.payload.error.message).toMatch(/Solana payment leg is coming later/);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses anything but exact USDC on Base, without calling Rozo', async () => {
    const { fn, calls } = mockFetch({});
    for (const bad of [
      { ...baseReq, network: 'eip155:1' },
      { ...baseReq, asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
      { ...baseReq, scheme: 'upto' },
    ]) {
      const out = await call('x402_sign', { accepts: [bad], budget: '1', idempotencyKey: IDEM }, fn, KEY);
      expect(out.isError).toBe(true);
      expect(out.payload.error.code).toBe('X402_UNSUPPORTED');
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a malformed payTo and never echoes a key placed in a requirement field', async () => {
    const { fn, calls } = mockFetch({});
    const badPay = await call('x402_sign', { accepts: [{ ...baseReq, payTo: 'not-an-address' }], budget: '1', idempotencyKey: IDEM }, fn, KEY);
    expect(badPay.payload.error.code).toBe('X402_UNSUPPORTED');
    const echo = await call('x402_sign', { accepts: [{ ...baseReq, asset: KEY }], budget: '1', idempotencyKey: IDEM }, fn, KEY);
    expect(echo.payload.error.code).toBe('X402_UNSUPPORTED');
    expect(echo.text).not.toContain(KEY);
    expect(calls).toHaveLength(0);
  });

  it('refuses a blacklisted payTo, a bad idempotencyKey, and a missing key', async () => {
    const { fn, calls } = mockFetch({});
    const bl = await call('x402_sign', { accepts: [{ ...baseReq, payTo: '0x5772FBe7a7817ef7F586215CA8b23b8dD22C8897' }], budget: '1', idempotencyKey: IDEM }, fn, KEY);
    expect(bl.payload.error.code).toBe('BLACKLIST_HIT');
    const idem = await call('x402_sign', { accepts: [baseReq], budget: '1', idempotencyKey: 'retry-1' }, fn, KEY);
    expect(idem.payload.error.code).toBe('BAD_VALUE');
    const nokey = await call('x402_sign', { accepts: [baseReq], budget: '1', idempotencyKey: IDEM }, fn);
    expect(nokey.payload.error.code).toBe('X402_NO_KEY');
    expect(calls).toHaveLength(0);
  });

  it('turns 503 into "x402 payer not enabled"', async () => {
    const { fn } = mockFetch({ 'POST /sign': () => reply({}, 503) });
    const out = await call('x402_sign', { accepts: [baseReq], budget: '1', idempotencyKey: IDEM }, fn, KEY);
    expect(out.isError).toBe(true);
    expect(out.payload.error.code).toBe('X402_PAYER_DISABLED');
    expect(out.payload.error.message).toMatch(/x402 payer not enabled/);
  });

  it('on an upstream failure hands back the idempotencyKey to retry with', async () => {
    const { fn } = mockFetch({ 'POST /sign': () => reply({ error: 'INSUFFICIENT_BALANCE', message: `low balance for ${KEY}` }, 402) });
    const out = await call('x402_sign', { accepts: [baseReq], budget: '1', idempotencyKey: IDEM }, fn, KEY);
    expect(out.payload.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(out.payload.idempotencyKey).toBe(IDEM);
    expect(out.text).not.toContain(KEY);
  });
});

describe('router response shapes', () => {
  it('reads paymentId + deposit.{chainId,tokenSymbol,address,amount} and withholds a different coin', async () => {
    const good = mockFetch({
      'POST /topup': () => reply({ ok: true, paymentId: 'pay_1', deposit: { chainId: '900', tokenSymbol: 'USDT', address: SOL_DEPOSIT, amount: '20.2' } }),
    });
    const ok = await call('x402_topup', { amount: '20', token: 'USDT', chain: '900' }, good.fn, KEY);
    expect(ok.payload.orderId).toBe('pay_1');
    expect(ok.payload.deposit.address).toBe(SOL_DEPOSIT);
    const bad = mockFetch({
      'POST /topup': () => reply({ ok: true, paymentId: 'pay_2', deposit: { chainId: '8453', tokenSymbol: 'USDC', address: '0x3333333333333333333333333333333333333333', amount: '20' } }),
    });
    const mis = await call('x402_topup', { amount: '20', token: 'USDT', chain: '900' }, bad.fn, KEY);
    expect(mis.payload.error.code).toBe('X402_TOPUP_MISMATCH');
    expect(mis.text).not.toContain('0x3333333333333333333333333333333333333333');
  });

  it('503 X402_RETRY keeps its code (retry same key); X402_PAYER_SHADOW reads as not enabled', async () => {
    const r = mockFetch({ 'POST /sign': () => reply({ ok: false, code: 'X402_RETRY', error: { code: 'X402_RETRY', message: 'x' } }, 503) });
    const a = await call('x402_sign', { accepts: [baseReq], budget: '1', idempotencyKey: IDEM }, r.fn, KEY);
    expect(a.payload.error.code).toBe('X402_RETRY');
    expect(a.payload.idempotencyKey).toBe(IDEM);
    const sh = mockFetch({ 'POST /sign': () => reply({ ok: false, code: 'X402_PAYER_SHADOW', error: { code: 'X402_PAYER_SHADOW', message: 'x' } }, 503) });
    const b = await call('x402_sign', { accepts: [baseReq], budget: '1', idempotencyKey: IDEM }, sh.fn, KEY);
    expect(b.payload.error.code).toBe('X402_PAYER_DISABLED');
  });

  it('uses the router "header" field as the header name', async () => {
    const { fn } = mockFetch({ 'POST /sign': () => reply({ ok: true, header: 'PAYMENT-SIGNATURE', paymentSignature: 'S', paymentId: 'p' }) });
    const out = await call('x402_sign', { accepts: [baseReq], budget: '1', idempotencyKey: IDEM }, fn, KEY);
    expect(out.payload.headerName).toBe('PAYMENT-SIGNATURE');
  });
});

describe('x402_topup', () => {
  it('creates a key when none is given, returns it once, and sends {amount, token, chain}', async () => {
    const { fn, calls } = mockFetch({
      'POST /keys': () => reply({ key: 'ak_new_9876543210fedcba' }),
      'POST /topup': () => reply({ orderId: 'ord_1', depositAddress: SOL_DEPOSIT, payAmount: '20.2', token: 'USDT', chain: '900' }),
    });
    const out = await call('x402_topup', { amount: '20', token: 'usdt', chain: '900' }, fn);
    expect(out.isError).toBe(false);
    expect(out.payload.agentKey).toBe('ak_new_9876543210fedcba');
    expect(out.payload.deposit.address).toBe(SOL_DEPOSIT);
    const topup = calls.find((c) => c.url.endsWith('/topup'))!;
    expect(topup.body).toEqual({ amount: '20', token: 'USDT', chain: '900', source: { chainId: '900', tokenSymbol: 'USDT' } });
    expect(topup.headers.authorization).toBe('Bearer ak_new_9876543210fedcba');
  });

  it('uses the connection key, never echoes it, and accepts native coins on the topup leg', async () => {
    const { fn, calls } = mockFetch({
      'POST /topup': () => reply({ orderId: 'ord_2', depositAddress: '0x2222222222222222222222222222222222222222', payAmount: '0.004', token: 'ETH', chain: '8453' }),
    });
    const out = await call('x402_topup', { amount: '10', token: 'ETH', chain: '8453' }, fn, KEY);
    expect(out.isError).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/keys'))).toBe(false);
    expect(out.text).not.toContain(KEY);
    expect(out.payload.agentKeyMasked).toBe('ak_...cdef');
  });

  it('refuses unknown coins, small amounts, and a blacklisted deposit address', async () => {
    const { fn } = mockFetch({
      'POST /topup': () => reply({ depositAddress: 'AEEtekA2EBYVy3e5Xx8fD3GkjWSoCsLvLzdD6pZTgHiH', payAmount: '20' }),
    });
    expect((await call('x402_topup', { amount: '20', token: 'SOL', chain: '56' }, fn, KEY)).payload.error.code).toBe('UNSUPPORTED_SOURCE');
    expect((await call('x402_topup', { amount: '4', token: 'USDC', chain: '900' }, fn, KEY)).payload.error.code).toBe('BAD_VALUE');
    expect((await call('x402_topup', { amount: '20', token: 'USDC', chain: '900' }, fn, KEY)).payload.error.code).toBe('BLACKLIST_HIT');
  });

  it('turns 503 into "x402 payer not enabled"', async () => {
    const { fn } = mockFetch({ 'POST /topup': () => reply({}, 503) });
    const out = await call('x402_topup', { amount: '20', token: 'USDC', chain: '900' }, fn, KEY);
    expect(out.payload.error.code).toBe('X402_PAYER_DISABLED');
  });
});
