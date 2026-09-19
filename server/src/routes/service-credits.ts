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
