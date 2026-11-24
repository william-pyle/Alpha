import { useCallback, useEffect, useState } from 'react'
import { api, onServiceEvent } from '../desktop/client'
import './workspace-tool-controls.css'

type ToolState = 'stopped' | 'starting' | 'running' | 'running-external' | 'stopping' | 'error'
interface ToolView {
  id: string; name: string; kind: 'managed-process' | 'observed-external' | 'one-shot'
  state: ToolState; ready: boolean; owned: boolean; error: string | null
  lastResult: { at: string; exitCode?: number; error?: string } | null
  launches: { id: string; name: string; available: boolean }[]
}
const labels: Record<ToolState, string> = {
  stopped: 'Stopped', starting: 'Starting…', running: 'Running', 'running-external': 'Running (external)', stopping: 'Stopping…', error: 'Error',
}

export default function WorkspaceToolControls({ cardId, toolIds, onRunFinished }: {
  cardId: string
  toolIds?: readonly string[]
  onRunFinished?: (id: string, success: boolean) => void
}) {
  const [tools, setTools] = useState<ToolView[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const refresh = useCallback(() => {
    api<ToolView[]>(`/workspace/tools/${encodeURIComponent(cardId)}`).then(setTools).catch(cause => setError(String(cause.message || cause)))
  }, [cardId])
  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 3000)
    const off = onServiceEvent(event => { if (event.type === 'workspace-tool-state' && event.cardId === cardId) refresh() })
    return () => { window.clearInterval(timer); off() }
  }, [cardId, refresh])
  const act = async (tool: ToolView, action: 'start' | 'stop' | 'launch', actionId?: string) => {
    const toolId = tool.id
    const key = `${toolId}/${action}`
    let success = false
    setBusy(key); setError('')
    try {
      await api(`/workspace/tools/${encodeURIComponent(cardId)}/${encodeURIComponent(toolId)}/${action}`, actionId ? { actionId } : {})
      success = true
      refresh()
    } catch (cause) { setError(String((cause as Error).message || cause)); refresh() }
    finally {
      setBusy('')
      if (action === 'start' && tool.kind === 'one-shot') onRunFinished?.(toolId, success)
    }
  }
  return <section className="workspace-tools" aria-label="Workspace tools">
    <div className="workspace-tools-heading"><strong>Tools</strong>{error && <span role="alert">{error}</span>}</div>
    <div className="workspace-tools-list">{tools.filter(tool => !toolIds || toolIds.includes(tool.id)).map(tool => {
      const changing = tool.state === 'starting' || tool.state === 'stopping' || busy.startsWith(`${tool.id}/`)
      const action = tool.kind === 'one-shot' ? 'start' : tool.kind === 'managed-process' && tool.owned ? 'stop' : tool.kind === 'managed-process' && tool.state !== 'running-external' ? 'start' : null
      return <div className="workspace-tool" key={tool.id}>
        <div className="workspace-tool-name"><strong>{tool.name}</strong><span className={`workspace-tool-state state-${tool.state}`}>{labels[tool.state]}</span>{tool.error && <small title={tool.error}>{tool.error}</small>}{tool.lastResult && <small>Last run: {tool.lastResult.error ? 'failed' : 'completed'}</small>}</div>
        <div className="workspace-tool-actions">
          {action && <button type="button" disabled={changing} onClick={() => void act(tool, action)}>{tool.kind === 'one-shot' ? 'Run' : action === 'stop' ? 'Stop' : 'Start'}</button>}
          {tool.launches.map(launch => <button type="button" key={launch.id} disabled={changing || !launch.available} onClick={() => void act(tool, 'launch', launch.id)}>{launch.name}</button>)}
        </div>
      </div>
    })}</div>
  </section>
}
