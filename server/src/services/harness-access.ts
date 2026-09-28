// Harness access: mint and verify the tokens that let a registered customer
// open the hosted harness without signing in again there.
//
// The flow: the site's account page (or a welcome email) carries a link to the
// harness's /auth/access with one of these tokens; the harness answers it by
// asking this gateway to verify the token, and signs the visitor in when the
// answer names a live account. The gateway stays the single identity authority
// — the harness holds no account store of its own and learns nothing beyond
// the account's address.
//
// Tokens are multi-use within their lifetime: the same person clicks the
// emailed link, then the account button, then the email again, and every one
// of those is the same account asking for the same chat surface. The lifetime
// is what bounds them, not single use.

import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { hashToken } from './customer-auth.js';

/** How long an access token stays usable. A link is a credential. */
const ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

/** An access token that was minted. The raw token is returned once and never stored. */
export interface HarnessAccess {
  token: string;
  expiresAtMs: number;
}

/** The account an access token names. */
export interface HarnessAccessAccount {
  id: number;
  email: string;
}

/**
 * Mint an access token for a customer.
 * @param customerId - the account the token opens the harness for.
 * @returns the token and its expiry. The token is stored hashed.
 */
export function mintHarnessAccess(customerId: number): HarnessAccess {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAtMs = Date.now() + ACCESS_TTL_MS;
  getDb().prepare(
    'INSERT INTO customer_harness_access (token_hash, customer_id, expires_at_ms) VALUES (?, ?, ?)',
  ).run(hashToken(token), customerId, expiresAtMs);
  return { token, expiresAtMs };
}

/**
 * Resolve an access token to its account, ignoring expired rows.
 * @param token - the token from the access link.
 * @returns the named account, or null.
 */
export function verifyHarnessAccess(token: string | undefined | null): HarnessAccessAccount | null {
  if (!token || token.length > 200) return null;
  const row = getDb().prepare(`
    SELECT c.id, c.email, c.disabled, a.expires_at_ms
    FROM customer_harness_access a JOIN customers c ON c.id = a.customer_id
    WHERE a.token_hash = ?
  `).get(hashToken(token)) as { id: number; email: string; disabled: number; expires_at_ms: number } | undefined;
  if (!row || row.disabled === 1) return null;
  if (row.expires_at_ms < Date.now()) return null;
  return { id: row.id, email: row.email };
}

/** Sweep expired rows. Cheap, index-backed, and safe to call often. */
export function pruneExpiredHarnessAccess(): void {
  getDb().prepare('DELETE FROM customer_harness_access WHERE expires_at_ms < ?').run(Date.now());
}
