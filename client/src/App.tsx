import { Suspense, lazy, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChevronDown, KeyRound, LogOut, Menu, MoreHorizontal, Search, Settings } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AuthGate, ChangeCredentialsModal } from '@/components/auth-gate'
import { CommandPalette } from '@/components/command-palette'
import { openCommandPalette } from '@/components/command-palette-state'
import { ErrorBoundary } from '@/components/error-boundary'
import { SettingsDialog } from '@/components/settings-dialog'
import { Toaster } from '@/components/toaster'
import { I18nProvider, useI18n } from '@/i18n'
import { logout } from '@/lib/api'
import { toast } from '@/lib/toast'
import { ThemeProvider } from '@/theme'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import ModelDetailPage from '@/pages/ModelDetailPage'
import FusionPage from '@/pages/FusionPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import LogsPage from '@/pages/LogsPage'
import NotFoundPage from '@/pages/NotFoundPage'
import AgentsPage from '@/pages/AgentsPage'
import PortalPage from '@/pages/PortalPage'

// The public landing page is the one route split out of the main bundle: a
// first-time visitor downloads marketing, not the dashboard.
const LandingPage = lazy(() => import('@/pages/LandingPage'))

// Every failed mutation surfaces as an error toast, so no action fails
// silently. A page that already shows the failure inline can opt out with
// `meta: { silenceToast: true }` on the mutation.
const queryClient = new QueryClient({
  // staleTime dedupes the mount storm (#1047) and keeps page-to-page
  // navigation off the network: the Models page alone mounts ~13 queries,
  // several of them the same endpoint from different components, and
  // staleTime 0 refetched every one of them on every navigation and window
  // focus. Cached data renders immediately either way; this only decides
  // whether a background refetch follows. Thirty seconds is shorter than any
  // poller here (refetchInterval still fires on its own clock), and mutations
  // invalidate explicitly, so nothing user-visible goes stale.
  defaultOptions: { queries: { staleTime: 30_000 } },
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silenceToast) return
      toast.error(error instanceof Error ? error.message : String(error))
    },
  }),
})

const navItems = [
  { to: '/models', labelKey: 'nav.models' },
  { to: '/playground', labelKey: 'nav.playground' },
  { to: '/keys', labelKey: 'nav.keys' },
  { to: '/agents', labelKey: 'nav.agents' },
  { to: '/analytics', labelKey: 'nav.analytics' },
]

// The pages behind "Models"; surfaced in the nav dropdown and the mobile
// submenu so Fusion is discoverable without first landing on the chat table.
const modelItems = [
  { to: '/models/chat', labelKey: 'models.chatModelsTab' },
  { to: '/models/fusion', labelKey: 'models.fusionTab' },
]

// The pages that hang off "Analytics". Logs is reachable only from here — it is
// deliberately kept out of navItems so the top bar does not grow a seventh entry.
const analyticsItems = [
  { to: '/analytics', labelKey: 'nav.analytics' },
  { to: '/logs', labelKey: 'nav.logs' },
]

// Nav entries rendered as a split control: the label still navigates, and a
// chevron (desktop) / submenu (mobile) reveals the pages behind it. Keyed by the
// nav entry's `to` so both branches below stay one lookup, not two hardcoded
// special cases.
const navMenus: Record<
  string,
  { ariaKey: string; items: { to: string; labelKey: string }[]; isActive: (pathname: string) => boolean }
> = {
  '/models': {
    ariaKey: 'nav.modelsMenu',
    items: modelItems,
    isActive: (pathname) => pathname.startsWith('/models'),
  },
  '/analytics': {
    ariaKey: 'nav.analyticsMenu',
    items: analyticsItems,
    isActive: (pathname) => pathname.startsWith('/analytics') || pathname.startsWith('/logs'),
  },
}

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `relative text-sm px-1 py-4 transition-colors ${
          isActive
            ? 'text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-foreground'
            : 'text-muted-foreground hover:text-foreground'
        }`
      }
    >
      {children}
    </NavLink>
  )
}

