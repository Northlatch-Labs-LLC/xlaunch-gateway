// The customer surface, mounted at /customer-api. Everything a buyer needs and
// nothing an operator has: sign up, sign in, register a paying wallet, read a
// balance and statement, and manage their own inference keys.
//
// This router is authenticated by a customer session, never by the admin
// session or the unified key. A customer can only ever see rows their own
// account owns, which is enforced in every query rather than at a wrapper, so
// no future handler can forget it.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { mintClientProfileKey, hashClientProfileKey } from '../lib/system-prompt.js';
import {
  MIN_PASSWORD_LENGTH,
  createCustomer,
  createCustomerSession,
  deleteCustomerSession,
  validateCustomerSession,
  verifyCustomer,
  type CustomerSession,
} from '../services/customer-auth.js';
import { balanceOf, ledgerFor, usdPerMillionTokens, billingEnabled } from '../services/billing.js';
import { paymentConfig, normalizeSuiAddress } from '../services/payment-watcher.js';

export const customerRouter = Router();

/** A request that has passed the customer session gate. */
type CustomerRequest = Request & { customer?: CustomerSession };

const credentialsSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

const walletSchema = z.object({
  chain: z.enum(['sui', 'ethereum', 'base']),
  address: z.string().trim().min(10).max(120),
});

const keySchema = z.object({
  name: z.string().trim().min(1).max(100),
});

/**
 * Require a signed-in customer.
 * @param req - the incoming request.
 * @param res - the response to refuse on.
 * @param next - the next handler.
 */
function requireCustomer(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-customer-token'] as string | undefined);
  const customer = validateCustomerSession(token);
  if (!customer) {
    res.status(401).json({ error: { message: 'Sign in required', type: 'authentication_error' } });
    return;
  }
  (req as CustomerRequest).customer = customer;
  next();
}

/**
 * The signed-in customer of a gated request.
 * @param req - a request that passed requireCustomer.
 * @returns the customer.
 */
function current(req: Request): CustomerSession {
  return (req as CustomerRequest).customer as CustomerSession;
}

/**
 * Normalize an address for storage. EVM addresses are case-insensitive and are
 * lowercased so sender matching cannot miss on checksum casing; Sui addresses
 * are already lowercase hex.
 * @param address - the address as supplied.
 * @returns the normalized address.
 */
function normalizeAddress(chain: string, address: string): string {
  /*
    Stored in the form the payment watcher compares against.

    A Sui address written without its leading zeros is the same address as the
    66-character one, and storing whichever spelling the customer pasted would
    leave their payments matching nothing. EVM addresses are fixed width, so
    case folding is the whole of it there.
  */
  if (chain === 'sui') return normalizeSuiAddress(address);
  return address.trim().toLowerCase();
}

customerRouter.post('/signup', (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: `A valid email and a password of at least ${String(MIN_PASSWORD_LENGTH)} characters are required` } });
    return;
  }
  try {
    const customer = createCustomer(parsed.data.email, parsed.data.password);
    res.status(201).json({ token: createCustomerSession(customer.id), email: customer.email });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'email_taken') {
      res.status(409).json({ error: { message: 'An account with that email already exists' } });
      return;
    }
    throw error;
  }
});

customerRouter.post('/login', (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Email and password are required' } });
    return;
  }
  const customer = verifyCustomer(parsed.data.email, parsed.data.password);
  if (!customer) {
    res.status(401).json({ error: { message: 'Invalid email or password' } });
    return;
  }
  res.json({ token: createCustomerSession(customer.id), email: customer.email });
});

