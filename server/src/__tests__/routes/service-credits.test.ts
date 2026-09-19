import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { recomputeBalance } from '../../services/billing.js';

const TOKEN = 't'.repeat(48);

async function post(app: Express, body: unknown, token?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/service-api/credits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  server.close();
  return { status: res.status, body: data };
}

const payment = (overrides: Record<string, unknown> = {}) => ({
  customerEmail: 'buyer@example.com',
  amountCents: 2500,
  currency: 'usd',
  paymentId: 'evt_test_0000000001',
  reason: 'Credit top-up',
  ...overrides,
});

describe('service credit door', () => {
  let app: Express;
  let customerId = 0;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    const info = getDb()
      .prepare("INSERT INTO customers (email, password_hash) VALUES ('buyer@example.com', 'x')")
      .run();
    customerId = Number(info.lastInsertRowid);
  });

  beforeEach(() => { process.env.XLAUNCH_BILLING_SERVICE_TOKEN = TOKEN; });
  afterEach(() => { delete process.env.XLAUNCH_BILLING_SERVICE_TOKEN; });

  const ledgerRows = () => (getDb()
    .prepare('SELECT COUNT(*) AS n FROM billing_ledger WHERE customer_id = ?')
    .get(customerId) as { n: number }).n;
  const paymentRows = () => (getDb()
    .prepare("SELECT COUNT(*) AS n FROM payments WHERE chain = 'stripe'")
    .get() as { n: number }).n;

  it('refuses every request while no service token is configured', async () => {
    delete process.env.XLAUNCH_BILLING_SERVICE_TOKEN;
    expect((await post(app, payment(), TOKEN)).status).toBe(503);
    expect(ledgerRows()).toBe(0);
  });

  it('treats a short token as unconfigured rather than as a weak secret', async () => {
    process.env.XLAUNCH_BILLING_SERVICE_TOKEN = 'short';
    expect((await post(app, payment(), 'short')).status).toBe(503);
  });

  it('refuses a missing or wrong token', async () => {
    expect((await post(app, payment())).status).toBe(401);
    expect((await post(app, payment(), 'w'.repeat(48))).status).toBe(401);
    expect(ledgerRows()).toBe(0);
  });

  it('rejects a malformed amount, currency or id', async () => {
    expect((await post(app, payment({ amountCents: 12.5 }), TOKEN)).status).toBe(400);
    expect((await post(app, payment({ amountCents: 0 }), TOKEN)).status).toBe(400);
    expect((await post(app, payment({ amountCents: -100 }), TOKEN)).status).toBe(400);
    expect((await post(app, payment({ currency: 'eur' }), TOKEN)).status).toBe(400);
    expect((await post(app, payment({ paymentId: '' }), TOKEN)).status).toBe(400);
    expect(ledgerRows()).toBe(0);
  });

  it('answers 404 for an unknown customer and records nothing', async () => {
    const res = await post(app, payment({ customerEmail: 'nobody@example.com' }), TOKEN);
    expect(res.status).toBe(404);
    expect(paymentRows()).toBe(0);
  });

  it('credits in integer micro-dollars and records the payment with its ledger entry', async () => {
    const res = await post(app, payment(), TOKEN);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ applied: true, balanceMicros: 25_000_000 });
    expect(paymentRows()).toBe(1);
    expect(ledgerRows()).toBe(1);
    // The cached balance must equal what the ledger re-derives.
    expect(recomputeBalance(customerId)).toBe(25_000_000);
  });

  it('credits a redelivered payment exactly once', async () => {
    const again = await post(app, payment(), TOKEN);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ applied: false, balanceMicros: 25_000_000 });
    // Even a redelivery that claims a larger amount cannot move the balance.
    const inflated = await post(app, payment({ amountCents: 999_900 }), TOKEN);
    expect(inflated.body).toEqual({ applied: false, balanceMicros: 25_000_000 });
    expect(paymentRows()).toBe(1);
    expect(ledgerRows()).toBe(1);
  });

  it('credits a second, distinct payment', async () => {
    const res = await post(app, payment({ paymentId: 'evt_test_0000000002', amountCents: 1000 }), TOKEN);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ applied: true, balanceMicros: 35_000_000 });
  });

  it('matches the customer email case-insensitively', async () => {
    const res = await post(app, payment({ paymentId: 'evt_test_0000000003', customerEmail: 'Buyer@Example.com', amountCents: 500 }), TOKEN);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ applied: true, balanceMicros: 40_000_000 });
  });
});
