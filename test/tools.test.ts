import { describe, expect, it } from 'vitest';
import { handleMcp, type Env } from '../src/index';
import { MPP_BASE, INTENTS_BASE } from '../src/api';
import { CLIENT_LABEL } from '../src/version';

const LINK = 'https://payments.coinbase.com/payment-links/pl_01TEST';
const ID = '11111111-2222-3333-4444-555555555555';
const DEPOSIT = 'So1anaDepositAddr1111111111111111111111111';

type Call = { url: string; method: string; body: any };

function mockFetch(overrides: { payment?: any; quote?: Record<string, unknown> } = {}) {
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
        ...(overrides.quote ?? {}),
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

async function rpc(method: string, params: unknown, fetchFn: typeof fetch, src = 'test-chan', env: Env = {}) {
  const req = new Request(`https://mcp.rozo.ai/mcp?src=${src}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const res = await handleMcp(req, fetchFn, env);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe('tools/list', () => {
  it('hides the two x402 tools by default (EXPOSE_X402_TOOLS unset)', async () => {
    const { fn } = mockFetch();
    const out = await rpc('tools/list', {}, fn);
    const names = (out.result.tools as any[]).map((t) => t.name).sort();
    expect(names).toEqual([
      'create_deposit_order',
      'funding_capabilities',
      'payment_status',
      'quote_invoice',
      'stellar_wallet_create_order',
      'stellar_wallet_get_signing_request',
      'stellar_wallet_order_status',
      'stellar_wallet_quote',
      'stellar_wallet_submit_signed',
      'supported_coins',
    ]);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }, fn);
    expect(init.result.instructions).not.toMatch(/x402/i);
    expect(init.result.instructions).toMatch(/Stellar wallet: funding_capabilities/);
  });

  it('x402 tools stay hidden for "0" / "false" and appear for "1" / "true"', async () => {
    const { fn } = mockFetch();
    for (const v of ['0', 'false', 'no']) {
      const out = await rpc('tools/list', {}, fn, 'test-chan', { EXPOSE_X402_TOOLS: v });
      expect((out.result.tools as any[]).some((t) => String(t.name).startsWith('x402_'))).toBe(false);
    }
    for (const v of ['1', 'true', ' TRUE ']) {
      const out = await rpc('tools/list', {}, fn, 'test-chan', { EXPOSE_X402_TOOLS: v });
      expect((out.result.tools as any[]).filter((t) => String(t.name).startsWith('x402_')).map((t) => t.name).sort()).toEqual(['x402_sign', 'x402_topup']);
    }
  });

  it('server instructions mention x402 only when the x402 tools are exposed', async () => {
    const { fn } = mockFetch();
    const init = (env: Env) => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }, fn, 'test-chan', env);
    for (const v of ['', '0', 'false']) {
      expect((await init({ EXPOSE_X402_TOOLS: v })).result.instructions).not.toMatch(/x402/i);
    }
    expect((await init({})).result.instructions).not.toMatch(/x402/i);
    const on = (await init({ EXPOSE_X402_TOOLS: '1' })).result.instructions;
    expect(on).toMatch(/x402_sign returns a PAYMENT-SIGNATURE/);
    expect(on).toMatch(/Stellar wallet: funding_capabilities/);
  });

  it('tools/call on a hidden x402 tool fails without any upstream call', async () => {
    const { fn, calls } = mockFetch();
    const out = await rpc('tools/call', { name: 'x402_sign', arguments: { accepts: {}, budget: '1', idempotencyKey: 'k' } }, fn);
    expect(out.error ?? out.result?.isError).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('exposes the checkout tools and the two x402 tools with titles and JSON schemas', async () => {
    const { fn } = mockFetch();
    const out = await rpc('tools/list', {}, fn, 'test-chan', { EXPOSE_X402_TOOLS: '1' });
    const tools = out.result.tools as any[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_deposit_order',
      'funding_capabilities',
      'payment_status',
      'quote_invoice',
      'stellar_wallet_create_order',
      'stellar_wallet_get_signing_request',
      'stellar_wallet_order_status',
      'stellar_wallet_quote',
      'stellar_wallet_submit_signed',
      'supported_coins',
      'x402_sign',
      'x402_topup',
    ]);
    const writers = ['create_deposit_order', 'x402_sign', 'x402_topup', 'stellar_wallet_create_order', 'stellar_wallet_get_signing_request', 'stellar_wallet_submit_signed'];
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations.readOnlyHint).toBe(!writers.includes(t.name));
      expect(t.annotations.destructiveHint).toBe(false);
      expect(t.inputSchema.type).toBe('object');
    }
    const create = tools.find((t) => t.name === 'create_deposit_order');
    expect(create.inputSchema.required.sort()).toEqual(['chainId', 'tokenSymbol', 'url']);
    expect(create.inputSchema.properties.chainId.enum).toContain('lightning');
    expect(create.inputSchema.properties.chainId.enum).toContain('42161');
    expect(create.description).toMatch(/quoteExpiresAt/);
    expect(create.description).toMatch(/creates a one-time deposit order; you pay from your own wallet/i);
    const coins = tools.find((t) => t.name === 'supported_coins');
    expect(coins.description).toMatch(/^Answers which cryptocurrencies and chains can pay an OpenRouter credit top-up/);
    expect(tools.find((t) => t.name === 'quote_invoice').description).toMatch(/^Answers how much a specific OpenRouter top-up/);
    // Directory policy: descriptions describe, they never steer tool choice.
    for (const t of tools) expect(t.description).not.toMatch(/\balways (use|call)\b|\buse this (tool )?for any\b|\binstead of (other|any|web)\b|\bprefer this\b/i);
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

  it('forwards an optional contact email (normalized) and never echoes it', async () => {
    const { fn, calls } = mockFetch();
    const out = await rpc(
      'tools/call',
      { name: 'create_deposit_order', arguments: { url: LINK, chainId: '900', tokenSymbol: 'USDT', email: ' Payer@Example.com ' } },
      fn,
    );
    const create = calls.find((c) => c.url === `${MPP_BASE}/create-invoice`)!;
    expect(create.body.email).toBe('payer@example.com');
    expect(out.result.isError).toBeFalsy();
    const text = out.result.content[0].text;
    expect(text).not.toContain('payer@example.com');
    const payload = JSON.parse(text);
    expect(payload.contactEmailProvided).toBe(true);
    expect(payload.support).toEqual({ email: 'hi@rozo.ai', x: 'https://x.com/ROZOai', discord: 'https://discord.gg/EfWejgTbuU' });
  });

  it('reports contactEmailProvided false when the order was reused', async () => {
    const { fn } = mockFetch();
    const reusedFn = (async (url: string, init?: RequestInit) =>
      url === `${MPP_BASE}/create-invoice`
        ? new Response(JSON.stringify({ rozoPaymentId: ID, reused: true, paymentLink: 'https://x/pay' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : fn(url, init)) as unknown as typeof fetch;
    const out = await rpc(
      'tools/call',
      { name: 'create_deposit_order', arguments: { url: LINK, chainId: '900', tokenSymbol: 'USDT', email: 'payer@example.com' } },
      reusedFn,
    );
    expect(out.result.isError).toBeFalsy();
    const payload = JSON.parse(out.result.content[0].text);
    expect(payload.reused).toBe(true);
    expect(payload.contactEmailProvided).toBe(false);
  });

  it('omits email when absent and rejects an invalid one without any network call', async () => {
    const a = mockFetch();
    await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '900', tokenSymbol: 'USDT' } }, a.fn);
    const create = a.calls.find((c) => c.url === `${MPP_BASE}/create-invoice`)!;
    expect('email' in create.body).toBe(false);

    const b = mockFetch();
    const out = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '900', tokenSymbol: 'USDT', email: 'nope' } }, b.fn);
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toContain('INVALID_EMAIL');
    expect(b.calls).toHaveLength(0);
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

describe('native coins and Arbitrum', () => {
  const SOL_DEPOSIT = 'So1anaNativeDeposit11111111111111111111111';
  const ALL_NATIVE = {
    '1': ['USDC', 'USDT', 'ETH'],
    '56': ['USDC', 'USDT', 'BNB'],
    '137': ['USDC', 'USDT', 'POL'],
    '8453': ['USDC', 'ETH'],
    '42161': ['USDC', 'USDT', 'ETH'],
    '900': ['USDC', 'USDT', 'SOL'],
    '1500': ['USDC'],
  };
  const inMin = (m: number) => new Date(Date.now() + m * 60e3).toISOString();
  const nativePayment = (extra: Record<string, unknown> = {}) => ({
    status: 'payment_unpaid',
    expiresAt: inMin(60 + 720),
    quoteExpiresAt: inMin(55),
    source: { chainId: '900', tokenSymbol: 'SOL', receiverAddress: SOL_DEPOSIT, amount: '0.0321', amountReceived: null, txHash: null },
    ...extra,
  });

  it('supported_coins lists native coins with on-chain decimals and never labels POL beta', async () => {
    const { fn } = mockFetch();
    const out = await rpc('tools/call', { name: 'supported_coins', arguments: {} }, fn);
    const text = out.result.content[0].text;
    const rows = JSON.parse(text).supportedSources as any[];
    const by = (id: string) => rows.find((r) => r.chainId === id);
    expect(by('1').tokens).toEqual(['USDC', 'USDT', 'ETH']);
    expect(by('8453').tokens).toEqual(['USDC', 'ETH']);
    expect(by('42161').tokens).toEqual(['USDC', 'USDT', 'ETH']);
    expect(by('56').native).toBe('BNB');
    expect(by('137').native).toBe('POL');
    expect(by('900').decimals.SOL).toBe(9);
    for (const [id, sym] of [['1', 'ETH'], ['8453', 'ETH'], ['42161', 'ETH'], ['56', 'BNB'], ['137', 'POL']] as const) expect(by(id).decimals[sym]).toBe(18);
    expect(by('56').decimals.USDC).toBe(18);
    expect(by('1500').tokens).toEqual(['USDC']);
    // The only Beta mention is the ZEC pointer to its own page; nothing else
    // (POL included) is labelled Beta.
    const zecNote = 'ZEC on Zcash (Beta) is not available through this server: send a payer holding ZEC to https://checkout.rozo.ai/zec.';
    expect(text).toContain(zecNote);
    expect(text.replace(zecNote, '').toLowerCase()).not.toContain('beta');
    expect(rows.some((r) => r.tokens.includes('ZEC'))).toBe(false);
  });

  it('quote_invoice offers a native coin only when the invoice lists it', async () => {
    const none = await rpc('tools/call', { name: 'quote_invoice', arguments: { url: LINK } }, mockFetch().fn);
    const noneRows = JSON.parse(none.result.content[0].text).supportedSources as any[];
    expect(noneRows.find((r) => r.chainId === '900').tokens).toEqual(['USDC', 'USDT']);
    expect(noneRows.find((r) => r.chainId === '42161').tokens).toEqual(['USDC', 'USDT']);
    expect(noneRows.find((r) => r.chainId === 'lightning').tokens).toEqual(['BTC']);

    const some = await rpc(
      'tools/call',
      { name: 'quote_invoice', arguments: { url: LINK } },
      mockFetch({ quote: { supportedSources: { ...ALL_NATIVE, '137': ['USDC', 'USDT'] }, nativeMinUsd: { '1': { ETH: 1 } } } }).fn,
    );
    const payload = JSON.parse(some.result.content[0].text);
    const rows = payload.supportedSources as any[];
    expect(rows.find((r) => r.chainId === '900').tokens).toEqual(['USDC', 'USDT', 'SOL']);
    expect(rows.find((r) => r.chainId === '137').tokens).toEqual(['USDC', 'USDT']);
    expect(rows.find((r) => r.chainId === '137').native).toBeUndefined();
    expect(payload.nativeMinUsd).toEqual({ '1': { ETH: 1 } });
    expect(payload.nativeMaxUsd).toBe(2000);
  });

  it('creates a native SOL order: exact amount, 9 decimals, expiresAt is the price lock', async () => {
    const payment = nativePayment();
    const { fn, calls } = mockFetch({ quote: { supportedSources: ALL_NATIVE }, payment });
    const out = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '900', tokenSymbol: 'sol' } }, fn);
    expect(out.result.isError).toBeFalsy();
    const create = calls.find((c) => c.url === `${MPP_BASE}/create-invoice`)!;
    expect(create.body.source).toEqual({ chainId: '900', tokenSymbol: 'SOL' });
    const p = JSON.parse(out.result.content[0].text);
    expect(p.deposit).toMatchObject({ payTo: SOL_DEPOSIT, amount: '0.0321', decimals: 9, amountBaseUnits: '32100000', native: true, exactOut: true });
    expect(p.quoteExpiresAt).toBe(new Date(payment.quoteExpiresAt).toISOString());
    expect(p.expiresAt).toBe(p.quoteExpiresAt);
    expect(p.instructions[0]).toContain(p.quoteExpiresAt);
    expect(p.instructions[0]).toMatch(/EXACTLY 0\.0321 SOL \(32100000 base units, 9 decimals\)/);
  });

  it('expresses ETH, BNB and POL amounts in 18-decimal base units', async () => {
    for (const [chainId, sym] of [['42161', 'ETH'], ['56', 'BNB'], ['137', 'POL'], ['8453', 'ETH']]) {
      const payment = nativePayment({ source: { chainId, tokenSymbol: sym, receiverAddress: '0x1111111111111111111111111111111111111111', amount: '0.0142' } });
      const { fn } = mockFetch({ quote: { supportedSources: ALL_NATIVE }, payment });
      const out = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId, tokenSymbol: sym } }, fn);
      expect(out.result.isError).toBeFalsy();
      const p = JSON.parse(out.result.content[0].text);
      expect(p.deposit.decimals).toBe(18);
      expect(p.deposit.amountBaseUnits).toBe('14200000000000000');
    }
  });

  it('refuses a native coin the invoice does not list, before creating anything', async () => {
    const { fn, calls } = mockFetch({ quote: { supportedSources: { '900': ['USDC', 'USDT'] } } });
    const out = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '900', tokenSymbol: 'SOL' } }, fn);
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toContain('NATIVE_NOT_OFFERED');
    expect(calls.some((c) => c.url === `${MPP_BASE}/create-invoice`)).toBe(false);
  });

  it('enforces the $2,000 cap and the per-chain minimum before creating anything', async () => {
    const over = mockFetch({ quote: { supportedSources: ALL_NATIVE, callerPays: '2000.01', quote: { callerPays: '2000.01' } } });
    const a = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '1', tokenSymbol: 'ETH' } }, over.fn);
    expect(a.result.content[0].text).toContain('NATIVE_OVER_LIMIT');
    expect(over.calls.some((c) => c.url === `${MPP_BASE}/create-invoice`)).toBe(false);

    const under = mockFetch({ quote: { supportedSources: ALL_NATIVE, quote: { callerPays: '0.50' } } });
    const b = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '1', tokenSymbol: 'ETH' } }, under.fn);
    expect(b.result.content[0].text).toContain('NATIVE_UNDER_MINIMUM');
    expect(under.calls.some((c) => c.url === `${MPP_BASE}/create-invoice`)).toBe(false);

    // The same $0.50 is fine on Base, whose floor is $0.10.
    const base = mockFetch({
      quote: { supportedSources: ALL_NATIVE, quote: { callerPays: '0.50' } },
      payment: nativePayment({ source: { chainId: '8453', tokenSymbol: 'ETH', receiverAddress: '0x1111111111111111111111111111111111111111', amount: '0.0002' } }),
    });
    const c = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '8453', tokenSymbol: 'ETH' } }, base.fn);
    expect(c.result.isError).toBeFalsy();
  });

  it('refuses a native order without a price lock or with one about to end, without leaking the address', async () => {
    const missing = mockFetch({ quote: { supportedSources: ALL_NATIVE }, payment: nativePayment({ quoteExpiresAt: undefined }) });
    const a = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '900', tokenSymbol: 'SOL' } }, missing.fn);
    expect(a.result.isError).toBe(true);
    expect(a.result.content[0].text).toContain('EXPIRY_UNPARSABLE');
    expect(a.result.content[0].text).not.toContain(SOL_DEPOSIT);

    const late = mockFetch({ quote: { supportedSources: ALL_NATIVE }, payment: nativePayment({ quoteExpiresAt: inMin(5) }) });
    const b = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '900', tokenSymbol: 'SOL' } }, late.fn);
    expect(b.result.isError).toBe(true);
    expect(b.result.content[0].text).toContain('QUOTE_EXPIRED');
    expect(b.result.content[0].text).not.toContain(SOL_DEPOSIT);
  });

  it('accepts USDC and USDT on Arbitrum without any native gating or price lock', async () => {
    const payment = {
      status: 'payment_unpaid',
      expiresAt: inMin(60),
      source: { chainId: '42161', tokenSymbol: 'USDT', receiverAddress: '0x2222222222222222222222222222222222222222', amount: '5.06' },
    };
    const { fn } = mockFetch({ payment });
    const out = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId: '42161', tokenSymbol: 'USDT' } }, fn);
    expect(out.result.isError).toBeFalsy();
    const p = JSON.parse(out.result.content[0].text);
    expect(p.deposit).toMatchObject({ chain: 'Arbitrum', decimals: 6, amountBaseUnits: '5060000', native: false, exactOut: false });
    expect(p.quoteExpiresAt).toBeUndefined();
  });

  it('still rejects coins that are not sources (USDT on Base, ETH on Polygon)', async () => {
    const { fn, calls } = mockFetch({ quote: { supportedSources: ALL_NATIVE } });
    for (const [chainId, tokenSymbol] of [['8453', 'USDT'], ['137', 'ETH'], ['1500', 'XLM']]) {
      const out = await rpc('tools/call', { name: 'create_deposit_order', arguments: { url: LINK, chainId, tokenSymbol } }, fn);
      expect(out.result.content[0].text).toContain('UNSUPPORTED_SOURCE');
    }
    expect(calls).toHaveLength(0);
  });
});
