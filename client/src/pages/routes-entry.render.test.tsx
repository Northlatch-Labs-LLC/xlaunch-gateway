// @vitest-environment jsdom
//
// Gate 4's route check, continued: landing-routes.test.ts pins the wiring and
// landing.render.test.tsx walks the landing's DOM. This file mounts the two
// entry points a visitor reaches *through* that wiring and pins what they see:
// `/admin` is the operator login (AuthGate over a signed-out status), and
// `/portal` is the customer portal's signed-out sign-in card.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n/I18nProvider'
import { AuthGate } from '@/components/auth-gate'
import PortalPage from '@/pages/PortalPage'

// Signed-out operator: the status query answers before the gate renders.
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async () => ({ needsSetup: false, authenticated: false, email: null })),
  setToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'xlaunch-gateway-unauthorized',
}))

let root: Root | null = null

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  document.body.innerHTML = ''
  root = createRoot(document.body)
  localStorage.clear()
})

describe('/admin renders the operator login', () => {
  it('shows the sign-in card for an unauthenticated visitor', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLocale="en">
            <AuthGate>
              <p>dashboard</p>
            </AuthGate>
          </I18nProvider>
        </QueryClientProvider>,
      )
    })
    // Flush the status query so the gate moves past its loading state.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Sign in')
    expect(text).not.toContain('dashboard') // the gate stays closed
    expect(document.querySelectorAll('input[type="email"], input[autocomplete="username"]')).toHaveLength(1)
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1)
  })
})

describe('/portal renders the customer portal', () => {
  it('shows the portal sign-in card with a signup toggle when signed out', async () => {
    localStorage.clear() // no customer token
    const queryClient = new QueryClient()
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLocale="en">
            <PortalPage />
          </I18nProvider>
        </QueryClientProvider>,
      )
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Sign in')
    expect(text).toContain('Need an account? Create one')
    expect(document.querySelectorAll('input[type="email"]')).toHaveLength(1)
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1)
  })
})

