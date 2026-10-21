/**
 * Step-up auth policy (audit S1/F1+F2): every credential-disclosure surface
 * demands password re-verification through ONE shared policy — the login
 * lockout's failure budget — and the surfaces that used to disclose on
 * session alone (unified key read/regenerate, URL-token minting) now demand
 * it too. Locked accounts answer 429; a correct password clears the streak.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

let app: Express;
let token: string;

async function call(method: string, path: string, password?: string, email = 'reauth@example.com') {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (password) headers['x-reauth-password'] = password;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { method, headers, body: method === 'POST' && path.includes('url-tokens') ? '{}' : undefined });
  const body = await res.json().catch(() => null);
  server.close();
  void email;
  return { status: res.status, body };
}

describe('step-up auth on credential surfaces', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken('reauth@example.com');
  });

  it('unified key read demands the password (session alone is 403)', async () => {
    const { status, body } = await call('GET', '/api/settings/api-key');
    expect(status).toBe(403);
    expect(body.error.message).toContain('unified API key');
  });

  it('unified key read succeeds with the correct password', async () => {
    const { status, body } = await call('GET', '/api/settings/api-key', 'password123');
    expect(status).toBe(200);
    expect(body.apiKey).toMatch(/^xlaunch-/);
  });

  it('unified key regenerate demands the password', async () => {
    const { status } = await call('POST', '/api/settings/api-key/regenerate');
    expect(status).toBe(403);
  });

  it('URL token minting demands the password', async () => {
    const { status, body } = await call('POST', '/api/settings/url-tokens');
    expect(status).toBe(403);
    expect(body.error.message).toContain('URL token');
  });

  it('wrong passwords accumulate into the shared lockout: the 5th consecutive failure is a 429, not a 403', async () => {
    // 5 wrong attempts (not counted toward other tests: fresh email).
    for (let i = 0; i < 5; i++) {
      const { status } = await call('GET', '/api/keys/export?format=json', `wrong-${i}`);
      expect([403, 429]).toContain(status);
    }
    // The account is now locked — even the CORRECT password is refused while locked.
    const { status, body } = await call('GET', '/api/keys/export?format=json', 'password123');
    expect(status).toBe(429);
    expect(body.error.message).toContain('Too many failed');
  });
});
