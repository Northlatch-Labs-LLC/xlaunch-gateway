import { useState, type FormEvent, type ReactNode } from 'react'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FieldError } from '@/components/ui/field-error'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'

// The desktop build has no user-set password (its machine user's password is
// random and never shown), so the re-verification dialog would lock desktop
// users out. The desktop server skips re-auth for local requests
// (XLAUNCH_GATEWAY_DESKTOP); only the Electron preload sets this flag, so a
// browser reaching the same desktop server over LAN still gets the field — and
// the server still demands the password from it.
const isDesktopApp = typeof window !== 'undefined'
  && (window as Window & { __XLAUNCH_GATEWAY_DESKTOP__?: boolean }).__XLAUNCH_GATEWAY_DESKTOP__ === true

/**
 * Shared password re-verification dialog for every credential-disclosure
 * action (unified key read/regenerate, URL-token minting, in addition to the
 * per-key reveal/export dialogs). Mounted only while open, so the password
 * never outlives the dialog.
 */
export function ReauthDialog({
  title,
  description,
  confirmLabel,
  action,
  onSuccess,
  onOpenChange,
}: {
  title: string
  description?: ReactNode
  confirmLabel: string
  /** Perform the gated call with the entered password; throw to show the error in place. */
  action: (password: string) => Promise<void>
  onSuccess: () => void
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await action(password)
      onSuccess()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md">
        <DialogTitle>{title}</DialogTitle>
        {description}
        <form onSubmit={submit} className="mt-4 space-y-4">
          {!isDesktopApp && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reauth-password">{t('auth.password')}</Label>
              <Input
                id="reauth-password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                aria-invalid={!!error}
              />
              <FieldError error={error} />
            </div>
          )}
          {isDesktopApp && error && <FieldError error={error} />}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={(!isDesktopApp && !password) || busy}>
              {confirmLabel}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

/** apiFetch with the reauth header attached (web build); desktop sends none. */
export function reauthFetch<T>(path: string, init: RequestInit & { method: string }, password: string): Promise<T> {
  return apiFetch<T>(path, {
    ...init,
    headers: isDesktopApp ? undefined : { ...(init.headers as Record<string, string> | undefined), 'x-reauth-password': password },
  })
}
