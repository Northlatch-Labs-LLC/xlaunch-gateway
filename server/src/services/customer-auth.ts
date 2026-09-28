// Customer identity: signup, login and sessions for the people who BUY
// inference, kept entirely separate from the operator accounts in auth.ts.
//
// The two identity spaces share nothing — not a table, not a session store,
// not a route prefix. A customer token presented to the admin surface resolves
// to nothing, and an admin token presented to the customer surface does the
// same, so neither can be escalated into the other by a mix-up.

import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

/** How long a customer session stays valid. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The minimum password this surface accepts. */
export const MIN_PASSWORD_LENGTH = 10;

/** A signed-in customer. */
export interface CustomerSession {
  id: number;
  email: string;
}

interface CustomerRow {
  id: number;
  email: string;
  password_hash: string;
  disabled: number;
}

/**
 * Hash a session token for storage, so a stolen database cannot be replayed as
 * a live session.
 * @param token - the opaque token handed to the client.
 * @returns its SHA-256 hex digest.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Normalize an email for storage and lookup, so the same address cannot be
 * registered twice in different cases.
 * @param email - the address as typed.
 * @returns the normalized address.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Register a customer.
 * @param email - the address they sign in with.
 * @param password - their chosen password.
 * @returns the new account.
 * @throws with code 'email_taken' when the address is already registered.
 */
export function createCustomer(email: string, password: string): CustomerSession {
  const normalized = normalizeEmail(email);
  try {
    const info = getDb().prepare(
      'INSERT INTO customers (email, password_hash) VALUES (?, ?)',
    ).run(normalized, hashPassword(password));
    return { id: Number(info.lastInsertRowid), email: normalized };
  } catch (error) {
    const err = new Error('An account with that email already exists') as Error & { code?: string };
    err.code = 'email_taken';
    void error;
    throw err;
  }
}

/**
 * Check a customer's credentials. A disabled account fails exactly like a
 * wrong password, so disabling cannot be probed from outside.
 * @param email - the address supplied.
 * @param password - the password supplied.
 * @returns the account, or null when the pair is not valid.
 */
export function verifyCustomer(email: string, password: string): CustomerSession | null {
  const row = getDb().prepare(
    'SELECT id, email, password_hash, disabled FROM customers WHERE email = ?',
  ).get(normalizeEmail(email)) as CustomerRow | undefined;
  if (!row || row.disabled === 1) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, email: row.email };
}

/**
 * Issue a session token.
 * @param customerId - the account signing in.
 * @returns the opaque token to hand to the client.
 */
export function createCustomerSession(customerId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  getDb().prepare(
    'INSERT INTO customer_sessions (token_hash, customer_id, expires_at_ms) VALUES (?, ?, ?)',
  ).run(hashToken(token), customerId, Date.now() + SESSION_TTL_MS);
  return token;
}

/**
 * Resolve a session token to its customer, dropping it when expired.
 * @param token - the bearer token from the request.
 * @returns the signed-in customer, or null.
 */
export function validateCustomerSession(token: string | undefined | null): CustomerSession | null {
  if (!token) return null;
  const db = getDb();
  const hash = hashToken(token);
  const row = db.prepare(`
    SELECT c.id, c.email, c.disabled, s.expires_at_ms
    FROM customer_sessions s JOIN customers c ON c.id = s.customer_id
    WHERE s.token_hash = ?
  `).get(hash) as { id: number; email: string; disabled: number; expires_at_ms: number } | undefined;
  if (!row) return null;
  if (row.expires_at_ms < Date.now() || row.disabled === 1) {
    db.prepare('DELETE FROM customer_sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  return { id: row.id, email: row.email };
}

/**
 * End one session.
 * @param token - the token to revoke.
 */
export function deleteCustomerSession(token: string | undefined | null): void {
  if (!token) return;
  getDb().prepare('DELETE FROM customer_sessions WHERE token_hash = ?').run(hashToken(token));
}

/** How long a password reset stays usable. Short: a link is a credential. */
const RESET_TTL_MS = 60 * 60 * 1000;

/** A reset that was issued. The token is returned once and never stored. */
export interface PasswordReset {
  token: string;
  expiresAtMs: number;
}

/**
 * Issue a password reset for an address.
 *
 * Returns null when no account holds that address. The CALLER must answer the
 * same way either way: an endpoint that says "no such account" tells a stranger
 * which addresses are registered here.
 *
 * Any reset already outstanding for the account is dropped first, so a person
 * who clicks twice has exactly one live link rather than several.
 *
 * @param email - the address as typed.
 * @returns the reset to deliver, or null when the address is not registered.
 */
export function createPasswordReset(email: string): PasswordReset | null {
  const db = getDb();
  const row = db.prepare('SELECT id, disabled FROM customers WHERE email = ?')
    .get(normalizeEmail(email)) as { id: number; disabled: number } | undefined;
  // A disabled account is not a route back in.
  if (!row || row.disabled === 1) return null;

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAtMs = Date.now() + RESET_TTL_MS;
  db.prepare('DELETE FROM customer_password_resets WHERE customer_id = ?').run(row.id);
  db.prepare(
    'INSERT INTO customer_password_resets (token_hash, customer_id, expires_at_ms) VALUES (?, ?, ?)',
  ).run(hashToken(token), row.id, expiresAtMs);
  return { token, expiresAtMs };
}

/** Why a reset could not be completed. The caller decides what to say. */
export type ResetFailure = 'invalid' | 'expired' | 'used' | 'too_short';

/**
 * Set a new password from a reset token, single use.
 *
 * Every session the account holds is ended in the same transaction as the
 * change. A password reset is what somebody does when they fear the account is
 * not theirs alone; leaving the old sessions alive would defeat it.
 *
 * @param token - the token from the reset link.
 * @param password - the new password.
 * @returns the account, or the reason it failed.
 */
export function completePasswordReset(
  token: string,
  password: string,
): { ok: true; customer: CustomerSession } | { ok: false; failure: ResetFailure } {
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, failure: 'too_short' };
  const db = getDb();
  const hash = hashToken(token);
  const row = db.prepare(`
    SELECT r.customer_id, r.expires_at_ms, r.used_at_ms, c.email, c.disabled
    FROM customer_password_resets r JOIN customers c ON c.id = r.customer_id
    WHERE r.token_hash = ?
  `).get(hash) as {
    customer_id: number; expires_at_ms: number; used_at_ms: number | null;
    email: string; disabled: number;
  } | undefined;

  if (!row || row.disabled === 1) return { ok: false, failure: 'invalid' };
  if (row.used_at_ms !== null) return { ok: false, failure: 'used' };
  if (row.expires_at_ms < Date.now()) return { ok: false, failure: 'expired' };

  const now = Date.now();
  const apply = db.transaction(() => {
    db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?')
      .run(hashPassword(password), row.customer_id);
    db.prepare('UPDATE customer_password_resets SET used_at_ms = ? WHERE token_hash = ?')
      .run(now, hash);
    db.prepare('DELETE FROM customer_sessions WHERE customer_id = ?').run(row.customer_id);
  });
  apply();
  return { ok: true, customer: { id: row.customer_id, email: row.email } };
}