customerRouter.post('/logout', (req: Request, res: Response) => {
  deleteCustomerSession(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
  res.json({ success: true });
});

customerRouter.get('/me', requireCustomer, (req: Request, res: Response) => {
  const customer = current(req);
  const config = paymentConfig();
  res.json({
    email: customer.email,
    balanceMicros: balanceOf(customer.id),
    billingEnabled: billingEnabled(),
    usdPerMillionTokens: usdPerMillionTokens(),
    // Where to send funds, so the portal never hardcodes an address.
    treasury: {
      sui: config.suiTreasury,
      evmChain: config.evmChain,
      evm: config.evmTreasury,
    },
  });
});

customerRouter.get('/wallets', requireCustomer, (req: Request, res: Response) => {
  const rows = getDb().prepare(
    'SELECT id, chain, address, created_at FROM customer_wallets WHERE customer_id = ? ORDER BY id',
  ).all(current(req).id) as { id: number; chain: string; address: string; created_at: string }[];
  res.json(rows.map(row => ({ id: row.id, chain: row.chain, address: row.address, createdAt: row.created_at })));
});

customerRouter.post('/wallets', requireCustomer, (req: Request, res: Response) => {
  const parsed = walletSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'A chain and a wallet address are required' } });
    return;
  }
  const address = normalizeAddress(parsed.data.chain, parsed.data.address);
  try {
    const info = getDb().prepare(
      'INSERT INTO customer_wallets (customer_id, chain, address) VALUES (?, ?, ?)',
    ).run(current(req).id, parsed.data.chain, address);
    res.status(201).json({ id: Number(info.lastInsertRowid), chain: parsed.data.chain, address });
  } catch {
    // The UNIQUE (chain, address) index is what stops one wallet funding two
    // accounts; the refusal says so without naming the other account.
    res.status(409).json({ error: { message: 'That wallet address is already registered' } });
  }
});

customerRouter.delete('/wallets/:id', requireCustomer, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid wallet id' } });
    return;
  }
  const info = getDb().prepare('DELETE FROM customer_wallets WHERE id = ? AND customer_id = ?')
    .run(id, current(req).id);
  if (info.changes === 0) {
    res.status(404).json({ error: { message: 'Wallet not found' } });
    return;
  }
  res.json({ success: true });
});

customerRouter.get('/ledger', requireCustomer, (req: Request, res: Response) => {
  const customer = current(req);
  res.json({ balanceMicros: balanceOf(customer.id), entries: ledgerFor(customer.id, 200) });
});

customerRouter.get('/payments', requireCustomer, (req: Request, res: Response) => {
  const rows = getDb().prepare(`
    SELECT id, chain, tx_hash, asset, amount_atomic, usd_micros, status, block_time, seen_at
    FROM payments WHERE customer_id = ? ORDER BY id DESC LIMIT 100
  `).all(current(req).id) as Record<string, unknown>[];
  res.json(rows.map(row => ({
    id: row.id,
    chain: row.chain,
    txHash: row.tx_hash,
    asset: row.asset,
    amountAtomic: row.amount_atomic,
    usdMicros: row.usd_micros,
    status: row.status,
    blockTime: row.block_time,
    seenAt: row.seen_at,
  })));
});

customerRouter.get('/keys', requireCustomer, (req: Request, res: Response) => {
  const rows = getDb().prepare(`
    SELECT id, name, encrypted_key, iv, auth_tag, enabled, created_at
    FROM client_profiles WHERE customer_id = ? ORDER BY id
  `).all(current(req).id) as {
    id: number; name: string; encrypted_key: string; iv: string; auth_tag: string;
    enabled: number; created_at: string;
  }[];
  res.json(rows.map(row => {
    let masked = '[unavailable]';
    try {
      masked = maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag));
    } catch {
      // A key encrypted under a rotated ENCRYPTION_KEY still authenticates —
      // auth reads the hash — so the row stays usable without its masked form.
    }
    return {
      id: row.id,
      name: row.name,
      maskedKey: masked,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    };
  }));
});

customerRouter.post('/keys', requireCustomer, (req: Request, res: Response) => {
  const parsed = keySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'A key name is required' } });
    return;
  }
  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  const info = getDb().prepare(`
    INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, customer_id)
    VALUES (?, ?, ?, ?, ?, NULL, ?)
  `).run(parsed.data.name, hashClientProfileKey(key), encrypted, iv, authTag, current(req).id);
  // The only time the full key leaves the server.
  res.status(201).json({ id: Number(info.lastInsertRowid), name: parsed.data.name, key });
});

customerRouter.delete('/keys/:id', requireCustomer, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid key id' } });
    return;
  }
  const db = getDb();
  const owned = db.prepare('SELECT 1 FROM client_profiles WHERE id = ? AND customer_id = ?')
    .get(id, current(req).id);
  if (!owned) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }
  db.prepare('DELETE FROM client_profile_usage WHERE profile_id = ?').run(id);
  db.prepare('DELETE FROM client_profiles WHERE id = ?').run(id);
  res.json({ success: true });
});
