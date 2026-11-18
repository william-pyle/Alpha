import { useEffect } from 'react'
import { api, onServiceEvent, useDesktop } from './client'

export default function useUiInspection() {
  const state = useDesktop()
  useEffect(() => onServiceEvent(event => {
    if (event.type !== 'ui-inspection-request' || event.threadId !== state.selectedThreadId) return
    const thread = state.threads.find(item => item.id === event.threadId)
    if (!thread?.allowUiInspection) return
    const unavailable = document.visibilityState !== 'visible' || !!document.querySelector('dialog[open],.desk-scrim')
    const selectors = { topbar: '.mdi-menu-bar', conversation: '.thread-conversation', messages: '.alpha-conversation-scroll', composer: '.layout-composer', viewer: '.layout-viewer', statusbar: '.mdi-statusbar', questions: '.questions-panel' }
    const regions = unavailable ? [] : Object.entries(selectors).flatMap(([kind, selector]) => {
      const element = document.querySelector<HTMLElement>(selector); if (!element) return []
      const r = element.getBoundingClientRect()
      return [{ kind, x: r.x, y: r.y, width: r.width, height: r.height, scrollHeight: element.scrollHeight, visible: r.width > 0 && r.height > 0 }]
    })
    void api('/ui-inspection/result', { inspectionId: event.inspectionId, threadId: event.threadId, unavailable, width: innerWidth, height: innerHeight, regions }).catch(() => { /* Expired or revoked requests collect nothing. */ })
  }), [state.selectedThreadId, state.threads])
}
