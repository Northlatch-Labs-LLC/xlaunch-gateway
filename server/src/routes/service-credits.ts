// The door a trusted billing service uses to turn a settled card payment into
// account credit.
//
// The Gateway holds no card processor code and no processor secret. The Xlaunch
// website owns that conversation: it creates the checkout, verifies the signed
// webhook, and only then calls this route to say "this customer paid this
// much, under this payment id". What arrives here is a fact already verified
// elsewhere, carried over a shared service token.
//
// Three properties make it safe to expose:
//
// - Off by default. With no XLAUNCH_BILLING_SERVICE_TOKEN set, every request
//   is refused: a deployment that never configured card billing has no door.
// - Exactly once. A payment is recorded in `payments`, whose UNIQUE
//   (chain, tx_hash) makes a second delivery of the same payment id a no-op.
//   Processors redeliver webhooks as a matter of course; the database, not the
//   caller's good behaviour, is what stops a double credit.
// - Atomic. The payment row and the ledger entry commit together, so there is
//   never a recorded payment without its credit or a credit without its record.

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { balanceOf, postLedger } from '../services/billing.js';
import { PLANS, clearPlan, customerForSubscription, planFor, setPlan } from '../services/customer-plan.js';

export const serviceCreditsRouter = Router();

/** Name under which card payments are recorded in `payments.chain`. */
const CARD_CHAIN = 'stripe';

/** Shortest service token accepted; shorter is treated as unconfigured. */
const MIN_TOKEN_LENGTH = 32;

// Amounts are integer cents: a processor reports money in the currency's
// smallest unit, and a float would lose the last cent on large sums. The cap
// bounds what one mistaken or forged call could grant.
const creditSchema = z.object({
  customerEmail: z.string().trim().toLowerCase().email().max(254),
  amountCents: z.number().int().positive().max(1_000_000_00),
  currency: z.literal('usd'),
  // The processor's own id for this payment. It is the idempotency key.
  paymentId: z.string().trim().min(8).max(255),
  // What was bought, for the customer's ledger line.
  reason: z.string().trim().min(1).max(200),
});

/** Micro-dollars in one cent. The ledger is integer micro-dollars throughout. */
const MICROS_PER_CENT = 10_000;

/**
 * The configured service token, or undefined when card billing is not set up.
 * @returns the token, or undefined.
 */
function configuredToken(): string | undefined {
  const token = process.env.XLAUNCH_BILLING_SERVICE_TOKEN?.trim();
  return token !== undefined && token.length >= MIN_TOKEN_LENGTH ? token : undefined;
}

/**
 * Compare two secrets without leaking where they differ. Hashing first gives
 * both sides the same length, which `timingSafeEqual` requires.
 * @param given - the presented value.
 * @param expected - the configured value.
 * @returns whether they match.
 */
function sameSecret(given: string, expected: string): boolean {
  const left = createHash('sha256').update(given).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/** Refuse anything that does not carry the configured service token. */
function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
  const expected = configuredToken();
  if (expected === undefined) {
    res.status(503).json({ error: { message: 'Card billing is not configured on this gateway' } });
    return;
  }
  const header = req.header('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (given === '' || !sameSecret(given, expected)) {
    res.status(401).json({ error: { message: 'Invalid service token' } });
    return;
  }
  next();
}

/** A plan change reported by the billing service. */
const planSchema = z.object({
  customerEmail: z.string().trim().toLowerCase().email().max(254),
  // The plan now in force, or null when the subscription ended.
  plan: z.enum(PLANS).nullable(),
  // The processor's own subscription id. It is the idempotency key, and it is
  // what stops a cancellation for an old subscription removing a newer plan.
  subscriptionRef: z.string().trim().min(3).max(255),
  // When the processor says it renews. Absent is a real answer; this service
  // never computes a renewal date of its own.
  renewsAtMs: z.number().int().positive().max(4_102_444_800_000).nullable().optional(),
});

// Which plan an account holds. Nothing recorded this before, so the account
// page could not name a plan and the same person could subscribe twice.
//
// Idempotent on subscriptionRef: a webhook delivered twice reports 'unchanged'
// rather than stacking a second plan.
serviceCreditsRouter.post('/plan', requireServiceToken, (req: Request, res: Response) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid plan request' } });
    return;
  }
  const { customerEmail, plan, subscriptionRef, renewsAtMs } = parsed.data;
  const customer = getDb().prepare('SELECT id FROM customers WHERE email = ?')
    .get(customerEmail) as { id: number } | undefined;
  if (!customer) {
    // Same rule as a credit: the subscription is real even though the account
    // is not, so the caller keeps the event and retries.
    res.status(404).json({ error: { message: 'No customer has this email' } });
    return;
  }

  if (plan === null) {
    const cleared = clearPlan(customer.id, subscriptionRef);
    // Not an error: a cancellation for a subscription this account has already
    // replaced must leave the newer plan alone, and the caller needs to know
    // nothing was removed.
    res.json({ outcome: cleared ? 'cleared' : 'not-in-force', plan: planFor(customer.id) });
    return;
  }

  const held = customerForSubscription(subscriptionRef);
  if (held !== null && held !== customer.id) {
    res.status(409).json({ error: { message: 'That subscription belongs to another account' } });
    return;
  }

  const outcome = setPlan(customer.id, plan, subscriptionRef, renewsAtMs ?? null);
  if (outcome === 'refused') {
    res.status(400).json({ error: { message: 'That plan cannot be recorded' } });
    return;
  }
  res.status(outcome === 'set' ? 201 : 200).json({ outcome, plan: planFor(customer.id) });
});

serviceCreditsRouter.post('/credits', requireServiceToken, (req: Request, res: Response) => {
  const parsed = creditSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid credit request' } });
    return;
  }
  const { customerEmail, amountCents, paymentId, reason } = parsed.data;
  const db = getDb();

  const customer = db.prepare('SELECT id FROM customers WHERE email = ?')
    .get(customerEmail) as { id: number } | undefined;
  if (!customer) {
    // The payment is real even though the account is not: the caller keeps
    // the event and retries after the customer exists, rather than this route
    // inventing an account from a webhook.
    res.status(404).json({ error: { message: 'No customer has this email' } });
    return;
  }

  const usdMicros = amountCents * MICROS_PER_CENT;
  const apply = db.transaction((): { applied: boolean; balanceMicros: number } => {
    const info = db.prepare(`
      INSERT OR IGNORE INTO payments
        (customer_id, chain, tx_hash, from_address, asset, amount_atomic, usd_micros, status, block_time)
      VALUES (?, ?, ?, ?, 'USD', ?, ?, 'credited', datetime('now'))
    `).run(customer.id, CARD_CHAIN, paymentId, customerEmail, String(amountCents), usdMicros);

    // No row written means this payment id was already recorded: a redelivery.
    if (info.changes === 0) return { applied: false, balanceMicros: balanceOf(customer.id) };

    const balanceMicros = postLedger(customer.id, {
      kind: 'credit',
      usdMicros,
      reason,
      refId: Number(info.lastInsertRowid),
    });
    return { applied: true, balanceMicros };
  });

  const outcome = apply();
  res.status(outcome.applied ? 201 : 200).json(outcome);
});
