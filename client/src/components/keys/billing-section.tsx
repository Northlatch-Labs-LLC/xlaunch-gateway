import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { formatUsd } from '@/lib/customer-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmButton } from '@/components/confirm-button'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n'

// The operator's billing surface: what inference costs, where funds arrive,
// who owes what, and which payments have landed. Nothing here can move money —
// the strongest action is an entry in the ledger.

interface BillingSettings {
  billingEnabled: boolean
  usdPerMillionTokens: number
  suiUsdRate: number
  paymentsEnabled: boolean
  suiTreasury: string | null
  suiRpc: string
  evmChain: 'ethereum' | 'base'
  evmTreasury: string | null
  evmRpc: string | null
  evmUsdc: string
}

interface CustomerRow {
  id: number
  email: string
  balanceMicros: number
  disabled: boolean
  keyCount: number
  walletCount: number
  createdAt: string
}

interface PaymentRow {
  id: number
  chain: string
  txHash: string
  fromAddress: string
  asset: string
  usdMicros: number
  status: string
  email: string | null
  seenAt: string
}

/** A labelled field, so every setting lines up the same way. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function BillingSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Partial<BillingSettings>>({})
  /*
    The two rates, held as the operator's own text while they are being typed.

    These were controlled inputs whose displayed value was `String(Number(text))`,
    recomputed on every keystroke. Typing "3." gives `Number("3.") === 3`, which
    renders as "3" — so the decimal point was deleted at the instant it was typed
    and no fractional rate could be entered at all. SUI could be priced at 3
    dollars or 4, never 3.42, and a per-million rate could never be 0.50.

    Text is what a person types; the number is what is saved. They are not the
    same thing and a half-typed number is not a number yet.
  */
  const [rateText, setRateText] = useState<{ usdPerMillionTokens?: string; suiUsdRate?: string }>({})

  /**
   * Take a rate the operator is typing, and save it only once it is a number.
   * @param field - which rate is being edited.
   * @param text - exactly what is in the box, including a trailing dot.
   */
  const editRate = (field: 'usdPerMillionTokens' | 'suiUsdRate', text: string): void => {
    setRateText(previous => ({ ...previous, [field]: text }));
    const parsed = Number(text);
    /*
      An empty or unfinished entry leaves the stored rate alone. The old code
      read `Number(text) || 0`, which turned a cleared box into a rate of zero —
      and a zero SUI rate silently credits every payment nothing.
    */
    if (text.trim() === '' || !Number.isFinite(parsed) || parsed < 0) return;
    setDraft(previous => ({ ...previous, [field]: parsed }));
  };

  /** Give the boxes back to the server's numbers. */
  const clearEdits = (): void => { setDraft({}); setRateText({}); };

  const { data: settings } = useQuery<BillingSettings>({
    queryKey: ['billing-settings'],
    queryFn: () => apiFetch('/api/billing/settings'),
  })
  const { data: customers = [] } = useQuery<CustomerRow[]>({
    queryKey: ['billing-customers'],
    queryFn: () => apiFetch('/api/billing/customers'),
  })
  const { data: payments = [] } = useQuery<PaymentRow[]>({
    queryKey: ['billing-payments'],
    queryFn: () => apiFetch('/api/billing/payments'),
  })

  const invalidate = (key: string) => void queryClient.invalidateQueries({ queryKey: [key] })

  const save = useMutation({
    mutationFn: (patch: Partial<BillingSettings>) =>
      apiFetch<BillingSettings>('/api/billing/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: () => { clearEdits(); invalidate('billing-settings') },
  })
  const adjust = useMutation({
    mutationFn: ({ id, usd }: { id: number; usd: number }) =>
      apiFetch(`/api/billing/customers/${String(id)}/adjust`, { method: 'POST', body: JSON.stringify({ usd, reason: 'operator adjustment' }) }),
    onSuccess: () => invalidate('billing-customers'),
  })
  const setDisabled = useMutation({
    mutationFn: ({ id, disabled }: { id: number; disabled: boolean }) =>
      apiFetch(`/api/billing/customers/${String(id)}`, { method: 'PATCH', body: JSON.stringify({ disabled }) }),
    onSuccess: () => invalidate('billing-customers'),
  })
  const removeCustomer = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/billing/customers/${String(id)}`, { method: 'DELETE' }),
    onSuccess: () => { invalidate('billing-customers'); invalidate('billing-payments') },
  })
  const poll = useMutation({
    mutationFn: () => apiFetch<{ sui: number; evm: number }>('/api/billing/poll', { method: 'POST' }),
    onSuccess: (result) => {
      toast.success(t('billing.polled', { count: String(result.sui + result.evm) }))
      invalidate('billing-payments'); invalidate('billing-customers')
    },
  })

  if (!settings) return null
  const value = { ...settings, ...draft }
  const dirty = Object.keys(draft).length > 0

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">{t('billing.pricing')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{t('billing.pricingDesc')}</p>
          </div>
          <Switch
            checked={value.billingEnabled}
            onCheckedChange={(billingEnabled) => save.mutate({ billingEnabled })}
            aria-label={t('billing.enabled')}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('billing.pricePerMtok')} hint={t('billing.pricePerMtokHint')}>
            <Input
              inputMode="decimal"
              value={rateText.usdPerMillionTokens ?? String(value.usdPerMillionTokens)}
              onChange={(e) => { editRate('usdPerMillionTokens', e.target.value) }}
            />
          </Field>
          <Field label={t('billing.suiRate')} hint={t('billing.suiRateHint')}>
            <Input
              inputMode="decimal"
              value={rateText.suiUsdRate ?? String(value.suiUsdRate)}
              onChange={(e) => { editRate('suiUsdRate', e.target.value) }}
            />
          </Field>
        </div>
      </section>

      <section className="rounded-3xl border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">{t('billing.payments')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{t('billing.paymentsDesc')}</p>
          </div>
          <Switch
            checked={value.paymentsEnabled}
            onCheckedChange={(paymentsEnabled) => save.mutate({ paymentsEnabled })}
            aria-label={t('billing.watcherEnabled')}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('billing.suiTreasury')} hint={t('billing.suiTreasuryHint')}>
            <Input
              value={value.suiTreasury ?? ''}
              placeholder="0x…"
              onChange={(e) => setDraft({ ...draft, suiTreasury: e.target.value })}
            />
          </Field>
          <Field label={t('billing.suiRpc')}>
            <Input
              value={value.suiRpc}
              onChange={(e) => setDraft({ ...draft, suiRpc: e.target.value })}
            />
          </Field>
          <Field label={t('billing.evmChain')}>
            <Select
              value={value.evmChain}
              onValueChange={(chain) => setDraft({ ...draft, evmChain: (chain ?? 'base') as 'ethereum' | 'base' })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="base">Base</SelectItem>
                <SelectItem value="ethereum">Ethereum</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('billing.evmTreasury')} hint={t('billing.evmTreasuryHint')}>
            <Input
              value={value.evmTreasury ?? ''}
              placeholder="0x…"
              onChange={(e) => setDraft({ ...draft, evmTreasury: e.target.value })}
            />
          </Field>
          <Field label={t('billing.evmRpc')} hint={t('billing.evmRpcHint')}>
            <Input
              value={value.evmRpc ?? ''}
              placeholder="https://…"
              onChange={(e) => setDraft({ ...draft, evmRpc: e.target.value })}
            />
          </Field>
          <Field label={t('billing.usdcContract')} hint={t('billing.usdcContractHint')}>
            <Input
              value={value.evmUsdc}
              onChange={(e) => setDraft({ ...draft, evmUsdc: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
            {t('common.save')}
          </Button>
          {dirty && (
            <Button variant="ghost" size="sm" onClick={clearEdits}>{t('common.cancel')}</Button>
          )}
          <Button variant="outline" size="sm" disabled={poll.isPending} onClick={() => poll.mutate()}>
            <RefreshCw className="size-3.5 mr-1.5" />{t('billing.pollNow')}
          </Button>
        </div>
      </section>

      <section className="rounded-3xl border bg-card p-5 space-y-4">
        <div>
          <h2 className="text-sm font-medium">{t('billing.customers')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('billing.customersDesc')}</p>
        </div>
        {customers.length === 0
          ? <p className="text-xs text-muted-foreground">{t('billing.noCustomers')}</p>
          : (
            <ul className="divide-y">
              {customers.map(customer => (
                <li key={customer.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{customer.email}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {t('billing.customerMeta', {
                        keys: String(customer.keyCount),
                        wallets: String(customer.walletCount),
                      })}
                    </p>
                  </div>
                  <span className={`text-xs tabular-nums ${customer.balanceMicros <= 0 ? 'text-destructive' : ''}`}>
                    {formatUsd(customer.balanceMicros)}
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      const raw = window.prompt(t('billing.adjustPrompt'), '10')
                      const usd = Number(raw)
                      if (raw !== null && Number.isFinite(usd) && usd !== 0) adjust.mutate({ id: customer.id, usd })
                    }}
                  >
                    {t('billing.adjust')}
                  </Button>
                  <Switch
                    size="sm"
                    checked={!customer.disabled}
                    onCheckedChange={(enabled) => setDisabled.mutate({ id: customer.id, disabled: !enabled })}
                    aria-label={t('billing.customerEnabled')}
                  />
                  <ConfirmButton
                    onConfirm={() => removeCustomer.mutate(customer.id)}
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
      </section>

      <section className="rounded-3xl border bg-card p-5 space-y-4">
        <div>
          <h2 className="text-sm font-medium">{t('billing.arrived')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('billing.arrivedDesc')}</p>
        </div>
        {payments.length === 0
          ? <p className="text-xs text-muted-foreground">{t('billing.noPayments')}</p>
          : (
            <ul className="divide-y">
              {payments.map(payment => (
                <li key={payment.id} className="flex items-center gap-3 py-2 text-xs">
                  <span className="text-muted-foreground w-36 shrink-0">{payment.seenAt}</span>
                  <span className="w-16 shrink-0">{payment.chain}</span>
                  <span className="flex-1 truncate">
                    {payment.email ?? <span className="text-destructive">{t('billing.unmatched')}</span>}
                    <span className="text-muted-foreground font-mono"> {payment.fromAddress.slice(0, 12)}…</span>
                  </span>
                  <span className="tabular-nums">{formatUsd(payment.usdMicros)} {payment.asset}</span>
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  )
}
