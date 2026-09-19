// Migration: per-client-profile token spend caps
// Created: 2026-09-08
//
// DOWN: reversible
//
// A profile key may carry a token budget so one consumer cannot drain the
// provider credit every other consumer shares. `token_cap` is the ceiling in
// combined input+output tokens (NULL means unlimited) and `cap_period` says
// how often it refills: 'day' and 'month' bucket by calendar date in UTC,
// 'total' never refills.
//
// Usage lives in its own table rather than being summed from `requests`,
// because that table is pruned by REQUEST_ANALYTICS_MAX_ROWS — a cap read from
// it would silently rise again as old rows aged out. One row per profile per
// period keeps the counter durable and the enforcement read a single lookup.

import type { Db } from '../types.js';

/**
 * Add a column only when the table does not already carry it, because SQLite
 * has no `ADD COLUMN IF NOT EXISTS` and a re-run must not fail.
 * @param db - the open database.
 * @param table - table to alter.
 * @param column - column name to check for.
 * @param definition - full column definition used when it is missing.
 */
function addColumnIfMissing(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some(entry => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition};`);
}

export function up(db: Db): void {
  addColumnIfMissing(db, 'client_profiles', 'token_cap', 'token_cap INTEGER');
  addColumnIfMissing(db, 'client_profiles', 'cap_period', "cap_period TEXT NOT NULL DEFAULT 'month'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_profile_usage (
      profile_id INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, period_start)
    );
    CREATE INDEX IF NOT EXISTS idx_client_profile_usage_profile
      ON client_profile_usage(profile_id);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS client_profile_usage;');
  // SQLite before 3.35 cannot drop a column; the added columns are nullable or
  // defaulted, so leaving them is harmless for a downgrade.
}
