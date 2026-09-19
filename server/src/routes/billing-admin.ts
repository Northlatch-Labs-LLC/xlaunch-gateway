// The operator's side of billing: prices, treasury addresses, the customer
// roster, and the payments that have arrived.
//
// Mounted under /api/billing behind the dashboard session gate, so none of it
// is reachable with a customer session or an inference key. Nothing here can
// move funds — the only money operation is an entry in the ledger, which
// changes what a customer is owed, never what a wallet holds.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  billingEnabled,
  ledgerFor,
  postLedger,
  recomputeBalance,
  setBillingEnabled,
  setSuiUsdRate,
  setUsdPerMillionTokens,
  suiUsdRate,
  usdPerMillionTokens,
  USD,
} from '../services/billing.js';
import { paymentConfig, pollPayments, setPaymentConfig } from '../services/payment-watcher.js';

export const billingAdminRouter = Router();

const settingsSchema = z.object({
  billingEnabled: z.boolean().optional(),
  usdPerMillionTokens: z.number().nonnegative().max(10_000).optional(),
  suiUsdRate: z.number().nonnegative().max(1_000_000).optional(),
  paymentsEnabled: z.boolean().optional(),
  suiTreasury: z.string().trim().max(120).optional(),
  suiRpc: z.string().trim().url().max(300).optional(),
  evmChain: z.enum(['ethereum', 'base']).optional(),
  evmTreasury: z.string().trim().max(120).optional(),
  evmRpc: z.string().trim().url().max(300).optional(),
  evmUsdc: z.string().trim().max(120).optional(),
});

// A manual adjustment in whole dollars, positive to grant credit and negative
// to claw it back. Bounded so a slipped keystroke cannot gift a fortune.
const adjustSchema = z.object({
  usd: z.number().finite().min(-1_000_000).max(1_000_000),
  reason: z.string().trim().min(1).max(200).default('manual adjustment'),
});

/**
 * The whole billing and payment configuration in one read, so the settings
 * page renders from a single request.
 * @returns the current configuration.
 */
function currentSettings() {
  const payments = paymentConfig();
  return {
    billingEnabled: billingEnabled(),
    usdPerMillionTokens: usdPerMillionTokens(),
    suiUsdRate: suiUsdRate(),
    paymentsEnabled: payments.enabled,
    suiTreasury: payments.suiTreasury,
    suiRpc: payments.suiRpc,
    evmChain: payments.evmChain,
    evmTreasury: payments.evmTreasury,
    evmRpc: payments.evmRpc,
    evmUsdc: payments.evmUsdc,
  };
}

billingAdminRouter.get('/settings', (_req: Request, res: Response) => {
  res.json(currentSettings());
});

billingAdminRouter.put('/settings', (req: Request, res: Response) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid billing settings' } });
    return;
  }
  const patch = parsed.data;
  if (patch.billingEnabled !== undefined) setBillingEnabled(patch.billingEnabled);
  if (patch.usdPerMillionTokens !== undefined) setUsdPerMillionTokens(patch.usdPerMillionTokens);
  if (patch.suiUsdRate !== undefined) setSuiUsdRate(patch.suiUsdRate);
  setPaymentConfig({
    ...patch.paymentsEnabled === undefined ? {} : { enabled: patch.paymentsEnabled },
    ...patch.suiTreasury === undefined ? {} : { suiTreasury: patch.suiTreasury },
    ...patch.suiRpc === undefined ? {} : { suiRpc: patch.suiRpc },
    ...patch.evmChain === undefined ? {} : { evmChain: patch.evmChain },
    ...patch.evmTreasury === undefined ? {} : { evmTreasury: patch.evmTreasury },
    ...patch.evmRpc === undefined ? {} : { evmRpc: patch.evmRpc },
    ...patch.evmUsdc === undefined ? {} : { evmUsdc: patch.evmUsdc },
  });
  res.json(currentSettings());
});

