import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { reportError } from './client'

export default function MessageMenu({ x, y, origin, selectedText, text, close, transfer, speak }: {
  x: number; y: number; origin: HTMLElement; selectedText: string; text: string
  close: () => void; transfer: () => void; speak?: () => void
}) {
  const menu = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ x, y })
  const dismiss = () => { close(); origin.focus({ preventScroll: true }) }
  useLayoutEffect(() => {
    const node = menu.current!
    setPosition({ x: Math.max(8, Math.min(x, innerWidth - node.offsetWidth - 8)), y: Math.max(8, Math.min(y, innerHeight - node.offsetHeight - 8)) })
    node.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [x, y])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close() }
    const resize = () => { close(); origin.focus({ preventScroll: true }) }
    window.addEventListener('pointerdown', outside); window.addEventListener('resize', resize)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize) }
  }, [close, origin])
  const copy = (value: string) => { void navigator.clipboard.writeText(value).catch(reportError); dismiss() }
  return createPortal(<div ref={menu} className="message-context-menu" role="menu" aria-label="Message actions" style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() }
    else if (event.key === 'Tab') { event.preventDefault(); dismiss() }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus() }
  }}>
    {selectedText && <button role="menuitem" onClick={() => copy(selectedText)}>Copy selected text</button>}
    <button role="menuitem" onClick={() => copy(text)}>Copy message text</button>
    <button role="menuitem" onClick={() => { dismiss(); transfer() }}>Copy to another conversation…</button>
    {speak && <button role="menuitem" onClick={() => { dismiss(); speak() }}>Read reply aloud</button>}
  </div>, document.body)
}
