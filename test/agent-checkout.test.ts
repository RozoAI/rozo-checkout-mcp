import { describe, expect, it } from 'vitest';
import { handleMcp, type Env } from '../src/index';
import { AC_BASE, acCredentialFromRequest } from '../src/agent-checkout';
import { X402_BASE } from '../src/x402';

const CRED = 'ac_test_' + 'A'.repeat(20) + '_-' + 'b'.repeat(21); // 43 base64url chars
const CRED2 = 'ac_live_' + 'Z'.repeat(43);
const AK = 'ak_testkey_1234567890';
const LINK = 'https://payments.coinbase.com/payment-links/pl_01TEST';
const SR_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ON: Env = { EXPOSE_AGENT_CHECKOUT_TOOLS: '1' };

type Call = { url: string; method: string; body: any; headers: Record<string, string>; redirect?: string };

const agentView = (over: Record<string, unknown> = {}) => ({
  spendRequestId: SR_ID,
  displayRef: 'AC-7K2Q',
  environment: 'test',
  status: 'pending_approval',
  statusVersion: 2,
  provider: 'coinbase',
  invoiceId: 'pl_01TEST',
  entry: 'mcp',
  requestedByType: 'agent',
  merchantDisplay: 'OpenRouter',
  merchantVerified: true,
  beneficiaryVerified: true,
  invoiceAmount: '10.00',
  invoiceCurrency: 'USD',
  feeAtomic: '100000',
  totalDebitAtomic: '10100000',
  quoteVersion: 1,
  quoteExpiresAt: '2026-11-17T12:10:00Z',
  approvalExpiresAt: '2026-11-17T12:30:00Z',
  fundingMode: 'per_payment',
  context: 'top up',
  merchantDeliveryStatus: 'delivered',
  merchantPaymentStatus: 'paid',
  createdAt: '2026-11-17T12:00:00Z',
  updatedAt: '2026-11-17T12:00:00Z',
  ...over,
});

