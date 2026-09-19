export const SUPPORTED_LOCALES = [
  'en',
  'fr',
  'es',
] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'
// No shipped locale is right-to-left; the set stays so adding one later
// needs no other change.
export const RTL_LOCALES = new Set<Locale>([])
