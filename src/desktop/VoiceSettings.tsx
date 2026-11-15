import { useState } from 'react'
import voiceOptions from '../../desktop/service/voice-options.json'
import { api, useDesktop } from './client'

export default function VoiceSettings() {
  const { settings } = useDesktop()
  const [style, setStyle] = useState(settings.voiceStyle || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = async (patch: { voiceName?: string; voiceStyle?: string }) => {
    setBusy(true); setError('')
    try { await api('/settings', patch) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <div className="settings-scroll"><section><h3>Voice</h3>
    <label>Spoken voice<select aria-label="Spoken voice" disabled={busy} value={settings.voiceName || 'cedar'} onChange={event => void change({ voiceName: event.target.value })}>
      {voiceOptions.map(name => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}
    </select></label>
    <p>Choose from the voices supported by Alpha’s GPT-Live session. A new voice takes effect when you start the next conversation.</p>
    <label>Voice personality<textarea aria-label="Voice personality" rows={6} maxLength={1800} value={style} onChange={event => setStyle(event.target.value)} /></label>
    <button className="desk-secondary" disabled={busy || !style.trim() || style === settings.voiceStyle} onClick={() => void change({ voiceStyle: style })}>Save personality</button>
    {error && <p role="alert">{error}</p>}
  </section></div>
}
