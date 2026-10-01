import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Braces,
  Database,
  FileText,
  KeyRound,
  RefreshCw,
  Server,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { useI18n } from '@/i18n'

// The public landing page: the only marketing surface the gateway has. It is
// lazy-loaded by App.tsx so it ships as its own chunk and the dashboard bundle
// stays exactly as heavy as it was. Every word goes through the i18n files —
// nothing here is hardcoded copy, only code samples and proper nouns.

const GITHUB_URL = 'https://github.com/Northlatch-Labs-LLC/xlaunch-gateway'
const API_DOCS_URL = '/v1/docs'

/** The wire formats the gateway speaks, as chips under the hero. */
const WIRE_FORMATS = [
  'landing.formats.openai',
  'landing.formats.anthropic',
  'landing.formats.responses',
  'landing.formats.gemini',
  'landing.formats.ollama',
  'landing.formats.mcp',
] as const

interface Feature {
  id: string
  icon: LucideIcon
  titleKey: string
  descKey: string
}

const FEATURES: Feature[] = [
  { id: 'wire', icon: Braces, titleKey: 'landing.features.wire.title', descKey: 'landing.features.wire.desc' },
  { id: 'failover', icon: RefreshCw, titleKey: 'landing.features.failover.title', descKey: 'landing.features.failover.desc' },
  { id: 'quotas', icon: KeyRound, titleKey: 'landing.features.quotas.title', descKey: 'landing.features.quotas.desc' },
  { id: 'cache', icon: Database, titleKey: 'landing.features.cache.title', descKey: 'landing.features.cache.desc' },
  { id: 'compression', icon: FileText, titleKey: 'landing.features.compression.title', descKey: 'landing.features.compression.desc' },
  { id: 'analytics', icon: BarChart3, titleKey: 'landing.features.analytics.title', descKey: 'landing.features.analytics.desc' },
  { id: 'selfhosted', icon: Server, titleKey: 'landing.features.selfhosted.title', descKey: 'landing.features.selfhosted.desc' },
  { id: 'license', icon: ShieldCheck, titleKey: 'landing.features.license.title', descKey: 'landing.features.license.desc' },
]

/** A terminal-shaped code sample; commands are literal, never translated. */
function CodeChip({ children }: { children: string }) {
  return (
    <code className="block overflow-x-auto rounded-xl bg-muted px-3 py-2 font-mono text-xs text-foreground">
      {children}
    </code>
  )
}

/** Section scaffolding so every block lands with the same rhythm. */
function Section({
  id, kicker, title, children,
}: { id: string; kicker: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 border-t py-16 sm:py-20">
      <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{kicker}</p>
      <h2 id={`${id}-title`} className="mt-2 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
        {title}
      </h2>
      <div className="mt-8">{children}</div>
    </section>
  )
}

/** One numbered step of the "how it works" ladder. */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted text-xs font-medium"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
      </div>
    </li>
  )
}

