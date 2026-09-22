// Which plan a customer holds.
//
// Billing has been charging for plans since the first subscription, but nothing
// recorded the plan itself: the account page could not name it, and the same
// person could subscribe twice because no surface could see that they already
// had one. This is the missing record, and it is deliberately thin — the
// authority on what was paid is the ledger, and the authority on the
// subscription's life is the payment processor. This says only which plan is
// in force right now, since when, and which subscription at the processor it
// belongs to.

import { getDb } from '../db/index.js';

/** The plans this gateway recognizes. An unknown name is refused, not stored. */
export const PLANS = ['pro', 'team'] as const;

/** One plan a customer can hold. */
export type PlanId = typeof PLANS[number];

/** Whether a string is a plan this gateway sells. */
export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}

/** The plan a customer holds, as reported to them. */
export interface PlanHeld {
  plan: PlanId;
  since: string;
  /** When the processor says it next renews, or null when it did not say. */
  renewsAtMs: number | null;
}

interface PlanRow {
  plan: string | null;
  plan_since: string | null;
  plan_renews_at_ms: number | null;
}

/**
 * Read the plan a customer holds.
 *
 * Null means pay as you go — no plan — which is a real state and not a missing
 * value: an account that never subscribed must never read as holding one. A
 * stored plan this build does not recognize is also reported as none, because
 * naming a plan whose terms this code does not know would be a guess.
 *
 * @param customerId - the customer.
 * @returns the plan in force, or null when there is none.
 */
export function planFor(customerId: number): PlanHeld | null {
  const row = getDb().prepare(
    'SELECT plan, plan_since, plan_renews_at_ms FROM customers WHERE id = ?',
  ).get(customerId) as PlanRow | undefined;
  if (!row || !isPlanId(row.plan)) return null;
  return {
    plan: row.plan,
    since: row.plan_since ?? '',
    renewsAtMs: row.plan_renews_at_ms,
  };
}

/** What a plan change did, so a caller can tell a repeat from a real change. */
export type PlanChange = 'set' | 'changed' | 'unchanged' | 'refused';

/**
 * Record the plan a customer now holds.
 *
 * Keyed on the subscription reference from the payment processor, which is what
 * makes this idempotent: the same webhook delivered twice lands the same row in
 * the same state instead of stacking a second plan. A different subscription
 * reference on an account that already holds a plan REPLACES it and reports
 * 'changed', because that is an upgrade or a re-subscribe, and the caller needs
 * to know it happened.
 *
 * @param customerId - the customer.
 * @param plan - the plan they now hold.
 * @param subscriptionRef - the subscription id at the processor.
 * @param renewsAtMs - when the processor says it renews, when it said.
 * @returns what changed.
 */
export function setPlan(
  customerId: number,
  plan: string,
  subscriptionRef: string,
  renewsAtMs: number | null,
): PlanChange {
  if (!isPlanId(plan) || !subscriptionRef) return 'refused';
  const db = getDb();
  const current = db.prepare(
    'SELECT plan, plan_subscription_ref FROM customers WHERE id = ?',
  ).get(customerId) as { plan: string | null; plan_subscription_ref: string | null } | undefined;
  if (!current) return 'refused';

  const repeat = current.plan === plan && current.plan_subscription_ref === subscriptionRef;
  if (repeat) {
    // Still move the renewal date: the processor's answer is the authority and
    // it moves on every renewal, even when nothing else does.
    db.prepare('UPDATE customers SET plan_renews_at_ms = ? WHERE id = ?').run(renewsAtMs, customerId);
    return 'unchanged';
  }

  db.prepare(`
    UPDATE customers
    SET plan = ?, plan_since = datetime('now'), plan_renews_at_ms = ?, plan_subscription_ref = ?
    WHERE id = ?
  `).run(plan, renewsAtMs, subscriptionRef, customerId);
  return current.plan === null ? 'set' : 'changed';
}

/**
 * Clear a customer's plan, back to pay as you go.
 *
 * Only the subscription that is actually in force may end it: a cancellation
 * webhook for a subscription the account has already replaced must not remove
 * the newer plan the customer is paying for.
 *
 * @param customerId - the customer.
 * @param subscriptionRef - the subscription the processor says ended.
 * @returns true when a plan was cleared.
 */
export function clearPlan(customerId: number, subscriptionRef: string): boolean {
  const changes = getDb().prepare(`
    UPDATE customers
    SET plan = NULL, plan_since = NULL, plan_renews_at_ms = NULL, plan_subscription_ref = NULL
    WHERE id = ? AND plan_subscription_ref = ?
  `).run(customerId, subscriptionRef).changes;
  return changes > 0;
}

/**
 * The customer holding a subscription reference, for a webhook that knows the
 * subscription but not the account.
 * @param subscriptionRef - the subscription id at the processor.
 * @returns the customer id, or null.
 */
export function customerForSubscription(subscriptionRef: string): number | null {
  if (!subscriptionRef) return null;
  const row = getDb().prepare(
    'SELECT id FROM customers WHERE plan_subscription_ref = ?',
  ).get(subscriptionRef) as { id: number } | undefined;
  return row?.id ?? null;
}
