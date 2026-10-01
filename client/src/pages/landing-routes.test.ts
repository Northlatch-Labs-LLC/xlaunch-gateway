import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The public surface is the product now: `/` must sell the gateway to a
// stranger, `/admin` must be the operator dashboard's front door, and `/portal`
// must keep serving customers outside the operator AuthGate. All three are
// wiring contracts in two files, easy to drag back into the gate with a
// refactor, so they are pinned here like the shell heights in App.test.ts.
const here = path.dirname(fileURLToPath(import.meta.url))
const app = readFileSync(path.join(here, '../App.tsx'), 'utf8')
// JSX props wrap across lines; collapse them so a single contains() can pin
// a route without matching prettier's exact wrapping.
const appFlat = app.replace(/\s+/g, ' ')
const landing = readFileSync(path.join(here, 'LandingPage.tsx'), 'utf8')
const desktopWindow = readFileSync(
  path.join(here, '../../../desktop/src/window.ts'),
  'utf8',
)

describe('route map', () => {
  it('serves the landing page at `/` outside AuthGate', () => {
    // Static routes win react-router's ranking over the `*` catch-all, so a
    // declared `/` route is what keeps the dashboard off the root.
    expect(appFlat).toContain('<Route path="/" element={( <Suspense fallback={<div className="min-h-screen bg-background" />}> <LandingPage /> </Suspense> )} />')
    // Code-split contract: the landing is the one lazy page.
    expect(app).toContain("const LandingPage = lazy(() => import('@/pages/LandingPage'))")
  })

  it('keeps the customer portal at /portal, outside the operator gate', () => {
    expect(app).toContain('<Route path="/portal/*" element={<><PortalPage /><Toaster /></>} />')
  })

  it('moves the dashboard front door to /admin', () => {
    expect(app).toContain('<Route path="/admin" element={<Navigate to="/models/chat" replace />} />')
    // The old root redirect must be gone, or `/` would bounce after login.
    expect(app).not.toContain('<Route path="/" element={<Navigate')
  })

  it('keeps the dashboard brand inside the dashboard', () => {
    // The navbar brand is dashboard chrome: it must not dump an authenticated
    // operator onto the public landing page.
    expect(app).toMatch(/<Link to="\/admin" className="flex items-center gap-2/)
  })

  it('keeps every existing dashboard path where it was', () => {
    for (const route of [
      '/models/chat',
      '/models/fusion',
      '/playground',
      '/keys',
      '/agents',
      '/analytics',
      '/logs',
    ]) {
      expect(app).toMatch(new RegExp(`<Route path="${route.replace('/', '\\/')}"`))
    }
  })

  it('sells only through the i18n dictionaries', () => {
    // Every landing string goes through t(), and every key the component
    // asks for exists in the English dictionary (check-i18n then guarantees
    // fr/es parity). A new section with a typo'd key renders as the key
    // itself and fails here.
    const en = JSON.parse(readFileSync(path.join(here, '../i18n/locales/en.json'), 'utf8'))
    const used = [...landing.matchAll(/t\('(landing\.[^']+)'/g)].map(match => match[1])
    expect(used.length).toBeGreaterThan(30)
    const unique = [...new Set(used)]
    for (const key of unique) {
      let node: unknown = en
      for (const segment of key.split('.')) {
        node = (node as Record<string, unknown>)?.[segment]
      }
      expect(typeof node, `en.json is missing ${key}`).toBe('string')
    }
  })

  it('points the desktop shell at the dashboard, not the landing', () => {
    expect(desktopWindow).toMatch(/loadURL\(`http:\/\/127\.0\.0\.1:\$\{port\}\/admin`\)/)
  })
})
