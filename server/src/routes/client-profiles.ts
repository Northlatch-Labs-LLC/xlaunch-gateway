import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { mintClientProfileKey, hashClientProfileKey } from '../lib/system-prompt.js';
import { CAP_PERIODS, capStatusFor, normalizeCapPeriod, resetProfileUsage } from '../services/client-profile-quota.js';

// Client-profile CRUD (#411), mounted under /api/client-profiles behind the
// dashboard session gate like every other admin route. The full `sk-cp-...`
// key is returned exactly once — from create and rotate; the list endpoint
// only ever shows the masked form (rendered from the encrypted copy, since
// the auth path stores nothing but a hash).

export const clientProfilesRouter = Router();

const MAX_NAME_LEN = 100;
// Generous ceiling — a system prompt is configuration, not a document.
const MAX_PROMPT_LEN = 32_000;

// A cap is a whole number of combined input+output tokens. null clears it,
// which returns the profile to unlimited.
const tokenCapSchema = z.number().int().positive().nullable();
const capPeriodSchema = z.enum(['day', 'month', 'total']);

const createSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullish(),
  tokenCap: tokenCapSchema.optional(),
  capPeriod: capPeriodSchema.optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN).optional(),
  // null clears the prompt (the profile key then authenticates without
  // injecting anything); absent leaves it untouched.
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullable().optional(),
  enabled: z.boolean().optional(),
  tokenCap: tokenCapSchema.optional(),
  capPeriod: capPeriodSchema.optional(),
});

interface ProfileRow {
  id: number;
  name: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  system_prompt: string | null;
  enabled: number;
  token_cap: number | null;
  cap_period: string | null;
  created_at: string;
  updated_at: string;
}

function maskedKeyFor(row: Pick<ProfileRow, 'encrypted_key' | 'iv' | 'auth_tag'>): string {
  try {
    return maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag));
  } catch {
    return '[decrypt failed]';
  }
}

function toJson(row: ProfileRow) {
  // Usage travels with the profile so the dashboard can render "used of cap"
  // without a second round trip per row.
  const status = capStatusFor(row.id);
  return {
    id: row.id,
    name: row.name,
    maskedKey: maskedKeyFor(row),
    systemPrompt: row.system_prompt,
    enabled: row.enabled === 1,
    tokenCap: row.token_cap,
    capPeriod: normalizeCapPeriod(row.cap_period),
    usage: {
      used: status?.used ?? 0,
      requests: status?.requests ?? 0,
      remaining: status?.remaining ?? null,
      periodStart: status?.periodStart ?? null,
      exceeded: status?.exceeded ?? false,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Period values the dashboard may offer, exported for the settings surface. */
export const CLIENT_PROFILE_CAP_PERIODS = CAP_PERIODS;

function getProfile(id: number): ProfileRow | undefined {
  return getDb().prepare('SELECT * FROM client_profiles WHERE id = ?').get(id) as ProfileRow | undefined;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid profile id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Client profile not found' } });
}

clientProfilesRouter.get('/', (_req: Request, res: Response) => {
  const rows = getDb().prepare('SELECT * FROM client_profiles ORDER BY id').all() as ProfileRow[];
  res.json(rows.map(toJson));
});

clientProfilesRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'A profile name is required' } });
    return;
  }
  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  const prompt = parsed.data.systemPrompt?.trim() || null;
  const info = getDb().prepare(`
    INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, token_cap, cap_period)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parsed.data.name,
    hashClientProfileKey(key),
    encrypted,
    iv,
    authTag,
    prompt,
    parsed.data.tokenCap ?? null,
    parsed.data.capPeriod ?? 'month',
  );
  const row = getProfile(Number(info.lastInsertRowid))!;
  // The only time the full key leaves the server (besides rotate).
  res.status(201).json({ ...toJson(row), key });
});

clientProfilesRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid profile update' } });
    return;
  }
  const row = getProfile(id);
  if (!row) return notFound(res);

  const { name, systemPrompt, enabled, tokenCap, capPeriod } = parsed.data;
  const nextPrompt = systemPrompt === undefined
    ? row.system_prompt
    : (systemPrompt?.trim() || null);
  getDb().prepare(`
    UPDATE client_profiles
    SET name = ?, system_prompt = ?, enabled = ?, token_cap = ?, cap_period = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? row.name,
    nextPrompt,
    enabled === undefined ? row.enabled : (enabled ? 1 : 0),
    tokenCap === undefined ? row.token_cap : tokenCap,
    capPeriod ?? normalizeCapPeriod(row.cap_period),
    id,
  );
  res.json(toJson(getProfile(id)!));
});

clientProfilesRouter.post('/:id/rotate', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const row = getProfile(id);
  if (!row) return notFound(res);

  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  getDb().prepare(`
    UPDATE client_profiles
    SET token_hash = ?, encrypted_key = ?, iv = ?, auth_tag = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(hashClientProfileKey(key), encrypted, iv, authTag, id);
  res.json({ ...toJson(getProfile(id)!), key });
});

// Hand a profile a fresh allowance for the current period without changing
// its cap — the "unblock this consumer now" action.
clientProfilesRouter.post('/:id/reset-usage', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!getProfile(id)) return notFound(res);
  resetProfileUsage(id);
  res.json(toJson(getProfile(id)!));
});

clientProfilesRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const db = getDb();
  db.prepare('DELETE FROM client_profile_usage WHERE profile_id = ?').run(id);
  const info = db.prepare('DELETE FROM client_profiles WHERE id = ?').run(id);
  if (info.changes === 0) return notFound(res);
  res.json({ success: true });
});
