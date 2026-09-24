import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { postLedger, recomputeBalance, balanceOf } from '../../services/billing.js';
import { hashClientProfileKey } from '../../lib/system-prompt.js';

const PLATFORM = 'p'.repeat(48);
const BILLING = 'b'.repeat(48);
const KEY = 'xl-test-key-belonging-to-the-agent-0001';

async function call(app: Express, method: string, path: string, body?: unknown, token?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/service-api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  server.close();
  return { status: res.status, body: data };
}

describe('platform charge door', () => {
  let app: Express;
  let customerId = 0;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    const db = getDb();
    customerId = Number(db.prepare("INSERT INTO customers (email, password_hash) VALUES ('agent@example.com', 'x')").run().lastInsertRowid);
    db.prepare(`INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, customer_id)
                VALUES ('agent key', ?, 'e', 'i', 'a', ?)`).run(hashClientProfileKey(KEY), customerId);
    db.prepare(`INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, customer_id, enabled)
                VALUES ('disabled key', ?, 'e', 'i', 'a', ?, 0)`).run(hashClientProfileKey(KEY + '-off'), customerId);
    postLedger(customerId, { kind: 'credit', usdMicros: 10_000_000, reason: 'SUI top-up', refId: null });
  });

  beforeEach(() => {
    process.env.XLAUNCH_PLATFORM_SERVICE_TOKEN = PLATFORM;
    process.env.XLAUNCH_BILLING_SERVICE_TOKEN = BILLING;
  });
  afterEach(() => {
    delete process.env.XLAUNCH_PLATFORM_SERVICE_TOKEN;
    delete process.env.XLAUNCH_BILLING_SERVICE_TOKEN;
  });

  const charge = (overrides: Record<string, unknown> = {}) => ({
    customerId, amountCents: 600, chargeRef: 'team-7-2026-09-24', reason: 'Agent 1 GB, 24 Sep to 24 Oct', ...overrides,
  });

  it('refuses every request while no platform token is configured', async () => {
    delete process.env.XLAUNCH_PLATFORM_SERVICE_TOKEN;
    expect((await call(app, 'POST', '/charges', charge(), PLATFORM)).status).toBe(503);
    expect((await call(app, 'POST', '/accounts/resolve-key', { apiKey: KEY }, PLATFORM)).status).toBe(503);
  });

  it('does not open for the card billing service token', async () => {
    expect((await call(app, 'POST', '/charges', charge(), BILLING)).status).toBe(401);
    expect((await call(app, 'GET', '/charges', undefined, BILLING)).status).toBe(401);
    expect((await call(app, 'POST', '/charges', charge())).status).toBe(401);
  });

  it('names the account a live key belongs to, and nobody for a disabled or unknown key', async () => {
    const found = await call(app, 'POST', '/accounts/resolve-key', { apiKey: KEY }, PLATFORM);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ customerId, email: 'agent@example.com', balanceMicros: 10_000_000 });
    expect((await call(app, 'POST', '/accounts/resolve-key', { apiKey: KEY + '-off' }, PLATFORM)).status).toBe(404);
    expect((await call(app, 'POST', '/accounts/resolve-key', { apiKey: 'xl-nobody-holds-this-key' }, PLATFORM)).status).toBe(404);
  });

  it('charges once, debits the ledger, and answers a retry with the first result', async () => {
    const first = await call(app, 'POST', '/charges', charge(), PLATFORM);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ applied: true, balanceMicros: 4_000_000 });
    const again = await call(app, 'POST', '/charges', charge(), PLATFORM);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ applied: false, chargeId: first.body?.chargeId, balanceMicros: 4_000_000 });
    // The cached balance and the ledger agree.
    expect(recomputeBalance(customerId)).toBe(4_000_000);
  });

  it('refuses the same reference for a different amount instead of calling it a retry', async () => {
    const res = await call(app, 'POST', '/charges', charge({ amountCents: 1200 }), PLATFORM);
    expect(res.status).toBe(409);
    expect(balanceOf(customerId)).toBe(4_000_000);
  });

  it('refuses a charge the balance cannot cover, whole, writing nothing', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM billing_ledger').get() as { n: number }).n;
    const res = await call(app, 'POST', '/charges', charge({ chargeRef: 'team-7-2026-10-24', amountCents: 401 }), PLATFORM);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ balanceMicros: 4_000_000, requiredMicros: 4_010_000 });
    const after = (getDb().prepare('SELECT COUNT(*) AS n FROM billing_ledger').get() as { n: number }).n;
    expect(after).toBe(before);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM service_charges WHERE charge_ref = 'team-7-2026-10-24'").get() as { n: number }).n).toBe(0);
  });

  it('charges exactly the whole balance, the last cent included', async () => {
    const res = await call(app, 'POST', '/charges', charge({ chargeRef: 'team-7-2026-11-24', amountCents: 400 }), PLATFORM);
    expect(res.status).toBe(201);
    expect(balanceOf(customerId)).toBe(0);
  });

  it('rejects an unknown account, a zero amount and an amount over the cap', async () => {
    expect((await call(app, 'POST', '/charges', charge({ customerId: 999_999, chargeRef: 'team-9-2026-09-24' }), PLATFORM)).status).toBe(404);
    expect((await call(app, 'POST', '/charges', charge({ amountCents: 0 }), PLATFORM)).status).toBe(400);
    expect((await call(app, 'POST', '/charges', charge({ amountCents: 100_001 }), PLATFORM)).status).toBe(400);
  });

  it('lists every charge in order and says when the page ran out', async () => {
    const all = await call(app, 'GET', '/charges', undefined, PLATFORM);
    expect(all.status).toBe(200);
    const charges = all.body?.charges as { chargeRef: string; amountCents: number }[];
    expect(charges.map(c => c.chargeRef)).toEqual(['team-7-2026-09-24', 'team-7-2026-11-24']);
    expect(charges[0].amountCents).toBe(600);
    expect(all.body?.truncated).toBe(false);
    const page = await call(app, 'GET', '/charges?limit=1', undefined, PLATFORM);
    expect(page.body?.truncated).toBe(true);
  });
});
