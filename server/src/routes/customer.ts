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
  completePasswordReset,
  createCustomer,
  createCustomerSession,
  createPasswordReset,
  deleteCustomerSession,
  issueEmailVerification,
  validateCustomerSession,
  verifyCustomer,
  verifyEmailToken,
  type CustomerSession,
} from '../services/customer-auth.js';
import { planFor } from '../services/customer-plan.js';
import { mintHarnessAccess, verifyHarnessAccess } from '../services/harness-access.js';
import {
  sendHarnessAccessMail,
  sendPasswordResetMail,
  sendSignupMail,
  sendVerificationMail,
} from '../services/mailer.js';
import { createAdminRateLimiter } from '../middleware/rateLimit.js';
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
    // The address has to prove itself before wallets or API keys move, and the
    // proof rides the welcome mail as a path-form link. Mail is
    // fire-and-forget: a slow or down SMTP host must not delay or fail a
    // signup that already succeeded, and the portal banner plus its resend
    // button remain the way in either way.
    const origin = portalOrigin();
    const issued = issueEmailVerification(customer.id);
    const verifyUrl = origin === null || !issued.ok
      ? null
      : `${origin}/verify-email/${issued.verification.token}`;
    const access = mintHarnessAccess(customer.id);
    const harnessOriginUrl = harnessOrigin();
    const harnessAccessUrl = harnessOriginUrl === null
      ? undefined
      : `${harnessOriginUrl}/auth/access/${access.token}`;
    if (verifyUrl !== null) {
      void sendSignupMail(customer.email, verifyUrl, harnessAccessUrl ?? null).catch(() => undefined);
    }
    res.status(201).json({
      token: createCustomerSession(customer.id),
      email: customer.email,
      harnessAccessUrl,
    });
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

// Email verification. An unverified customer can sign in — the session is how
// the portal shows them a banner and a resend button — but wallets and API
// keys wait for the verified mark. The link is path-form, the token is stored
// hashed, and the resend cooldown is 60 seconds per account, server-side.
customerRouter.post(
  '/email-verification/resend',
  createAdminRateLimiter(20),
  requireCustomer,
  async (req: Request, res: Response) => {
    const customer = current(req);
    if (customer.emailVerified) {
      res.json({ verified: true, sent: false });
      return;
    }
    const origin = portalOrigin();
    if (origin === null) {
      res.status(503).json({ error: { message: 'The portal is not configured for emailed verification links yet' } });
      return;
    }
    const issued = issueEmailVerification(customer.id);
    if (!issued.ok) {
      const retryAfter = Math.max(1, Math.ceil(issued.retryInMs / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          message: `A verification mail was just sent. Try again in ${String(retryAfter)} seconds.`,
          type: 'rate_limit_error',
        },
      });
      return;
    }
    const mail = await sendVerificationMail(
      customer.email,
      `${origin}/verify-email/${issued.verification.token}`,
    );
    res.json({ verified: false, sent: mail.sent, reason: mail.sent ? undefined : mail.reason });
  },
);

// The mailed verification link lands here. Expired and already-used are told
// apart on purpose: both are dead ends, but only one is worth asking for a new
// link over. Nothing in the answer reveals anything beyond the token itself.
customerRouter.get('/verify-email/:token', (req: Request, res: Response) => {
  const token = String(req.params.token ?? '');
  const outcome = token.length === 0 || token.length > 200
    ? { ok: false as const, failure: 'invalid' as const }
    : verifyEmailToken(token);
  if (!outcome.ok) {
    const said = {
      invalid: 'This verification link is not valid. Ask for a new one from your account.',
      expired: 'This verification link has expired. Ask for a new one from your account.',
      used: 'This verification link has already been used. Your email is verified.',
    }[outcome.failure];
    res.status(410).json({ error: { message: said } });
    return;
  }
  res.json({ ok: true, email: outcome.customer.email });
});

// A forgotten password, without an operator on the server.
//
// Both routes answer the same way whether or not the address is registered.
// An endpoint that distinguishes them is a way to ask this gateway which of a
// list of addresses has an account here. The reset link is mailed, never
// returned: a token handed to whoever asks would let anyone reset any
// account's password, and the response must carry nothing that differs
// between a registered and an unregistered address.
customerRouter.post(
  '/password-reset',
  createAdminRateLimiter(20),
  async (req: Request, res: Response) => {
    const parsed = z.object({ email: z.string().trim().email().max(200) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'A valid email is required' } });
      return;
    }
    const reset = createPasswordReset(parsed.data.email);
    if (reset !== null) {
      const origin = portalOrigin();
      if (origin !== null) {
        // A failed send must not change the answer: the person is told a mail
        // may have gone out either way, and the reason only reaches the logs.
        await sendPasswordResetMail(
          parsed.data.email,
          `${origin}/reset-password/${reset.token}`,
        ).catch(() => undefined);
      }
    }
    res.json({
      success: true,
      message: 'If that address has an account, a reset link has been mailed to it.',
    });
  },
);

