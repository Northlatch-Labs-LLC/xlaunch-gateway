import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Copy, LogOut, Plus, Trash2, Wallet } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmButton } from '@/components/confirm-button'
import { copyText } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { isCustomerHost } from '@/lib/host'
import { isEmail } from '@/lib/validate'
import { useI18n } from '@/i18n'
import {
  clearCustomerToken,
  customerFetch,
  type CustomerApiError,
  formatUsd,
  getCustomerToken,
  setCustomerToken,
} from '@/lib/customer-api'

// The customer portal: what a person who BUYS inference sees. It shares this
// bundle with the operator dashboard but nothing else — its own session token,
// its own API prefix, and no route into /api. It sits outside AuthGate, since
// a customer must reach it without an operator login.

/** Chains a customer may register a paying wallet on. */
const CHAINS = [
  { value: 'sui', labelKey: 'portal.chainSui' },
  { value: 'base', labelKey: 'portal.chainBase' },
  { value: 'ethereum', labelKey: 'portal.chainEthereum' },
] as const

// Matches the server rule (services/customer-auth.ts MIN_PASSWORD_LENGTH).
const PASSWORD_MIN = 10

// The docs link in the slim portal header; same target as the landing's.
const API_DOCS_URL = '/v1/docs'

interface Account {
  email: string
  balanceMicros: number
  billingEnabled: boolean
  usdPerMillionTokens: number
  treasury: { sui: string | null; evmChain: string; evm: string | null }
}

interface WalletRow { id: number; chain: string; address: string; createdAt: string }
interface KeyRow { id: number; name: string; maskedKey: string; enabled: boolean; createdAt: string }
interface LedgerRow {
  id: number
  kind: 'credit' | 'debit'
  usdMicros: number
  reason: string
  inputTokens: number
  outputTokens: number
  createdAt: string
}

/** A titled card, so every panel on the page frames the same way. */
function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border bg-card p-5 space-y-4">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** An address with a copy button, used for every treasury and wallet string. */
function AddressRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n()
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all break-all">{value}</code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { void copyText(value).then(ok => { if (!ok) toast.error(t('common.copyFailed')) }) }}
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

/**
 * The slim product header, shown only on the customer's own hostname where a
 * stranger arrives with no context: logo, one line of what this is, and a
 * way to the docs. The operator's /portal keeps the dashboard chrome off it.
 */
function PortalHostHeader() {
  const { t } = useI18n()
  return (
    <header className="border-b">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <span className="flex items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-foreground" />
          <span className="text-sm font-semibold tracking-tight">Xlaunch Gateway</span>
        </span>
        <p className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">
          {t('portal.headerTagline')}
        </p>
        <a
          href={API_DOCS_URL}
          className="ms-auto inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:ms-0"
        >
          {t('landing.footer.apiDocs')}
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </a>
      </div>
    </header>
  )
}

/** Sign-in and sign-up, shown until a customer session exists. */
function SignedOut({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n()
  const location = useLocation()
  // The path carries the mode, so a landing "Create your account" link can
  // aim a stranger straight at the signup form: /portal/signup on the
  // dashboard host, /signup on the customer's own hostname.
  const mode = location.pathname.endsWith('/signup') ? 'signup' : 'login'
  const modeBase = location.pathname.startsWith('/portal') ? '/portal' : ''
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [attempted, setAttempted] = useState(false)

  // Inline field feedback, the auth-gate pattern; the server stays
  // authoritative. Login only checks presence — an existing password of any
  // length must still sign in.
  const emailError = !email.trim()
    ? t('validation.required')
    : !isEmail(email)
      ? t('validation.email')
      : null
  const passwordError = !password
    ? t('validation.required')
    : mode === 'signup' && password.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : null

  const submit = useMutation({
    mutationFn: () => customerFetch<{ token: string }>(`/${mode}`, {
      method: 'POST',
      body: JSON.stringify({ email: email.trim(), password }),
    }),
    meta: { silenceToast: true },
    onSuccess: (result) => {
      setCustomerToken(result.token)
      setError(null)
      onSignedIn()
    },
    onError: (err: unknown) => {
      // Map the statuses this surface actually produces to honest messages;
      // anything else still shows the server's own words, never silence.
      const status = (err as CustomerApiError).status
      if (status === 401) setError(t('portal.errorInvalidCredentials'))
      else if (status === 409) setError(t('portal.errorEmailTaken'))
      else if (status === 400) setError(t('portal.errorInvalidInput'))
      else setError(err instanceof Error && err.message ? err.message : t('portal.errorUnexpected'))
    },
  })

  return (
    <div className="min-h-screen">
      {isCustomerHost() && <PortalHostHeader />}
      <div className="mx-auto max-w-sm py-16">
      <Panel
        title={mode === 'login' ? t('portal.signIn') : t('portal.createAccount')}
        description={mode === 'login' ? t('portal.signInDesc') : t('portal.createAccountDesc')}
      >
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            if (emailError || passwordError) { setAttempted(true); return }
            submit.mutate()
          }}
        >
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="portal-email">{t('portal.email')}</Label>
            <Input
              id="portal-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('portal.emailPlaceholder')}
              autoComplete="email"
              aria-invalid={attempted && !!emailError}
            />
            {attempted && <FieldError error={emailError} />}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="portal-password">{t('portal.password')}</Label>
            <Input
              id="portal-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('portal.passwordPlaceholder')}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              aria-invalid={attempted && !!passwordError}
            />
            {attempted && <FieldError error={passwordError} />}
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={submit.isPending}>
            {mode === 'login' ? t('portal.signIn') : t('portal.createAccount')}
          </Button>
        </form>
        {/* The other mode is a visible, equal-weight action from first paint —
            not a text toggle — and navigating between the mode paths keeps this
            component (and the typed email) mounted. */}
        <Link
          to={mode === 'login' ? `${modeBase}/signup` : `${modeBase}/signin`}
          className={`${buttonVariants({ variant: 'outline' })} mt-3 w-full`}
          onClick={() => { setError(null); setAttempted(false) }}
        >
          {mode === 'login' ? t('portal.createAccount') : t('portal.signIn')}
        </Link>
      </Panel>
      </div>
    </div>
  )
}