function Brand() {
  return (
    // `/admin`, not `/`: the brand mark is dashboard chrome, and the root is
    // now the public landing page.
    <Link to="/admin" className="flex items-center gap-2 transition-opacity hover:opacity-70">
      <span className="inline-block size-2 rounded-full bg-foreground" />
      <span className="font-semibold tracking-tight text-sm">Xlaunch Gateway</span>
    </Link>
  )
}

// True when the dashboard runs inside the desktop shell (Electron preload
// sets this). The navbar then doubles as the window title bar: draggable,
// padded for the macOS traffic lights, and without the web-only Sign out.
const isDesktopApp = typeof window !== 'undefined'
  && (window as Window & { __XLAUNCH_GATEWAY_DESKTOP__?: boolean }).__XLAUNCH_GATEWAY_DESKTOP__ === true

// The preload's own early classList.add can be lost (it may run before this
// document exists), so the client claims the class itself at module load —
// before the first React paint — keeping html.desktop CSS (transparent body,
// glass backdrop) reliable.
if (isDesktopApp) {
  document.documentElement.classList.add('desktop')
}

function AccountMenuItems({
  settingsLabel,
  signOutLabel,
  changeEmailLabel,
  changePasswordLabel,
  onOpenSettings,
  onChangeEmail,
  onChangePassword,
}: {
  settingsLabel: string
  signOutLabel: string
  changeEmailLabel: string
  changePasswordLabel: string
  onOpenSettings: () => void
  onChangeEmail: () => void
  onChangePassword: () => void
}) {
  return (
    <>
      <DropdownMenuItem onClick={onOpenSettings}>
        <Settings />
        {settingsLabel}
      </DropdownMenuItem>
      {/* Desktop signs in with a hidden local account, so it has no credentials
          to change and no session to end. */}
      {!isDesktopApp && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onChangeEmail}>
            <span className="flex size-4 items-center justify-center font-serif text-xs font-bold">@</span>
            {changeEmailLabel}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onChangePassword}>
            <KeyRound />
            {changePasswordLabel}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => logout()}>
            <LogOut />
            {signOutLabel}
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

