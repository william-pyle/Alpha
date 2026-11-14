import { useEffect, useState } from 'react'
import { api, onServiceEvent } from './client'
type Update = { status: string; currentVersion: string; version?: string; releaseUrl?: string; percent?: number; error?: string }
export default function Updates({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<Update | null>(null), [busy, setBusy] = useState(false), [dismissed, setDismissed] = useState('')
  useEffect(() => {
    void api<Update>('/updates').then(setState).catch(() => {})
    return onServiceEvent(event => { if (event.type === 'update') setState((event as unknown as { update: Update }).update) })
  }, [])
  const action = async (name: string) => {
    setBusy(true)
    try { setState(await api<Update>('/updates/' + name, name === 'install' ? { confirmed: true } : {})) }
    catch (error) { setState(current => current && { ...current, error: String(error) }) }
    finally { setBusy(false) }
  }
  if (!state || (compact && (!['available', 'downloading', 'downloaded'].includes(state.status) || dismissed === state.version))) return null
  return <section className={compact ? 'alpha-update-notice' : 'alpha-update-settings'} aria-label="Alpha updates">
    {!compact && <h3>Alpha updates</h3>}
    <p>{state.status === 'available' ? `Update available: Alpha ${state.version}.` : state.status === 'downloaded' ? `Alpha ${state.version} is ready to install.` : state.status === 'downloading' ? `Downloading update · ${state.percent || 0}%` : state.status === 'checking' ? 'Checking GitHub…' : state.status === 'current' ? `Alpha ${state.currentVersion} is up to date.` : `Alpha ${state.currentVersion}`}</p>
    {state.error && <p role="alert">{state.error}</p>}
    <div className="alpha-update-actions">
      {!compact && <button className="desk-secondary" disabled={busy || ['checking','downloading'].includes(state.status)} onClick={() => void action('check')}>Check for updates</button>}
      {(state.status === 'available' || (state.status === 'error' && state.version)) && <button className="desk-primary" disabled={busy} onClick={() => void action('download')}>Download update</button>}
      {state.status === 'available' && state.releaseUrl && <a className="desk-secondary" href={state.releaseUrl} target="_blank" rel="noopener noreferrer">Release details</a>}
      {state.status === 'downloaded' && <button className="desk-primary" disabled={busy} onClick={() => void action('install')}>Restart and install</button>}
      {compact && <button className="desk-secondary" onClick={() => setDismissed(state.version || '')}>Later</button>}
    </div>
    {!compact && <p>Checks GitHub when Alpha starts and every six hours. Downloads and restarts happen only when you choose them.</p>}
  </section>
}