/** Everything a signed-in customer can do. */
function SignedIn({ onSignedOut }: { onSignedOut: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [chain, setChain] = useState<string>('base')
  const [address, setAddress] = useState('')
  const [keyName, setKeyName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)

  const { data: account } = useQuery<Account>({ queryKey: ['portal-me'], queryFn: () => customerFetch('/me') })
  const { data: wallets = [] } = useQuery<WalletRow[]>({ queryKey: ['portal-wallets'], queryFn: () => customerFetch('/wallets') })
  const { data: keys = [] } = useQuery<KeyRow[]>({ queryKey: ['portal-keys'], queryFn: () => customerFetch('/keys') })
  const { data: ledger } = useQuery<{ balanceMicros: number; entries: LedgerRow[] }>({
    queryKey: ['portal-ledger'],
    queryFn: () => customerFetch('/ledger'),
  })

  const refresh = (keys: string[]) => keys.forEach(key => void queryClient.invalidateQueries({ queryKey: [key] }))

  const addWallet = useMutation({
    mutationFn: () => customerFetch('/wallets', { method: 'POST', body: JSON.stringify({ chain, address: address.trim() }) }),
    onSuccess: () => { setAddress(''); refresh(['portal-wallets']) },
  })
  const removeWallet = useMutation({
    mutationFn: (id: number) => customerFetch(`/wallets/${String(id)}`, { method: 'DELETE' }),
    onSuccess: () => refresh(['portal-wallets']),
  })
  const createKey = useMutation({
    mutationFn: () => customerFetch<{ key: string }>('/keys', { method: 'POST', body: JSON.stringify({ name: keyName.trim() }) }),
    onSuccess: (created) => { setKeyName(''); setNewKey(created.key); refresh(['portal-keys']) },
  })
  const removeKey = useMutation({
    mutationFn: (id: number) => customerFetch(`/keys/${String(id)}`, { method: 'DELETE' }),
    onSuccess: () => refresh(['portal-keys']),
  })

  const signOut = (): void => {
    void customerFetch('/logout', { method: 'POST' }).catch(() => {
      // The local session is cleared either way; a failed revoke only leaves a
      // row that expires on its own.
    })
    clearCustomerToken()
    onSignedOut()
  }

  const balance = ledger?.balanceMicros ?? account?.balanceMicros ?? 0

  return (
    <div className="mx-auto max-w-3xl py-10 space-y-5 px-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium">{t('portal.title')}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{account?.email}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={signOut}>
          <LogOut className="size-3.5 mr-1.5" />{t('portal.signOut')}
        </Button>
      </header>

      <Panel title={t('portal.balance')} description={t('portal.balanceDesc')}>
        <div className="flex items-baseline gap-3">
          <span className={`text-3xl font-medium ${balance <= 0 ? 'text-destructive' : ''}`}>{formatUsd(balance)}</span>
          {account?.billingEnabled === false && (
            <span className="text-xs text-muted-foreground">{t('portal.billingOff')}</span>
          )}
        </div>
        {account && account.billingEnabled && (
          <p className="text-xs text-muted-foreground">
            {t('portal.rate', { rate: String(account.usdPerMillionTokens) })}
          </p>
        )}
      </Panel>

      <Panel title={t('portal.addFunds')} description={t('portal.addFundsDesc')}>
        {account?.treasury.sui && <AddressRow label={t('portal.treasurySui')} value={account.treasury.sui} />}
        {account?.treasury.evm && (
          <AddressRow label={t('portal.treasuryEvm', { chain: account.treasury.evmChain })} value={account.treasury.evm} />
        )}
        {!account?.treasury.sui && !account?.treasury.evm && (
          <p className="text-xs text-muted-foreground">{t('portal.noTreasury')}</p>
        )}
      </Panel>

      <Panel title={t('portal.wallets')} description={t('portal.walletsDesc')}>
        {wallets.length === 0
          ? <p className="text-xs text-muted-foreground">{t('portal.noWallets')}</p>
          : (
            <ul className="divide-y">
              {wallets.map(wallet => (
                <li key={wallet.id} className="flex items-center gap-3 py-2">
                  <Wallet className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-xs font-medium w-20 shrink-0">{wallet.chain}</span>
                  <code className="flex-1 font-mono text-[11px] truncate">{wallet.address}</code>
                  <ConfirmButton
                    onConfirm={() => removeWallet.mutate(wallet.id)}
                    size="icon-xs"
                    armedSize="xs"
                    armedClassName="text-destructive"
                    title={t('common.delete')}
                    aria-label={t('common.delete')}
                  >
                    <Trash2 className="size-3.5" />
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}
        <form
          className="flex items-center gap-2 border-t pt-4"
          onSubmit={(e) => { e.preventDefault(); if (address.trim()) addWallet.mutate() }}
        >
          <Select value={chain} onValueChange={(value) => setChain(value ?? "base")}>
            <SelectTrigger className="w-40" aria-label={t('portal.chain')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {CHAINS.map(entry => <SelectItem key={entry.value} value={entry.value}>{t(entry.labelKey)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input
            className="flex-1"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t('portal.walletPlaceholder')}
            aria-label={t('portal.walletAddress')}
          />
          <Button type="submit" size="sm" disabled={!address.trim() || addWallet.isPending}>
            <Plus className="size-3.5" />
          </Button>
        </form>
      </Panel>

      <Panel title={t('portal.keys')} description={t('portal.keysDesc')}>
        {newKey && (
          <div className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5 space-y-1.5">
            <p className="text-xs text-muted-foreground">{t('portal.keyOnce')}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all truncate">{newKey}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void copyText(newKey).then(ok => { if (!ok) toast.error(t('common.copyFailed')) }) }}
              >
                {t('common.copy')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setNewKey(null)}>{t('common.dismiss')}</Button>
            </div>
          </div>
        )}
        {keys.length === 0
          ? <p className="text-xs text-muted-foreground">{t('portal.noKeys')}</p>
          : (
            <ul className="divide-y">
              {keys.map(key => (
                <li key={key.id} className="flex items-center gap-3 py-2">
                  <span className="text-xs font-medium truncate flex-1">{key.name}</span>
                  <code className="font-mono text-[11px] text-muted-foreground">{key.maskedKey}</code>
                  <ConfirmButton
                    onConfirm={() => removeKey.mutate(key.id)}
                    size="icon-xs"
                    armedSize="xs"
                    armedClassName="text-destructive"
                    title={t('common.delete')}
                    aria-label={t('common.delete')}
                  >
                    <Trash2 className="size-3.5" />
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}
        <form
          className="flex items-center gap-2 border-t pt-4"
          onSubmit={(e) => { e.preventDefault(); if (keyName.trim()) createKey.mutate() }}
        >
          <Input
            className="flex-1"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder={t('portal.keyNamePlaceholder')}
            aria-label={t('portal.keyName')}
            maxLength={100}
          />
          <Button type="submit" size="sm" disabled={!keyName.trim() || createKey.isPending}>
            {t('portal.createKey')}
          </Button>
        </form>
      </Panel>

      <Panel title={t('portal.statement')} description={t('portal.statementDesc')}>
        {!ledger?.entries.length
          ? <p className="text-xs text-muted-foreground">{t('portal.noActivity')}</p>
          : (
            <ul className="divide-y">
              {ledger.entries.map(entry => (
                <li key={entry.id} className="flex items-center gap-3 py-2 text-xs">
                  <span className="text-muted-foreground w-36 shrink-0">{entry.createdAt}</span>
                  <span className="flex-1 truncate">
                    {entry.reason}
                    {entry.inputTokens + entry.outputTokens > 0 && (
                      <span className="text-muted-foreground">
                        {' '}({(entry.inputTokens + entry.outputTokens).toLocaleString()} {t('portal.tokens')})
                      </span>
                    )}
                  </span>
                  <span className={entry.kind === 'credit' ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                    {entry.kind === 'credit' ? '+' : '−'}{formatUsd(entry.usdMicros)}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </div>
  )
}

/** The portal route. */
export default function PortalPage() {
  const [signedIn, setSignedIn] = useState(() => getCustomerToken() !== null)
  return signedIn
    ? <SignedIn onSignedOut={() => setSignedIn(false)} />
    : <SignedOut onSignedIn={() => setSignedIn(true)} />
}
