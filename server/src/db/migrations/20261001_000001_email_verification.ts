// Migration: email verification
// Created: 2026-10-01
//
// DOWN: reversible
//
// A customer signs up from the public portal, so the address they typed is the
// only proof of who they are — and until it is verified it is only a string.
// Unverified accounts may sign in (the session is the same either way, so the
// portal can show a banner and a resend button) but cannot register a wallet
// or mint an API key: money and credentials wait for a verified address.
//
// `email_verified` is a column, not a table, for the same reason `plan` is: the
// question asked of it is always "is this account verified, right now". The
// migration marks every row that already exists as verified — those accounts
// were created before this gate, and locking them out of their own wallets and
// keys would punish the customers who trusted us first.
//
// `customer_email_verifications` mirrors `customer_password_resets`: a HASH of
// the token, never the token (a leaked database must not hand the reader a
// working credential), single use (`used_at_ms`), short-lived
// (`expires_at_ms`), and one live row per account (`requested_at_ms` is when
// the last mail went out, which is what the resend rate limit reads).

import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = (db.prepare('PRAGMA table_info(customers)').all() as { name: string }[])
    .map(entry => entry.name);
  if (!columns.includes('email_verified')) {
    // New rows default to 0; the UPDATE below marks the pre-existing ones.
    db.exec('ALTER TABLE customers ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;');
    db.exec('UPDATE customers SET email_verified = 1;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_email_verifications (
      token_hash      TEXT PRIMARY KEY,
      customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      expires_at_ms   INTEGER NOT NULL,
      used_at_ms      INTEGER,
      requested_at_ms INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_customer_email_verifications_customer
      ON customer_email_verifications(customer_id, expires_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS customer_email_verifications;');
  // The column is dropped the same way it was added; an older SQLite without
  // DROP COLUMN leaves it in place, which is harmless once no code reads it.
  try {
    db.exec('ALTER TABLE customers DROP COLUMN email_verified;');
  } catch {
    // SQLite older than 3.35 cannot drop a column. Leaving it is safe.
  }
}
