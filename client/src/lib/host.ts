/**
 * Whether this browser is on the customer's hostname rather than the operator's.
 *
 * By hostname and not by build flag: one image serves both, and a flag would mean two builds that
 * can disagree. `portal.` is the customer prefix; anything else — the operator's SSH tunnel on
 * localhost included — is the dashboard.
 */
export function isCustomerHost(): boolean {
  if (typeof window === 'undefined') return false
  return window.location.hostname.split('.')[0] === 'portal'
}
