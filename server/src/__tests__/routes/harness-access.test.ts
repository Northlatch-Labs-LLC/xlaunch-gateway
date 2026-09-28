import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { createCustomer, createCustomerSession } from '../../services/customer-auth.js';
import { mailConfig } from '../../services/mailer.js';

const EMAIL = 'harness@example.com';
const PASSWORD = 'a-tidy-password-1';

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

describe('hosted harness access', () => {
  let app: Express;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.XLAUNCH_HARNESS_URL;
    initDb(':memory:');
    app = createApp();
    createCustomer(EMAIL, PASSWORD);
  });

  it('mints a token for a signed-in customer and verifies it back', async () => {
    const session = createCustomerSession(1);
    const minted = await call(app, 'POST', '/customer-api/harness-access', {}, session);
    expect(minted.status).toBe(200);
    expect(typeof minted.body?.token).toBe('string');
    expect(minted.body?.url).toBeUndefined();

    const verified = await call(app, 'POST', '/customer-api/harness-verify', { token: minted.body?.token });
    expect(verified.status).toBe(200);
    expect(verified.body?.ok).toBe(true);
    expect(verified.body?.email).toBe(EMAIL);
  });

  it('builds the access URL when the harness origin is configured', async () => {
    process.env.XLAUNCH_HARNESS_URL = 'https://harness.example.work/';
    try {
      const session = createCustomerSession(1);
      const minted = await call(app, 'POST', '/customer-api/harness-access', {}, session);
      expect(minted.status).toBe(200);
      expect(String(minted.body?.url)).toMatch(/^https:\/\/harness\.example\.work\/auth\/access\?token=/);
    } finally {
      delete process.env.XLAUNCH_HARNESS_URL;
    }
  });

  it('refuses strangers on the mint route and bogus tokens on verify', async () => {
    expect((await call(app, 'POST', '/customer-api/harness-access', {})).status).toBe(401);

    const bad = await call(app, 'POST', '/customer-api/harness-verify', { token: 'not-a-token' });
    expect(bad.status).toBe(401);
    expect(bad.body?.ok).toBe(false);

    const missing = await call(app, 'POST', '/customer-api/harness-verify', {});
    expect(missing.status).toBe(401);
  });

  it('keeps a token working across repeated use but not past its expiry', async () => {
    const session = createCustomerSession(1);
    const minted = await call(app, 'POST', '/customer-api/harness-access', {}, session);
    const token = minted.body?.token as string;
    for (let i = 0; i < 3; i += 1) {
      const again = await call(app, 'POST', '/customer-api/harness-verify', { token });
      expect(again.status).toBe(200);
      expect(again.body?.ok).toBe(true);
    }
    // Expire every live token for the account directly, then verify refuses.
    const { getDb } = await import('../../db/index.js');
    getDb().prepare('UPDATE customer_harness_access SET expires_at_ms = ?').run(0);
    const expired = await call(app, 'POST', '/customer-api/harness-verify', { token });
    expect(expired.status).toBe(401);
  });

  it('sends no mail and fails no surface while SMTP is unconfigured', async () => {
    expect(mailConfig()).toBeNull();
    const session = createCustomerSession(1);
    const emailed = await call(app, 'POST', '/customer-api/harness-access/email', {}, session);
    // No harness origin configured in this suite: the route says so rather
    // than pretending an email went out.
    expect(emailed.status).toBe(503);
    const signup = await call(app, 'POST', '/customer-api/signup', { email: 'welcome@example.com', password: PASSWORD });
    expect(signup.status).toBe(201);
    expect(signup.body?.harnessAccessUrl).toBeUndefined();
  });
});
