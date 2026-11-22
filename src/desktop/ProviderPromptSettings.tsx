import { useState } from 'react'
import { api, useDesktop } from './client'
import { isMac } from './platform'

export default function ProviderPromptSettings() {
  const { settings } = useDesktop()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (isMac) return null
  return <section className="settings-scroll"><h3>Native terminal questions</h3>
    <p>Supported choices appear in the Questions tab. Optional Codex updates are skipped during work. Login, passwords and unsupported prompts stay in the locked native terminal.</p>
    <label className="setting-toggle"><span>Review Codex folder trust under C:\Projects<small>Show eligible or ambiguous requests in Needs attention. Confirm trust in Questions or in the terminal.</small></span><input type="checkbox" checked={settings.trustProjectsScope === true} disabled={busy} onChange={event => {
      const value = event.target.checked; setBusy(true); setError('')
      void api('/settings', { trustProjectsScope: value }).catch(reason => setError(String(reason.message || reason))).finally(() => setBusy(false))
    }} /></label>
    <p>Codex can load project configuration after trust is granted. Automatic trust requires a provider check that preserves your selected permissions and existing trust decisions.</p>
    {error && <p role="alert">{error}</p>}
  </section>
}
