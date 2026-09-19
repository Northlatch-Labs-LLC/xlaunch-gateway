// Migration: customer accounts, crypto payments and usage billing
// Created: 2026-09-08
//
// DOWN: reversible
//
// Three concerns arrive together because none is useful alone.
//
// `customers` is a SECOND identity space, deliberately separate from `users`:
// a user administers this gateway, a customer buys inference from it. They
// never share a session, a table or a route prefix, so a customer can never
// reach the admin surface even if a bug leaks a token between them.
//
// Money is held as integer micro-dollars (1 USD = 1_000_000) everywhere.
// Floating point would drift across millions of small debits, and a balance
// that drifts is a balance that either overcharges or gives inference away.
//
// `payments` records one on-chain transfer each. `tx_hash` is UNIQUE per
// chain, which is what makes crediting idempotent: a watcher that re-reads the
// same block, or two watchers racing, can only ever insert the row once.
//
// `billing_ledger` is append-only and is the authority on a balance. The
// denormalized `customers.balance_micros` is a cache the ledger can rebuild,
// so a disputed balance is always answerable from history.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      -- Integer micro-dollars. May go negative: a streaming request is billed
      -- after it finishes, so the last request of an exhausted account can
      -- overshoot rather than being cut off mid-answer.
      balance_micros INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customer_sessions (
      token_hash TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- A customer proves ownership of a wallet by paying from it. The address is
    -- globally unique so one wallet can never fund two accounts, which is what
    -- keeps sender-matching unambiguous.
    CREATE TABLE IF NOT EXISTS customer_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      chain TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (chain, address)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      chain TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      from_address TEXT NOT NULL,
      asset TEXT NOT NULL,
      -- The transfer exactly as the chain reports it, in the asset's smallest
      -- unit, kept as text because a u64 of MIST exceeds a JS safe integer.
      amount_atomic TEXT NOT NULL,
      usd_micros INTEGER NOT NULL,
      -- 'credited' when it reached a known wallet; 'unmatched' when the sender
      -- belongs to no customer, which is money received that nobody claimed.
      status TEXT NOT NULL,
      block_time TEXT,
      seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (chain, tx_hash)
    );

    CREATE TABLE IF NOT EXISTS billing_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      -- 'credit' adds (a payment or an operator adjustment); 'debit' subtracts
      -- (inference served).
      kind TEXT NOT NULL CHECK (kind IN ('credit', 'debit')),
      usd_micros INTEGER NOT NULL,
      reason TEXT NOT NULL,
      -- payments.id for a credit, client_profiles.id for a usage debit.
      ref_id INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_billing_ledger_customer
      ON billing_ledger(customer_id, id);
    CREATE INDEX IF NOT EXISTS idx_customer_wallets_lookup
      ON customer_wallets(chain, address);
    CREATE INDEX IF NOT EXISTS idx_payments_customer
      ON payments(customer_id, id);
  `);

  // Which customer a key bills to. NULL keeps the pre-billing behaviour: the
  // operator's own keys are served without a balance check.
  const columns = db.prepare('PRAGMA table_info(client_profiles)').all() as { name: string }[];
  if (!columns.some(entry => entry.name === 'customer_id')) {
    db.exec('ALTER TABLE client_profiles ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE;');
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS billing_ledger;
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS customer_wallets;
    DROP TABLE IF EXISTS customer_sessions;
    DROP TABLE IF EXISTS customers;
  `);
}
