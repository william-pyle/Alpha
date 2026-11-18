import { useEffect, useState } from 'react'
import { api, reportError, selectThread, useDesktop } from './client'
import ConversationDialog from './ConversationDialog'
import { importantEvents } from './conversationAttention'

export default function ImportantEvents() {
  const state = useDesktop(), [open, setOpen] = useState(false)
  const items = importantEvents(state)
  useEffect(() => {
    const reveal = () => setOpen(true)
    window.addEventListener('alpha-important-events', reveal)
    return () => window.removeEventListener('alpha-important-events', reveal)
  }, [])
  useEffect(() => {
    if (!state.awareness.settings.enabled || !state.awareness.settings.desktop) return
    const sample = () => { if (document.visibilityState === 'visible') void api('/awareness/desktop', {}).catch(reportError) }
    sample(); const timer = window.setInterval(sample, 5000)
    return () => clearInterval(timer)
  }, [state.awareness.settings.enabled, state.awareness.settings.desktop])
  const navigate = async (item: typeof items[number]) => {
    if (item.threadId) {
      await selectThread(item.threadId)
      // Validate the worker against the event's origin, never the selected worker.
      if (item.sessionId && state.threads.find(thread => thread.id === item.threadId)?.sessionIds.includes(item.sessionId)) {
        await api(`/threads/${item.threadId}/view`, { viewMode: 'terminal', workerId: item.sessionId })
      } else await api(`/threads/${item.threadId}/view`, { viewMode: 'alpha' })
    } else window.dispatchEvent(new Event('alpha-open-health'))
    setOpen(false)
  }
  return <>{items.length > 0 && state.awareness.settings.enabled && !state.awareness.settings.quiet && <button className="important-events-trigger" aria-label={`Important events: ${items.length}`} onClick={() => setOpen(true)}>! {items.length}</button>}
    {open && <ConversationDialog title="Important events" close={() => setOpen(false)}><div className="thread-attention">
      {!items.length && <p>No important events waiting.</p>}
      {items.map(item => <article key={item.id} data-event-id={item.id}><strong>{state.threads.find(thread => thread.id === item.threadId)?.name || 'Alpha'}{state.threads.find(thread => thread.id === item.threadId)?.archived ? ' · History' : ''} — {item.kind === 'review' ? 'Result ready for review; not verified' : item.kind === 'attention' ? 'Worker needs input' : 'Needs attention'}</strong><p>{item.text}</p>
        <button onClick={() => void navigate(item).catch(reportError)}>{item.threadId ? 'Open originating conversation' : 'Open Alpha health'}</button>
        <button onClick={() => void api('/awareness', { id: item.id, action: 'dismiss' }).catch(reportError)}>Dismiss</button><button onClick={() => void api('/awareness', { id: item.id, action: 'snooze' }).catch(reportError)}>Snooze 30 minutes</button>
      </article>)}
    </div></ConversationDialog>}
  </>
}
