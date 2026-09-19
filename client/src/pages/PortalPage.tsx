import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, LogOut, Plus, Trash2, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmButton } from '@/components/confirm-button'
import { copyText } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n'
import {
  clearCustomerToken,
  customerFetch,
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
  { value: 'sui', label: 'Sui (SUI)' },
  { value: 'base', label: 'Base (USDC)' },
  { value: 'ethereum', label: 'Ethereum (USDC)' },
] as const

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

/** Sign-in and sign-up, shown until a customer session exists. */
function SignedOut({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

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
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  })

  return (
    <div className="mx-auto max-w-sm py-16">
      <Panel
        title={mode === 'login' ? t('portal.signIn') : t('portal.createAccount')}
        description={mode === 'login' ? t('portal.signInDesc') : t('portal.createAccountDesc')}
      >
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); if (email.trim() && password) submit.mutate() }}
        >
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('portal.emailPlaceholder')}
            aria-label={t('portal.email')}
            autoComplete="email"
          />
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('portal.passwordPlaceholder')}
            aria-label={t('portal.password')}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={!email.trim() || !password || submit.isPending}>
            {mode === 'login' ? t('portal.signIn') : t('portal.createAccount')}
          </Button>
        </form>
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null) }}
        >
          {mode === 'login' ? t('portal.needAccount') : t('portal.haveAccount')}
        </button>
      </Panel>
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
              {CHAINS.map(entry => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}
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
