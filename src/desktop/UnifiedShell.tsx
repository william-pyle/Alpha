import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import App from '../App'
import { useWorkspace } from '../lib/workspace'
import { parseHash } from '../lib/route'
import { api, contentUrl, onServiceEvent, reportError, sendEvent, setPreview, surface, useDesktop } from './client'
import { FilePreview } from './FilesRail'
import QuestionsPanel from './QuestionsPanel'
import Updates from './Updates'
import SettingsDialog from './SettingsDialog'
import NewCard from '../components/NewCard'
import useUiInspection from './useUiInspection'
import TopMenus from './TopMenus'
import LearningPanel from './LearningPanel'
import ConversationHistory from './ConversationHistory'
import ImportantEvents from './ImportantEvents'
import { isWorkspaceUtility, openWorkspaceUtility, workspaceUtilities, type WorkspaceUtility } from './workspaceUtilities'
import ConversationStatus from './ConversationStatus'
import ThreadConversations from './ThreadConversations'
import AgentCenter from './AgentCenter'
import { categoryIcon } from '../lib/categories'
import { Icon } from './Icons'
import type { Preview, ServiceEvent } from './types'
import './unified.css'


type DocumentTab = { id: string; title: string; kind: 'workspace' | 'entity' | 'file' | 'utility'; utility?: WorkspaceUtility; route?: string; preview?: Preview; workerTargetId?: string }
const home: DocumentTab = { id: 'workspace', title: 'Workspace', kind: 'workspace' }
const questions: DocumentTab = { id: 'utility:questions', title: 'Questions', kind: 'utility', utility: 'questions' }

