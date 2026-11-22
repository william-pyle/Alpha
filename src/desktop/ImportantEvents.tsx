import { useEffect } from 'react'
import { api, reportError, selectThread, useDesktop } from './client'
import { attentionLabels, importantEvents } from './conversationAttention'
import { Icon } from './Icons'
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
    if (item.source === 'Conversation deletion recovery') {
      openWorkspaceUtility('conversation-history')
    } else if (item.source === 'Codex folder trust' && item.questionId) {
      window.dispatchEvent(new CustomEvent('alpha-open-question', { detail: item.questionId }))
    } else if (item.threadId) {
      await selectThread(item.threadId)
      // Validate the worker against the event's origin, never the selected worker.
      if (item.sessionId && state.threads.find(thread => thread.id === item.threadId)?.sessionIds.includes(item.sessionId)) {
        await api(`/threads/${item.threadId}/view`, { viewMode: 'terminal', workerId: item.sessionId })
      } else await api(`/threads/${item.threadId}/view`, { viewMode: 'alpha' })
    } else openWorkspaceUtility('health')
  }
  if (!panel) {
    if (!items.length || !state.awareness.settings.enabled || state.awareness.settings.quiet) return null
    const breakdown = Object.entries(attentionLabels).flatMap(([kind, { singular, plural }]) => {
      const count = items.filter(item => item.kind === kind).length
      return count ? [`${count} ${count === 1 ? singular : plural}`] : []
    }).join(', ')
    return <button type="button" className="important-events-trigger" data-urgent={items.some(item => item.kind !== 'review')}
      aria-label={`Needs attention: ${items.length}. ${breakdown}`} title={breakdown}
      onClick={() => openWorkspaceUtility('needs-attention')}>
      <Icon name="bell" size={14} />
      <span>Needs attention</span>
      <span className="important-events-count">{items.length}</span>
    </button>
  }
  return <section className="utility-document" aria-label="Needs attention"><header><h1>Needs attention</h1></header><div className="thread-attention">
      {!items.length && <p>Nothing needs attention.</p>}
      {items.map(item => {
        const origin = state.threads.find(thread => thread.id === item.threadId)
        const { heading } = attentionLabels[item.kind]
        const destination = item.source === 'Conversation deletion recovery' ? 'Open conversation history' : item.source === 'Codex folder trust' ? 'Open Questions' : item.threadId ? 'Open originating conversation' : 'Open Alpha health'
        return <article key={item.id} data-event-id={item.id}>
          <strong>{heading}</strong>
          <small>{origin?.name || 'Alpha'}{origin?.archived ? ' · History' : ''}</small>
          <p>{item.text}</p>
          <button onClick={() => void navigate(item).catch(reportError)}>{destination}</button>
          <button onClick={() => void api('/awareness', { id: item.id, action: 'dismiss' }).catch(reportError)}>Dismiss</button>
          <button onClick={() => void api('/awareness', { id: item.id, action: 'snooze' }).catch(reportError)}>Snooze 30 minutes</button>
        </article>
      })}
    </div></section>
}
