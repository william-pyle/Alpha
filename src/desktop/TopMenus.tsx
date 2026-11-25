import { useEffect, useRef, useState } from 'react'
import { useDesktop } from './client'
import WindowControls from './WindowControls'
import { Nose } from './Icons'

const menus: Record<string, Array<[string, string]>> = {
  File: [['New conversation', 'new-conversation'], ['Create project', 'new-card']],
  View: [['Workspace', 'workspace'], ['Conversation history', 'conversation-history'], ['Needs attention', 'needs-attention'], ['Questions', 'questions'], ["What I've learned", 'learned-preferences'], ['Common agents', 'common-agents'], ['Alpha health', 'health']],
  Help: [['Open Help', 'help'], ['Check for Updates', 'check-for-updates']],
}
const labels = Object.keys(menus)

export default function TopMenus({ run, messagesVisible, viewerVisible }: { run: (action: string) => void; messagesVisible?: boolean; viewerVisible?: boolean }) {
  const [open, setOpen] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const { nativeWindow } = useDesktop()
  const viewMenus = messagesVisible === undefined || viewerVisible === undefined ? menus : {
    ...menus,
    View: [...menus.View, [messagesVisible ? 'Hide message panel' : 'Show message panel', 'toggle-messages'],
      [viewerVisible ? 'Hide 3D viewer' : 'Show 3D viewer', 'toggle-viewer']],
  }
  const trigger = (label: string) => root.current?.querySelector<HTMLButtonElement>(`[data-menu-trigger="${label}"]`)
  const focusItem = (label: string, last = false) => requestAnimationFrame(() => {
    const items = root.current?.querySelectorAll<HTMLButtonElement>(`[data-menu="${label}"] [role=menuitem]`)
    items?.[last ? items.length - 1 : 0]?.focus()
  })
  useEffect(() => {
    const dismiss = () => setOpen(null)
    const outside = (event: Event) => { if (!(event.target instanceof Element) || !root.current?.contains(event.target) || !event.target.closest('.mdi-menu-group')) dismiss() }
    const visibility = () => { if (document.visibilityState !== 'visible') dismiss() }
    // Capture also covers clicks in widgets that stop React propagation. Blur
    // handles focus entering an embedded report or another native window.
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside, true)
    window.addEventListener('blur', dismiss)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside, true)
      window.removeEventListener('blur', dismiss)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  useEffect(() => {
    if (nativeWindow?.focused === false || nativeWindow?.minimized) {
      // Native focus can change without the WebView emitting a DOM blur.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(null)
    }
  }, [nativeWindow?.focused, nativeWindow?.minimized])
  return <div ref={root} className="mdi-menu-bar" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); trigger(open)?.focus(); setOpen(null) }
    if (event.key === 'Tab') setOpen(null)
  }} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(null)
  }}>
    <div className="mdi-brand"><Nose size={20} /><strong>Alpha</strong></div>
    {Object.entries(viewMenus).map(([label, items]) => <div className="mdi-menu-group" key={label}>
      <button type="button" data-menu-trigger={label} aria-haspopup="menu" aria-controls={`top-menu-${label}`} aria-expanded={open === label}
        onClick={() => setOpen(current => current === label ? null : label)}
        onKeyDown={event => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(label); focusItem(label, event.key === 'ArrowUp') }
          if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const next = labels[(labels.indexOf(label) + (event.key === 'ArrowRight' ? 1 : labels.length - 1)) % labels.length]; trigger(next)?.focus(); if (open) setOpen(next) }
        }}>{label}</button>
      {open === label && <div className="mdi-menu-popup" id={`top-menu-${label}`} data-menu={label} role="menu" aria-label={label} onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]'))
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
        }
        if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault(); const next = labels[(labels.indexOf(label) + (event.key === 'ArrowRight' ? 1 : labels.length - 1)) % labels.length]
          setOpen(next); focusItem(next)
        }
      }}>
        {items.map(([text, action]) => <button role="menuitem" key={action} type="button" onClick={() => { setOpen(null); trigger(label)?.focus(); run(action) }}>{text}</button>)}
      </div>}
    </div>)}
    <WindowControls openSettings={() => run('settings')} />
  </div>
}
