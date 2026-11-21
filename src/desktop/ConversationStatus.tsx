import { useSyncExternalStore } from 'react'
import { api, reportError, useDesktop } from './client'
import { liveVoice } from './live'
import ImportantEvents from './ImportantEvents'
import { captureState } from './captureState'

export default function ConversationStatus() {
  const state = useDesktop(), live = useSyncExternalStore(liveVoice.subscribe, liveVoice.snapshot), capture = useSyncExternalStore(captureState.subscribe, captureState.snapshot)
  const thread = state.threads.find(item => item.id === state.selectedThreadId), op = thread?.operation, t = op?.timings
  const working = state.sessions.filter(item => thread?.sessionIds.includes(item.id) && item.status === 'running' && item.activity === 'working').length
  const seconds = (end?: number, start = t?.queuedAt) => end == null || start == null ? 'pending' : `${((end - start) / 1000).toFixed(2)}s`
  const basePhase = ({ queued: 'Working: queued', starting: 'Starting coordinator', provider: 'Working: waiting for provider', tool: 'Working: running tool', responding: 'Receiving response', 'waiting-for-user': 'Waiting for your answer', completed: 'Ready', failed: 'Request failed — review Needs attention', interrupted: 'Ready' } as Record<string, string>)[op?.phase || ''] || (thread?.status === 'working' ? 'Working' : thread?.status === 'waiting-for-user' ? 'Waiting for your answer' : 'Ready')
  const evidence = state.sessions.filter(item => thread?.sessionIds.includes(item.id) && item.workerEvidence).map(item => item.workerEvidence!).sort((a, b) => b.observedAt - a.observedAt)[0]
  const useWorker = evidence && (!op || ['completed', 'failed', 'interrupted'].includes(op.phase) && evidence.observedAt >= (t?.completedAt || 0))
  const pendingInput = state.sessions.find(item => thread?.sessionIds.includes(item.id) && item.submission && item.submission.acceptance !== 'observed')?.submission
  const phase = pendingInput ? `Worker input: ${pendingInput.stage}` : useWorker ? ({ working: 'Worker working', 'needs-input': 'Waiting for input', finished: 'Ready', failed: 'Worker failed — review Needs attention', interrupted: 'Ready', unknown: evidence.acceptance === 'unconfirmed' ? 'Delivered; acceptance unconfirmed' : 'Worker state unconfirmed' } as Record<string, string>)[evidence.execution] || basePhase : basePhase
  return <footer className="mdi-statusbar" aria-label="Status bar">
    <span title={state.connected ? 'Connected' : 'Reconnecting'}><i className={state.connected ? 'connected-dot' : 'disconnected-dot'} /></span>
    <details className="status-runtime"><summary>{phase}{working > 0 ? ` · ${working} working` : ''}</summary><div className="status-detail"><strong>{phase}</strong><p>{working} active workers</p>{t && <><p>Queue {seconds(t.dequeuedAt)} · Startup {seconds(t.readyAt, t.dequeuedAt)} · First text {seconds(t.firstTextAt)} · Tools {((t.toolMs || 0) / 1000).toFixed(2)}s ({t.toolCalls || 0}) · Total {seconds(t.completedAt)}</p><p>Provider wait includes network and model processing. Completion does not verify the work. Speech onset is not measured.</p></>}<p>{state.connected ? 'Connected' : 'Reconnecting'} · {state.questions.length} pending Questions</p></div></details>
    {capture.camera && <button className="capture-stop" onClick={() => captureState.set({ camera: false })}>{capture.cameraStatus || 'Camera requested'} · Stop camera</button>}
    {['live', 'connecting', 'closing'].includes(live.status) && <button className="capture-stop" onClick={() => liveVoice.stopImmediately()}>Microphone {live.status} · Stop voice</button>}
    {state.speech.speaking && <button onClick={() => void api('/speech/stop', {}).catch(reportError)}>Speaking · Stop</button>}
    {(capture.error || live.error || state.speech.error) && <span role="alert" title={capture.error || live.error || state.speech.error || ''}>Capture/speech error: {capture.error || live.error || state.speech.error}</span>}
    <ImportantEvents />
  </footer>
}
