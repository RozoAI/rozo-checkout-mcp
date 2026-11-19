import { describe, expect, it } from 'vitest';
import { handleMcp } from '../src/index';
import { MPP_BASE } from '../src/api';
import { alphaOptionFromBody, alphaStatusPhase, alphaFailure, capabilityPairs } from '../src/alpha';

const LINK = 'https://payments.coinbase.com/payment-links/pl_01TRON';
const SESSION_ID = 'paymentSession_0f8fad5b-d9cb-469f-a165-70867728950e';
const SESSION = `https://payments.coinbase.com/payment-sessions/${SESSION_ID}`;
const TRON_ADDR = 'T' + 'R'.repeat(33);
const TON_ADDR = 'UQ' + 'A'.repeat(46);
const JETTON = 'EQ' + 'C'.repeat(46);
const CAP_ALL = {
  ok: true,
  enabled: true,
  options: [
    { network: 'tron', token: 'USDT', chainId: '728126428', displayDecimals: 2 },
    { network: 'tron', token: 'TRX', chainId: '728126428', displayDecimals: 1 },
    { network: 'ton', token: 'USDT', chainId: '1600', displayDecimals: 2 },
  ],
};

type Call = { url: string; method: string; body: any };

function optionBody(net: 'tron' | 'ton', token: string, over: Record<string, unknown> = {}) {
  const exp = new Date(Date.now() + 55 * 60 * 1000).toISOString();
  const amount = token === 'TRX' ? '41.3' : '5.07';
  const atomic = token === 'TRX' ? '41300000' : '5070000';
  return {
    ok: true,
    alpha: true,
    linkId: 'pl_01TRON',
    merchant: 'OpenRouter',
    reused: false,
    orderState: 'open',
    expired: false,
    network: net,
    chainId: net === 'tron' ? '728126428' : '1600',
    tokenSymbol: token,
    tokenIdentityDisplay: net === 'ton' ? JETTON : null,
    receivingAddressDisplay: net === 'tron' ? TRON_ADDR : TON_ADDR,
    expectedAmount: amount,
    expectedAmountAtomic: atomic,
    paymentReference: net === 'ton' ? '123456' : null,
    expiresAt: exp,
    serverTime: new Date().toISOString(),
    linkExpiresAt: null,
    fees: { invoiceUsd: '5.00', serviceFeeUsd: '0.05', feeBps: 100, networkFeeUsd: '0.02', totalUsd: '5.07' },
    ...over,
  };
}

