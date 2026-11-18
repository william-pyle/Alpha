import { useState, useSyncExternalStore } from 'react'
import { api, reportError, useDesktop } from './client'
import { captureState } from './captureState'
import { liveVoice } from './live'
import VoiceInput from '../voice/VoiceInput'
import { useDictation } from './useDictation'

export default function ConversationSettings() {
  const state = useDesktop(), capture = useSyncExternalStore(captureState.subscribe, captureState.snapshot), live = useSyncExternalStore(liveVoice.subscribe, liveVoice.snapshot)
  const { info } = useDictation(), [, setBusy] = useState(false)
  const thread = state.threads.find(item => item.id === state.selectedThreadId)
  const voiceActive = ['live', 'connecting', 'closing'].includes(live.status)
  const change = (value: object) => void api('/settings', value).catch(reportError)
  const awareness = (value: object) => void api('/awareness', value).catch(reportError)
  return <div className="settings-scroll conversation-settings"><h2>Conversation</h2>
    <label><input type="checkbox" checked={!!state.settings.viewerEnabled} onChange={event => { if (!event.target.checked) captureState.set({ camera: false }); change({ viewerEnabled: event.target.checked }) }} />Enable 3D viewer</label>
    <p>Drag the viewer divider to resize it. Disabling releases its renderer and camera; its saved size is retained.</p>
    <h3>Reading</h3>
    <label>Text size<select aria-label="Conversation text size" value={state.settings.readingSize || 16} onChange={event => change({ readingSize: Number(event.target.value) })}>{[14, 16, 18, 20, 24].map(size => <option key={size} value={size}>{size}px</option>)}</select></label>
    <label>Line spacing<select aria-label="Conversation line spacing" value={state.settings.readingSpacing || 1.6} onChange={event => change({ readingSpacing: Number(event.target.value) })}>{[1.4, 1.6, 1.8, 2].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
    <label><input type="checkbox" checked={state.settings.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches} onChange={event => change({ reducedMotion: event.target.checked })} />Reduce motion</label>
    <p>Stops decorative viewer motion and interface animations. Manual resizing remains available.</p>
    <h3>Camera and microphone</h3><p>Camera eye contact uses local face position only. No identification, saved frames or upload. Capture starts only with your action and stops when the viewer is disabled or Alpha is hidden.</p>
    <button disabled={!state.settings.viewerEnabled} onClick={() => captureState.set({ camera: !capture.camera, error: '' })}>{capture.camera ? 'Stop camera' : 'Start camera for eye contact'}</button>
    {state.voice.configured && <button disabled={!thread || thread.projectPending} onClick={() => voiceActive ? liveVoice.stopImmediately() : void liveVoice.start()}>{voiceActive ? 'End live voice' : 'Start live voice'}</button>}
    {capture.error && <p role="alert">{capture.error}</p>}{live.error && <p role="alert">{live.error}</p>}
    <h3>Dictate into this conversation</h3><p>Recording stays recoverable if Settings closes. Review the transcribed draft before sending.</p>
    {thread && <VoiceInput key={thread.id} id={`alpha-thread-${thread.id}`} config={info} connected={state.connected} disabled={!!thread.archived || thread.projectPending} onBusy={setBusy} onText={async text => {
      const key = `alpha.threadDraft.${thread.id}`
      const draft = JSON.parse(localStorage.getItem(key) || JSON.stringify(thread.draft || { text: '', paths: [] }))
      draft.text = draft.text ? `${draft.text}\n${text}` : text
      await api(`/threads/${thread.id}/draft`, draft)
      localStorage.setItem(key, JSON.stringify(draft)); window.dispatchEvent(new CustomEvent('alpha-draft-updated', { detail: thread.id }))
    }} />}
    <h3>Alpha layout inspection</h3>
    {thread && <label><input type="checkbox" checked={!!thread.allowUiInspection} onChange={event => void api(`/threads/${thread.id}`, { allowUiInspection: event.target.checked }, 'PATCH').catch(reportError)} />Allow layout inspection in this conversation</label>}
    <p>Revocable access to visible Alpha region sizes only, on an explicit coordinator tool call. No message text, inputs, screenshots, other conversations or desktop access. Blocked while Settings or another dialog is open.</p>
    <h3>Awareness</h3>
    <label><input type="checkbox" checked={state.awareness.settings.enabled} onChange={event => awareness({ enabled: event.target.checked })} />Enable awareness</label>
    <label><input type="checkbox" checked={state.awareness.settings.quiet} onChange={event => awareness({ quiet: event.target.checked })} />Quiet mode</label>
    <label><input type="checkbox" checked={state.awareness.settings.desktop} onChange={event => awareness({ desktop: event.target.checked })} />Allow foreground application names only</label>
    <p>Uses Alpha and Workspace events. Optional app context reads names only, never screen, audio, clipboard, titles or input.</p>
    {thread && state.awareness.settings.desktop && <label><input type="checkbox" checked={!!thread.desktopContext} onChange={event => void api(`/threads/${thread.id}`, { desktopContext: event.target.checked }, 'PATCH').catch(reportError)} />Share app name with this conversation</label>}
  </div>
}
