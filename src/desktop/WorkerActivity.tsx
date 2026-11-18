import { useState } from 'react'
import { api, reportError, useDesktop } from './client'
import type { AlphaThread } from './types'
import TerminalPane from './TerminalPane'

const ignoreAttachmentStatus = () => {}

// Keep mounted terminals while switching views, preserving xterm scrollback and
// viewport. Hidden panes cannot accept input, file-picker events or focus.
export default function WorkerActivity({ thread, active }: { thread: AlphaThread; active: boolean }) {
  const state = useDesktop()
  const workers = state.sessions.filter(session => thread.sessionIds.includes(session.id))
  const worker = workers.find(session => session.id === thread.workerId) || workers[0]
  const [enabled, setEnabled] = useState<string | null>(null)
  const unlocked = active && enabled === worker?.id && worker?.status === 'running' && state.connected
  // A new activation requires an explicit unlock, even when returning to the
  // same worker. No permissions or process lifecycle change here.
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) { setWasActive(active); setEnabled(null) }
  return <section className="conversation-worker" aria-label={`Worker activity for ${thread.name}`} hidden={!active}>
    {!worker ? <div className="worker-empty"><strong>No worker in this conversation</strong><p>Worker activity appears here after this conversation starts work. Switching views does not start a worker.</p></div> : <>
      <div className="worker-toolbar"><label>Worker<select aria-label={`Worker for ${thread.name}`} value={worker.id} onChange={event => { setEnabled(null); void api(`/threads/${thread.id}/view`, { workerId: event.target.value }).catch(reportError) }}>{workers.map(session => <option key={session.id} value={session.id}>{session.name} · {session.status}</option>)}</select></label>
        <button disabled={!state.connected || worker.status !== 'running'} aria-pressed={!!unlocked} onClick={() => setEnabled(unlocked ? null : worker.id)}>{unlocked ? 'Lock terminal controls' : 'Enable terminal controls'}</button>
      </div>
      {worker.submission && <p className="worker-destination" role="status">Last request: {worker.submission.stage}. {worker.submission.note}</p>}
      <p className="worker-destination" role="status">{unlocked ? `Keyboard input goes directly to ${worker.name} only. Click the terminal to type.` : `Read-only terminal: ${worker.name}. ${worker.status === 'running' ? 'Enable controls to type directly.' : 'Worker is stopped; switching views does not resume it.'}`}</p>
      {workers.map(session => <div key={session.id} className="worker-terminal" hidden={session.id !== worker.id}>
        <TerminalPane id={session.id} agent={session.agent} fontSize={state.settings.terminalFontSize || 13} appearance={state.settings.terminalAppearance || 'original'} readOnly={!unlocked || session.id !== worker.id} active={active && session.id === worker.id} autoFocus={false} onAttachmentStatus={ignoreAttachmentStatus} />
      </div>)}
      <button className="worker-focus" disabled={!unlocked} onClick={() => { window.dispatchEvent(new CustomEvent('alpha-focus-terminal', { detail: { id: worker.id } })) }}>Focus terminal: {worker.name}</button>
    </>}
  </section>
}