function mockFetch(o: { cap?: any; capStatus?: number; capThrows?: boolean; option?: any; optionStatus?: number; status?: any; statusCode?: number; quote?: any } = {}) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const reply = (j: unknown, status = 200) => new Response(typeof j === 'string' ? j : JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${MPP_BASE}/tron-ton-alpha/capability`) {
      if (o.capThrows) throw new TypeError('network down');
      return reply(o.cap ?? CAP_ALL, o.capStatus ?? 200);
    }
    if (url === `${MPP_BASE}/tron-ton-alpha/option`) return reply(o.option ?? optionBody(body.network, body.token), o.optionStatus ?? 200);
    if (url.startsWith(`${MPP_BASE}/invoice-status?payment_id=`)) return reply(o.status ?? { error: 'not found' }, o.statusCode ?? 404);
    if (url === `${MPP_BASE}/quote-invoice`) {
      return reply({
        linkId: 'pl_01TRON',
        merchant: 'OpenRouter',
        invoice: { amount: '5.00', fiat: 'USD' },
        callerPays: '5.05',
        quote: { callerPaysAtomicUsdc: '5050000', originalAtomicUsdc: '5000000', serviceFeeAtomicUsdc: '50000', feeBps: 100 },
        coinbasePayment: { status: 'ACTIVE', usageCount: 0, maxUsage: 1, preApprovalExpiry: new Date(Date.now() + 3600_000).toISOString() },
        ...(o.quote ?? {}),
      });
    }
    return reply({ error: 'unexpected' }, 500);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

async function call(name: string, args: unknown, fetchFn: typeof fetch) {
  const req = new Request('https://mcp.rozo.ai/mcp?src=test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await handleMcp(req, fetchFn, {});
  const out = (await res.json()) as any;
  return { isError: out.result.isError === true, payload: JSON.parse(out.result.content[0].text) };
}

const create = (fn: typeof fetch, chainId: string, tokenSymbol: string, extra: Record<string, unknown> = {}) =>
  call('create_deposit_order', { url: LINK, chainId, tokenSymbol, ...extra }, fn);

describe('supported_coins: TRON, TON and web-only routes', () => {
  it('lists TRON (Beta) and TON with route, decimals and fee, plus the web-only pages, without a network call', async () => {
    const { fn, calls } = mockFetch();
    const { payload } = await call('supported_coins', {}, fn);
    const tron = payload.supportedSources.find((r: any) => r.chainId === '728126428');
    const ton = payload.supportedSources.find((r: any) => r.chainId === '1600');
    expect(tron).toMatchObject({ chain: 'TRON', tokens: ['USDT', 'TRX'], decimals: { USDT: 6, TRX: 6 }, beta: true, route: 'tron_ton_alpha', fee: '1% with a $0.30 minimum' });
    expect(ton).toMatchObject({ chain: 'TON', tokens: ['USDT'], decimals: { USDT: 6 }, beta: false, route: 'tron_ton_alpha', fee: '1%' });
    expect(payload.webOnlyRoutes.map((r: any) => r.url)).toEqual(['https://checkout.rozo.ai/zec', 'https://checkout.rozo.ai/arc', 'https://checkout.rozo.ai/btc-onchain']);
    // On-chain BTC (PR-12): web only, Beta, never a create_deposit_order chain id (not "9000"), never Lightning.
    const btc = payload.webOnlyRoutes.find((r: any) => r.url.endsWith('/btc-onchain'));
    expect(btc).toMatchObject({ chain: 'Bitcoin', tokens: ['BTC'], beta: true });
    expect(btc.name).toMatch(/on-chain, not Lightning/);
    expect(payload.supportedSources.map((r: any) => r.chainId)).not.toContain('9000');
    expect(calls).toHaveLength(0);
  });
  it('never leaks internal-only items (Arc / Celo chain ids, Celo, DTOKEN, TRON pool internals)', async () => {
    const { fn } = mockFetch();
    const req = new Request('https://mcp.rozo.ai/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const list = await (await handleMcp(req, fn, {})).text();
    const coins = JSON.stringify((await call('supported_coins', {}, fn)).payload);
    for (const text of [list, coins]) {
      expect(text).not.toMatch(/\b5042\b|\b42220\b|\bCelo\b|\bDTOKEN\b/);
      // Same patterns as ainative ops/supported-matrix-baseline.json docs_internal_patterns.
      expect(text).not.toMatch(/\bTRON_[A-Z0-9_]{3,}\b|\broute_first\b/);
      expect(text).not.toMatch(/\bflush(ing)?\b/i);
    }
  });
});

describe('quote_invoice: TRON / TON availability', () => {
  it('adds TRON and TON when the capability is enabled', async () => {
    const { fn } = mockFetch();
    const { payload } = await call('quote_invoice', { url: LINK }, fn);
    const ids = payload.supportedSources.map((r: any) => r.chainId);
    expect(ids).toContain('728126428');
    expect(ids).toContain('1600');
    expect(payload.tronTon).toMatch(/USDT and TRX on TRON \(Beta\); USDT on TON/);
  });
  it('narrows to the coins the capability enables', async () => {
    const { fn } = mockFetch({ cap: { ok: true, enabled: true, options: [{ network: 'tron', token: 'USDT' }, { network: 'tron', token: 'BOGUS' }] } });
    const { payload } = await call('quote_invoice', { url: LINK }, fn);
    expect(payload.supportedSources.find((r: any) => r.chainId === '728126428').tokens).toEqual(['USDT']);
    expect(payload.supportedSources.find((r: any) => r.chainId === '1600')).toBeUndefined();
  });
  it('omits them with a note when the capability is off (read twice)', async () => {
    const { fn, calls } = mockFetch({ cap: { ok: true, enabled: false, options: [] } });
    const { isError, payload } = await call('quote_invoice', { url: LINK }, fn);
    expect(isError).toBe(false);
    expect(payload.supportedSources.map((r: any) => r.chainId)).not.toContain('728126428');
    expect(payload.tronTon).toMatch(/not available right now/);
    expect(calls.filter((c) => c.url.endsWith('/capability'))).toHaveLength(2);
  });
  it('still quotes when the capability read fails', async () => {
    const { fn } = mockFetch({ capThrows: true });
    const { isError, payload } = await call('quote_invoice', { url: LINK }, fn);
    expect(isError).toBe(false);
    expect(payload.payable).toBe(true);
    expect(payload.tronTon).toMatch(/could not be checked/);
  });
  it('does not duplicate a chain the standard quote already lists', async () => {
    const { fn } = mockFetch({ quote: { supportedSources: { '728126428': ['USDT'] } } });
    const { payload } = await call('quote_invoice', { url: LINK }, fn);
    // offeredSources only maps the standard table, so the alpha row appears exactly once.
    expect(payload.supportedSources.filter((r: any) => r.chainId === '728126428')).toHaveLength(1);
  });
});

describe('create_deposit_order: TRON / TON', () => {
  it('TRON USDT: exact amount, address only, no memo, through the alpha route only', async () => {
    const { fn, calls } = mockFetch();
    const { isError, payload } = await create(fn, '728126428', 'usdt');
    expect(isError).toBe(false);
    const opt = calls.find((c) => c.url.endsWith('/tron-ton-alpha/option'))!;
    expect(opt.method).toBe('POST');
    expect(opt.body).toEqual({ url: LINK, network: 'tron', token: 'USDT' });
    expect(calls.some((c) => c.url.endsWith('/create-invoice') || c.url.endsWith('/quote-invoice'))).toBe(false);
    expect(payload.route).toBe('tron_ton_alpha');
    expect(payload.deposit).toMatchObject({ chainId: '728126428', chain: 'TRON', beta: true, tokenSymbol: 'USDT', payTo: TRON_ADDR, memo: null, memoRequired: false, amount: '5.07', amountBaseUnits: '5070000', decimals: 6, exactOut: true, native: false });
    expect(payload.deposit.tokenContract).toBeUndefined();
    expect(payload.fees.totalUsd).toBe('5.07');
    expect(payload.statusCheck).toEqual({ tool: 'payment_status', arguments: { url: LINK } });
    const text = payload.instructions.join(' ');
    expect(text).toMatch(/EXACTLY 5\.07 USDT/);
    expect(text).toMatch(/address only: no memo/);
    expect(text).toMatch(/one payment only/i);
    expect(text).toMatch(/Never reuse/);
    expect(payload.rozoPaymentId).toBeUndefined();
  });
  it('TRON TRX: one-decimal amount in sun', async () => {
    const { fn } = mockFetch();
    const { isError, payload } = await create(fn, '728126428', 'TRX');
    expect(isError).toBe(false);
    expect(payload.deposit).toMatchObject({ tokenSymbol: 'TRX', amount: '41.3', amountBaseUnits: '41300000', native: true });
    expect(payload.instructions.join(' ')).toMatch(/native TRX/);
  });
  it('TON USDT on a shared address: the six digit comment is required', async () => {
    const { fn, calls } = mockFetch();
    const { isError, payload } = await create(fn, '1600', 'USDT');
    expect(isError).toBe(false);
    expect(calls.find((c) => c.url.endsWith('/option'))!.body).toEqual({ url: LINK, network: 'ton', token: 'USDT' });
    expect(payload.deposit).toMatchObject({ chain: 'TON', beta: false, payTo: TON_ADDR, memo: '123456', memoType: 'text', memoRequired: true, addressPerOrder: false, tokenContract: JETTON });
    expect(payload.instructions.join(' ')).toMatch(/comment \(memo\) 123456/);
  });
  it('TON USDT on a per-order address: no comment, with or without a reference', async () => {
    for (const ref of [null, '654321']) {
      const { fn } = mockFetch({ option: optionBody('ton', 'USDT', { addressPerOrder: true, paymentReference: ref }) });
      const { isError, payload } = await create(fn, '1600', 'USDT');
      expect(isError).toBe(false);
      expect(payload.deposit).toMatchObject({ memo: null, memoRequired: false, addressPerOrder: true });
      expect(payload.instructions.join(' ')).toMatch(/no comment is needed/);
    }
  });
  it('rejects coins the route does not serve, before any network call', async () => {
    const { fn, calls } = mockFetch();
    for (const [chain, tok] of [['728126428', 'USDC'], ['1600', 'TON'], ['1600', 'TRX']]) {
      const { isError, payload } = await create(fn, chain!, tok!);
      expect(isError).toBe(true);
      expect(payload.error.code).toBe('UNSUPPORTED_SOURCE');
    }
    expect(calls).toHaveLength(0);
  });
  it('does not forward a contact email and says so', async () => {
    const { fn, calls } = mockFetch();
    const { payload } = await create(fn, '728126428', 'USDT', { email: 'a@b.co' });
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('a@b.co');
    expect(payload.contactEmailProvided).toBe(false);
    expect(payload.contactEmailNote).toMatch(/does not take a contact email/);
  });

  const ERRORS: [string, number, string, boolean][] = [
    ['ALPHA_UNAVAILABLE', 404, 'ROUTE_UNAVAILABLE', false],
    ['UNSUPPORTED_SOURCE', 400, 'ROUTE_UNAVAILABLE', false],
    ['UNSUPPORTED_INVOICE', 400, 'ROUTE_UNAVAILABLE', false],
    ['ALPHA_CAPACITY', 503, 'ROUTE_AT_CAPACITY', false],
    ['ALPHA_PRICE_UNAVAILABLE', 503, 'PRICE_UNAVAILABLE', false],
    ['ALPHA_AMOUNT_TOO_HIGH', 422, 'AMOUNT_TOO_HIGH', false],
    ['LINK_EXPIRES_TOO_SOON', 422, 'NOT_ENOUGH_TIME', false],
    ['PAYMENT_ALREADY_PAID', 409, 'LINK_ALREADY_PAID', true],
    ['ALPHA_ORDER_EXPIRED', 410, 'ORDER_EXPIRED', true],
    ['LINK_USED_OR_EXPIRED', 410, 'LINK_NO_LONGER_PAYABLE', true],
    ['ALPHA_ORDER_CONFLICT', 409, 'ORDER_NEEDS_REVIEW', true],
    ['ALPHA_ORDER_CLOSED', 409, 'ORDER_NEEDS_REVIEW', true],
    ['RATE_LIMITED', 429, 'RATE_LIMITED', false],
    ['ALPHA_UPSTREAM_FAILED', 502, 'ROUTE_FAILED', false],
    ['SERVER_MISCONFIGURED', 500, 'ROUTE_FAILED', false],
  ];
  for (const [upstream, http, code, doNotPay] of ERRORS) {
    it(`maps ${upstream} to ${code} and never returns an address`, async () => {
      const { fn } = mockFetch({ option: { error: 'x', code: upstream, message: 'm' }, optionStatus: http });
      const { isError, payload } = await create(fn, '728126428', 'USDT');
      expect(isError).toBe(true);
      expect(payload.error.code).toBe(code);
      expect(payload.upstreamCode).toBe(upstream);
      expect(payload.doNotPay).toBe(doNotPay);
      expect(JSON.stringify(payload)).not.toContain(TRON_ADDR);
    });
  }
  it('sanitizes an odd upstream code', async () => {
    const { fn } = mockFetch({ option: { code: 'weird<script>' }, optionStatus: 500 });
    const { payload } = await create(fn, '728126428', 'USDT');
    expect(payload.upstreamCode).toBe('UNKNOWN');
    expect(payload.error.code).toBe('ROUTE_FAILED');
  });

  const MALFORMED: [string, 'tron' | 'ton', string, Record<string, unknown>][] = [
    ['ok missing', 'tron', 'USDT', { ok: undefined }],
    ['alpha false', 'tron', 'USDT', { alpha: false }],
    ['other network', 'tron', 'USDT', { network: 'ton' }],
    ['other token', 'tron', 'USDT', { tokenSymbol: 'TRX' }],
    ['bad TRON address', 'tron', 'USDT', { receivingAddressDisplay: '0x' + 'a'.repeat(40) }],
    ['TRON address with 0', 'tron', 'USDT', { receivingAddressDisplay: 'T0' + 'R'.repeat(32) }],
    ['atomic mismatch', 'tron', 'USDT', { expectedAmountAtomic: '5070001' }],
    ['amount three decimals', 'tron', 'USDT', { expectedAmount: '5.070', expectedAmountAtomic: '5070000' }],
    ['TRX two decimals', 'tron', 'TRX', { expectedAmount: '41.30', expectedAmountAtomic: '41300000' }],
    ['zero amount', 'tron', 'USDT', { expectedAmount: '0.00', expectedAmountAtomic: '0' }],
    ['TRON with a reference', 'tron', 'USDT', { paymentReference: '123456' }],
    ['TON shared without a reference', 'ton', 'USDT', { paymentReference: null }],
    ['TON five digit reference', 'ton', 'USDT', { paymentReference: '12345' }],
    ['TON per-order bad reference', 'ton', 'USDT', { addressPerOrder: true, paymentReference: 'abc' }],
    ['TON bad jetton', 'ton', 'USDT', { tokenIdentityDisplay: 'short' }],
    ['TON bad address', 'ton', 'USDT', { receivingAddressDisplay: TRON_ADDR }],
    ['no expiry', 'tron', 'USDT', { expiresAt: 'soon' }],
    ['bad link expiry', 'tron', 'USDT', { linkExpiresAt: 'never' }],
  ];
  for (const [label, net, token, over] of MALFORMED) {
    it(`refuses a malformed 200 answer: ${label}`, async () => {
      const { fn } = mockFetch({ option: optionBody(net, token, over) });
      const { isError, payload } = await create(fn, net === 'tron' ? '728126428' : '1600', token);
      expect(isError).toBe(true);
      expect(payload.error.code).toBe('DEPOSIT_INCOMPLETE');
      expect(payload.upstreamCode).toBe('MALFORMED');
    });
  }
  it('refuses a non-JSON 200 answer', async () => {
    const { fn } = mockFetch({ option: 'not json' });
    const { isError, payload } = await create(fn, '728126428', 'USDT');
    expect(isError).toBe(true);
    expect(payload.error.code).toBe('DEPOSIT_INCOMPLETE');
  });
  it('refuses an answer for another link', async () => {
    const { fn } = mockFetch({ option: optionBody('tron', 'USDT', { linkId: 'pl_OTHER' }) });
    const { payload } = await create(fn, '728126428', 'USDT');
    expect(payload.error.code).toBe('DEPOSIT_INCOMPLETE');
  });
  it('refuses paid, closed and expired orders', async () => {
    for (const [over, code] of [
      [{ orderState: 'paid' }, 'ORDER_ALREADY_FUNDED'],
      [{ orderState: 'closed' }, 'ORDER_NEEDS_REVIEW'],
      [{ expired: true }, 'ORDER_EXPIRED'],
      [{ expiresAt: new Date(Date.now() - 1000).toISOString() }, 'ORDER_EXPIRED'],
    ] as const) {
      const { fn } = mockFetch({ option: optionBody('tron', 'USDT', over) });
      const { isError, payload } = await create(fn, '728126428', 'USDT');
      expect(isError).toBe(true);
      expect(payload.error.code).toBe(code);
      expect(JSON.stringify(payload)).not.toContain(TRON_ADDR);
    }
  });
  it('refuses with less than 10 minutes left, on our clock or the router clock', async () => {
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const a = mockFetch({ option: optionBody('tron', 'USDT', { expiresAt: soon }) });
    expect((await create(a.fn, '728126428', 'USDT')).payload.error.code).toBe('NOT_ENOUGH_TIME');
    // Router clock 50 minutes ahead: only 5 minutes left by its own time.
    const b = mockFetch({ option: optionBody('tron', 'USDT', { serverTime: new Date(Date.now() + 50 * 60 * 1000).toISOString() }) });
    expect((await create(b.fn, '728126428', 'USDT')).payload.error.code).toBe('NOT_ENOUGH_TIME');
  });
  it('refuses when the payment link dies before the order deadline', async () => {
    const { fn } = mockFetch({ option: optionBody('tron', 'USDT', { linkExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString() }) });
    expect((await create(fn, '728126428', 'USDT')).payload.error.code).toBe('NOT_ENOUGH_TIME');
  });
  it('refuses a blacklisted receiving address', async () => {
    const { fn } = mockFetch({ option: optionBody('tron', 'USDT', { receivingAddressDisplay: 'TBcegJf63xa5r7hi5jmqSsTnSEAAFkUcGu' }) });
    const { payload } = await create(fn, '728126428', 'USDT');
    expect(payload.error.code).toBe('BLACKLIST_HIT');
    expect(JSON.stringify(payload)).not.toContain('TBcegJf63xa5r7hi5jmqSsTnSEAAFkUcGu');
  });
  it('stops before creating anything when the link already shows a payment', async () => {
    for (const [status, code] of [
      [{ ok: true, pl_id: 'pl_01TRON', payin: { confirmed: true } }, 'ORDER_ALREADY_FUNDED'],
      [{ ok: true, pl_id: 'pl_01TRON', coinbase: { settled: true } }, 'ORDER_ALREADY_FUNDED'],
      [{ ok: true, pl_id: 'pl_01TRON', routerState: { status: 'manual_review' } }, 'ORDER_NEEDS_REVIEW'],
      [{ ok: true, pl_id: 'pl_01TRON', rozoPayment: { amountMismatch: true } }, 'ORDER_NEEDS_REVIEW'],
    ] as const) {
      const { fn, calls } = mockFetch({ status, statusCode: 200 });
      const { payload } = await create(fn, '728126428', 'USDT');
      expect(payload.error.code).toBe(code);
      expect(calls.some((c) => c.url.endsWith('/option'))).toBe(false);
    }
  });
  it('proceeds when the status read for an unknown link is 404 or unreachable', async () => {
    const { fn } = mockFetch();
    expect((await create(fn, '728126428', 'USDT')).isError).toBe(false);
    const flaky = async (url: string, init?: RequestInit) => {
      if (url.includes('invoice-status')) throw new TypeError('down');
      return mockFetch().fn(url, init);
    };
    expect((await create(flaky as unknown as typeof fetch, '728126428', 'USDT')).isError).toBe(false);
  });
  it('ignores a status answer for a different link', async () => {
    const { fn } = mockFetch({ status: { ok: true, pl_id: 'pl_OTHER', payin: { confirmed: true } }, statusCode: 200 });
    expect((await create(fn, '728126428', 'USDT')).isError).toBe(false);
  });
});

describe('payment_status by url (TRON / TON)', () => {
  const status = (fn: typeof fetch, url = LINK) => call('payment_status', { url }, fn);
  it('reports settled, paid, review and pending', async () => {
    const cases: [any, string][] = [
      [{ ok: true, pl_id: 'pl_01TRON', coinbase: { settled: true, status: 'COMPLETED' }, payin: { confirmed: true } }, 'settled'],
      [{ ok: true, pl_id: 'pl_01TRON', payin: { confirmed: true }, routerState: { status: 'pending' } }, 'paid'],
      [{ ok: true, pl_id: 'pl_01TRON', payin: { confirmed: true }, routerState: { status: 'failed_provider' } }, 'review'],
      [{ ok: true, pl_id: 'pl_01TRON', payin: { confirmed: false } }, 'pending'],
    ];
    for (const [s, phase] of cases) {
      const { fn, calls } = mockFetch({ status: s, statusCode: 200 });
      const { isError, payload } = await status(fn);
      expect(isError).toBe(false);
      expect(payload.phase).toBe(phase);
      expect(payload.settled).toBe(phase === 'settled');
      expect(calls[0]!.url).toBe(`${MPP_BASE}/invoice-status?payment_id=pl_01TRON`);
      expect(calls.every((c) => c.method === 'GET')).toBe(true);
    }
  });
  it('a v3 session is settled only at CAPTURE_SUCCEEDED (case-insensitive id match)', async () => {
    const upper = SESSION_ID.replace('paymentSession_', 'paymentSession_').toUpperCase().replace('PAYMENTSESSION_', 'paymentSession_');
    const a = mockFetch({ status: { ok: true, pl_id: upper, coinbase: { settled: true, status: 'PAYMENT_SESSION_STATUS_AUTHORIZED' }, payin: { confirmed: true } }, statusCode: 200 });
    expect((await status(a.fn, SESSION)).payload.phase).toBe('paid');
    const b = mockFetch({ status: { ok: true, pl_id: upper, coinbase: { settled: true, status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' } }, statusCode: 200 });
    expect((await status(b.fn, SESSION)).payload.phase).toBe('settled');
  });
  it('reports not_found on 404 and refuses a status for another link', async () => {
    const a = mockFetch();
    expect((await status(a.fn)).payload.phase).toBe('not_found');
    const b = mockFetch({ status: { ok: true, pl_id: 'pl_OTHER', payin: { confirmed: true } }, statusCode: 200 });
    const r = await status(b.fn);
    expect(r.isError).toBe(true);
    expect(r.payload.error.code).toBe('STATUS_MISMATCH');
  });
  it('needs exactly one of rozoPaymentId and url', async () => {
    const { fn, calls } = mockFetch();
    const both = await call('payment_status', { url: LINK, rozoPaymentId: '11111111-2222-3333-4444-555555555555' }, fn);
    expect(both.payload.error.code).toBe('INVALID_INPUT');
    const none = await call('payment_status', {}, fn);
    expect(none.payload.error.code).toBe('BAD_ROZO_PAYMENT_ID');
    const bad = await call('payment_status', { url: 'https://evil.example/pl_x' }, fn);
    expect(bad.payload.error.code).toBe('BAD_LINK');
    expect(calls).toHaveLength(0);
  });
});

describe('alpha helpers', () => {
  it('capabilityPairs ignores disabled and malformed answers', () => {
    expect(capabilityPairs(null)).toEqual([]);
    expect(capabilityPairs({ enabled: false, options: CAP_ALL.options })).toEqual([]);
    expect(capabilityPairs({ enabled: true, options: 'x' })).toEqual([]);
    expect(capabilityPairs(CAP_ALL)).toHaveLength(3);
  });
  it('alphaOptionFromBody and alphaStatusPhase fail closed', () => {
    expect(alphaOptionFromBody(optionBody('tron', 'USDT'), 'tron', 'USDT')).not.toBeNull();
    expect(alphaOptionFromBody(optionBody('ton', 'USDT'), 'ton', 'TRX')).toBeNull();
    expect(alphaStatusPhase({ ok: true, payin: { confirmed: true } }, 'pl_01TRON')).toBe('');
    expect(alphaFailure('ANYTHING').code).toBe('ROUTE_FAILED');
  });
});
