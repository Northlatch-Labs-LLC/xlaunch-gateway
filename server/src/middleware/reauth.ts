/**
 * Shared password re-verification with brute-force lockout for the routes
 * that disclose credentials (key reveal/export, unified-key read/regenerate,
 * URL-token minting).
 *
 * The login route keeps its own 5-attempts/15-minutes per-email lockout; this
 * module shares the SAME failure counter so a failed re-verification counts
 * against the same account budget — closing the gap where a stolen dashboard
 * session could otherwise guess the operator's password online without ever
 * tripping the login lockout (audit S1/F1+F2).
 *
 * Disclosing a credential without step-up is the privilege inconsistency this
 * exists to remove: reading ONE provider key required the password, while
 * reading the unified key (or minting a full-equivalent URL token) required
 * only the session. Credential-minting and -disclosure surfaces now demand
 * the same proof, through {@link requireReauth}.
 */

import type { Request, Response } from 'express'
import { verifyCredentials } from '../services/auth.js'

/**
 * Is the caller connecting from this machine? Read from the real socket peer
 * address, NOT req.ip or X-Forwarded-For: those are caller-controlled, so
 * trusting them here would let a remote caller claim to be local. Shared by
 * every reauth-gated surface so the desktop skip means the same thing
 * everywhere.
 */
function isLoopbackRemote(req: Request): boolean {
  let addr = req.socket?.remoteAddress ?? '';
  // Node reports IPv4 loopback over a dual-stack socket as "::ffff:127.0.0.1".
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

/**
 * The desktop-build skip: the bundled desktop app has no password to re-enter
 * for a request from this machine — but ONLY for a request from this machine.
 * A remote viewer of a LAN-shared desktop server still proves the password.
 */
export function skipsReauth(req: Request): boolean {
  return process.env.XLAUNCH_GATEWAY_DESKTOP === '1' && isLoopbackRemote(req)
}

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

/** Per-account (lowercased email) failure count and lock deadline. */
const attempts = new Map<string, { count: number; lockedUntil: number }>()

function isLockedOut(email: string): boolean {
  const entry = attempts.get(email.toLowerCase())
  return !!entry && entry.lockedUntil > Date.now()
}

function recordFailure(email: string): void {
  const key = email.toLowerCase()
  const entry = attempts.get(key) ?? { count: 0, lockedUntil: 0 }
  entry.count++
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS
    entry.count = 0
  }
  attempts.set(key, entry)
}

function clearFailures(email: string): void {
  attempts.delete(email.toLowerCase())
}

/**
 * Verify the `x-reauth-password` header against the session user's account.
 * On any failure — missing password, wrong password, or a currently locked
 * account — answers the response (403/429) and returns false. On success,
 * clears the failure streak and returns true. The desktop loopback skip is
 * the caller's decision (it owns that policy); every call that reaches here
 * is counted.
 */
export function requireReauth(req: Request, res: Response, action: string): boolean {
  const user = (req as unknown as { user?: { email: string } }).user
  const email = user?.email
  if (!email) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } })
    return false
  }
  if (isLockedOut(email)) {
    res.status(429).json({
      error: {
        message: 'Too many failed verifications. Try again later.',
        type: 'authentication_error',
      },
    })
    return false
  }
  const password = req.headers['x-reauth-password'] as string | undefined
  if (!password || !verifyCredentials(email, password)) {
    recordFailure(email)
    const locked = isLockedOut(email)
    res.status(locked ? 429 : 403).json({
      error: {
        message: locked
          ? 'Too many failed verifications. Try again later.'
          : `Password verification required to ${action}`,
        type: 'authentication_error',
      },
    })
    return false
  }
  clearFailures(email)
  return true
}

/**
 * Clear the reauth failure/lockout state. Test-only: a spec exercising denial
 * paths would otherwise lock its fixture account for the rest of the file,
 * because the whole point of this module is that failures persist across
 * surfaces. Not exported from the package; never called by runtime code.
 */
export function __resetReauthForTests(): void {
  attempts.clear()
}
