import { useEffect, useRef, useState } from 'react'
import ChatComposer from './ChatComposer'
import TerminalPane from './TerminalPane'
import { api, reportError } from './client'
import type { AgentId } from './types'
import type { TerminalAppearance } from './terminalAppearance'

const DEFAULT_EDITOR_HEIGHT = 170
const DIVIDER_HEIGHT = 10
const MIN_TERMINAL_HEIGHT = 120
const MIN_EDITOR_HEIGHT = 110
export default function ChatSplit({ id, agent, fontSize, appearance, connected, running, showReconnect, restoreError, savedHeight, onAttachmentStatus }: {
  id: string
  agent: AgentId
  fontSize: number
  appearance: TerminalAppearance
  connected: boolean
  running: boolean
  showReconnect: boolean
  restoreError?: string | null
  savedHeight?: number
  onAttachmentStatus: (id: string, text: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const reconnect = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; height: number } | null>(null)
  const [space, setSpace] = useState(0)
  const [preferred, setPreferred] = useState(() => savedHeight && savedHeight >= MIN_EDITOR_HEIGHT ? savedHeight : DEFAULT_EDITOR_HEIGHT)

  useEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => setSpace(element.clientHeight - (reconnect.current?.offsetHeight || 0))
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (reconnect.current) observer.observe(reconnect.current)
    measure()
    return () => observer.disconnect()
  }, [showReconnect])

  const maximum = Math.max(MIN_EDITOR_HEIGHT, space - MIN_TERMINAL_HEIGHT - DIVIDER_HEIGHT)
  const height = Math.min(Math.max(preferred, MIN_EDITOR_HEIGHT), maximum)
  const save = (value: number) => { setPreferred(value); void api('/settings', { chatEditorHeight: { id, height: Math.round(value) } }).catch(reportError) }
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    drag.current = { y: event.clientY, height }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    setPreferred(Math.min(Math.max(drag.current.height + drag.current.y - event.clientY, MIN_EDITOR_HEIGHT), maximum))
  }
  const stop = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const next = Math.min(Math.max(drag.current.height + drag.current.y - event.clientY, MIN_EDITOR_HEIGHT), maximum)
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    save(next)
  }
  const keyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 50 : 10
    let next: number
    if (event.key === 'ArrowUp') next = height + step
    else if (event.key === 'ArrowDown') next = height - step
    else if (event.key === 'Home') next = MIN_EDITOR_HEIGHT
    else if (event.key === 'End') next = maximum
    else return
    event.preventDefault()
    save(Math.min(Math.max(next, MIN_EDITOR_HEIGHT), maximum))
  }

  return <div className="chat-split" ref={root}>
    <TerminalPane id={id} agent={agent} fontSize={fontSize} appearance={appearance} onAttachmentStatus={onAttachmentStatus} />
    {showReconnect && <div ref={reconnect} className="terminal-reconnect"><span>{restoreError || 'Reconnecting to your conversation…'}</span><button onClick={() => api(`/sessions/${id}/resume`, {}).catch(reportError)}>Reconnect</button></div>}
    <div className="chat-splitter" role="separator" tabIndex={0} aria-label="Resize terminal and message editor" aria-orientation="horizontal" aria-valuemin={MIN_EDITOR_HEIGHT} aria-valuemax={maximum} aria-valuenow={height} aria-valuetext={`Message editor ${height} pixels high`} onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onKeyDown={keyboard} onDoubleClick={() => save(DEFAULT_EDITOR_HEIGHT)}><span /></div>
    <ChatComposer id={id} connected={connected} running={running} height={height} />
  </div>
}
