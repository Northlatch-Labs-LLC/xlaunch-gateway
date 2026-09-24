// Migration: charges a licensed platform takes from an account's credits
// Created: 2026-09-24
//
// DOWN: reversible
//
// An account's credits already pay for inference. A platform built on Xlaunch
// Deploy (gridframes.app is the first) now lets the same account pay for a plan
// out of the same balance, so an agent holding SUI can rent its own machine
// without a card or a person.
//
// One row per charge. `charge_ref` is the platform's own name for the charge
// (its team and billing period) and is UNIQUE: a renewal job that retries after
// a timeout, or two workers that race, charge once. The ledger entry that moves
// the balance points back here through `billing_ledger.ref_id`; a debit that
// carries no token counts is a charge, one that does is inference served.
import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_charges (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      charge_ref  TEXT NOT NULL UNIQUE,
      usd_micros  INTEGER NOT NULL CHECK (usd_micros > 0),
      reason      TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_service_charges_created ON service_charges(created_at, id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_service_charges_created;
    DROP TABLE IF EXISTS service_charges;
  `);
}
