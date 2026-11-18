import { useEffect, useRef, useState } from 'react'
import { api, reportError, useDesktop } from './client'

export default function LayoutRegion({ kind, children }: { kind: 'composer' | 'viewer'; children: React.ReactNode }) {
  const { settings } = useDesktop()
  const key = kind === 'composer' ? 'composerHeight' : 'viewerHeight'
  const [chosen, setChosen] = useState(settings[key] || (kind === 'composer' ? 190 : 240))
  const [available, setAvailable] = useState(700)
  const host = useRef<HTMLDivElement>(null), drag = useRef<{ y: number; height: number } | null>(null)
  const min = kind === 'composer' ? 100 : Math.min(80, Math.max(24, available - 240))
  const budget = kind === 'composer' ? available - (settings.viewerEnabled ? 210 : 130) : available - 240
  const max = Math.max(min, Math.min(kind === 'composer' ? 520 : 420, budget, available * (kind === 'composer' ? .43 : .28)))
  const height = Math.round(Math.max(min, Math.min(max, chosen)))
  useEffect(() => {
    const pane = host.current?.closest('.thread-conversation')
    if (!pane) return
    const observer = new ResizeObserver(() => setAvailable(pane.clientHeight))
    observer.observe(pane); return () => observer.disconnect()
  }, [])
  const resize = (value: number, save = false) => {
    const next = Math.round(Math.max(min, Math.min(max, value)))
    setChosen(next)
    if (save) void api('/settings', { [key]: next }).catch(reportError)
  }
  const separator = <div className="conversation-resizer" role="separator" aria-label={`Resize ${kind === 'composer' ? 'writing area' : '3D viewer'}`} aria-orientation="horizontal" aria-valuemin={min} aria-valuemax={Math.round(max)} aria-valuenow={height} tabIndex={0} title="Drag to resize. Arrow keys resize; Home/End choose minimum/maximum."
    onPointerDown={event => { if (event.button !== 0) return; drag.current = { y: event.clientY, height }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }}
    onPointerMove={event => { if (drag.current) resize(drag.current.height + (event.clientY - drag.current.y) * (kind === 'composer' ? -1 : 1)) }}
    onPointerUp={event => { if (!drag.current) return; resize(drag.current.height + (event.clientY - drag.current.y) * (kind === 'composer' ? -1 : 1), true); drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
    onPointerCancel={() => { drag.current = null }}
    onKeyDown={event => { const step = event.shiftKey ? 40 : 20; const values: Record<string, number> = { ArrowUp: height + (kind === 'composer' ? step : -step), ArrowDown: height + (kind === 'composer' ? -step : step), Home: min, End: max }; if (event.key in values) { event.preventDefault(); resize(values[event.key], true) } }}><span /></div>
  return <div ref={host} className={`layout-region layout-${kind}`} style={{ height }}>{kind === 'composer' && separator}<div className="layout-region-content">{children}</div>{kind === 'viewer' && separator}</div>
}
