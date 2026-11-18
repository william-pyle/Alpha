import { useEffect, useState } from 'react'
import { api } from './client'
export default function OrganizationUndo() {
  const [change, setChange] = useState<{ undoId?: string; undoError?: string; threadId?: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { const listener = (event: Event) => { setChange((event as CustomEvent).detail); setError('') }; window.addEventListener('alpha-organization-change', listener); return () => window.removeEventListener('alpha-organization-change', listener) }, [])
  if (!change) return null
  return <div className="organization-undo" role="status">Organization updated. {change.undoId && <button disabled={busy} onClick={() => { setBusy(true); void api(change.threadId ? `/threads/${change.threadId}/undo` : '/workspace/undo', { id: change.undoId }).then(() => { setChange(null); window.dispatchEvent(new Event('alpha-workspace-changed')) }).catch(reason => setError(String(reason))).finally(() => setBusy(false)) }}>Undo</button>}<button disabled={busy} aria-label="Dismiss undo notice" onClick={() => setChange(null)}>Dismiss</button>{(error || change.undoError) && <span role="alert">{error || change.undoError}</span>}</div>
}
