// The register flow's second half: a signup mints an UNVERIFIED customer, the
// welcome mail carries the verification link, and wallets and API keys wait
// until the link is followed. Mail never goes anywhere in here: the Resend
// transport is pointed at a stubbed fetch that records what would have been
// sent, which is also how these tests read a token the API refuses to return.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { up as accountsUp } from '../../db/migrations/20260908_000002_customer_accounts_and_billing.js';
import { up as verificationUp } from '../../db/migrations/20261001_000001_email_verification.js';

const EMAIL = 'buyer@example.com';
const PASSWORD = 'a-password-of-length';

/** One mail the stubbed transport "sent". */
interface SentMail { to: string; subject: string; text: string; html: string }
const sent: SentMail[] = [];

/** The URL inside the first mail whose text mentions the given path prefix. */
function linkFrom(path: string): string {
  const mail = sent.find(entry => entry.text.includes(path));
  const match = mail?.text.match(new RegExp(`https://\\S+${path}\\S+`));
  if (match === undefined) throw new Error(`no mailed ${path} link to read`);
  return match[0];
}

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

describe('customer email verification', () => {
  let app: Express;
  let session = '';
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.SMTP_FROM = 'noreply@xlaunch.test';
    process.env.XLAUNCH_PORTAL_URL = 'https://portal.test';
    initDb(':memory:');
    app = createApp();
    // Only Resend's endpoint is stubbed; the test's own HTTP still goes out.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('api.resend.com')) {
        const body = JSON.parse(String(init?.body)) as SentMail;
        sent.push(body);
        return new Response('{}', { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => { /* mails accumulate: later tests read the link an earlier one was sent */ });

  it('signs up unverified, mails a path-form link, and keeps wallets and keys waiting', async () => {
    const signup = await call(app, 'POST', '/customer-api/signup', { email: EMAIL, password: PASSWORD });
    expect(signup.status).toBe(201);
    session = signup.body?.token as string;

    const me = await call(app, 'GET', '/customer-api/me', undefined, session);
    expect(me.body?.emailVerified).toBe(false);

    // The gate: money and credentials wait for a verified address.
    expect((await call(app, 'POST', '/customer-api/wallets', { chain: 'base', address: '0x' + 'a'.repeat(40) }, session)).status).toBe(403);
    expect((await call(app, 'POST', '/customer-api/keys', { name: 'prod' }, session)).status).toBe(403);

    // The welcome mail: path-form link, token never in a query string.
    expect(sent.some(mail => mail.to === EMAIL && /\/verify-email\/[A-Za-z0-9_-]+/.test(mail.text))).toBe(true);
    const verifyUrl = linkFrom('/verify-email/');
    expect(verifyUrl).toMatch(/^https:\/\/portal\.test\/verify-email\//);
    expect(verifyUrl).not.toContain('?');
  });

  it('verifies the address from the mailed link, and the gate opens', async () => {
    const token = linkFrom('/verify-email/').split('/').pop() ?? '';
    const verified = await call(app, 'GET', `/customer-api/verify-email/${token}`);
    expect(verified.status).toBe(200);
    expect(verified.body?.email).toBe(EMAIL);

    const me = await call(app, 'GET', '/customer-api/me', undefined, session);
    expect(me.body?.emailVerified).toBe(true);
    expect((await call(app, 'POST', '/customer-api/wallets', { chain: 'base', address: '0x' + 'a'.repeat(40) }, session)).status).toBe(201);
    expect((await call(app, 'POST', '/customer-api/keys', { name: 'prod' }, session)).status).toBe(201);

    // Single use: the link that worked is dead the second time.
    expect((await call(app, 'GET', `/customer-api/verify-email/${token}`)).status).toBe(410);
    // ...and the account stays verified: a used link must not undo its work.
    expect((await call(app, 'GET', '/customer-api/me', undefined, session)).body?.emailVerified).toBe(true);
  });
  it('resends once and then holds the line for 60 seconds, server-side', async () => {
    // A second, still-unverified account to drive the resend path. Signup
    // itself mails the link, so the first resend is inside the cooldown.
    const signup = await call(app, 'POST', '/customer-api/signup', { email: 'late@example.com', password: PASSWORD });
    const late = signup.body?.token as string;
    sent.length = 0;

    expect((await call(app, 'POST', '/customer-api/email-verification/resend', undefined, late)).status).toBe(429);

    // Once the 60 seconds have passed the resend goes out...
    getDb().prepare('UPDATE customer_email_verifications SET requested_at_ms = ?').run(Date.now() - 61_000);
    const first = await call(app, 'POST', '/customer-api/email-verification/resend', undefined, late);
    expect(first.status).toBe(200);
    expect(first.body?.sent).toBe(true);
    expect(sent.some(mail => mail.to === 'late@example.com' && mail.text.includes('/verify-email/'))).toBe(true);

    // ...and the line holds again until the next minute turns.
    expect((await call(app, 'POST', '/customer-api/email-verification/resend', undefined, late)).status).toBe(429);

    // An already-verified account is told so, and nothing is mailed.
    sent.length = 0;
    const done = await call(app, 'POST', '/customer-api/email-verification/resend', undefined, session);
    expect(done.body?.verified).toBe(true);
    expect(sent.length).toBe(0);
  });

  it('refuses an expired or unknown verification link', async () => {
    const signup = await call(app, 'POST', '/customer-api/signup', { email: 'stale@example.com', password: PASSWORD });
    const stale = signup.body?.token as string;
    const token = linkFrom('/verify-email/').split('/').pop() ?? '';
    getDb().prepare('UPDATE customer_email_verifications SET expires_at_ms = ?').run(Date.now() - 1);
    expect((await call(app, 'GET', `/customer-api/verify-email/${token}`)).status).toBe(410);
    expect((await call(app, 'GET', '/customer-api/me', undefined, stale)).body?.emailVerified).toBe(false);
    expect((await call(app, 'GET', '/customer-api/verify-email/not-a-token')).status).toBe(410);
  });
});

// The migration's own promise: nobody who already had an account is locked out.
describe('the email verification migration', () => {
  it('marks the customers that already exist and leaves new ones unverified', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE client_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
    accountsUp(db);
    db.prepare('INSERT INTO customers (email, password_hash) VALUES (?, ?)').run('old@example.com', 'x');
    verificationUp(db);

    const before = db.prepare('SELECT email_verified FROM customers WHERE email = ?').get('old@example.com') as { email_verified: number };
    expect(before.email_verified).toBe(1);

    db.prepare('INSERT INTO customers (email, password_hash) VALUES (?, ?)').run('new@example.com', 'x');
    const after = db.prepare('SELECT email_verified FROM customers WHERE email = ?').get('new@example.com') as { email_verified: number };
    expect(after.email_verified).toBe(0);
    db.close();
  });
});
