import { useEffect, useRef } from 'react'
import { api, reportError, useDesktop } from './client'

export default function WindowControls() {
  const { nativeWindow } = useDesktop(), press = useRef<{ x: number; y: number } | null>(null)
  const command = (action: string) => void api('/window', { window: 'workspace', action }).catch(reportError)
  useEffect(() => {
    if (!nativeWindow?.available) return
    const key = (event: KeyboardEvent) => { if (event.altKey && event.code === 'Space') { event.preventDefault(); command('system-menu') } }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [nativeWindow?.available])
  if (!nativeWindow?.available) return null
  return <><div className="window-drag-region" aria-label="Window drag area" onPointerDown={event => { if (event.button === 0) press.current = { x: event.clientX, y: event.clientY } }} onPointerMove={event => {
    if (press.current && event.buttons === 1 && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 3) { press.current = null; command('drag') }
  }} onPointerUp={() => { press.current = null }} onPointerLeave={() => { press.current = null }} onDoubleClick={() => command('toggle-maximize')} onContextMenu={event => { event.preventDefault(); command('system-menu') }} />
    <div className="window-controls" aria-label="Window commands">
      <button aria-label="Minimize window" title="Minimize" onClick={() => command('minimize')}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" /></svg></button>
      <button aria-label={nativeWindow.maximized ? 'Restore window' : 'Maximize window'} title={nativeWindow.maximized ? 'Restore' : 'Maximize'} onClick={() => command('toggle-maximize')}><svg viewBox="0 0 12 12" aria-hidden="true">{nativeWindow.maximized ? <path d="M3 3V1h8v8H9M1 3h8v8H1z" /> : <path d="M1 1h10v10H1z" />}</svg></button>
      <button className="window-close" aria-label="Close window" title="Close window (keeps work running)" onClick={() => command('close')}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1 1 10 10M11 1 1 11" /></svg></button>
    </div></>
}
