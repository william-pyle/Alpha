import { useEffect } from 'react'
import { api, reportError, selectThread, useDesktop } from './client'
import { importantEvents } from './conversationAttention'
import { openWorkspaceUtility } from './workspaceUtilities'

export default function ImportantEvents({ panel = false }: { panel?: boolean }) {
  const state = useDesktop()
  const items = importantEvents(state)
  useEffect(() => {
    if (panel || !state.awareness.settings.enabled || !state.awareness.settings.desktop) return
    const sample = () => { if (document.visibilityState === 'visible') void api('/awareness/desktop', {}).catch(reportError) }
    sample(); const timer = window.setInterval(sample, 5000)
    return () => clearInterval(timer)
  }, [panel, state.awareness.settings.enabled, state.awareness.settings.desktop])
  const navigate = async (item: typeof items[number]) => {
    if (item.threadId) {
      await selectThread(item.threadId)
      // Validate the worker against the event's origin, never the selected worker.
      if (item.sessionId && state.threads.find(thread => thread.id === item.threadId)?.sessionIds.includes(item.sessionId)) {
        await api(`/threads/${item.threadId}/view`, { viewMode: 'terminal', workerId: item.sessionId })
      } else await api(`/threads/${item.threadId}/view`, { viewMode: 'alpha' })
    } else openWorkspaceUtility('health')
  }
  if (!panel) return items.length > 0 && state.awareness.settings.enabled && !state.awareness.settings.quiet ? <button className="important-events-trigger" aria-label={`Needs attention: ${items.length}`} onClick={() => openWorkspaceUtility('needs-attention')}>Needs attention ({items.length})</button> : null
  return <section className="utility-document" aria-label="Needs attention"><header><h1>Needs attention</h1></header><p>Errors, input requests and results that need review. Routine activity is in Work details; decisions stay in Questions.</p><div className="thread-attention">
      {!items.length && <p>Nothing needs attention.</p>}
      {items.map(item => <article key={item.id} data-event-id={item.id}><strong>{state.threads.find(thread => thread.id === item.threadId)?.name || 'Alpha'}{state.threads.find(thread => thread.id === item.threadId)?.archived ? ' · History' : ''} — {item.kind === 'review' ? 'Result ready for review; not verified' : item.kind === 'attention' ? 'Worker needs input' : 'Needs attention'}</strong><p>{item.text}</p>
        <button onClick={() => void navigate(item).catch(reportError)}>{item.threadId ? 'Open originating conversation' : 'Open Alpha health'}</button>
        <button onClick={() => void api('/awareness', { id: item.id, action: 'dismiss' }).catch(reportError)}>Dismiss</button><button onClick={() => void api('/awareness', { id: item.id, action: 'snooze' }).catch(reportError)}>Snooze 30 minutes</button>
      </article>)}
    </div></section>
}
