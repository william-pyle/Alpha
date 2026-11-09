import { useEffect, useState } from 'react'
import { api, onServiceEvent } from './client'
import './workspace-location.css'

type LocationState = { available: boolean; current: string; pending: null | { source: string; destination: string; mode: 'copy' | 'existing' } }
export default function WorkspaceLocation() {
  const [state, setState] = useState<LocationState | null>(null)
  const [folder, setFolder] = useState(''), [mode, setMode] = useState<'copy' | 'existing'>('copy')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const refresh = () => api<LocationState>('/workspace/location').then(value => { setState(value); if (value.pending) { setFolder(value.pending.destination); setMode(value.pending.mode) } }).catch(error => setError(String(error.message || error)))
    void refresh()
    return onServiceEvent(event => { if (event.type === 'workspace-location') void refresh() })
  }, [])
  const action = async (name: 'browse' | 'save' | 'cancel') => {
    setBusy(true); setError('')
    try {
      if (name === 'browse') { const value = await api<{ path: string | null }>('/workspace/location/browse', {}); if (value.path) setFolder(value.path) }
      else { setState(await api<LocationState>('/workspace/location/' + name, name === 'save' ? { path: folder, mode } : {})); if (name === 'cancel') setFolder('') }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className="workspace-location" aria-label="Workspace location"><h3>Workspace location</h3>
    <p>Current folder</p><p className="settings-repo">{state?.current || 'Loading…'}</p>
    <p>This folder contains your cards, project files, local knowledge and Alpha chat history.</p>
    {state?.available ? <>
      <label>Workspace folder<input value={folder} placeholder="Choose a folder…" disabled={busy} onChange={event => setFolder(event.target.value)} /></label>
      <button className="desk-secondary" disabled={busy} onClick={() => void action('browse')}>Browse…</button>
      <label>When Alpha next starts<select value={mode} disabled={busy} onChange={event => setMode(event.target.value as typeof mode)}><option value="copy">Copy current Workspace</option><option value="existing">Open existing Workspace</option></select></label>
      <p>{mode === 'copy' ? 'Choose a new or empty folder. All Workspace files are copied when Alpha next starts; the original folder is kept.' : 'Choose the root of an existing Alpha Workspace. Its contents will be opened as they are; your current Workspace stays in its original folder.'}</p>
      <button className="desk-primary" disabled={busy || !folder.trim()} onClick={() => void action('save')}>Save location</button>
      {state.pending && <div role="status"><p><strong>Saved for next launch</strong></p><p className="settings-repo">{state.pending.destination}</p><p>Quit Alpha from its tray menu when you are ready, then open it again. Current chats keep running until you quit.</p><button className="desk-secondary" disabled={busy} onClick={() => void action('cancel')}>Cancel location change</button></div>}
    </> : state && <p>Change this setting in the installed Alpha application.</p>}
    {error && <p role="alert" className="desk-error-inline">{error}</p>}
  </section>
}
