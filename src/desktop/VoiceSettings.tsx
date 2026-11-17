import { useEffect, useState } from 'react'
import voiceOptions from '../../desktop/service/voice-options.json'
import { api, useDesktop } from './client'

export default function VoiceSettings() {
  const { settings } = useDesktop()
  const [style, setStyle] = useState(settings.voiceStyle || '')
  const [conversation, setConversation] = useState(settings.conversationStyle || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [voices, setVoices] = useState<string[]>([])
  useEffect(() => { api<{ voices: string[] }>('/speech/voices').then(value => setVoices(value.voices)).catch(cause => setError(String(cause.message || cause))) }, [])
  const change = async (patch: { voiceName?: string; voiceStyle?: string; conversationStyle?: string; speakReplies?: boolean; speechVoice?: string }) => {
    setBusy(true); setError('')
    try { await api('/settings', patch) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <div className="settings-scroll"><section><h3>Voice</h3>
    <label><input type="checkbox" checked={settings.speakReplies !== false} onChange={event => void change({ speakReplies: event.target.checked })} /> Speak Alpha's replies aloud</label>
    <label>Windows reply voice<select aria-label="Windows reply voice" disabled={busy} value={settings.speechVoice || ''} onChange={event => void change({ speechVoice: event.target.value })}><option value="">System default</option>{voices.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
    <p>Text replies use Windows speech on this computer. The conversation microphone uses your selected speech-to-text provider.</p>
    <label>Conversation personality<textarea aria-label="Conversation personality" rows={4} maxLength={1200} value={conversation} onChange={event => setConversation(event.target.value)} /></label>
    <button className="desk-secondary" disabled={busy || !conversation.trim() || conversation === settings.conversationStyle} onClick={() => void change({ conversationStyle: conversation })}>Save conversation personality</button>
    <label>Spoken voice<select aria-label="Spoken voice" disabled={busy} value={settings.voiceName || 'cedar'} onChange={event => void change({ voiceName: event.target.value })}>
      {voiceOptions.map(name => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}
    </select></label>
    <p>Choose from the voices supported by Alpha’s GPT-Live session. A new voice takes effect when you start the next conversation.</p>
    <label>Voice personality<textarea aria-label="Voice personality" rows={6} maxLength={1800} value={style} onChange={event => setStyle(event.target.value)} /></label>
    <button className="desk-secondary" disabled={busy || !style.trim() || style === settings.voiceStyle} onClick={() => void change({ voiceStyle: style })}>Save personality</button>
    {error && <p role="alert">{error}</p>}
  </section></div>
}
