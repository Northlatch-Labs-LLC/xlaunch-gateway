// @vitest-environment jsdom
//
// The route-map pins in landing-routes.test.ts prove App.tsx wires `/` to the
// landing page. They cannot prove what a visitor then *sees* — a broken i18n
// key or a dropped section would pass them. So this file mounts the real
// LandingPage with the real dictionaries and walks the rendered DOM the way
// the route check does: header, hero, wire-format chips, feature grid,
// three-step guide, pricing card, footer.
import { beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '@/i18n/I18nProvider'
import LandingPage from '@/pages/LandingPage'

const GITHUB_URL = 'https://github.com/Northlatch-Labs-LLC/xlaunch-gateway'

let root: Root | null = null

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  document.body.innerHTML = ''
  root = createRoot(document.body)
})

async function renderLanding(): Promise<void> {
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <I18nProvider initialLocale="en">
          <LandingPage />
        </I18nProvider>
      </MemoryRouter>,
    )
  })
}

describe('landing page at /', () => {
  it('renders every marketing section in the DOM', async () => {
    await renderLanding()
    const text = document.body.textContent ?? ''

    // Landmarks: banner, main, footer, and exactly one h1.
    expect(document.querySelectorAll('header')).toHaveLength(1)
    expect(document.querySelectorAll('main')).toHaveLength(1)
    expect(document.querySelectorAll('footer')).toHaveLength(1)
    expect(document.querySelectorAll('h1')).toHaveLength(1)

    // Hero.
    expect(document.querySelector('h1')?.textContent).toBe(
      'One endpoint for 44+ AI providers. Your keys, your rules.',
    )

    // Wire-format chips.
    for (const chip of ['OpenAI', 'Anthropic Messages', 'OpenAI Responses', 'Google Gemini', 'Ollama', 'MCP']) {
      expect(text).toContain(chip)
    }

    // Feature grid: eight cards, headings from the i18n files.
    const featureTitles = [
      'Five wire formats, one endpoint',
      'Automatic failover and cooldowns',
      'Per-key quota tracking',
      'Response cache',
      'Prompt compression',
      'Analytics and logs',
      'Self-hosted: SQLite, one process',
      'Commercially licensed',
    ]
    for (const title of featureTitles) expect(text).toContain(title)

    // How it works: three steps with real commands.
    for (const step of ['Deploy the gateway', 'Add your provider keys', 'Point your clients at one endpoint']) {
      expect(text).toContain(step)
    }
    expect(text).toContain('docker compose up -d --build')
    expect(text).toContain('npm start --workspace server')
    expect(text).toContain('POST /v1/chat/completions')

    // Pricing: licence-required card, no invented tiers.
    expect(text).toContain('Honest licensing: the gateway is a licensed product')
    expect(text).toContain('Licence required')

    // Footer: repo, license, API docs.
    expect(text).toContain('© 2026 Northlatch Labs LLC')
    expect(text).toContain('Proprietary — all rights reserved')
    expect(text).toContain('API reference')
  })

  it('links out to GitHub and into the portal signup', async () => {
    await renderLanding()
    const github = Array.from(document.querySelectorAll('a')).find(
      a => a.href === GITHUB_URL,
    )
    expect(github).toBeDefined()
    const portalLinks = Array.from(document.querySelectorAll('a[href="/portal"]'))
    expect(portalLinks.length).toBeGreaterThanOrEqual(2) // header + pricing CTA
    const apiDocs = Array.from(document.querySelectorAll('a')).find(a => a.getAttribute('href') === '/v1/docs')
    expect(apiDocs).toBeDefined()
  })

  it('claims the marketing document title', async () => {
    await renderLanding()
    expect(document.title).toBe('Xlaunch Gateway · One endpoint for every AI provider')
  })
})

