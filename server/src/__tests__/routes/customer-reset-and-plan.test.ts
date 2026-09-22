import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { createCustomer, createCustomerSession, verifyCustomer } from '../../services/customer-auth.js';

const SERVICE_TOKEN = 't'.repeat(48);
const EMAIL = 'reset@example.com';
const PASSWORD = 'first-password-1';

async function call(app: Express, method: string, path: string, body?: unknown, bearer?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  server.close();
  return { status: res.status, body: data };
}

describe('customer password reset', () => {
  let app: Express;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    createCustomer(EMAIL, PASSWORD);
  });

  it('answers the same way whether or not the address is registered', async () => {
    const known = await call(app, 'POST', '/customer-api/password-reset', { email: EMAIL });
    const unknown = await call(app, 'POST', '/customer-api/password-reset', { email: 'nobody@example.com' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body?.message).toBe(unknown.body?.message);
    expect(typeof known.body?.token).toBe('string');
    expect(unknown.body?.token).toBeUndefined();
  });

  it('sets the new password once, signs the person in, and ends every older session', async () => {
    const older = createCustomerSession(1);
    expect((await call(app, 'GET', '/customer-api/me', undefined, older)).status).toBe(200);

    const issued = await call(app, 'POST', '/customer-api/password-reset', { email: EMAIL });
    const token = issued.body?.token as string;
    const done = await call(app, 'POST', '/customer-api/password-reset/complete', { token, password: 'second-password-2' });
    expect(done.status).toBe(200);
    expect(done.body?.email).toBe(EMAIL);
    expect(typeof done.body?.token).toBe('string');

    expect(verifyCustomer(EMAIL, PASSWORD)).toBeNull();
    expect(verifyCustomer(EMAIL, 'second-password-2')?.email).toBe(EMAIL);
    expect((await call(app, 'GET', '/customer-api/me', undefined, older)).status).toBe(401);

    const again = await call(app, 'POST', '/customer-api/password-reset/complete', { token, password: 'third-password-3' });
    expect(again.status).toBe(410);
    expect(verifyCustomer(EMAIL, 'second-password-2')?.email).toBe(EMAIL);
  });

  it('refuses an expired link, an unknown link, and a short password', async () => {
    const issued = await call(app, 'POST', '/customer-api/password-reset', { email: EMAIL });
    const token = issued.body?.token as string;
    getDb().prepare('UPDATE customer_password_resets SET expires_at_ms = ?').run(Date.now() - 1);
    expect((await call(app, 'POST', '/customer-api/password-reset/complete', { token, password: 'fourth-password-4' })).status).toBe(410);
    expect((await call(app, 'POST', '/customer-api/password-reset/complete', { token: 'not-a-token', password: 'fourth-password-4' })).status).toBe(410);
    expect((await call(app, 'POST', '/customer-api/password-reset/complete', { token, password: 'short' })).status).toBe(400);
  });

  it('keeps exactly one live reset per account', async () => {
    await call(app, 'POST', '/customer-api/password-reset', { email: EMAIL });
    await call(app, 'POST', '/customer-api/password-reset', { email: EMAIL });
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM customer_password_resets WHERE customer_id = 1').get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('the plan a customer holds', () => {
  let app: Express;
  let session = '';
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    createCustomer('plan@example.com', 'a-password-of-length');
    createCustomer('other@example.com', 'a-password-of-length');
    session = createCustomerSession(1);
  });
  beforeEach(() => { process.env.XLAUNCH_BILLING_SERVICE_TOKEN = SERVICE_TOKEN; });
  afterEach(() => { delete process.env.XLAUNCH_BILLING_SERVICE_TOKEN; });

  const plan = (body: Record<string, unknown>) => call(app, 'POST', '/service-api/plan', body, SERVICE_TOKEN);
  const me = async () => (await call(app, 'GET', '/customer-api/me', undefined, session)).body?.plan;

  it('starts as none, and refuses a caller without the service token', async () => {
    expect(await me()).toBeNull();
    const bare = await call(app, 'POST', '/service-api/plan', { customerEmail: 'plan@example.com', plan: 'pro', subscriptionRef: 'sub_1' });
    expect(bare.status).toBe(401);
    expect(await me()).toBeNull();
  });

  it('records a plan once, reports a repeat as unchanged, and moves the renewal on the repeat', async () => {
    const first = await plan({ customerEmail: 'plan@example.com', plan: 'pro', subscriptionRef: 'sub_1', renewsAtMs: 1_800_000_000_000 });
    expect(first.status).toBe(201);
    expect(first.body?.outcome).toBe('set');
    expect(await me()).toMatchObject({ plan: 'pro', renewsAtMs: 1_800_000_000_000 });

    const repeat = await plan({ customerEmail: 'plan@example.com', plan: 'pro', subscriptionRef: 'sub_1', renewsAtMs: 1_802_592_000_000 });
    expect(repeat.status).toBe(200);
    expect(repeat.body?.outcome).toBe('unchanged');
    expect(await me()).toMatchObject({ plan: 'pro', renewsAtMs: 1_802_592_000_000 });
  });

  it('replaces the plan under a new subscription, and a cancel for the old one leaves the new one alone', async () => {
    const changed = await plan({ customerEmail: 'plan@example.com', plan: 'team', subscriptionRef: 'sub_2' });
    expect(changed.body?.outcome).toBe('changed');
    expect(await me()).toMatchObject({ plan: 'team' });

    const stale = await plan({ customerEmail: 'plan@example.com', plan: null, subscriptionRef: 'sub_1' });
    expect(stale.body?.outcome).toBe('not-in-force');
    expect(await me()).toMatchObject({ plan: 'team' });

    const ended = await plan({ customerEmail: 'plan@example.com', plan: null, subscriptionRef: 'sub_2' });
    expect(ended.body?.outcome).toBe('cleared');
    expect(await me()).toBeNull();
  });

  it('refuses a subscription that belongs to another account, an unknown plan, and an unknown customer', async () => {
    await plan({ customerEmail: 'plan@example.com', plan: 'pro', subscriptionRef: 'sub_3' });
    expect((await plan({ customerEmail: 'other@example.com', plan: 'pro', subscriptionRef: 'sub_3' })).status).toBe(409);
    expect((await plan({ customerEmail: 'other@example.com', plan: 'gold', subscriptionRef: 'sub_4' })).status).toBe(400);
    expect((await plan({ customerEmail: 'nobody@example.com', plan: 'pro', subscriptionRef: 'sub_5' })).status).toBe(404);
  });
});
