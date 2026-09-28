// Migration: harness access tokens
// Created: 2026-09-28
//
// DOWN: reversible
//
// A registered customer reaches the hosted harness through a one-click or
// emailed access link, and that link carries a token this table answers for.
// The row holds a HASH of the token, never the token itself, for the same
// reason `customer_sessions` and `customer_password_resets` do: a database
// that leaks must not hand the reader a working credential.
//
// Unlike a reset, a token here is multi-use within its life: the same person
// reasonably clicks an emailed link, then the account button, then the email
// again, and every one of those is the same account asking for the same chat
// surface. What bounds the exposure is the lifetime — short by design — and
// that the surface behind it executes nothing.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_harness_access (
      token_hash    TEXT PRIMARY KEY,
      customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      expires_at_ms INTEGER NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_customer_harness_access_customer
      ON customer_harness_access(customer_id, expires_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS customer_harness_access;');
}
