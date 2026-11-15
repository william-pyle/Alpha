import { useEffect, useState } from 'react'
import DictationSettings from '../components/DictationSettings'
import { api } from './client'
import { useDictation } from './useDictation'
import type { DictationInfo } from '../voice/types'

export default function SpeechSettings() {
  const dictation = useDictation()
  const { info, choose, refresh, setInfo } = dictation
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh().catch(() => {}) }, 3000)
    return () => window.clearInterval(timer)
  }, [refresh])
  const action = async (name: 'install' | 'start' | 'stop') => {
    setBusy(true); setError('')
    try { setInfo(await api<DictationInfo>(`/dictation/local/${name}`, {})) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const local = info?.local
  return <div className="settings-scroll"><DictationSettings info={info} onChange={choose} />
    {info?.provider === 'local' && <section aria-label="Local Whisper status"><h3>Local Whisper</h3>
      <p role="status">{local?.installing ? 'Installing Local Whisper…' : local?.starting ? 'Starting Local Whisper…' : !local?.installed ? 'Not installed' : local.running ? 'Installed and running' : 'Installed, but stopped'}</p>
      <p>Start keeps the model ready in the background. When stopped, dictation can still launch Whisper for each recording.</p>
      <div className="alpha-update-actions">
        {!local?.installed && <button className="desk-primary" disabled={busy || local?.installing} onClick={() => void action('install')}>Install Local Whisper</button>}
        {local?.installed && !local.running && <button className="desk-primary" disabled={busy || local.starting || local.installing} onClick={() => void action('start')}>Start Local Whisper</button>}
        {local?.installed && local.running && <button className="desk-secondary" disabled={busy} onClick={() => void action('stop')}>Stop Local Whisper</button>}
      </div>
      {local?.error && <p role="alert">{local.error}</p>}{error && <p role="alert">{error}</p>}
    </section>}
  </div>
}