customerRouter.post('/password-reset/complete', (req: Request, res: Response) => {
  const parsed = z.object({
    token: z.string().min(1).max(200),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { message: `A reset token and a password of at least ${String(MIN_PASSWORD_LENGTH)} characters are required` },
    });
    return;
  }
  const outcome = completePasswordReset(parsed.data.token, parsed.data.password);
  if (!outcome.ok) {
    // Expired and already-used are told apart on purpose: both are dead ends,
    // but only one is worth asking for a new link over, and neither reveals
    // whether an address is registered.
    const said = {
      invalid: 'That reset link is not valid.',
      expired: 'That reset link has expired. Ask for a new one.',
      used: 'That reset link has already been used. Ask for a new one.',
      too_short: `A password of at least ${String(MIN_PASSWORD_LENGTH)} characters is required`,
    }[outcome.failure];
    res.status(outcome.failure === 'too_short' ? 400 : 410).json({ error: { message: said } });
    return;
  }
  // Signed straight in: the person just proved they hold the address, and
  // every older session was ended by the reset itself.
  res.json({ token: createCustomerSession(outcome.customer.id), email: outcome.customer.email });
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
    emailVerified: customer.emailVerified,
    balanceMicros: balanceOf(customer.id),
    billingEnabled: billingEnabled(),
    usdPerMillionTokens: usdPerMillionTokens(),
    // The plan in force, or null for pay as you go. Null is a real answer, not
    // a missing one: an account that never subscribed holds no plan.
    plan: planFor(customer.id),
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
  // Money moves against wallets, so an unverified address — which is only a
  // string someone typed at signup — cannot register one.
  if (!current(req).emailVerified) {
    res.status(403).json({ error: { message: 'Verify your email before registering a wallet' } });
    return;
  }
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
  // A key is a credential: it leaves with whoever asks, so it waits for a
  // verified address the same way a wallet does.
  if (!current(req).emailVerified) {
    res.status(403).json({ error: { message: 'Verify your email before creating an API key' } });
    return;
  }
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

// ------------------------------------------------------------------ harness
//
// Access to the hosted harness rides the account, not a terminal: the site's
// account page mints a token and opens the harness with it, a welcome email
// carries the same kind of link, and the harness itself asks this gateway to
// verify whatever token a browser brings. The gateway stays the one identity
// authority; the harness learns only the account's address.

/** Where the hosted harness lives, for building access URLs. Optional: a
 *  surface that knows its own address composes the URL itself. */
function harnessOrigin(): string | null {
  const raw = process.env.XLAUNCH_HARNESS_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Where the customer portal lives, for building mailed account-action links
 *  (verify the address, reset the password). Links are path-form —
 *  `/verify-email/<token>`, `/reset-password/<token>` — so no mail client can
 *  truncate a query string off the credential. Optional: without it no mailed
 *  link can be built, and each endpoint says so honestly rather than mailing a
 *  link to nowhere. */
function portalOrigin(): string | null {
  const raw = process.env.XLAUNCH_PORTAL_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

customerRouter.post('/harness-access', requireCustomer, (req: Request, res: Response) => {
  const access = mintHarnessAccess(current(req).id);
  const origin = harnessOrigin();
  res.json({
    token: access.token,
    expiresAtMs: access.expiresAtMs,
    url: origin === null ? undefined : `${origin}/auth/access/${access.token}`,
  });
});

customerRouter.post('/harness-access/email', requireCustomer, async (req: Request, res: Response) => {
  const customer = current(req);
  const access = mintHarnessAccess(customer.id);
  const origin = harnessOrigin();
  if (origin === null) {
    res.status(503).json({ error: { message: 'The hosted harness is not connected to this gateway yet' } });
    return;
  }
  const url = `${origin}/auth/access/${access.token}`;
  const mail = await sendHarnessAccessMail(customer.email, url);
  res.json({ sent: mail.sent, reason: mail.sent === true ? undefined : mail.reason, url });
});

customerRouter.post('/harness-verify', (req: Request, res: Response) => {
  const parsed = z.object({ token: z.string().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(401).json({ ok: false, error: { message: 'A valid access token is required' } });
    return;
  }
  const account = verifyHarnessAccess(parsed.data.token);
  if (account === null) {
    // The same answer for unknown, expired, and disabled: a stranger probing
    // tokens learns nothing about which of the three they hit.
    res.status(401).json({ ok: false, error: { message: 'This access link is not valid. Open harness access again from your account.' } });
    return;
  }
  res.json({ ok: true, email: account.email });
});