/** The marketing site. Public: no auth, no queries, just routes out. */
export default function LandingPage() {
  const { t } = useI18n()

  // The SPA ships one static <title>; claim a marketing one while we are here.
  useEffect(() => {
    document.title = t('landing.metaTitle')
    return () => {
      document.title = t('landing.metaTitleDefault')
    }
  }, [t])

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 transition-opacity hover:opacity-70">
            <span className="inline-block size-2 rounded-full bg-foreground" />
            <span className="text-sm font-semibold tracking-tight">Xlaunch Gateway</span>
          </Link>
          <nav aria-label={t('landing.nav.label')} className="ms-auto flex items-center gap-1">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              GitHub
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </a>
            <Link to="/portal" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('landing.nav.signIn')}
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6">
        {/* Hero */}
        <section aria-labelledby="landing-hero-title" className="py-16 sm:py-24">
          <Badge variant="outline" className="mb-5">{t('landing.hero.badge')}</Badge>
          <h1
            id="landing-hero-title"
            className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
          >
            {t('landing.hero.title')}
          </h1>
          <p className="mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">
            {t('landing.hero.subtitle')}
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              to="/portal/signup"
              className={buttonVariants({ size: 'lg', className: 'h-10 px-5 text-base' })}
            >
              {t('landing.hero.ctaPrimary')}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <a
              href={API_DOCS_URL}
              className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-10 px-5 text-base' })}
            >
              {t('landing.hero.ctaSecondary')}
            </a>
          </div>
          <ul className="mt-10 flex flex-wrap gap-2" aria-label={t('landing.formats.label')}>
            {WIRE_FORMATS.map((key) => (
              <li key={key}>
                <Badge variant="secondary">{t(key)}</Badge>
              </li>
            ))}
          </ul>
        </section>

        {/* Feature grid */}
        <Section id="features" kicker={t('landing.features.kicker')} title={t('landing.features.title')}>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <li
                key={feature.id}
                className="rounded-2xl border bg-card p-5 text-sm"
              >
                <feature.icon className="size-5 text-muted-foreground" aria-hidden="true" />
                <h3 className="mt-3 font-medium">{t(feature.titleKey)}</h3>
                <p className="mt-1.5 text-muted-foreground">{t(feature.descKey)}</p>
              </li>
            ))}
          </ul>
        </Section>

        {/* How it works */}
        <Section id="how" kicker={t('landing.how.kicker')} title={t('landing.how.title')}>
          <ol className="max-w-2xl space-y-10">
            <Step n={1} title={t('landing.how.step1.title')}>
              <p>{t('landing.how.step1.desc')}</p>
              <CodeChip>docker compose up -d --build</CodeChip>
              <p className="text-xs">{t('landing.how.step1.alt')}</p>
              <CodeChip>npm install && npm run build && npm start --workspace server</CodeChip>
            </Step>
            <Step n={2} title={t('landing.how.step2.title')}>
              <p>{t('landing.how.step2.desc')}</p>
              <CodeChip>xlaunch-your-unified-key</CodeChip>
            </Step>
            <Step n={3} title={t('landing.how.step3.title')}>
              <p>{t('landing.how.step3.desc')}</p>
              <CodeChip>POST /v1/chat/completions — Bearer xlaunch-your-unified-key</CodeChip>
              <p className="text-xs">{t('landing.how.step3.alt')}</p>
            </Step>
          </ol>
        </Section>

        {/* Pricing: one honest card, no invented tiers */}
        <Section id="pricing" kicker={t('landing.pricing.kicker')} title={t('landing.pricing.title')}>
          <div className="max-w-xl rounded-2xl border bg-card p-6 sm:p-8">
            <p className="text-sm text-muted-foreground">{t('landing.pricing.software')}</p>
            <p className="mt-2 text-4xl font-semibold tracking-tight">
              $0
              <span className="ms-2 text-base font-normal text-muted-foreground">
                {t('landing.pricing.priceNote')}
              </span>
            </p>
            <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
              <li className="flex gap-2.5">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                {t('landing.pricing.bulletSoftware')}
              </li>
              <li className="flex gap-2.5">
                <KeyRound className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                {t('landing.pricing.bulletInference')}
              </li>
              <li className="flex gap-2.5">
                <Server className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                {t('landing.pricing.bulletHosted')}
              </li>
            </ul>
            <Link
              to="/portal/signup"
              className={buttonVariants({ size: 'lg', className: 'mt-8 h-10 px-5 text-base' })}
            >
              {t('landing.pricing.cta')}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </Section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-6">
          <p>
            © 2026 Northlatch Labs LLC · {t('landing.footer.license')}
          </p>
          <nav aria-label={t('landing.footer.navLabel')} className="flex flex-wrap items-center gap-5 sm:ms-auto">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              GitHub
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </a>
            <a
              href={API_DOCS_URL}
              className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t('landing.footer.apiDocs')}
            </a>
            <Link
              to="/portal"
              className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t('landing.nav.signIn')}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}

