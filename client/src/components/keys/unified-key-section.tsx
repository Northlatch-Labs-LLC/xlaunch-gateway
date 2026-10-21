import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { ReauthDialog, reauthFetch } from './reauth-dialog'

// The unified key read/regenerate are step-up protected server-side: the
// session alone cannot disclose or rotate the credential every inference
// client uses. This component gates its fetches behind the shared password
// dialog (the server enforces the policy; the desktop loopback skip is
// honored there, so desktop users still see the key without a password).
export function UnifiedKeySection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState<null | 'read' | 'regenerate'>(null)

  const { data, isError } = useQuery<{ apiKey: string; publicUrl?: string | null }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
    retry: false,
  })

  async function gatedRead(password: string) {
    await reauthFetch<{ apiKey: string }>('/api/settings/api-key', { method: 'GET' }, password)
    await queryClient.invalidateQueries({ queryKey: ['unified-key'] })
  }

  async function gatedRegenerate(password: string) {
    await reauthFetch('/api/settings/api-key/regenerate', { method: 'POST' }, password)
    await queryClient.invalidateQueries({ queryKey: ['unified-key'] })
    toast.success(t('keys.copiedKey'))
  }

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? apiKey.slice(0, 13) + '•'.repeat(32) : '…'
  const baseUrl = data?.publicUrl
    ? `${data.publicUrl}/v1`
    : import.meta.env.DEV
      ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
      : `${window.location.origin}/v1`

  async function copy() {
    if (!await copyText(apiKey)) {
      toast.error(t('common.copyFailed'))
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">{t('keys.unifiedKey')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('keys.unifiedKeyDescBefore')}<code className="font-mono">api_key</code>{t('keys.unifiedKeyDescAfter')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPending('regenerate')}
          disabled={isError}
        >
          {t('keys.regenerate')}
        </Button>
      </div>

      {isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('keys.serverUnreachableBefore')}<code className="font-mono">{baseUrl.replace('/v1', '')}</code>{t('keys.serverUnreachableAfter')}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all truncate tabular-nums">
            {showKey ? apiKey : masked}
          </code>
          <Button variant="outline" size="sm" onClick={() => setPending('read')}>
            {showKey ? t('keys.hideKey') : t('keys.showKey')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? t('keys.copiedKey') : t('keys.copyKey')}
          </Button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">{t('keys.baseUrl')}</span>
        <code className="font-mono">{baseUrl}</code>
        <span className="text-muted-foreground">{t('keys.endpointChat')}</span>
        <code className="font-mono">/v1/chat/completions</code>
        <span className="text-muted-foreground">{t('keys.endpointResponses')}</span>
        <code className="font-mono">/v1/responses</code>
        <span className="text-muted-foreground">{t('keys.endpointMessages')}</span>
        <code className="font-mono">/v1/messages <span className="text-muted-foreground">({t('keys.endpointMessagesHint')})</span></code>
      </div>

      {pending !== null && (
        <ReauthDialog
          title={pending === 'read' ? t('keys.unifiedKey') : t('keys.regenerate')}
          confirmLabel={pending === 'read' ? t('keys.showKey') : t('keys.regenerate')}
          action={pending === 'read' ? gatedRead : gatedRegenerate}
          onSuccess={() => {
            if (pending === 'read') setShowKey(true)
            setPending(null)
          }}
          onOpenChange={open => { if (!open) setPending(null) }}
        />
      )}
    </section>
  )
}
