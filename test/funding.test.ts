import { describe, expect, it } from 'vitest';
import { handleMcp } from '../src/index';
import { FUNDING_BASE, STELLAR_PUBLIC_PASSPHRASE, upstreamOrderIds } from '../src/funding';
import caps from './fixtures/funding-capabilities.json';
import quoteFixture from './fixtures/funding-quote.json';

// Valid-looking G address (not a real funded account).
const RECEIVER = 'GBBPI5SMAFK23RUKTKJRSG5FBVBWDT2MMZ4SP3M6G3VRKU2PATSWWFJY';
const QUOTE = JSON.parse(JSON.stringify(quoteFixture).replaceAll('RECEIVER_PLACEHOLDER', RECEIVER));
const FUNDING_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SR_ID = '99999999-8888-4777-8666-555555555555';
const DEPOSIT = '0x1234567890abcdef1234567890abcdef12345678';
const SIGNED = 'AAAAAgAAAA' + 'b'.repeat(200) + '==';

type Call = { url: string; method: string; body: any; headers: Record<string, string> };

function reply(j: unknown, status = 200) {
  return new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(routes: Record<string, (body: any) => Response>) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? 'GET', body, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = url.startsWith(FUNDING_BASE) ? url.slice(FUNDING_BASE.length) : url;
    const route = routes[`${init?.method ?? 'GET'} ${path}`];
    return route ? route(body) : reply({ code: 'unexpected', message: 'unexpected' }, 500);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

async function call(name: string, args: unknown, fetchFn: typeof fetch) {
  const req = new Request('https://mcp.rozo.ai/mcp?src=test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await handleMcp(req, fetchFn);
  expect(res.status).toBe(200);
  const out = (await res.json()) as any;
  const text = out.result.content[0].text as string;
  let payload: any = null;
  try { payload = JSON.parse(text); } catch { /* SDK validation errors are plain text */ }
  return { isError: Boolean(out.result.isError), text, payload };
}

const order = (over: Record<string, unknown> = {}) => ({
  fundingId: FUNDING_ID,
  orderId: 'agent-order-0001',
  status: 'awaiting_payment',
  stateVersion: 1,
  deposit: { chainId: '8453', assetId: 'erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', address: DEPOSIT, amount: '10', payBefore: '2099-01-01T00:00:00Z', memo: null },
  legs: QUOTE.legs,
  fees: QUOTE.fees,
  totals: QUOTE.totals,
  pendingActions: [{ kind: 'pay_source', legIds: [], dueBy: '2099-01-01T00:00:00Z' }],
  recovery: null,
  ...over,
});

describe('tool descriptions', () => {
  it('state the fee, signature, deposit and exact-amount rules', async () => {
    const { fn } = mockFetch({});
    const req = new Request('https://mcp.rozo.ai/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const tools = ((await (await handleMcp(req, fn)).json()) as any).result.tools as any[];
    for (const name of ['funding_capabilities', 'stellar_wallet_quote', 'stellar_wallet_create_order']) {
      const d = tools.find((t) => t.name === name).description as string;
      expect(d).toMatch(/Fees come from the quote/);
      expect(d).toMatch(/ONE transaction/);
      expect(d).toMatch(/same on Base, Ethereum, Arbitrum and Polygon/);
      expect(d).toMatch(/USDC or USDT is accepted 1:1/);
      expect(d).toMatch(/EXACT deposit amount/);
      expect(d).toMatch(/amountPolicy/);
    }
    // No tool takes a secret key.
    for (const t of tools) expect(JSON.stringify(t.inputSchema)).not.toMatch(/secretKey|privateKey|"secret"/i);
  });
});

describe('funding_capabilities', () => {
  it('summarizes the keyless capabilities with no API key header', async () => {
    const { fn, calls } = mockFetch({ 'GET /capabilities': () => reply(caps) });
    const { isError, payload } = await call('funding_capabilities', {}, fn);
    expect(isError).toBe(false);
    expect(payload.stellarOnboarding.status).toBe('supported');
    expect(payload.gasOptions.options.map((o: any) => o.usdGas)).toEqual(['0', '0.5', '1']);
    expect(payload.sourceAssets.map((a: any) => a.chainId).sort()).toEqual(['1', '137', '42161', '8453']);
    expect(Object.keys(calls[0]!.headers).map((h) => h.toLowerCase())).not.toContain('x-api-key');
  });
});

describe('stellar_wallet_quote', () => {
  it('builds the stellar_onboarding body from capabilities and returns the quote fees', async () => {
    const { fn, calls } = mockFetch({ 'GET /capabilities': () => reply(caps), 'POST /quotes': () => reply(QUOTE, 201) });
    const { isError, payload } = await call('stellar_wallet_quote', { receiverAddress: RECEIVER, sourceChain: 'ethereum', amountUsd: '10', usdGas: '1' }, fn);
    expect(isError).toBe(false);
    const q = calls.find((c) => c.url.endsWith('/quotes'))!;
    expect(q.method).toBe('POST');
    expect(q.body).toEqual({
      mode: 'stellar_onboarding',
      reserveMode: 'sponsored',
      source: { chainId: '1', assetId: 'erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', amount: '10' },
      outputs: [{ id: 'stable', kind: 'stable', chainId: '1500', assetId: 'stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', receiverAddress: RECEIVER, allocation: 'remainder' }],
      usdGas: '1',
    });
    expect(payload.quoteId).toBe(QUOTE.quoteId);
    expect(payload.planDigest).toBe(QUOTE.planDigest);
    expect(payload.fees).toEqual([{ kind: 'bridge_fee', usd: '0.01', appliesTo: 'stable', refundable: true }]);
    expect(payload.totals.totalFeesUsd).toBe('0.01');
    expect(payload.receives).toEqual({ usdcMinimum: '9.4898612', xlm: '1.6' });
    expect(payload.signatureNeeded).toBe(true);
  });

  it('omits usdGas when not given (server default)', async () => {
    const { fn, calls } = mockFetch({ 'GET /capabilities': () => reply(caps), 'POST /quotes': () => reply(QUOTE, 201) });
    await call('stellar_wallet_quote', { receiverAddress: RECEIVER, sourceChain: 'base', amountUsd: '10' }, fn);
    const body = calls.find((c) => c.url.endsWith('/quotes'))!.body;
    expect('usdGas' in body).toBe(false);
    expect(body.source.chainId).toBe('8453');
  });

  it('refuses a secret key without echoing it or calling upstream', async () => {
    const { fn, calls } = mockFetch({});
    const secret = 'S' + 'A'.repeat(55);
    const { isError, text } = await call('stellar_wallet_quote', { receiverAddress: secret, sourceChain: 'base', amountUsd: '10' }, fn);
    expect(isError).toBe(true);
    expect(text).toMatch(/SECRET_KEY_REFUSED/);
    expect(text).not.toContain(secret);
    expect(calls).toHaveLength(0);
  });

  it('refuses a blacklisted receiver', async () => {
    const { fn, calls } = mockFetch({});
    const { isError, text } = await call('stellar_wallet_quote', { receiverAddress: 'GD2UZOA5RFWILHTPQL6CDTLIT6XPEGZQXJX4NWQC7ZU7DCEXK5NSQ2GH', sourceChain: 'base', amountUsd: '10' }, fn);
    expect(isError).toBe(true);
    expect(text).toMatch(/BLACKLIST_HIT/);
    expect(calls).toHaveLength(0);
  });

  it('stops when stellar_onboarding is disabled', async () => {
    const off = { ...caps, modes: caps.modes.map((m: any) => (m.mode === 'stellar_onboarding' ? { ...m, status: 'disabled', reason: 'app_not_enabled' } : m)) };
    const { fn, calls } = mockFetch({ 'GET /capabilities': () => reply(off) });
    const { isError, text } = await call('stellar_wallet_quote', { receiverAddress: RECEIVER, sourceChain: 'base', amountUsd: '10' }, fn);
    expect(isError).toBe(true);
    expect(text).toMatch(/FUNDING_UNAVAILABLE/);
    expect(calls.some((c) => c.url.endsWith('/quotes'))).toBe(false);
  });

  it('passes upstream error codes through', async () => {
    const { fn } = mockFetch({
      'GET /capabilities': () => reply(caps),
      'POST /quotes': () => reply({ code: 'limit_exceeded', message: 'Amount above limit', retryable: false, nextAction: 'change_request', correlationId: 'c1' }, 422),
    });
    const { isError, payload } = await call('stellar_wallet_quote', { receiverAddress: RECEIVER, sourceChain: 'base', amountUsd: '5000' }, fn);
    expect(isError).toBe(true);
    expect(payload.error.code).toBe('limit_exceeded');
    expect(payload.httpStatus).toBe(422);
  });
});

describe('stellar_wallet_create_order', () => {
  it('sends upstream ids derived from quoteId + orderId and returns the deposit', async () => {
    const { fn, calls } = mockFetch({ 'POST /orders': () => reply(order(), 201) });
    const { isError, payload } = await call('stellar_wallet_create_order', { quoteId: QUOTE.quoteId, planDigest: QUOTE.planDigest, orderId: 'agent-order-0001' }, fn);
    expect(isError).toBe(false);
    const c = calls[0]!;
    const up = await upstreamOrderIds(QUOTE.quoteId, 'agent-order-0001');
    expect(c.headers['idempotency-key']).toBe(up.idempotencyKey);
    expect(c.body).toEqual({ quoteId: QUOTE.quoteId, planDigest: QUOTE.planDigest, orderId: up.orderId });
    // The caller's own reference never leaves the server; it is echoed back to the caller.
    expect(JSON.stringify(c.body) + c.headers['idempotency-key']).not.toContain('agent-order-0001');
    expect(payload.orderId).toBe('agent-order-0001');
    expect(payload.upstreamOrderId).toBe(up.orderId);
    expect(payload.fundingId).toBe(FUNDING_ID);
    expect(payload.replayed).toBe(false);
    expect(payload.deposit.address).toBe(DEPOSIT);
    expect(payload.deposit.amount).toBe('10');
    expect(payload.deposit.payBefore).toBe('2099-01-01T00:00:00Z');
    expect(payload.deposit.acceptedChains).toEqual(['Base', 'Ethereum', 'Arbitrum', 'Polygon']);
    expect(payload.deposit.acceptedTokens[0]).toHaveProperty('USDT');
  });

  it('derives stable, namespaced upstream ids within the upstream charset and length limits', async () => {
    const q1 = QUOTE.quoteId as string;
    const q2 = '11111111-2222-4333-8444-555555555555';
    const a = await upstreamOrderIds(q1, 'agent-order-0001');
    // Stable across retries of the same call (and quoteId case).
    expect(await upstreamOrderIds(q1, 'agent-order-0001')).toEqual(a);
    expect(await upstreamOrderIds(q1.toUpperCase(), 'agent-order-0001')).toEqual(a);
    // Two callers using the same reference on different quotes do not collide.
    const b = await upstreamOrderIds(q2, 'agent-order-0001');
    expect(b.orderId).not.toBe(a.orderId);
    expect(b.idempotencyKey).not.toBe(a.idempotencyKey);
    // Different references on the same quote differ too.
    expect((await upstreamOrderIds(q1, 'agent-order-0002')).orderId).not.toBe(a.orderId);
    // Upstream: orderId [A-Za-z0-9_.:-]{1,128}, Idempotency-Key [A-Za-z0-9_.:-]{8,128}.
    for (const id of [a.orderId, a.idempotencyKey, (await upstreamOrderIds(q1, 'x'.repeat(128))).orderId]) {
      expect(id).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    }
    expect(a.orderId).not.toBe(a.idempotencyKey);
  });

  it('two callers with the same orderId send different upstream ids', async () => {
    const { fn, calls } = mockFetch({ 'POST /orders': () => reply(order(), 201) });
    const q2 = '11111111-2222-4333-8444-555555555555';
    await call('stellar_wallet_create_order', { quoteId: QUOTE.quoteId, planDigest: QUOTE.planDigest, orderId: 'agent-order-0001' }, fn);
    await call('stellar_wallet_create_order', { quoteId: q2, planDigest: QUOTE.planDigest, orderId: 'agent-order-0001' }, fn);
    await call('stellar_wallet_create_order', { quoteId: QUOTE.quoteId, planDigest: QUOTE.planDigest, orderId: 'agent-order-0001' }, fn);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.body.orderId).not.toBe(calls[1]!.body.orderId);
    expect(calls[0]!.headers['idempotency-key']).not.toBe(calls[1]!.headers['idempotency-key']);
    // A retry of the first call repeats its ids exactly.
    expect(calls[2]!.body).toEqual(calls[0]!.body);
    expect(calls[2]!.headers['idempotency-key']).toBe(calls[0]!.headers['idempotency-key']);
  });

  it('marks an idempotent replay (200)', async () => {
    const { fn } = mockFetch({ 'POST /orders': () => reply(order(), 200) });
    const { payload } = await call('stellar_wallet_create_order', { quoteId: QUOTE.quoteId, planDigest: QUOTE.planDigest, orderId: 'agent-order-0001' }, fn);
    expect(payload.replayed).toBe(true);
  });

  it('rejects a short orderId and a bad digest locally', async () => {
    const { fn, calls } = mockFetch({});
    expect((await call('stellar_wallet_create_order', { quoteId: QUOTE.quoteId, planDigest: QUOTE.planDigest, orderId: 'short' }, fn)).text).toMatch(/BAD_ORDER_ID/);
    expect((await call('stellar_wallet_create_order', { quoteId: QUOTE.quoteId, planDigest: 'xyz', orderId: 'agent-order-0001' }, fn)).text).toMatch(/BAD_PLAN_DIGEST/);
    expect(calls).toHaveLength(0);
  });

  it('withholds a blacklisted deposit address', async () => {
    const bad = order({ deposit: { ...order().deposit, address: '0x5772FBe7a7817ef7F586215CA8b23b8dD22C8897' } });
    const { fn } = mockFetch({ 'POST /orders': () => reply(bad, 201) });
    const { isError, text } = await call('stellar_wallet_create_order', { quoteId: QUOTE.quoteId, planDigest: QUOTE.planDigest, orderId: 'agent-order-0001' }, fn);
    expect(isError).toBe(true);
    expect(text).toMatch(/BLACKLIST_HIT/);
  });
});

describe('stellar_wallet_order_status', () => {
  it('reports legs and the signature action', async () => {
    const legs = QUOTE.legs.map((l: any) => ({ ...l, status: l.kind === 'stable' ? 'ready' : 'planned' }));
    const { fn, calls } = mockFetch({
      [`GET /orders/${FUNDING_ID}`]: () => reply(order({ status: 'action_required', legs, pendingActions: [{ kind: 'sign_stellar_onboarding', legIds: ['native', 'stable'], dueBy: '2099-01-01T00:00:00Z' }] })),
    });
    const { payload } = await call('stellar_wallet_order_status', { fundingId: FUNDING_ID.toUpperCase() }, fn);
    expect(calls[0]!.method).toBe('GET');
    expect(payload.status).toBe('action_required');
    expect(payload.signatureNeeded).toBe(true);
    expect(payload.legs.map((l: any) => l.kind).sort()).toEqual(['native', 'stable']);
    expect(payload.guidance).toMatch(/stellar_wallet_get_signing_request/);
  });

  it('says completed when done', async () => {
    const { fn } = mockFetch({ [`GET /orders/${FUNDING_ID}`]: () => reply(order({ status: 'completed', pendingActions: [] })) });
    const { payload } = await call('stellar_wallet_order_status', { fundingId: FUNDING_ID }, fn);
    expect(payload.guidance).toMatch(/Done/);
  });
});

describe('Stellar signing', () => {
  const sr = (over: Record<string, unknown> = {}) => ({
    signingRequestId: SR_ID,
    fundingId: FUNDING_ID,
    status: 'awaiting_signature',
    templateVersion: 'funding_onboarding_v1',
    networkPassphrase: STELLAR_PUBLIC_PASSPHRASE,
    xdr: 'AAAAAgAAAAA' + 'a'.repeat(100),
    txHash: 'f'.repeat(64),
    expiresAt: '2099-01-01T00:05:00Z',
    accountState: 'missing',
    operations: [{ type: 'createAccount' }, { type: 'changeTrust' }, { type: 'claimClaimableBalance' }],
    ...over,
  });

  it('get_signing_request posts walletAddress and returns xdr + operations', async () => {
    const { fn, calls } = mockFetch({ [`POST /orders/${FUNDING_ID}/signing-requests`]: () => reply(sr(), 201) });
    const { isError, payload } = await call('stellar_wallet_get_signing_request', { fundingId: FUNDING_ID, walletAddress: RECEIVER }, fn);
    expect(isError).toBe(false);
    expect(calls[0]!.body).toEqual({ walletAddress: RECEIVER });
    expect(payload.signingRequestId).toBe(SR_ID);
    expect(payload.xdr).toMatch(/^AAAA/);
    expect(payload.operations).toHaveLength(3);
    expect(payload.expiresAt).toBe('2099-01-01T00:05:00Z');
  });

  it('refuses a non-mainnet signing request', async () => {
    const { fn } = mockFetch({ [`POST /orders/${FUNDING_ID}/signing-requests`]: () => reply(sr({ networkPassphrase: 'Test SDF Network ; September 2015' }), 201) });
    const { isError, text } = await call('stellar_wallet_get_signing_request', { fundingId: FUNDING_ID, walletAddress: RECEIVER }, fn);
    expect(isError).toBe(true);
    expect(text).toMatch(/UNEXPECTED_NETWORK/);
  });

  it('submit_signed forwards the signed XDR', async () => {
    const { fn, calls } = mockFetch({ [`POST /signing-requests/${SR_ID}/submit`]: () => reply(sr({ status: 'submitting', submittedTxHash: 'f'.repeat(64) }), 202) });
    const { isError, payload } = await call('stellar_wallet_submit_signed', { signingRequestId: SR_ID, signedXdr: SIGNED }, fn);
    expect(isError).toBe(false);
    expect(calls[0]!.body).toEqual({ signedXdr: SIGNED });
    expect(payload.status).toBe('submitting');
    expect(payload.confirmed).toBe(false);
    expect(payload.txHash).toBe('f'.repeat(64));
  });

  it('submit_signed refuses a secret key and does not call upstream', async () => {
    const { fn, calls } = mockFetch({});
    const secret = 'S' + 'B'.repeat(55);
    const { isError, text } = await call('stellar_wallet_submit_signed', { signingRequestId: SR_ID, signedXdr: secret }, fn);
    expect(isError).toBe(true);
    expect(text).toMatch(/SECRET_KEY_REFUSED/);
    expect(text).not.toContain(secret);
    expect(calls).toHaveLength(0);
  });
});

describe('review hardening', () => {
  it('create_order replay of a paid or expired order gives no payment instructions', async () => {
    for (const o of [order({ status: 'executing' }), order({ deposit: { ...order().deposit, payBefore: '2000-01-01T00:00:00Z' } })]) {
      const { fn } = mockFetch({ 'POST /orders': () => reply(o, 200) });
      const { isError, payload, text } = await call('stellar_wallet_create_order', { quoteId: QUOTE.quoteId, planDigest: QUOTE.planDigest, orderId: 'agent-order-0001' }, fn);
      expect(isError).toBe(true);
      expect(payload.error.code).toBe('ORDER_NOT_PAYABLE');
      expect(text).not.toContain(DEPOSIT);
    }
  });

  it('refuses key-shaped orderIds without forwarding them', async () => {
    const { fn, calls } = mockFetch({});
    for (const bad of ['S' + 'C'.repeat(55), '0x' + 'a'.repeat(64), 'b'.repeat(64)]) {
      const { text } = await call('stellar_wallet_create_order', { quoteId: QUOTE.quoteId, planDigest: QUOTE.planDigest, orderId: bad }, fn);
      expect(text).toMatch(/SECRET_KEY_REFUSED/);
      expect(text).not.toContain(bad);
    }
    expect(calls).toHaveLength(0);
  });

  it('redacts credentials from lastError and upstream error messages', async () => {
    const seed = 'S' + 'D'.repeat(55);
    const { fn } = mockFetch({
      [`POST /signing-requests/${SR_ID}/submit`]: () => reply({ signingRequestId: SR_ID, fundingId: FUNDING_ID, status: 'submitting', lastError: `signer said ${seed} Bearer abc.def.ghi` }, 202),
      [`GET /orders/${FUNDING_ID}`]: () => reply({ code: 'internal_error', message: `boom 0x${'e'.repeat(64)} ${seed}` }, 500),
    });
    const a = await call('stellar_wallet_submit_signed', { signingRequestId: SR_ID, signedXdr: SIGNED }, fn);
    expect(a.text).not.toContain(seed);
    expect(a.text).not.toContain('abc.def.ghi');
    const b = await call('stellar_wallet_order_status', { fundingId: FUNDING_ID }, fn);
    expect(b.text).not.toContain(seed);
    expect(b.text).not.toContain('e'.repeat(64));
  });
});

describe('order_status after payBefore', () => {
  it('tells the caller not to pay once the window has closed', async () => {
    const { fn } = mockFetch({ [`GET /orders/${FUNDING_ID}`]: () => reply(order({ deposit: { ...order().deposit, payBefore: '2000-01-01T00:00:00Z' } })) });
    const { payload } = await call('stellar_wallet_order_status', { fundingId: FUNDING_ID }, fn);
    expect(payload.paymentWindowClosed).toBe(true);
    expect(payload.guidance).toMatch(/Do NOT send a deposit/);
  });
});


describe('Funding actual amount policy', () => {
  const policy = { amountPolicy: 'any_amount', minAcceptedAmount: '0.51', maxPricedAmount: '1000' };
  it('preserves quote policy and bounds', async () => {
    const { fn } = mockFetch({ 'GET /capabilities': () => reply(caps), 'POST /quotes': () => reply({ ...QUOTE, source: { ...QUOTE.source, ...policy } }, 201) });
    const { payload } = await call('stellar_wallet_quote', { receiverAddress: RECEIVER, sourceChain: 'base', amountUsd: '10' }, fn);
    expect(payload.source).toMatchObject(policy);
  });
  it('preserves order policy and gives bounded actual-amount instructions', async () => {
    const o: any = order(); o.deposit = { ...o.deposit, ...policy };
    const { fn } = mockFetch({ 'POST /orders': () => reply(o, 201) });
    const { payload } = await call('stellar_wallet_create_order', { quoteId: QUOTE.quoteId, planDigest: QUOTE.planDigest, orderId: 'agent-policy-0001' }, fn);
    expect(payload.deposit).toMatchObject(policy);
    expect(payload.instructions.join(' ')).toMatch(/Suggested amount.*0.51.*1000.*XLM tier stays the same/);
    expect(payload.instructions.join(' ')).not.toContain('Send EXACTLY');
    expect(payload.instructions.join(' ')).toMatch(/Below the minimum needs manual handling/);
  });
  it('status reflects repriced legs and audit rather than the original quote', async () => {
    const audit = { quotedAmount: '10', receivedAmount: '8', pricedAmount: '8', excessAmount: '0', quotedPlanDigest: 'a'.repeat(64) };
    const o: any = order({ repricing: audit, legs: [{ ...QUOTE.legs.find((l: any) => l.kind === 'stable'), minimumAmount: '7.49' }] }); o.deposit = { ...o.deposit, ...policy };
    const { fn } = mockFetch({ [`GET /orders/${FUNDING_ID}`]: () => reply(o) });
    const { payload } = await call('stellar_wallet_order_status', { fundingId: FUNDING_ID }, fn);
    expect(payload.deposit).toMatchObject(policy);
    expect(payload.repricing).toEqual(audit);
    expect(payload.legs[0].minimumAmount).toBe('7.49');
    expect(payload.guidance).toContain('0.51');
  });
  it.each([undefined, 'exact', 'untrusted'])('keeps legacy exact guidance for policy %s', async (amountPolicy) => {
    const o: any = order(); o.deposit = { ...o.deposit, amountPolicy };
    const { fn } = mockFetch({ [`GET /orders/${FUNDING_ID}`]: () => reply(o) });
    const { payload } = await call('stellar_wallet_order_status', { fundingId: FUNDING_ID }, fn);
    expect(payload.deposit.amountPolicy).toBe('exact');
    expect(payload.guidance).toContain('Send EXACTLY 10');
  });
  it('fails closed on an incomplete any_amount range', async () => {
    const o: any = order(); o.deposit = { ...o.deposit, ...policy, minAcceptedAmount: 'invalid' };
    const { fn } = mockFetch({ [`GET /orders/${FUNDING_ID}`]: () => reply(o) });
    const { payload } = await call('stellar_wallet_order_status', { fundingId: FUNDING_ID }, fn);
    expect(payload.guidance).toContain('Do not pay');
    expect(payload.deposit.minAcceptedAmount).toBeNull();
  });
});


it('signing guidance checks the current order template rather than the original quoted minimum', async () => {
  const { fn } = mockFetch({ [`POST /orders/${FUNDING_ID}/signing-requests`]: () => reply({ signingRequestId: SR_ID, fundingId: FUNDING_ID, status: 'ready', networkPassphrase: STELLAR_PUBLIC_PASSPHRASE, xdr: SIGNED, operations: [] }, 201) });
  const { payload, isError } = await call('stellar_wallet_get_signing_request', { fundingId: FUNDING_ID, walletAddress: RECEIVER }, fn);
  expect(isError).toBe(false);
  expect(payload.instructions.join(' ')).toContain('current order.legs minimumAmount after repricing and the server template');
  expect(payload.instructions.join(' ')).not.toContain('quoted minimum');
  expect(payload.instructions.join(' ')).toContain('Sign the XDR unchanged');
});
