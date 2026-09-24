// The door a licensed Xlaunch Deploy platform uses to let an account pay for a
// plan out of its credits.
//
// The platform never sees a card and never holds a customer's key. The customer
// proves the account is theirs once, by handing the platform one of their API
// keys; the platform asks this door whose key it is, keeps only the account id,
// and forgets the key. From then on it charges that account by id, once per
// billing period, under a reference it chooses.
//
// It is a separate door from the billing service's, with its own token, because
// the two are held by different parties: the card billing service is ours; a
// platform may be run by a licensee. Neither token opens the other's door.
//
// - Off by default. With no XLAUNCH_PLATFORM_SERVICE_TOKEN set, every request
//   is refused.
// - Exactly once. `service_charges.charge_ref` is UNIQUE; a retried charge
//   returns the first result instead of charging again.
// - Never below zero. A charge the balance cannot cover is refused whole, and
//   nothing is written.
// - Atomic. The charge row and its ledger debit commit together.

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { balanceOf, postLedger } from '../services/billing.js';
import { hashClientProfileKey } from '../lib/system-prompt.js';

export const serviceChargesRouter = Router();

/** Shortest token accepted; shorter is treated as unconfigured. */
const MIN_TOKEN_LENGTH = 32;

/** Micro-dollars in one cent. The ledger is integer micro-dollars throughout. */
const MICROS_PER_CENT = 10_000;

/** Most one call to the listing returns; a statement pages with `afterId`. */
const MAX_LIST = 500;

function configuredToken(): string | undefined {
  const token = process.env.XLAUNCH_PLATFORM_SERVICE_TOKEN?.trim();
  return token !== undefined && token.length >= MIN_TOKEN_LENGTH ? token : undefined;
}

function sameSecret(given: string, expected: string): boolean {
  const left = createHash('sha256').update(given).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

function requirePlatformToken(req: Request, res: Response, next: NextFunction): void {
  const expected = configuredToken();
  if (expected === undefined) {
    res.status(503).json({ error: { message: 'Platform billing is not configured on this gateway' } });
    return;
  }
  const header = req.header('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (given === '' || !sameSecret(given, expected)) {
    res.status(401).json({ error: { message: 'Invalid platform token' } });
    return;
  }
  next();
}

const resolveSchema = z.object({
  apiKey: z.string().trim().min(16).max(512),
});

// Whose account a key belongs to. A disabled key, or one an operator issued
// that no customer owns, belongs to nobody for this purpose.
serviceChargesRouter.post('/accounts/resolve-key', requirePlatformToken, (req: Request, res: Response) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid key' } });
    return;
  }
  const row = getDb().prepare(`
    SELECT c.id AS id, c.email AS email
    FROM client_profiles p JOIN customers c ON c.id = p.customer_id
    WHERE p.token_hash = ? AND p.enabled = 1
  `).get(hashClientProfileKey(parsed.data.apiKey)) as { id: number; email: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'No account holds this key' } });
    return;
  }
  res.json({ customerId: row.id, email: row.email, balanceMicros: balanceOf(row.id) });
});

// Amounts are integer cents, capped so one mistaken or forged call cannot empty
// an account: the most expensive plan is a small fraction of the cap.
const chargeSchema = z.object({
  customerId: z.number().int().positive(),
  amountCents: z.number().int().positive().max(1_000_00),
  // The platform's own name for this charge: its team and billing period.
  chargeRef: z.string().trim().min(8).max(255),
  // What was bought, for the customer's ledger line.
  reason: z.string().trim().min(1).max(200),
});

type ChargeOutcome =
  | { kind: 'charged'; chargeId: number; balanceMicros: number }
  | { kind: 'repeat'; chargeId: number; balanceMicros: number }
  | { kind: 'conflict' }
  | { kind: 'no-account' }
  | { kind: 'insufficient'; balanceMicros: number; requiredMicros: number };

serviceChargesRouter.post('/charges', requirePlatformToken, (req: Request, res: Response) => {
  const parsed = chargeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid charge request' } });
    return;
  }
  const { customerId, amountCents, chargeRef, reason } = parsed.data;
  const usdMicros = amountCents * MICROS_PER_CENT;
  const db = getDb();

  const charge = db.transaction((): ChargeOutcome => {
    const earlier = db.prepare('SELECT id, customer_id, usd_micros FROM service_charges WHERE charge_ref = ?')
      .get(chargeRef) as { id: number; customer_id: number; usd_micros: number } | undefined;
    if (earlier) {
      // The same reference for a different account or amount is a caller bug,
      // not a retry; answering "already charged" would hide it.
      if (earlier.customer_id !== customerId || earlier.usd_micros !== usdMicros) return { kind: 'conflict' };
      return { kind: 'repeat', chargeId: earlier.id, balanceMicros: balanceOf(customerId) };
    }
    const exists = db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId);
    if (!exists) return { kind: 'no-account' };
    const balanceMicros = balanceOf(customerId);
    if (balanceMicros < usdMicros) return { kind: 'insufficient', balanceMicros, requiredMicros: usdMicros };
    const info = db.prepare('INSERT INTO service_charges (customer_id, charge_ref, usd_micros, reason) VALUES (?, ?, ?, ?)')
      .run(customerId, chargeRef, usdMicros, reason);
    const chargeId = Number(info.lastInsertRowid);
    const after = postLedger(customerId, { kind: 'debit', usdMicros, reason, refId: chargeId });
    return { kind: 'charged', chargeId, balanceMicros: after };
  });

  const outcome = charge();
  switch (outcome.kind) {
    case 'charged':
      res.status(201).json({ applied: true, chargeId: outcome.chargeId, balanceMicros: outcome.balanceMicros });
      return;
    case 'repeat':
      res.status(200).json({ applied: false, chargeId: outcome.chargeId, balanceMicros: outcome.balanceMicros });
      return;
    case 'conflict':
      res.status(409).json({ error: { message: 'That charge reference was used for a different charge' } });
      return;
    case 'no-account':
      res.status(404).json({ error: { message: 'No such account' } });
      return;
    case 'insufficient':
      res.status(402).json({
        error: { message: 'The account does not hold enough credit' },
        balanceMicros: outcome.balanceMicros,
        requiredMicros: outcome.requiredMicros,
      });
      return;
  }
});

const listSchema = z.object({
  afterId: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIST).default(100),
});

// Every charge taken, oldest first, for the platform's finance page and the
// monthly settlement between the two companies. `truncated` says there is more:
// "that is all of them" and "the page ran out" must not look alike.
serviceChargesRouter.get('/charges', requirePlatformToken, (req: Request, res: Response) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid listing request' } });
    return;
  }
  const { afterId, limit } = parsed.data;
  const rows = getDb().prepare(`
    SELECT s.id, s.customer_id, c.email, s.charge_ref, s.usd_micros, s.reason, s.created_at
    FROM service_charges s JOIN customers c ON c.id = s.customer_id
    WHERE s.id > ? ORDER BY s.id LIMIT ?
  `).all(afterId, limit + 1) as {
    id: number; customer_id: number; email: string; charge_ref: string; usd_micros: number; reason: string; created_at: string;
  }[];
  const truncated = rows.length > limit;
  res.json({
    charges: rows.slice(0, limit).map(row => ({
      chargeId: row.id,
      customerId: row.customer_id,
      email: row.email,
      chargeRef: row.charge_ref,
      amountCents: row.usd_micros / MICROS_PER_CENT,
      reason: row.reason,
      createdAt: row.created_at,
    })),
    truncated,
  });
});