billingAdminRouter.get('/customers', (_req: Request, res: Response) => {
  const rows = getDb().prepare(`
    SELECT c.id, c.email, c.balance_micros, c.disabled, c.created_at,
      (SELECT COUNT(*) FROM client_profiles p WHERE p.customer_id = c.id) AS key_count,
      (SELECT COUNT(*) FROM customer_wallets w WHERE w.customer_id = c.id) AS wallet_count
    FROM customers c ORDER BY c.id
  `).all() as {
    id: number; email: string; balance_micros: number; disabled: number;
    created_at: string; key_count: number; wallet_count: number;
  }[];
  res.json(rows.map(row => ({
    id: row.id,
    email: row.email,
    balanceMicros: row.balance_micros,
    disabled: row.disabled === 1,
    keyCount: row.key_count,
    walletCount: row.wallet_count,
    createdAt: row.created_at,
  })));
});

billingAdminRouter.get('/customers/:id/ledger', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid customer id' } });
    return;
  }
  res.json({ balanceMicros: recomputeBalance(id), entries: ledgerFor(id, 200) });
});

billingAdminRouter.post('/customers/:id/adjust', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = adjustSchema.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: { message: 'Invalid adjustment' } });
    return;
  }
  const exists = getDb().prepare('SELECT 1 FROM customers WHERE id = ?').get(id);
  if (!exists) {
    res.status(404).json({ error: { message: 'Customer not found' } });
    return;
  }
  const micros = Math.round(Math.abs(parsed.data.usd) * USD);
  if (micros === 0) {
    res.json({ balanceMicros: recomputeBalance(id) });
    return;
  }
  const balanceMicros = postLedger(id, {
    kind: parsed.data.usd >= 0 ? 'credit' : 'debit',
    usdMicros: micros,
    reason: parsed.data.reason,
  });
  res.json({ balanceMicros });
});

billingAdminRouter.patch('/customers/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const disabled = z.object({ disabled: z.boolean() }).safeParse(req.body);
  if (!Number.isInteger(id) || !disabled.success) {
    res.status(400).json({ error: { message: 'Invalid customer update' } });
    return;
  }
  const db = getDb();
  const info = db.prepare('UPDATE customers SET disabled = ? WHERE id = ?')
    .run(disabled.data.disabled ? 1 : 0, id);
  if (info.changes === 0) {
    res.status(404).json({ error: { message: 'Customer not found' } });
    return;
  }
  // Disabling must also end the sessions already issued, otherwise a signed-in
  // customer keeps their portal access until the token expires.
  if (disabled.data.disabled) db.prepare('DELETE FROM customer_sessions WHERE customer_id = ?').run(id);
  res.json({ success: true });
});

billingAdminRouter.delete('/customers/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid customer id' } });
    return;
  }
  const db = getDb();
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM client_profile_usage WHERE profile_id IN (SELECT id FROM client_profiles WHERE customer_id = ?)').run(id);
    db.prepare('DELETE FROM client_profiles WHERE customer_id = ?').run(id);
    db.prepare('DELETE FROM billing_ledger WHERE customer_id = ?').run(id);
    db.prepare('DELETE FROM customer_wallets WHERE customer_id = ?').run(id);
    db.prepare('DELETE FROM customer_sessions WHERE customer_id = ?').run(id);
    // Payments keep their row and lose their owner: money that arrived stays
    // on the books even when the account it funded is gone.
    db.prepare('UPDATE payments SET customer_id = NULL, status = ? WHERE customer_id = ?').run('unmatched', id);
    return db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });
  if (remove().changes === 0) {
    res.status(404).json({ error: { message: 'Customer not found' } });
    return;
  }
  res.json({ success: true });
});

billingAdminRouter.get('/payments', (_req: Request, res: Response) => {
  const rows = getDb().prepare(`
    SELECT p.id, p.chain, p.tx_hash, p.from_address, p.asset, p.amount_atomic,
           p.usd_micros, p.status, p.block_time, p.seen_at, c.email
    FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
    ORDER BY p.id DESC LIMIT 200
  `).all() as Record<string, unknown>[];
  res.json(rows.map(row => ({
    id: row.id,
    chain: row.chain,
    txHash: row.tx_hash,
    fromAddress: row.from_address,
    asset: row.asset,
    amountAtomic: row.amount_atomic,
    usdMicros: row.usd_micros,
    status: row.status,
    email: row.email,
    blockTime: row.block_time,
    seenAt: row.seen_at,
  })));
});

billingAdminRouter.post('/poll', (_req: Request, res: Response) => {
  void pollPayments()
    .then(result => res.json(result))
    .catch((error: unknown) => {
      res.status(502).json({
        error: { message: error instanceof Error ? error.message : 'Poll failed' },
      });
    });
});
