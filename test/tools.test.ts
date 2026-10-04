import { describe, expect, it } from 'vitest';
import { handleMcp } from '../src/index';
import { MPP_BASE, INTENTS_BASE } from '../src/api';
import { CLIENT_LABEL } from '../src/version';

const LINK = 'https://payments.coinbase.com/payment-links/pl_01TEST';
const ID = '11111111-2222-3333-4444-555555555555';
const DEPOSIT = 'So1anaDepositAddr1111111111111111111111111';

type Call = { url: string; method: string; body: any };

function mockFetch(overrides: { payment?: any } = {}) {
  const calls: Call[] = [];
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const fn = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const reply = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${MPP_BASE}/quote-invoice`) {
      return reply({
        linkId: 'pl_01TEST',
        merchant: 'OpenRouter',
        invoice: { amount: '5.00', fiat: 'USD' },
        quote: { callerPays: '5.00' },
        coinbasePayment: { status: 'ACTIVE', usageCount: 0, maxUsage: 1, preApprovalExpiry: future },
        quoteReceipt: 'rcpt_abc',
      });
    }
    if (url === `${MPP_BASE}/create-invoice`) return reply({ rozoPaymentId: ID, reused: false, paymentLink: 'https://x/pay' });
    if (url === `${INTENTS_BASE}/payments/${ID}`) {
      return reply(
        overrides.payment ?? {
          status: 'payment_unpaid',
          expiresAt: future,
          source: { chainId: '900', tokenSymbol: 'USDT', receiverAddress: DEPOSIT, amount: '5.12', amountReceived: null, txHash: null },
        },
      );
    }
    if (url.startsWith(`${MPP_BASE}/invoice-status`)) return reply({ coinbase: { settled: false, status: 'ACTIVE' } });
    return reply({ error: 'unexpected' }, 500);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

async function rpc(method: string, params: unknown, fetchFn: typeof fetch, src = 'test-chan') {
  const req = new Request(`https://mcp.rozo.ai/mcp?src=${src}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const res = await handleMcp(req, fetchFn);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe('tools/list', () => {
  it('exposes four read-only tools with titles and JSON schemas', async () => {
    const { fn } = mockFetch();
    const out = await rpc('tools/list', {}, fn);
    const tools = out.result.tools as any[];
    expect(tools.map((t) => t.name).sort()).toEqual(['create_deposit_order', 'payment_status', 'quote_invoice', 'supported_coins']);
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.inputSchema.type).toBe('object');
    }
    const create = tools.find((t) => t.name === 'create_deposit_order');
    expect(create.inputSchema.required.sort()).toEqual(['chainId', 'tokenSymbol', 'url']);
    expect(create.inputSchema.properties.chainId.enum).toContain('lightning');
    expect(create.description).toMatch(/creates a one-time deposit order; you pay from your own wallet/i);
    expect(tools.find((t) => t.name === 'quote_invoice').inputSchema.required).toEqual(['url']);
    expect(tools.find((t) => t.name === 'payment_status').inputSchema.required).toEqual(['rozoPaymentId']);
  });
});

