// Token spend caps for client-profile keys.
//
// The gateway's other limits protect UPSTREAM provider quotas: they are keyed
// by (platform, model, provider key). This one protects the operator from a
// single downstream consumer, so it is keyed by client profile. A profile that
// reaches its cap is refused at authentication, before routing spends anything.

import { getDb } from '../db/index.js';

/** How often a profile's cap refills. */
export type CapPeriod = 'day' | 'month' | 'total';

/** Accepted period values, in the order the dashboard offers them. */
export const CAP_PERIODS: readonly CapPeriod[] = ['day', 'month', 'total'];

/** One profile's cap and its consumption for the current period. */
export interface CapStatus {
  /** Ceiling in combined input+output tokens; null when the profile is uncapped. */
  cap: number | null;
  /** The refill period this profile uses. */
  period: CapPeriod;
  /** Bucket the current usage is counted in. */
  periodStart: string;
  /** Tokens already spent in that bucket. */
  used: number;
  /** Requests already served in that bucket. */
  requests: number;
  /** Tokens left before the cap; null when uncapped. */
  remaining: number | null;
  /** Whether the cap is reached and further requests must be refused. */
  exceeded: boolean;
}

interface ProfileCapRow {
  token_cap: number | null;
  cap_period: string | null;
}

interface UsageRow {
  input_tokens: number;
  output_tokens: number;
  requests: number;
}

/**
 * Normalize a stored or supplied period value.
 * @param value - the raw period.
 * @returns a known period, defaulting to monthly.
 */
export function normalizeCapPeriod(value: unknown): CapPeriod {
  return CAP_PERIODS.includes(value as CapPeriod) ? value as CapPeriod : 'month';
}

/**
 * The bucket key usage accumulates into. Calendar buckets use UTC so a server
 * that changes timezone does not hand a consumer a second allowance.
 * @param period - the refill period.
 * @param now - the instant to bucket; defaults to the current time.
 * @returns the bucket key stored in `client_profile_usage.period_start`.
 */
export function periodStartFor(period: CapPeriod, now: Date = new Date()): string {
  if (period === 'total') return 'total';
  const iso = now.toISOString();
  return period === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}

/**
 * Read one profile's cap and current consumption.
 * @param profileId - the client profile.
 * @returns the cap state, or undefined when no such profile exists.
 */
export function capStatusFor(profileId: number): CapStatus | undefined {
  const db = getDb();
  const profile = db.prepare(
    'SELECT token_cap, cap_period FROM client_profiles WHERE id = ?',
  ).get(profileId) as ProfileCapRow | undefined;
  if (!profile) return undefined;

  const period = normalizeCapPeriod(profile.cap_period);
  const periodStart = periodStartFor(period);
  const usage = db.prepare(
    'SELECT input_tokens, output_tokens, requests FROM client_profile_usage WHERE profile_id = ? AND period_start = ?',
  ).get(profileId, periodStart) as UsageRow | undefined;

  const used = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  const cap = profile.token_cap ?? null;
  return {
    cap,
    period,
    periodStart,
    used,
    requests: usage?.requests ?? 0,
    remaining: cap === null ? null : Math.max(0, cap - used),
    exceeded: cap !== null && used >= cap,
  };
}

/**
 * Whether this profile has already spent its allowance. A profile that has
 * disappeared is treated as within cap, because authentication has already
 * refused an unknown key by the time this is asked.
 * @param profileId - the client profile.
 * @returns the cap state when the cap is reached, otherwise undefined.
 */
export function exceededCap(profileId: number): CapStatus | undefined {
  const status = capStatusFor(profileId);
  return status?.exceeded === true ? status : undefined;
}

/**
 * Add one served request's tokens to a profile's current bucket. Called inside
 * the request-log transaction so the counter can never drift from the request
 * row that produced it.
 * @param db - the transaction the caller already opened.
 * @param profileId - the client profile that authenticated the request.
 * @param inputTokens - prompt tokens billed to this request.
 * @param outputTokens - completion tokens billed to this request.
 */
export function recordProfileUsage(
  db: ReturnType<typeof getDb>,
  profileId: number,
  inputTokens: number,
  outputTokens: number,
): void {
  const row = db.prepare(
    'SELECT cap_period FROM client_profiles WHERE id = ?',
  ).get(profileId) as ProfileCapRow | undefined;
  if (!row) return;
  const periodStart = periodStartFor(normalizeCapPeriod(row.cap_period));
  db.prepare(`
    INSERT INTO client_profile_usage (profile_id, period_start, input_tokens, output_tokens, requests)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(profile_id, period_start) DO UPDATE SET
      input_tokens  = input_tokens + ?,
      output_tokens = output_tokens + ?,
      requests      = requests + 1,
      updated_at    = datetime('now')
  `).run(profileId, periodStart, inputTokens, outputTokens, inputTokens, outputTokens);
}

/**
 * Clear a profile's consumption for the current period, handing it a fresh
 * allowance without changing the cap itself.
 * @param profileId - the client profile.
 */
export function resetProfileUsage(profileId: number): void {
  const db = getDb();
  const row = db.prepare(
    'SELECT cap_period FROM client_profiles WHERE id = ?',
  ).get(profileId) as ProfileCapRow | undefined;
  if (!row) return;
  db.prepare(
    'DELETE FROM client_profile_usage WHERE profile_id = ? AND period_start = ?',
  ).run(profileId, periodStartFor(normalizeCapPeriod(row.cap_period)));
}