export default function UnifiedShell() {
  useUiInspection()
  const state = useDesktop()
  const { workspace } = useWorkspace()
  const [restored] = useState(() => {
    const tools = [...new Set(state.settings.utilityTabs ?? ['questions'])].filter(isWorkspaceUtility)
    return { tools, active: isWorkspaceUtility(state.settings.activeUtilityTab) && tools.includes(state.settings.activeUtilityTab) ? state.settings.activeUtilityTab : null }
  })
  const [tabs, setTabs] = useState<DocumentTab[]>(() => [home, ...restored.tools.map(utility => ({ id: `utility:${utility}`, kind: 'utility' as const, utility, title: workspaceUtilities[utility] }))])
  const [active, setActive] = useState(() => restored.active ? `utility:${restored.active}` : 'workspace')
  const [chatWidth, setChatWidth] = useState(() => state.settings.chatSidebarWidth || 500)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const activeTab = tabs.find(tab => tab.id === active) || home
  const previousQuestionsView = useRef<string | null>(null)
  const [seenQuestionIds] = useState(() => new Set(state.questions.map(question => question.id)))
  const focusQuestionsTab = useRef(false)
  const pendingWorkerCloses = useRef(new Map<string, string>())
  // Keep the panel mounted while its tab is closed so in-flight answers and
  // unsent drafts keep their state.
  const panelTabs = tabs.some(tab => tab.id === questions.id) ? tabs : [...tabs, questions]
  useEffect(() => {
    if (active !== questions.id) previousQuestionsView.current = active
    document.getElementById(`document-tab-${active}`)?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  useEffect(() => {
    const route = (activate = true) => {
      const parsed = parseHash()
      if (!parsed.id) { if (activate) setActive('workspace'); return }
      const id = `entity:${parsed.id}`
      setTabs(current => current.some(tab => tab.id === id) ? current.map(tab => tab.id === id ? { ...tab, route: location.hash } : tab) : [...current, { id, kind: 'entity', title: parsed.id || 'Document', route: location.hash }])
      if (activate) setActive(id)
      setPreview(null)
    }
    const changed = () => route()
    window.addEventListener('hashchange', changed)
    route(!restored.active)
    return () => window.removeEventListener('hashchange', changed)
  }, [restored.active])
  useEffect(() => {
    const changed = (event: Event) => {
      const preview = (event as CustomEvent<Preview | null>).detail
      if (!preview) return
      const id = `file:${preview.path}`
      const targetId = preview.kind === 'document' && preview.disposable === 'help' ? crypto.randomUUID() : undefined
      setTabs(current => {
        const existing = current.find(tab => tab.id === id)
        const tab: DocumentTab = { id, kind: 'file', title: preview.name, preview, workerTargetId: targetId ? existing?.workerTargetId || targetId : undefined }
        return existing ? current.map(item => item.id === id ? tab : item) : [...current, tab]
      })
      setActive(id)
    }
    window.addEventListener('alpha-preview-changed', changed)
    return () => window.removeEventListener('alpha-preview-changed', changed)
  }, [])
  const title = (tab: DocumentTab) => tab.kind === 'entity' ? workspace?.entities.find(item => item.id === tab.id.slice(7))?.title || tab.title : tab.title
  const tabIcon = (tab: DocumentTab) => {
    if (tab.kind === 'workspace') return <Icon name="workspace" size={14} />
    if (tab.kind === 'file') return <Icon name="files" size={14} />
    if (tab.utility === 'questions') return <Icon name="help" size={14} />
    if (tab.kind === 'utility') return <Icon name="settings" size={14} />
    const entity = workspace?.entities.find(item => item.id === tab.id.slice(7))
    if (entity?.icon) return <img className="mdi-card-tab-icon" src={contentUrl(`/workspace/${entity.folder}/${entity.icon}`)} alt="" />
    return entity?.category ? <span className="mdi-category-tab-icon" aria-hidden="true">{categoryIcon(entity.category, workspace?.categories || [])}</span> : <Icon name="folder" size={14} />
  }
  const choose = (tab: DocumentTab) => {
    setActive(tab.id)
    if (tab.kind === 'utility') { setPreview(null); return }
    if (tab.kind === 'file') { setPreview(tab.preview || null); return }
    setPreview(null)
    const route = tab.kind === 'workspace' ? '' : tab.route || `#/${encodeURIComponent(tab.id.slice(7))}/0`
    history.pushState(null, '', `${window.location.pathname}${window.location.search}${route}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }
  const close = (tab: DocumentTab, workerTargetId?: string) => {
    if (tab.kind === 'workspace') return
    setTabs(current => current.filter(item => item.id !== tab.id || !!workerTargetId && item.workerTargetId !== workerTargetId))
    if (tab.id === questions.id) {
      const fallback = tab.id === active ? tabs.find(item => item.id === previousQuestionsView.current) ||
        tabs.find(item => item.id === `entity:${parseHash().id}`) || home : activeTab
      if (tab.id === active) choose(fallback)
      requestAnimationFrame(() => document.getElementById(`document-tab-${fallback.id}`)?.focus())
    } else if (tab.kind === 'utility') {
      const route = parseHash()
      const fallback = tabs.find(item => item.id === `entity:${route.id}`) || home
      setActive(current => current === tab.id ? fallback.id : current)
    } else if (tab.id === active) choose(home)
  }
  const receiveWorkerPreviewEvent = useEffectEvent((event: ServiceEvent) => {
    if (event.type === 'disconnected') {
      pendingWorkerCloses.current.clear()
      const targetId = crypto.randomUUID()
      setTabs(current => current.map(tab => tab.workerTargetId ? { ...tab, workerTargetId: targetId } : tab))
      return
    }
    if (event.type !== 'worker-preview-close' || !event.requestId || !event.targetId) return
    const { requestId, targetId, expiresAt } = event
    if (pendingWorkerCloses.current.has(requestId)) return
    const tab = tabs.find(item => item.workerTargetId === targetId)
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || document.visibilityState !== 'visible' ||
        tab?.kind !== 'file' || tab.preview?.kind !== 'document' || tab.preview.disposable !== 'help' ||
        Array.from(pendingWorkerCloses.current.values()).includes(targetId)) {
      sendEvent({ type: 'worker-preview-ack', requestId, targetId, closed: false })
      return
    }
    pendingWorkerCloses.current.set(requestId, targetId)
    close(tab, targetId)
  })
  const receiveQuestions = useEffectEvent((event: ServiceEvent) => {
    if (event.type === 'connected') {
      for (const question of event.questions ?? []) seenQuestionIds.add(question.id)
      return
    }
    if (event.type !== 'questions' || !event.addedQuestionIds?.length) return
    const pending = new Set(event.questions?.map(question => question.id))
    let hasNewQuestion = false
    for (const id of event.addedQuestionIds) {
      if (!pending.has(id) || seenQuestionIds.has(id)) continue
      seenQuestionIds.add(id)
      hasNewQuestion = true
    }
    if (!hasNewQuestion || active === questions.id) return
    focusQuestionsTab.current = true
    setTabs(current => current.some(tab => tab.id === questions.id) ? current : [...current, questions])
    setActive(questions.id)
  })
  useLayoutEffect(() => {
    if (surface === 'workspace') return onServiceEvent(event => {
      receiveQuestions(event)
      receiveWorkerPreviewEvent(event)
    })
  }, [])
  useLayoutEffect(() => {
    if (!focusQuestionsTab.current) return
    focusQuestionsTab.current = false
    if (active === questions.id && document.hasFocus()) {
      document.getElementById(`document-tab-${questions.id}`)?.focus({ preventScroll: true })
    }
  }, [active])
  useLayoutEffect(() => {
    if (surface !== 'workspace' || !state.connected) return
    // Certify only a removal that reached the rendered documents tab list.
    for (const [requestId, targetId] of pendingWorkerCloses.current) {
      if (tabs.some(tab => tab.workerTargetId === targetId)) continue
      pendingWorkerCloses.current.delete(requestId)
      sendEvent({ type: 'worker-preview-ack', requestId, targetId, closed: true })
    }
    const inventory = () => {
      const targets = document.visibilityState === 'visible' ? tabs.flatMap(tab => tab.workerTargetId ? [{ id: tab.workerTargetId }] : []) : []
      sendEvent({ type: 'worker-preview-inventory', targets })
    }
    inventory()
    document.addEventListener('visibilitychange', inventory)
    return () => document.removeEventListener('visibilitychange', inventory)
  }, [state.connected, tabs])
  const openHelp = async () => {
    try { const file = await api<Preview>('/help'); setPreview({ ...file, name: 'Help' }) }
    catch (error) { reportError(error) }
  }
  const openTool = useCallback((utility: WorkspaceUtility) => {
    const id = `utility:${utility}`
    setTabs(current => current.some(tab => tab.id === id) ? current : [...current, { id, kind: 'utility', utility, title: workspaceUtilities[utility] }])
    setActive(id)
    setPreview(null)
    requestAnimationFrame(() => document.getElementById(`document-tab-${id}`)?.focus())
  }, [])
  useEffect(() => {
    const aliases: Record<string, WorkspaceUtility> = { 'alpha-conversation-history': 'conversation-history', 'alpha-important-events': 'needs-attention', 'alpha-needs-attention': 'needs-attention', 'alpha-learned-preferences': 'learned-preferences', 'alpha-open-health': 'health', 'alpha-common-agents': 'common-agents', 'alpha-settings': 'settings' }
    const direct = (event: Event) => { const id = (event as CustomEvent<unknown>).detail; if (isWorkspaceUtility(id)) openTool(id) }
    const legacy = (event: Event) => openTool(aliases[event.type])
    window.addEventListener('alpha-open-utility', direct)
    Object.keys(aliases).forEach(name => window.addEventListener(name, legacy))
    return () => { window.removeEventListener('alpha-open-utility', direct); Object.keys(aliases).forEach(name => window.removeEventListener(name, legacy)) }
  }, [openTool])
  const utilityIds = tabs.flatMap(tab => tab.utility ? [tab.utility] : []).join(',')
  useEffect(() => {
    const timer = window.setTimeout(() => void api('/settings', { utilityTabs: utilityIds ? utilityIds.split(',') : [], activeUtilityTab: active.startsWith('utility:') ? active.slice(8) : null }).catch(reportError), 180)
    return () => clearTimeout(timer)
  }, [utilityIds, active])
  const run = (action: string) => {
    if (action === 'check-for-updates') {
      openTool(action)
      void api('/updates/check', {}).catch(reportError)
      return
    }
    if (isWorkspaceUtility(action)) { openWorkspaceUtility(action); return }
    if (action === 'new-conversation') window.dispatchEvent(new Event('alpha-new-conversation'))
    if (action === 'new-card') window.dispatchEvent(new Event('alpha-new-card'))
    if (action === 'workspace') choose(home)
    if (action === 'help') void openHelp()
  }
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    drag.current = { x: event.clientX, width: chatWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current) setChatWidth(Math.min(Math.max(drag.current.width + event.clientX - drag.current.x, 300), Math.max(300, window.innerWidth * .6)))
  }
  const stopDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const width = Math.min(Math.max(drag.current.width + event.clientX - drag.current.x, 300), Math.max(300, window.innerWidth * .6))
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setChatWidth(width)
    void api('/settings', { chatSidebarWidth: Math.round(width) }).catch(reportError)
  }

  return <div className="unified-shell" data-reduced-motion={state.settings.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches} style={{ '--reading-size': `${state.settings.readingSize || 16}px`, '--reading-spacing': state.settings.readingSpacing || 1.6 } as React.CSSProperties}>
    <TopMenus run={run} />
    <div className="mdi-body">
      <aside className="mdi-chats" style={{ width: Math.min(chatWidth, Math.max(300, window.innerWidth * .6)) }}><ThreadConversations /></aside>
      {<div className="mdi-side-splitter" role="separator" aria-label="Resize Chats sidebar" aria-orientation="vertical" tabIndex={0} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = Math.min(Math.max(chatWidth + (event.key === 'ArrowRight' ? 20 : -20), 300), Math.max(300, window.innerWidth * .6)); setChatWidth(next); void api('/settings', { chatSidebarWidth: Math.round(next) }).catch(reportError) } }} />}
      <div className="mdi-center"><div className="mdi-document-tabs" role="tablist" aria-label="Documents">{tabs.map(tab => <div className={`mdi-document-tab ${active === tab.id ? 'selected' : ''}`} key={tab.id}><button id={`document-tab-${tab.id}`} role="tab" type="button" aria-selected={active === tab.id} aria-controls={tab.kind === 'utility' ? `utility-panel-${tab.utility}` : undefined} onClick={() => choose(tab)} title={title(tab)}>{tabIcon(tab)}<span>{title(tab)}</span>{tab.utility === 'questions' && state.questions.length > 0 && <span className="mdi-questions-count" aria-hidden="true" title={state.questions.length + ' pending questions'}>{state.questions.length}</span>}</button>{tab.kind !== 'workspace' && <button type="button" className="mdi-tab-close" aria-label={`Close ${title(tab)}`} onClick={() => close(tab)}>×</button>}</div>)}</div><div className="workspace-surface mdi-workspace-surface"><div className="mdi-app-view" hidden={activeTab.kind === 'utility'}><App mdi /></div>{panelTabs.filter(tab => tab.kind === 'utility').map(tab => <section key={tab.id} id={`utility-panel-${tab.utility}`} role="tabpanel" aria-labelledby={`document-tab-${tab.id}`} className="mdi-utility-panel" hidden={active !== tab.id}>{tab.utility === 'settings' && <SettingsDialog onClose={() => close(tab)} />}{tab.utility === 'learned-preferences' && <LearningPanel />}{tab.utility === 'common-agents' && <AgentCenter initialTab="Agents" />}{tab.utility === 'health' && <AgentCenter initialTab="Health" />}{tab.utility === 'conversation-history' && <ConversationHistory />}{tab.utility === 'needs-attention' && <ImportantEvents panel />}{tab.utility === 'questions' && <QuestionsPanel />}{tab.utility === 'check-for-updates' && <div className="settings-scroll"><Updates /></div>}</section>)}{activeTab.kind === 'file' && activeTab.preview && <FilePreview file={activeTab.preview} onClose={() => close(activeTab)} />}</div></div>
    </div>
    <NewCard hideTrigger />
    <ConversationStatus />
    <Updates compact hidden={activeTab.utility === 'check-for-updates'} />
  </div>
}
