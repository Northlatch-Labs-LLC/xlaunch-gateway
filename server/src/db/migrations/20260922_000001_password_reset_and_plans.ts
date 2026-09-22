// Migration: customer password resets, and the plan a customer holds
// Created: 2026-09-22
//
// DOWN: reversible
//
// Two gaps that only show up once a real customer exists, and both are on the
// paying path.
//
// `customer_password_resets` closes the first: today a forgotten password can
// only be changed by an operator on the server. The row holds a HASH of the
// token, never the token, for the same reason `customer_sessions` does: a
// database that leaks must not hand the reader a working credential. One row
// per request, single use (`used_at_ms`), and short-lived (`expires_at_ms`),
// so a link found later in a mailbox is already worthless.
//
// The plan columns close the second. Billing has been charging for plans since
// the first subscription, but nothing recorded which plan an account holds, so
// the account page could not name it and the same person could subscribe twice
// without anything noticing. The plan lives on `customers` rather than in its
// own table because a customer holds at most one at a time and the question
// asked of it is always "which one, right now".
//
// `plan_subscription_ref` is the subscription id at the payment processor. It
// is what makes a plan change idempotent: the same webhook delivered twice
// updates the same row to the same state instead of stacking a second plan.
// `plan_renews_at_ms` is what the processor said, not a date computed here: a
// renewal date this service invents would drift from the one the customer is
// actually charged on.
import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_password_resets (
      token_hash    TEXT PRIMARY KEY,
      customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      expires_at_ms INTEGER NOT NULL,
      used_at_ms    INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_customer_password_resets_customer
      ON customer_password_resets(customer_id, expires_at_ms);
  `);

  // Added one at a time: SQLite has no "ADD COLUMN IF NOT EXISTS", and this
  // migration must be safe to re-run over a database that already has some.
  const columns = (db.prepare('PRAGMA table_info(customers)').all() as { name: string }[])
    .map(entry => entry.name);
  const add = (name: string, definition: string): void => {
    if (!columns.includes(name)) db.exec(`ALTER TABLE customers ADD COLUMN ${name} ${definition};`);
  };
  // NULL means no plan: pay as you go. A customer who never subscribed must not
  // read as holding the cheapest plan.
  add('plan', 'TEXT');
  add('plan_since', 'TEXT');
  add('plan_renews_at_ms', 'INTEGER');
  add('plan_subscription_ref', 'TEXT');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_plan_subscription
      ON customers(plan_subscription_ref) WHERE plan_subscription_ref IS NOT NULL;
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_customers_plan_subscription;
    DROP TABLE IF EXISTS customer_password_resets;
  `);
  // The plan columns are dropped one at a time for the same reason they were
  // added that way; an older SQLite without DROP COLUMN leaves them in place,
  // which is harmless because nothing reads them once the code is gone.
  for (const column of ['plan_subscription_ref', 'plan_renews_at_ms', 'plan_since', 'plan']) {
    try {
      db.exec(`ALTER TABLE customers DROP COLUMN ${column};`);
    } catch {
      // SQLite older than 3.35 cannot drop a column. Leaving it is safe.
    }
  }
}