function Navbar() {
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [credentialsMode, setCredentialsMode] = useState<'password' | 'email' | null>(null)

  return (
    <>
      <header
        // In the desktop shell the body backdrop is already translucent glass;
        // a lighter wash keeps the title bar from looking more solid than the page.
        className={`sticky top-0 z-40 border-b backdrop-blur ${isDesktopApp ? 'bg-background/45' : 'bg-background/80'}`}
        style={isDesktopApp ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
      >
        <div
          // Physical pl (not logical ps): the gutter reserves the macOS
          // traffic lights, which stay top-left even when an RTL locale
          // flips the document direction.
          className={`mx-auto flex max-w-6xl items-center px-4 sm:px-6 ${isDesktopApp ? 'pl-20 sm:pl-20' : ''}`}
          style={isDesktopApp ? { minHeight: 52 } : undefined}
        >
          <Brand />
          <nav
            className="ms-10 hidden items-center gap-6 md:flex"
            style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
          >
            {navItems.map((item) => {
              const menu = navMenus[item.to]
              return menu ? (
                // Split control: the label navigates, the chevron reveals the
                // pages hiding behind it.
                <div key={item.to} className="flex items-center gap-0.5">
                  <NavItem to={item.to}>{t(item.labelKey)}</NavItem>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={t(menu.ariaKey)}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ChevronDown className="size-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-44">
                      {menu.items.map((entry) => (
                        <DropdownMenuItem key={entry.to} onClick={() => navigate(entry.to)}>
                          {t(entry.labelKey)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : (
                <NavItem key={item.to} to={item.to}>
                  {t(item.labelKey)}
                </NavItem>
              )
            })}
          </nav>
          <div
            className="ms-auto hidden items-center gap-1 md:flex"
            style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
          >
            <button
              type="button"
              onClick={openCommandPalette}
              aria-label={t('palette.title')}
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              <Search className="size-3.5" />
              <kbd className="text-[10px] text-muted-foreground">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                aria-label={t('nav.openMenu')}
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <AccountMenuItems
                  settingsLabel={t('nav.settings')}
                  signOutLabel={t('nav.signOut')}
                  changeEmailLabel={t('auth.changeEmail')}
                  changePasswordLabel={t('auth.changePassword')}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onChangeEmail={() => setCredentialsMode('email')}
                  onChangePassword={() => setCredentialsMode('password')}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="ms-auto md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger
                className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                aria-label={t('nav.openMenu')}
              >
                <Menu />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuGroup>
                  {navItems.map((item) => {
                    const menu = navMenus[item.to]
                    return menu ? (
                      <DropdownMenuSub key={item.to}>
                        <DropdownMenuSubTrigger
                          className={menu.isActive(location.pathname) ? 'bg-accent text-accent-foreground font-medium' : undefined}
                        >
                          {t(item.labelKey)}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {menu.items.map((entry) => (
                            <DropdownMenuItem key={entry.to} onClick={() => navigate(entry.to)}>
                              {t(entry.labelKey)}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ) : (
                      <DropdownMenuItem
                        key={item.to}
                        onClick={() => navigate(item.to)}
                        className={location.pathname === item.to ? 'bg-accent text-accent-foreground font-medium' : undefined}
                      >
                        {t(item.labelKey)}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <AccountMenuItems
                  settingsLabel={t('nav.settings')}
                  signOutLabel={t('nav.signOut')}
                  changeEmailLabel={t('auth.changeEmail')}
                  changePasswordLabel={t('auth.changePassword')}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onChangeEmail={() => setCredentialsMode('email')}
                  onChangePassword={() => setCredentialsMode('password')}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {credentialsMode && (
        <ChangeCredentialsModal mode={credentialsMode} onClose={() => setCredentialsMode(null)} />
      )}
    </>
  )
}

// Keyed by pathname so navigating away from a crashed page resets the boundary.
function PageBoundary({ children }: { children: ReactNode }) {
  const location = useLocation()
  return <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
}

// Routes that own the whole viewport instead of sitting in the shell's centred,
// padded column. Only the Playground so far: its three columns run edge to edge
// and the transcript scrolls inside its own pane, so the page must be exactly
// as tall as what is left under the navbar — not a centred card with margins.
const FULL_BLEED_ROUTES = new Set(['/playground'])

// The shell's content container. A full-bleed route drops the max-width and the
// padding and becomes a flex child that fills the rest of the screen; every
// other route gets a centred column that is always exactly max-w-6xl wide.
//
// `w-full` is load-bearing, not decoration. This <main> is an item of a COLUMN
// flex container, so its cross axis is the horizontal one — and flexbox only
// stretches an item across the cross axis when neither cross-axis margin is
// auto (CSS Flexbox §9.6). `mx-auto` sets both, so without an explicit width
// the column shrink-to-fits its content instead: the page is only ever as wide
// as the widest thing that has finished rendering. On a page that fills in from
// several independent queries — Analytics fires ten — that turns every arriving
// response into a visible horizontal jump as the column re-fits, and pages
// whose content never reaches 72rem (Analytics) settle narrower than
// they were designed to be. A definite width makes the column 72rem from the
// first paint, and `mx-auto` goes back to only centring it.
function PageContainer({ children }: { children: ReactNode }) {
  const location = useLocation()
  const fullBleed = FULL_BLEED_ROUTES.has(location.pathname)
  return (
    <main className={fullBleed ? 'flex min-h-0 flex-1 flex-col' : 'mx-auto w-full max-w-6xl px-6 py-8'}>
      {children}
    </main>
  )
}

// The shell column. Padded routes keep `min-h-screen` and scroll as a document;
// a full-bleed route pins the shell to the dynamic viewport instead, because
// min-height alone is a floor, not a ceiling: with an indefinite shell height
// every flex-1 container below grows with its content and the document scrolls
// rather than the one pane (the Playground transcript) that means to.
function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const fullBleed = FULL_BLEED_ROUTES.has(location.pathname)
  return (
    <div className={`flex flex-col ${fullBleed ? 'h-dvh overflow-hidden' : 'min-h-screen'} ${isDesktopApp ? 'desktop-backdrop' : 'bg-background'}`}>
      {children}
    </div>
  )
}

/**
 * Whether this browser is on the customer's hostname rather than the operator's.
 *
 * By hostname and not by build flag: one image serves both, and a flag would mean two builds that
 * can disagree. `portal.` is the customer prefix; anything else — the operator's SSH tunnel on
 * localhost included — is the dashboard.
 */
function isCustomerHost(): boolean {
  if (typeof window === 'undefined') return false
  return window.location.hostname.split('.')[0] === 'portal'
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <BrowserRouter basename={import.meta.env.BASE_URL}>
            {/* The customer portal sits OUTSIDE AuthGate: a buyer signs in with
                their own account against /customer-api and must never need an
                operator login to reach it. */}
            {/* On the customer's own hostname the portal IS the site, at the
                root. Served only at /portal, a buyer arriving at the bare
                customer hostname would get the operator dashboard — which cannot
                reach /api on a public host, correctly, and so reported that it
                could not reach the server. A customer should never meet that
                screen, and should never be told to add a path to the address
                they were given.

                The operator's own hostname is unchanged: everything is the
                dashboard, and /portal still reaches the customer's view for
                checking it. */}
            <Routes>
              {isCustomerHost() ? (
                <Route path="*" element={<><PortalPage /><Toaster /></>} />
              ) : (
                <>
                  {/* The root is the public landing page: the only place a
                      first-time visitor is sold the product. Static `/` wins
                      route ranking over the `*` catch-all below, so the
                      dashboard keeps every existing path untouched. */}
                  <Route
                    path="/"
                    element={(
                      <Suspense fallback={<div className="min-h-screen bg-background" />}>
                        <LandingPage />
                      </Suspense>
                    )}
                  />
                  <Route path="/portal/*" element={<><PortalPage /><Toaster /></>} />
                  <Route path="*" element={<OperatorApp />} />
                </>
              )}
            </Routes>
          </BrowserRouter>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

/** The operator dashboard: everything behind the admin session gate. */
function OperatorApp() {
  return (
            <AuthGate>
              {/* Column, so a full-bleed route can claim the height the navbar
                  leaves without anyone having to know how tall the navbar is.
                  Fixed-position children (toaster, palette) are out of
                  flow, and a padded route stretches to nothing it can show. */}
              <AppShell>
                <Navbar />
                <PageContainer>
                  <PageBoundary>
                    <Routes>
                      {/* The dashboard's front door: `/` now belongs to the
                          public landing, so the operator shell enters here
                          and lands on the chat table as before. */}
                      <Route path="/admin" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/models" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/models/chat" element={<FallbackPage />} />
                      <Route path="/models/chat/:id" element={<ModelDetailPage />} />
                      <Route path="/models/fusion" element={<FusionPage />} />
                      <Route path="/playground" element={<PlaygroundPage />} />
                      <Route path="/keys" element={<KeysPage />} />
                      <Route path="/agents" element={<AgentsPage />} />
                      <Route path="/fallback" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/analytics" element={<AnalyticsPage />} />
                      <Route path="/logs" element={<LogsPage />} />
                      <Route path="/test" element={<Navigate to="/playground" replace />} />
                      <Route path="/health" element={<Navigate to="/keys" replace />} />
                      <Route path="*" element={<NotFoundPage />} />
                    </Routes>
                  </PageBoundary>
                </PageContainer>
                <Toaster />
                <CommandPalette />
              </AppShell>
            </AuthGate>
  )
}

export default App
