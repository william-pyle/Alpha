import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type ConversationMenuOrigin = { id: string | null; x: number; y: number; origin: HTMLElement }
export default function ConversationContextMenu({ target, items, close }: { target: ConversationMenuOrigin; items: { label: string; run: () => void }[]; close: () => void }) {
  const menu = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ x: target.x, y: target.y })
  const dismiss = () => { close(); if (target.origin.isConnected) target.origin.focus({ preventScroll: true }); else document.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')?.focus() }
  useLayoutEffect(() => {
    const node = menu.current!
    setPosition({ x: Math.max(8, Math.min(target.x, innerWidth - node.offsetWidth - 8)), y: Math.max(8, Math.min(target.y, innerHeight - node.offsetHeight - 8)) })
    node.querySelector<HTMLButtonElement>('button')?.focus()
  }, [target])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close() }
    window.addEventListener('pointerdown', outside)
    return () => window.removeEventListener('pointerdown', outside)
  }, [close])
  return createPortal(<div ref={menu} role="menu" aria-label="Conversation actions" className="message-context-menu" style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); dismiss() }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus() }
  }}>{items.map(item => <button role="menuitem" key={item.label} onClick={() => { dismiss(); item.run() }}>{item.label}</button>)}</div>, document.body)
}
