import { NavLink } from 'react-router-dom'
import { useI18n } from '@/i18n'

// Segmented Chat | Fusion switcher shared by the Models pages: chat routing
// (cross-model fallback) and fusion (multi-model synthesis) are different
// machines behind one roof.
export function ModelsTabs() {
  const { t } = useI18n()
  const tab = (isActive: boolean) =>
    `inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
      isActive ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
    }`
  return (
    <div className="inline-flex gap-1 rounded-xl border p-1">
      <NavLink to="/models/chat" className={({ isActive }) => tab(isActive)}>{t('models.chatModelsTab')}</NavLink>
      <NavLink to="/models/fusion" className={({ isActive }) => tab(isActive)}>{t('models.fusionTab')}</NavLink>
    </div>
  )
}
