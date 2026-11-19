import { useState } from 'react'
import { api, useDesktop } from './client'
import { isMac } from './platform'

export default function ProviderPromptSettings() {
  const { settings } = useDesktop()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (isMac) return null
  return <section className="settings-scroll"><h3>Native terminal questions</h3>
    <p>Supported choices appear one at a time in Questions. Optional Codex updates are skipped during work. Login, passwords and unsupported prompts stay in the locked native terminal.</p>
    <label className="setting-toggle"><span>Trust projects under C:\Projects<small>For future Codex launches only. Trust allows project configuration to load. Full Access controls permissions separately.</small></span><input type="checkbox" checked={settings.trustProjectsScope === true} disabled={busy} onChange={event => {
      const value = event.target.checked; setBusy(true); setError('')
      void api('/settings', { trustProjectsScope: value }).catch(reason => setError(String(reason.message || reason))).finally(() => setBusy(false))
    }} /></label>
    <p>Only each launch’s exact canonical project path is trusted. Paths and repository roots outside C:\Projects are excluded, including junction escapes. Provider configuration files and existing terminals are unchanged.</p>
    {error && <p role="alert">{error}</p>}
  </section>
}
