// Client for the customer surface at /customer-api.
//
// Deliberately a separate module from lib/api.ts with its own token key: an
// operator and a customer may both be signed in on the same browser, and a
// shared key would silently hand one of them the other's session.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const TOKEN_KEY = 'xlaunch_gateway_customer_token';

/** The signed-in customer's session token, if any. */
export function getCustomerToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

/** Persist a customer session token. */
export function setCustomerToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable; the session lasts this tab only */ }
}

/** Forget the customer session. */
export function clearCustomerToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing to clear */ }
}

/** An error carrying the HTTP status, so callers can branch on 401 or 409. */
export interface CustomerApiError extends Error {
  status?: number;
}

/**
 * Call the customer API, attaching the session token and turning a non-2xx
 * response into an Error carrying the server's message.
 * @param path - path under /customer-api.
 * @param options - fetch options.
 * @returns the decoded JSON body.
 * @throws a CustomerApiError on any non-2xx reply.
 */
export async function customerFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const token = getCustomerToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${BASE}/customer-api${path}`, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : null;

  if (!response.ok) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message
      ?? `Request failed (${String(response.status)})`;
    const error = new Error(message) as CustomerApiError;
    error.status = response.status;
    // An expired or revoked session should not leave a dead token behind.
    if (response.status === 401) clearCustomerToken();
    throw error;
  }
  return body as T;
}

/** Render integer micro-dollars as a currency string. */
export function formatUsd(micros: number): string {
  return (micros / 1_000_000).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}