function mockFetch(handler: (c: Call) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const c: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers, redirect: init?.redirect };
    calls.push(c);
    const { status, json } = handler(c);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function mcpRequest(method: string, params: unknown, headers: Record<string, string> = {}) {
  return new Request('https://mcp.rozo.ai/mcp?src=test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function list(env: Env, fn: typeof fetch) {
  const res = await handleMcp(mcpRequest('tools/list', {}), fn, env);
  return ((await res.json()) as any).result.tools as any[];
}

async function call(name: string, args: unknown, fn: typeof fetch, headers: Record<string, string> = { authorization: `Bearer ${CRED}` }, env: Env = ON) {
  const res = await handleMcp(mcpRequest('tools/call', { name, arguments: args }, headers), fn, env);
  expect(res.status).toBe(200);
  const raw = await res.text();
  const out = JSON.parse(raw) as any;
  const text = out.result.content[0].text as string;
  let payload: any = null;
  try { payload = JSON.parse(text); } catch { /* SDK validation errors are plain text */ }
  return { isError: Boolean(out.result.isError), text, raw, payload };
}

const created = () => mockFetch(() => ({ status: 201, json: { replay: false, request: agentView() } }));

describe('flag', () => {
  it('hides the tools unless EXPOSE_AGENT_CHECKOUT_TOOLS is "1" / "true"', async () => {
    const { fn, calls } = created();
    for (const env of [{}, { EXPOSE_AGENT_CHECKOUT_TOOLS: '0' }, { EXPOSE_AGENT_CHECKOUT_TOOLS: 'false' }] as Env[]) {
      expect((await list(env, fn)).some((t) => String(t.name).startsWith('agent_checkout_'))).toBe(false);
    }
    for (const v of ['1', 'true', 'TRUE']) {
      const names = (await list({ EXPOSE_AGENT_CHECKOUT_TOOLS: v }, fn)).map((t) => t.name).filter((n) => n.startsWith('agent_checkout_')).sort();
      expect(names).toEqual(['agent_checkout_request_payment', 'agent_checkout_request_status']);
    }
    const hidden = await call('agent_checkout_request_status', { spendRequestId: SR_ID }, fn, undefined, {});
    expect(hidden.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('tool schemas have no credential field', async () => {
    const { fn } = created();
    const tools = (await list(ON, fn)).filter((t) => String(t.name).startsWith('agent_checkout_'));
    for (const t of tools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props.some((p) => /cred|key|token|auth|secret/i.test(p) && p !== 'idempotencyKey')).toBe(false);
    }
    expect(Object.keys(tools.find((t) => t.name === 'agent_checkout_request_payment').inputSchema.properties).sort()).toEqual(['context', 'fundingPreference', 'idempotencyKey', 'invoice']);
    expect(Object.keys(tools.find((t) => t.name === 'agent_checkout_request_status').inputSchema.properties)).toEqual(['spendRequestId']);
  });
});

describe('credential parsing', () => {
  const req = (h: Record<string, string>) => new Request('https://x/mcp', { headers: h });
  it('reads Bearer ac_ and the dedicated header; ak_ is not an ac credential', () => {
    expect(acCredentialFromRequest(req({ authorization: `Bearer ${CRED}` }))).toEqual({ state: 'ok', value: CRED });
    expect(acCredentialFromRequest(req({ 'x-rozo-agent-checkout-credential': CRED2, authorization: `Bearer ${AK}` }))).toEqual({ state: 'ok', value: CRED2 });
    expect(acCredentialFromRequest(req({ authorization: `Bearer ${AK}` }))).toEqual({ state: 'missing' });
    expect(acCredentialFromRequest(req({}))).toEqual({ state: 'missing' });
    expect(acCredentialFromRequest(req({ authorization: 'Bearer ac_live_short' }))).toEqual({ state: 'malformed' });
    expect(acCredentialFromRequest(req({ 'x-rozo-agent-checkout-credential': 'nope' }))).toEqual({ state: 'malformed' });
  });

  it('without a credential the tools answer "not bound" and make no network call', async () => {
    const { fn, calls } = created();
    const variants: Record<string, string>[] = [{}, { authorization: `Bearer ${AK}` }];
    for (const headers of variants) {
      const out = await call('agent_checkout_request_payment', { invoice: LINK, context: 'top up' }, fn, headers);
      expect(out.isError).toBe(true);
      expect(out.payload.error.code).toBe('AC_NOT_BOUND');
      expect(out.payload.error.message).toMatch(/bind this agent in the Discord settings/);
      const st = await call('agent_checkout_request_status', { spendRequestId: SR_ID }, fn, headers);
      expect(st.payload.error.code).toBe('AC_NOT_BOUND');
    }
    const bad = await call('agent_checkout_request_status', { spendRequestId: SR_ID }, fn, { authorization: 'Bearer ac_live_short' });
    expect(bad.payload.error.code).toBe('AC_CREDENTIAL_MALFORMED');
    expect(calls).toHaveLength(0);
  });

  it('an ak_ key still goes to x402 and the ac credential never does', async () => {
    const { fn, calls } = mockFetch((c) =>
      c.url.startsWith(X402_BASE) ? { status: 200, json: { paymentSignature: 'sig' } } : { status: 500, json: {} },
    );
    const accepts = [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x' + '1'.repeat(40) }];
    const res = await handleMcp(
      mcpRequest('tools/call', { name: 'x402_sign', arguments: { accepts, budget: '1', idempotencyKey: SR_ID } }, { authorization: `Bearer ${AK}`, 'x-rozo-agent-checkout-credential': CRED }),
      fn,
      { EXPOSE_X402_TOOLS: '1', EXPOSE_AGENT_CHECKOUT_TOOLS: '1' },
    );
    expect(((await res.json()) as any).result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${AK}`);
    // An ac_ bearer is not treated as an x402 key.
    const { fn: fn2, calls: calls2 } = mockFetch(() => ({ status: 500, json: {} }));
    const res2 = await handleMcp(
      mcpRequest('tools/call', { name: 'x402_sign', arguments: { accepts, budget: '1', idempotencyKey: SR_ID } }, { authorization: `Bearer ${CRED}` }),
      fn2,
      { EXPOSE_X402_TOOLS: '1', EXPOSE_AGENT_CHECKOUT_TOOLS: '1' },
    );
    const out2 = JSON.parse(((await res2.json()) as any).result.content[0].text);
    expect(out2.error.code).toBe('X402_NO_KEY');
    expect(calls2).toHaveLength(0);
  });
});

describe('agent_checkout_request_payment', () => {
  it('sends the credential as Authorization only, never in the result', async () => {
    const { fn, calls } = created();
    const out = await call('agent_checkout_request_payment', { invoice: LINK, context: 'Top up OpenRouter for the eval run', fundingPreference: 'per_payment' }, fn, { 'x-rozo-agent-checkout-credential': CRED });
    expect(out.isError).toBe(false);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(`${AC_BASE}/requests`);
    expect(c.method).toBe('POST');
    expect(c.headers.authorization).toBe(`Bearer ${CRED}`);
    expect(c.body).toEqual({ invoice: LINK, context: 'Top up OpenRouter for the eval run', entry: 'mcp', fundingPreference: 'per_payment' });
    expect(JSON.stringify(c.body)).not.toContain(CRED);
    expect(out.raw).not.toContain(CRED);
    expect(out.raw).not.toContain('ac_test_');
    expect(out.payload.notice).toMatch(/Nothing is paid until the owner approves this request in Discord/);
    expect(out.payload).toMatchObject({
      displayRef: 'AC-7K2Q',
      status: 'pending_approval',
      merchant: 'OpenRouter',
      invoiceAmount: '10.00',
      invoiceCurrency: 'USD',
      fee: '0.100000 USDC',
      total: '10.100000 USDC',
      approvalExpiresAt: '2026-11-17T12:30:00Z',
    });
    expect(out.text).not.toMatch(/delivered/i);
  });

  it('generates an idempotency key when absent, returns it, and reuses a given one', async () => {
    const { fn, calls } = created();
    const first = await call('agent_checkout_request_payment', { invoice: 'pl_01TEST', context: 'why' }, fn);
    const key = first.payload.idempotencyKey as string;
    expect(key).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(calls[0]!.headers['idempotency-key']).toBe(key);
    expect(calls[0]!.body.invoice).toBe(LINK);
    const again = await call('agent_checkout_request_payment', { invoice: LINK, context: 'why', idempotencyKey: key }, fn);
    expect(calls[1]!.headers['idempotency-key']).toBe(key);
    expect(again.payload.idempotencyKey).toBe(key);
    const bad = await call('agent_checkout_request_payment', { invoice: LINK, context: 'why', idempotencyKey: 'short' }, fn);
    expect(bad.payload.error.code).toBe('BAD_VALUE');
    expect(calls).toHaveLength(2);
  });

  it('202 tells the agent to retry later with the same key', async () => {
    const { fn } = mockFetch(() => ({ status: 202, json: { replay: false, quoteError: 'QUOTE_UNAVAILABLE', request: agentView({ status: 'created', feeAtomic: null, totalDebitAtomic: null }) } }));
    const out = await call('agent_checkout_request_payment', { invoice: LINK, context: 'why', idempotencyKey: 'retry-key-1' }, fn);
    expect(out.isError).toBe(false);
    expect(out.payload.quoteError).toBe('QUOTE_UNAVAILABLE');
    expect(out.payload.next).toMatch(/SAME idempotencyKey/);
    expect(out.payload.idempotencyKey).toBe('retry-key-1');
    expect(out.payload.fee).toBeNull();
  });

  it('refuses non-Coinbase invoices client side', async () => {
    const { fn, calls } = created();
    for (const invoice of ['https://www.bitrefill.com/invoice/abc', 'https://commerce.coinbase.com/pay/x', '0f8fad5b-d9cb-469f-a165-70867728950e']) {
      const out = await call('agent_checkout_request_payment', { invoice, context: 'why' }, fn);
      expect(out.payload.error.code).toBe('INVOICE_UNSUPPORTED');
    }
    expect(calls).toHaveLength(0);
  });

  it('maps errors', async () => {
    const cases: [number, unknown, string, RegExp][] = [
      [401, { error: { code: 'UNAUTHORIZED', messageKey: 'agent_checkout.unauthorized' } }, 'AC_UNAUTHORIZED', /not valid or not yet confirmed/],
      [404, { error: { code: 'NOT_FOUND' } }, 'AC_DISABLED', /not enabled yet/],
      [503, { error: { code: 'AC_DISABLED' } }, 'AC_DISABLED', /not enabled yet/],
      [503, { error: { code: 'RETRY_LATER' } }, 'RETRY_LATER', /same idempotencyKey/],
      [409, { error: { code: 'IDEMPOTENCY_CONFLICT' } }, 'IDEMPOTENCY_CONFLICT', /different request/],
      [429, { error: { code: 'RATE_LIMITED' } }, 'RATE_LIMITED', /retry later/],
      [500, { error: { code: `LEAK ${CRED}` } }, 'HTTP_500', /HTTP 500/],
    ];
    for (const [status, json, code, msg] of cases) {
      const { fn } = mockFetch(() => ({ status, json }));
      const out = await call('agent_checkout_request_payment', { invoice: LINK, context: 'why', idempotencyKey: 'err-key-01' }, fn);
      expect(out.isError).toBe(true);
      expect(out.payload.error.code).toBe(code);
      expect(out.payload.error.message).toMatch(msg);
      expect(out.payload.idempotencyKey).toBe('err-key-01');
      expect(out.raw).not.toContain(CRED);
    }
    const { fn } = mockFetch(() => ({ status: 409, json: { error: { code: 'INVOICE_IN_PROGRESS' }, spendRequestId: SR_ID, displayRef: 'AC-7K2Q' } }));
    const out = await call('agent_checkout_request_payment', { invoice: LINK, context: 'why' }, fn);
    expect(out.payload).toMatchObject({ error: { code: 'INVOICE_IN_PROGRESS' }, spendRequestId: SR_ID, displayRef: 'AC-7K2Q' });
  });
});

describe('agent_checkout_request_status', () => {
  it('reads one request and maps status to a sentence, never claiming delivery', async () => {
    const statuses = ['created', 'pending_approval', 'approved', 'awaiting_payment', 'paying', 'succeeded', 'denied', 'expired', 'canceled', 'failed', 'manual_review'];
    for (const status of statuses) {
      const { fn, calls } = mockFetch(() => ({ status: 200, json: { request: agentView({ status }) } }));
      const out = await call('agent_checkout_request_status', { spendRequestId: SR_ID }, fn);
      expect(out.isError).toBe(false);
      expect(calls[0]!.url).toBe(`${AC_BASE}/requests/${SR_ID}`);
      expect(calls[0]!.method).toBe('GET');
      expect(calls[0]!.headers.authorization).toBe(`Bearer ${CRED}`);
      expect(out.payload.status).toBe(status);
      expect(typeof out.payload.statusMeaning).toBe('string');
      expect(out.payload.statusMeaning).not.toMatch(/\bdelivered\b/i);
      expect(out.text).not.toMatch(/"delivered"/);
      expect(out.raw).not.toContain(CRED);
    }
  });

  it('validates the id and maps 404 / 401 / 503', async () => {
    const { fn, calls } = created();
    expect((await call('agent_checkout_request_status', { spendRequestId: 'nope' }, fn)).payload.error.code).toBe('BAD_VALUE');
    expect(calls).toHaveLength(0);
    for (const [status, json, code] of [
      [404, { error: { code: 'NOT_FOUND' } }, 'NOT_FOUND'],
      [401, { error: { code: 'UNAUTHORIZED' } }, 'AC_UNAUTHORIZED'],
      [503, { error: { code: 'AC_NOT_CONFIGURED' } }, 'AC_DISABLED'],
    ] as const) {
      const m = mockFetch(() => ({ status, json }));
      const out = await call('agent_checkout_request_status', { spendRequestId: SR_ID }, m.fn);
      expect(out.payload.error.code).toBe(code);
    }
  });
});

describe('review fixes', () => {
  it('refuses redirects on every credential-bearing call', async () => {
    const { fn, calls } = mockFetch(() => ({ status: 200, json: { request: agentView() } }));
    await call('agent_checkout_request_payment', { invoice: LINK, context: 'why' }, fn);
    await call('agent_checkout_request_status', { spendRequestId: SR_ID }, fn);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.redirect).toBe('error');
      expect(new URL(c.url).origin).toBe('https://apiserver.mpprouter.dev');
    }
    // A fetch that still hands back a 3xx is treated as an unknown outcome, never followed.
    const r = mockFetch(() => ({ status: 302, json: {} }));
    const out = await call('agent_checkout_request_status', { spendRequestId: SR_ID }, r.fn);
    expect(out.payload.error.code).toBe('OUTCOME_UNKNOWN');
    expect(r.calls).toHaveLength(1);
  });

  it('network failure or timeout is OUTCOME_UNKNOWN, never "nothing was paid"', async () => {
    const boom = (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch;
    const create = await call('agent_checkout_request_payment', { invoice: LINK, context: 'why', idempotencyKey: 'net-key-01' }, boom);
    expect(create.payload.error.code).toBe('OUTCOME_UNKNOWN');
    expect(create.payload.error.message).toMatch(/may already exist/);
    expect(create.payload.error.message).toMatch(/SAME idempotencyKey/);
    expect(create.payload.idempotencyKey).toBe('net-key-01');
    expect(create.text).not.toMatch(/Nothing was paid/i);
    const st = await call('agent_checkout_request_status', { spendRequestId: SR_ID }, boom);
    expect(st.payload.error.code).toBe('OUTCOME_UNKNOWN');
    expect(st.payload.error.message).toMatch(/could not be read/);
    expect(st.payload.error.message).toMatch(/Do not assume it is unpaid/);
    expect(st.raw).not.toContain(CRED);
  });

  it('next-step hint follows the returned status on a replay', async () => {
    for (const [status, re] of [
      ['pending_approval', /owner must approve in Discord/],
      ['approved', /owner approved/],
      ['succeeded', /Do not create another request/],
      ['denied', /owner declined/],
      ['expired', /expired unpaid/],
    ] as const) {
      const { fn } = mockFetch(() => ({ status: 200, json: { replay: true, request: agentView({ status }) } }));
      const out = await call('agent_checkout_request_payment', { invoice: LINK, context: 'why', idempotencyKey: 'replay-key-1' }, fn);
      expect(out.payload.replay).toBe(true);
      expect(out.payload.next).toMatch(re);
      if (status !== 'pending_approval') expect(out.payload.next).not.toMatch(/must approve/);
    }
  });
});
