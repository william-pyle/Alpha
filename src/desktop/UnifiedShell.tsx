import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import App from '../App'
import { useWorkspace } from '../lib/workspace'
import { parseHash } from '../lib/route'
import { api, pickFiles, reportError, setPreview, useDesktop } from './client'
import { FilePreview } from './FilesRail'
import QuestionsPanel from './QuestionsPanel'
import SettingsDialog from './SettingsDialog'
import NewCard from '../components/NewCard'
import VoiceDock from './VoiceDock'
import { categoryIcon } from '../lib/categories'
import { contentUrl } from './client'
import { Icon, Nose } from './Icons'
import type { Preview } from './types'
import './unified.css'

const Chats = lazy(() => import('./Chats'))
type DocumentTab = { id: string; title: string; kind: 'workspace' | 'entity' | 'file'; route?: string; preview?: Preview }
const home: DocumentTab = { id: 'workspace', title: 'Workspace', kind: 'workspace' }

export default function UnifiedShell() {
  const state = useDesktop()
  const { workspace } = useWorkspace()
  const [tabs, setTabs] = useState<DocumentTab[]>([home])
  const [active, setActive] = useState('workspace')
  const [menu, setMenu] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [chatsVisible, setChatsVisible] = useState(true)
  const [archiveVisible, setArchiveVisible] = useState(false)
  const [microphoneVisible, setMicrophoneVisible] = useState(() => localStorage.getItem('alpha.workspaceMicrophoneVisible') === '1')
  const [chatWidth, setChatWidth] = useState(() => Number(localStorage.getItem('alpha.chatSidebarWidth')) || 390)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const activeTab = tabs.find(tab => tab.id === active) || home

  useEffect(() => {
    const route = () => {
      const parsed = parseHash()
      if (!parsed.id) { setActive('workspace'); return }
      const id = `entity:${parsed.id}`
      setTabs(current => current.some(tab => tab.id === id) ? current.map(tab => tab.id === id ? { ...tab, route: location.hash } : tab) : [...current, { id, kind: 'entity', title: parsed.id || 'Document', route: location.hash }])
      setActive(id)
      setPreview(null)
    }
    window.addEventListener('hashchange', route)
    route()
    return () => window.removeEventListener('hashchange', route)
  }, [])
  useEffect(() => {
    const changed = (event: Event) => {
      const preview = (event as CustomEvent<Preview | null>).detail
      if (!preview) return
      const id = `file:${preview.path}`
      setTabs(current => current.some(tab => tab.id === id) ? current.map(tab => tab.id === id ? { ...tab, title: preview.name, preview } : tab) : [...current, { id, kind: 'file', title: preview.name, preview }])
      setActive(id)
    }
    window.addEventListener('alpha-preview-changed', changed)
    return () => window.removeEventListener('alpha-preview-changed', changed)
  }, [])
  const title = (tab: DocumentTab) => tab.kind === 'entity' ? workspace?.entities.find(item => item.id === tab.id.slice(7))?.title || tab.title : tab.title
  const tabIcon = (tab: DocumentTab) => {
    if (tab.kind === 'workspace') return <Icon name="workspace" size={14} />
    if (tab.kind === 'file') return <Icon name="files" size={14} />
    const entity = workspace?.entities.find(item => item.id === tab.id.slice(7))
    if (entity?.icon) return <img className="mdi-card-tab-icon" src={contentUrl(`/workspace/${entity.folder}/${entity.icon}`)} alt="" />
    return entity?.category ? <span className="mdi-category-tab-icon" aria-hidden="true">{categoryIcon(entity.category, workspace?.categories || [])}</span> : <Icon name="folder" size={14} />
  }
  const choose = (tab: DocumentTab) => {
    setActive(tab.id); setMenu(null)
    if (tab.kind === 'file') { setPreview(tab.preview || null); return }
    setPreview(null)
    const route = tab.kind === 'workspace' ? '' : tab.route || `#/${encodeURIComponent(tab.id.slice(7))}/0`
    history.pushState(null, '', `${window.location.pathname}${window.location.search}${route}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }
  const close = (tab: DocumentTab) => {
    if (tab.kind === 'workspace') return
    setTabs(current => current.filter(item => item.id !== tab.id))
    if (tab.id === active) choose(home)
  }
  const openHelp = async () => {
    setMenu(null)
    try { const file = await api<Preview>('/help'); setPreview({ ...file, name: 'Help' }) }
    catch (error) { reportError(error) }
  }
  const openFile = async () => {
    setMenu(null)
    try { const paths = await pickFiles(); if (paths[0]) setPreview(await api<Preview>(`/preview?path=${encodeURIComponent(paths[0])}`)) }
    catch (error) { reportError(error) }
  }
  const run = (action: string) => {
    setMenu(null)
    if (action === 'new-card') window.dispatchEvent(new Event('alpha-new-card'))
    if (action === 'open-file') void openFile()
    if (action === 'workspace') choose(home)
    if (action === 'close-document') close(activeTab)
    if (action === 'chats') setChatsVisible(value => !value)
    if (action === 'archive') setArchiveVisible(value => { window.dispatchEvent(new CustomEvent('alpha-show-archive', { detail: !value })); return !value })
    if (action === 'microphone') setMicrophoneVisible(value => { localStorage.setItem('alpha.workspaceMicrophoneVisible', value ? '0' : '1'); return !value })
    if (action === 'questions') window.dispatchEvent(new Event('alpha-toggle-questions'))
    if (action === 'settings') setSettings(true)
    if (action === 'help') void openHelp()
  }
  const menuItems: Record<string, Array<[string, string]>> = {
    File: [['New card', 'new-card'], ['Open file…', 'open-file'], ['Close document', 'close-document']],
    View: [['Workspace', 'workspace'], [chatsVisible ? 'Hide Chats' : 'Show Chats', 'chats'], [archiveVisible ? 'Hide archive' : 'Show archive', 'archive'], [microphoneVisible ? 'Hide microphone' : 'Show microphone', 'microphone'], ['Questions', 'questions']],
    Tools: [['Settings…', 'settings']],
    Help: [['Open Help', 'help']],
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
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    localStorage.setItem('alpha.chatSidebarWidth', String(chatWidth))
  }

  return <div className="unified-shell" onKeyDown={event => { if (event.key === 'Escape') setMenu(null) }}>
    <div className="mdi-menu-bar"><div className="mdi-brand"><Nose size={21} /><strong>Alpha</strong></div>{Object.entries(menuItems).map(([label, items]) => <div className="mdi-menu-group" key={label}><button type="button" aria-expanded={menu === label} onClick={() => setMenu(current => current === label ? null : label)}>{label}</button>{menu === label && <div className="mdi-menu-popup" role="menu">{items.map(([text, action]) => <button role="menuitem" key={action} type="button" disabled={action === 'close-document' && active === 'workspace'} onClick={() => run(action)}>{text}</button>)}</div>}</div>)}<span className="mdi-menu-spacer" /><span className="mdi-menu-title">{title(activeTab)}</span><button className="mdi-menu-settings" type="button" aria-label="Settings" onClick={() => setSettings(true)}><Icon name="settings" size={16} /></button></div>
    <div className="mdi-body">
      {chatsVisible && <><aside className="mdi-chats" style={{ width: Math.min(chatWidth, Math.max(300, window.innerWidth * .6)) }}><Suspense fallback={<div className="desk-muted">Opening Chats…</div>}><Chats embedded /></Suspense></aside><div className="mdi-side-splitter" role="separator" aria-label="Resize Chats sidebar" aria-orientation="vertical" tabIndex={0} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setChatWidth(value => { const next = Math.min(Math.max(value + (event.key === 'ArrowRight' ? 20 : -20), 300), Math.max(300, window.innerWidth * .6)); localStorage.setItem('alpha.chatSidebarWidth', String(next)); return next }) } }} /></>}
      <div className="mdi-center"><div className="mdi-document-tabs" role="tablist" aria-label="Documents">{tabs.map(tab => <div className={`mdi-document-tab ${active === tab.id ? 'selected' : ''}`} key={tab.id}><button role="tab" type="button" aria-selected={active === tab.id} onClick={() => choose(tab)} title={title(tab)}>{tabIcon(tab)}<span>{title(tab)}</span></button>{tab.kind !== 'workspace' && <button className="mdi-tab-close" aria-label={`Close ${title(tab)}`} onClick={() => close(tab)}>×</button>}</div>)}</div><div className="workspace-surface mdi-workspace-surface"><App mdi />{activeTab.kind === 'file' && activeTab.preview && <FilePreview file={activeTab.preview} onClose={() => close(activeTab)} />}</div></div>
    </div>
    <QuestionsPanel />
    <div hidden={!microphoneVisible}><VoiceDock /></div>
    <NewCard hideTrigger />
    <footer className="mdi-statusbar"><span><i className={state.connected ? 'connected-dot' : 'disconnected-dot'} />{state.connected ? 'Connected' : 'Reconnecting'}</span><span>{title(activeTab)}</span><span>{state.sessions.find(item => item.id === state.selectedId)?.name || 'No chat selected'}</span><span>{state.questions.length} questions</span><span className="mdi-status-path" title={state.repo}>{state.repo}</span></footer>
    {settings && <SettingsDialog onClose={() => setSettings(false)} />}
  </div>
}
