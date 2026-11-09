import { api } from '../desktop/client'
import { applicationThemes, useApplicationTheme } from '../lib/application-theme'
import { useState } from 'react'
import { setWorkspaceTheme, useWorkspaceTheme, type WorkspaceTheme } from '../lib/workspace-theme'

export default function ThemePicker() {
  const { preference } = useWorkspaceTheme()
  const theme = useApplicationTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = async (value: WorkspaceTheme) => {
    setBusy(true); setError('')
    try { await setWorkspaceTheme(value) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div className="workspace-theme-picker">
    <div className="application-theme-picker"><label>Application theme<select aria-label="Application theme" value={theme.id} disabled={busy} onChange={async event => { setBusy(true); setError(''); try { await api('/settings', { appTheme: event.target.value }) } catch (e) { setError(String(e)) } finally { setBusy(false) } }}>{Object.entries(applicationThemes).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</select></label><div className="application-theme-preview"><img src={theme.icon} alt={theme.controller} /><span><strong>{theme.label}</strong><small>{theme.controller} · Workspace and Chats</small></span></div></div>
    <label>Reading appearance<select aria-label="Workspace theme" value={preference} disabled={busy} onChange={event => void change(event.target.value as WorkspaceTheme)}>
      <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
    </select></label>
    <p>Light uses dark text on a white background. System follows your device. Applies to both windows and standard reports.</p>
    {error && <p role="alert">{error}</p>}
  </div>
}
