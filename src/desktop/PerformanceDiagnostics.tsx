import { useCallback, useEffect, useState } from 'react'
import { api, onServiceEvent } from './client'

const categories = {
  conversation: 'Conversation input',
  worker: 'Worker session',
  workspace: 'Workspace or files',
  settings: 'Settings request',
  voice: 'Voice or dictation',
  updates: 'Updates',
  integrations: 'Integrations',
  startup: 'Window hydration',
} as const
type Category = keyof typeof categories
type TraceEvent = { seq: number; ms: number; event: string; kind?: string; method?: string; tool?: string; match?: string; durationMs?: number; statusCode?: number }
type Capture = { id: string; category: Category; outcome: string; durationMs: number; dropped: number; events: TraceEvent[] }
type DiagnosticStatus = { enabled: boolean; armed: Category | null; active: { id: string; category: Category } | null; last: Capture | null }
const endpoint = '/performance-diagnostics'
const milestones: Record<string, string> = {
  'first-text': 'First text',
  'receipt-created': 'Worker receipt',
  paste: 'Paste',
  submit: 'Submit',
  'native-input': 'Native acceptance',
  'worker-completion': 'Worker completion',
}

export default function PerformanceDiagnostics() {
  const [status, setStatus] = useState<DiagnosticStatus>()
  const [category, setCategory] = useState<Category>('conversation')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(() => {
    void api<DiagnosticStatus>(endpoint).then(setStatus).catch(() => setError('Could not read performance diagnostics.'))
  }, [])
  useEffect(() => {
    refresh()
    return onServiceEvent(event => { if (event.type === 'performance-diagnostics-changed' || event.type === 'connected') refresh() })
  }, [refresh])
  async function change(data?: unknown, method?: string) {
    setBusy(true)
    setError('')
    try { setStatus(await api<DiagnosticStatus>(endpoint, data, method)) }
    catch { setError('Could not change performance diagnostics. Check the connection and try again.'); refresh() }
    finally { setBusy(false) }
  }
  function exportCapture(capture: Capture) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(capture, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'alpha-performance-' + capture.id + '.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const summary = new Map<string, number>()
  for (const entry of status?.last?.events || []) {
    const label = entry.event === 'ipc-reply' && entry.method === 'turn/start' && entry.kind === 'ok' ? 'Local app-server acknowledgement' : milestones[entry.event]
    if (label && !summary.has(label)) summary.set(label, entry.ms)
  }
  return <div className="settings-scroll"><section aria-labelledby="performance-heading">
    <h2 id="performance-heading">Performance Diagnostics</h2>
    <p>Capture local timing for one operation. Alpha keeps the last capture in memory until it closes or you delete it. Export a copy to keep it.</p>
    <label className="setting-toggle"><span>Enable Performance Diagnostics</span><input type="checkbox" checked={status?.enabled === true} disabled={busy || !status} onChange={event => void change({ enabled: event.target.checked })} /></label>
    {status?.enabled && <div className="setting-actions">
      <label>Capture category <select value={category} disabled={busy || !!status.active} onChange={event => setCategory(event.target.value as Category)}>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <button type="button" className="desk-secondary" disabled={busy || !!status.active || !!status.armed} onClick={() => void change({ action: 'arm', category })}>Capture next operation</button>
      {(status.active || status.armed) && <button type="button" className="desk-secondary" disabled={busy} onClick={() => void change({ action: 'stop' })}>Stop capture</button>}
    </div>}
    <p role="status">{status?.active ? 'Capturing ' + categories[status.active.category] + ' timing.' : status?.armed ? 'Waiting for ' + categories[status.armed] + ' activity. Arming expires after one minute.' : 'No capture running.'}</p>
    {error && <p role="alert">{error}</p>}
    {status?.last && <section aria-label="Last capture">
      <h3>Last capture</h3>
      <p>{categories[status.last.category]} · {status.last.outcome} · {(status.last.durationMs / 1000).toFixed(2)} s · {status.last.events.length} retained · {status.last.dropped} dropped</p>
      {summary.size > 0 && <dl>{Array.from(summary, ([label, ms]) => <div key={label}><dt>{label}</dt><dd>+{ms} ms</dd></div>)}</dl>}
      <button type="button" className="desk-secondary" onClick={() => exportCapture(status.last!)}>Export JSON</button>{' '}
      <button type="button" className="desk-secondary" disabled={busy} onClick={() => void change(undefined, 'DELETE')}>Delete capture</button>
      <details><summary>Event timing (latest 60)</summary><ol>{status.last.events.slice(-60).map(entry => <li key={entry.seq}><time>{entry.ms} ms</time> · {entry.event}{entry.method ? ' · ' + entry.method : ''}{entry.tool ? ' · ' + entry.tool : ''}{entry.kind ? ' · ' + entry.kind : ''}{entry.match ? ' · ' + entry.match : ''}{entry.statusCode ? ' · HTTP ' + entry.statusCode : ''}{entry.durationMs !== undefined ? ' · ' + entry.durationMs + ' ms elapsed' : ''}</li>)}</ol></details>
    </section>}
  </section></div>
}
