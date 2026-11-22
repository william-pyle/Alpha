import { useEffect } from 'react'
import { dismissError, sendEvent, startDesktop, surface, useDesktop } from './client'
import UnifiedShell from './UnifiedShell'
import { Icon, Nose } from './Icons'
import './desktop.css'


export default function DesktopApp() {
  const state = useDesktop()
  useEffect(() => { startDesktop() }, [])
  useEffect(() => {
    if (surface !== 'workspace') return
    const route = () => sendEvent({ type: 'workspace-route', route: location.hash })
    window.addEventListener('hashchange', route)
    return () => window.removeEventListener('hashchange', route)
  }, [])
  if (!state.ready) return <div className="desktop-boot"><Nose size={70} /><h1>Alpha</h1><p>{state.error || 'Opening your workspace…'}</p>{state.error && <button className="desk-secondary" onClick={() => startDesktop()}>Reconnect</button>}</div>
  return <div className={`desktop-root ${surface}-root`}>
    <UnifiedShell />
    {state.error && <div className="desktop-error" role="alert"><span>{state.error}</span><button onClick={dismissError} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>}
    {!state.connected && <div className="desktop-offline">Reconnecting to the local service…</div>}
  </div>
}