describe('create_deposit_order', () => {
  it('sends the CLI body shape with attribution from ?src=', async () => {
    const { fn, calls } = mockFetch();
    const out = await rpc(
      'tools/call',
      { name: 'create_deposit_order', arguments: { url: `${LINK}?utm=zz`, chainId: '900', tokenSymbol: 'usdt' } },
      fn,
      'Registry',
    );
    const create = calls.find((c) => c.url === `${MPP_BASE}/create-invoice`)!;
    expect(create.method).toBe('POST');
    expect(create.body).toEqual({
      url: LINK,
      source: { chainId: '900', tokenSymbol: 'USDT' },
      quoteReceipt: 'rcpt_abc',
      client: CLIENT_LABEL,
      attribution: { client: CLIENT_LABEL, utm_source: 'registry' },
    });
    expect(out.result.isError).toBeFalsy();
    const payload = JSON.parse(out.result.content[0].text);
    expect(payload.rozoPaymentId).toBe(ID);
    expect(payload.deposit.payTo).toBe(DEPOSIT);
    expect(payload.deposit.amount).toBe('5.12');
    expect(payload.expiresAt).toBeTruthy();
    // Only GET to payment-api, never a write.
    for (const c of calls.filter((c) => c.url.startsWith(INTENTS_BASE))) expect(c.method).toBe('GET');
  });

  it('refuses a blacklisted deposit address', async () => {
    const future = new Date(Date.now() + 3600e3).toISOString();
    const { fn } = mockFetch({
      payment: { status: 'payment_unpaid', expiresAt: future, source: { chainId: '1', tokenSymbol: 'USDC', receiverAddress: '0x5772fbe7a7817ef7f586215ca8b23b8dd22c8897', amount: '5' } },
    });
    const out = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '1', tokenSymbol: 'USDC' } }, fn);
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toContain('BLACKLIST_HIT');
    expect(out.result.content[0].text).not.toContain('0x5772fbe7a7817ef7f586215ca8b23b8dd22c8897');
  });

  it('refuses an already funded order', async () => {
    const future = new Date(Date.now() + 3600e3).toISOString();
    const { fn } = mockFetch({
      payment: { status: 'payment_payin_completed', expiresAt: future, source: { chainId: '900', tokenSymbol: 'USDT', receiverAddress: DEPOSIT, amount: '5', txHash: '0xabc' } },
    });
    const out = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '900', tokenSymbol: 'USDT' } }, fn);
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toContain('ORDER_ALREADY_FUNDED');
  });

  it('rejects unsupported coins and non-coinbase urls without any network call', async () => {
    const { fn, calls } = mockFetch();
    const a = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '8453', tokenSymbol: 'USDT' } }, fn);
    expect(a.result.content[0].text).toContain('UNSUPPORTED_SOURCE');
    const b = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: 'https://evil.example/payment-links/pl_1', chainId: '900', tokenSymbol: 'USDT' } }, fn);
    expect(b.result.content[0].text).toContain('BAD_LINK');
    expect(calls).toHaveLength(0);
  });
});

describe('supported_coins and payment_status', () => {
  it('supported_coins returns the static list', async () => {
    const { fn, calls } = mockFetch();
    const out = await rpc('tools/call', { name: 'supported_coins', arguments: {} }, fn);
    const payload = JSON.parse(out.result.content[0].text);
    expect(payload.supportedSources.find((s: any) => s.chainId === 'lightning').tokens).toEqual(['BTC']);
    expect(calls).toHaveLength(0);
  });
  it('payment_status validates the id and reads both views', async () => {
    const { fn, calls } = mockFetch();
    const bad = await rpc('tools/call', { name: 'payment_status', arguments: { rozoPaymentId: '../x' } }, fn);
    expect(bad.result.isError).toBe(true);
    const out = await rpc('tools/call', { name: 'payment_status', arguments: { rozoPaymentId: ID } }, fn);
    const payload = JSON.parse(out.result.content[0].text);
    expect(payload.status).toBe('payment_unpaid');
    expect(payload.moneyDetected).toBe(false);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

describe('worker routes', () => {
  it('serves /healthz with the version and rejects GET /mcp', async () => {
    const worker = (await import('../src/index')).default;
    const h = await worker.fetch(new Request('https://mcp.rozo.ai/healthz'));
    expect(await h.json()).toEqual({ ok: true, name: 'rozo-checkout-mcp', version: (await import('../package.json')).default.version });
    const g = await worker.fetch(new Request('https://mcp.rozo.ai/mcp', { headers: { accept: 'text/event-stream' } }));
    expect(g.status).toBe(405);
  });
});

describe('expiry guard', () => {
  it('refuses when the order expiry is missing', async () => {
    const { fn } = mockFetch({
      payment: { status: 'payment_unpaid', source: { chainId: '900', tokenSymbol: 'USDT', receiverAddress: DEPOSIT, amount: '5' } },
    });
    const out = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '900', tokenSymbol: 'USDT' } }, fn);
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toContain('EXPIRY_UNPARSABLE');
    expect(out.result.content[0].text).not.toContain(DEPOSIT);
  });
});
