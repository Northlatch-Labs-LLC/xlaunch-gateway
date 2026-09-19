// Customer balances, the billing ledger, and what inference costs.
//
// Every amount here is integer micro-dollars (1 USD = 1_000_000). The ledger
// is append-only and authoritative; `customers.balance_micros` is a cache of
// its running sum, so a balance can always be re-derived and defended.

import { getDb, getSetting, setSetting } from '../db/index.js';

/** One micro-dollar unit; 1 USD. */
export const USD = 1_000_000;

/** Price setting keys, stored as text in `settings`. */
const PRICE_PER_MTOK_KEY = 'billing_usd_per_million_tokens';
const SUI_RATE_KEY = 'billing_sui_usd_rate';
const BILLING_ENABLED_KEY = 'billing_enabled';

/** Charged per million combined input+output tokens when nothing is configured. */
const DEFAULT_USD_PER_MTOK = 2;

/** One entry in a customer's statement. */
export interface LedgerEntry {
  id: number;
  kind: 'credit' | 'debit';
  usdMicros: number;
  reason: string;
  refId: number | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

/**
 * Read a numeric setting, falling back when unset or unparseable so a corrupt
 * row can never make inference free or infinitely expensive.
 * @param key - the settings key.
 * @param fallback - value used when the stored one is missing or invalid.
 * @returns the resolved number.
 */
function numericSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Whether balances are enforced at all. Off leaves the gateway free to use. */
export function billingEnabled(): boolean {
  return getSetting(BILLING_ENABLED_KEY) === 'true';
}

/**
 * Turn billing on or off.
 * @param enabled - whether requests should be charged and balances enforced.
 */
export function setBillingEnabled(enabled: boolean): void {
  setSetting(BILLING_ENABLED_KEY, enabled ? 'true' : 'false');
}

/** Dollars charged per million combined tokens. */
export function usdPerMillionTokens(): number {
  return numericSetting(PRICE_PER_MTOK_KEY, DEFAULT_USD_PER_MTOK);
}

/**
 * Set the inference price.
 * @param usd - dollars per million combined input+output tokens.
 */
export function setUsdPerMillionTokens(usd: number): void {
  setSetting(PRICE_PER_MTOK_KEY, String(usd));
}

/**
 * Dollars one SUI is worth. Operator-set rather than fetched: a price feed is
 * an outbound dependency that can fail, stall, or be manipulated, and a wrong
 * rate here silently mis-credits real money. USDC needs no rate.
 * @returns the configured rate, or 0 when none is set.
 */
export function suiUsdRate(): number {
  return numericSetting(SUI_RATE_KEY, 0);
}

/**
 * Set the SUI to USD rate used when crediting SUI payments.
 * @param usd - dollars per 1 SUI.
 */
export function setSuiUsdRate(usd: number): void {
  setSetting(SUI_RATE_KEY, String(usd));
}

/**
 * Price one request. Rounded up, so a request can never cost nothing: a
 * thousand free micro-requests would otherwise be a free tier nobody chose.
 * @param inputTokens - prompt tokens.
 * @param outputTokens - completion tokens.
 * @returns the charge in micro-dollars.
 */
export function priceRequest(inputTokens: number, outputTokens: number): number {
  const tokens = Math.max(0, inputTokens) + Math.max(0, outputTokens);
  if (tokens === 0) return 0;
  return Math.ceil((tokens / 1_000_000) * usdPerMillionTokens() * USD);
}

/**
 * Append one ledger entry and move the cached balance by the same amount, in a
 * single transaction so the two can never disagree.
 * @param customerId - the account to move.
 * @param entry - what happened.
 * @returns the balance after the move, in micro-dollars.
 */
export function postLedger(
  customerId: number,
  entry: {
    kind: 'credit' | 'debit';
    usdMicros: number;
    reason: string;
    refId?: number | null;
    inputTokens?: number;
    outputTokens?: number;
  },
): number {
  const db = getDb();
  const delta = entry.kind === 'credit' ? entry.usdMicros : -entry.usdMicros;
  const apply = db.transaction(() => {
    db.prepare(`
      INSERT INTO billing_ledger (customer_id, kind, usd_micros, reason, ref_id, input_tokens, output_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      customerId,
      entry.kind,
      entry.usdMicros,
      entry.reason,
      entry.refId ?? null,
      entry.inputTokens ?? 0,
      entry.outputTokens ?? 0,
    );
    db.prepare('UPDATE customers SET balance_micros = balance_micros + ? WHERE id = ?')
      .run(delta, customerId);
  });
  apply();
  return balanceOf(customerId);
}

/**
 * Current cached balance.
 * @param customerId - the account to read.
 * @returns micro-dollars, or 0 for an account that no longer exists.
 */
export function balanceOf(customerId: number): number {
  const row = getDb().prepare('SELECT balance_micros FROM customers WHERE id = ?')
    .get(customerId) as { balance_micros: number } | undefined;
  return row?.balance_micros ?? 0;
}

/**
 * Rebuild the cached balance from the ledger. The ledger is the authority, so
 * this is the answer to any dispute about what an account is owed.
 * @param customerId - the account to recompute.
 * @returns the recomputed balance in micro-dollars.
 */
export function recomputeBalance(customerId: number): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN kind = 'credit' THEN usd_micros ELSE -usd_micros END), 0) AS total
    FROM billing_ledger WHERE customer_id = ?
  `).get(customerId) as { total: number };
  db.prepare('UPDATE customers SET balance_micros = ? WHERE id = ?').run(row.total, customerId);
  return row.total;
}

/**
 * A page of a customer's statement, newest first.
 * @param customerId - the account to read.
 * @param limit - maximum entries to return.
 * @returns the ledger entries.
 */
export function ledgerFor(customerId: number, limit = 100): LedgerEntry[] {
  const rows = getDb().prepare(`
    SELECT id, kind, usd_micros, reason, ref_id, input_tokens, output_tokens, created_at
    FROM billing_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT ?
  `).all(customerId, Math.min(Math.max(1, limit), 1000)) as {
    id: number; kind: 'credit' | 'debit'; usd_micros: number; reason: string;
    ref_id: number | null; input_tokens: number; output_tokens: number; created_at: string;
  }[];
  return rows.map(row => ({
    id: row.id,
    kind: row.kind,
    usdMicros: row.usd_micros,
    reason: row.reason,
    refId: row.ref_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at,
  }));
}

/**
 * The customer a profile key bills to, when it belongs to one.
 * @param profileId - the client profile.
 * @returns the owning customer id, or undefined for an operator-owned key.
 */
export function customerForProfile(profileId: number): number | undefined {
  const row = getDb().prepare('SELECT customer_id FROM client_profiles WHERE id = ?')
    .get(profileId) as { customer_id: number | null } | undefined;
  return row?.customer_id ?? undefined;
}

/**
 * Whether this profile's owner has run out of credit. Operator-owned keys and
 * a disabled billing system always pass.
 * @param profileId - the client profile presented for authentication.
 * @returns the owing account and its balance when it is out of credit.
 */
export function outOfCredit(profileId: number): { customerId: number; balanceMicros: number } | undefined {
  if (!billingEnabled()) return undefined;
  const customerId = customerForProfile(profileId);
  if (customerId === undefined) return undefined;
  const balanceMicros = balanceOf(customerId);
  return balanceMicros > 0 ? undefined : { customerId, balanceMicros };
}

/**
 * Charge one served request to the profile's owner. Silent for operator keys
 * and while billing is off.
 * @param profileId - the profile that authenticated the request.
 * @param inputTokens - prompt tokens billed.
 * @param outputTokens - completion tokens billed.
 */
export function chargeUsage(profileId: number, inputTokens: number, outputTokens: number): void {
  if (!billingEnabled()) return;
  const customerId = customerForProfile(profileId);
  if (customerId === undefined) return;
  const cost = priceRequest(inputTokens, outputTokens);
  if (cost === 0) return;
  postLedger(customerId, {
    kind: 'debit',
    usdMicros: cost,
    reason: 'inference',
    refId: profileId,
    inputTokens,
    outputTokens,
  });
}
