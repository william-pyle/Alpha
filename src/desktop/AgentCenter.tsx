import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, onServiceEvent, useDesktop } from './client'
import './agent-center.css'

type Run = { id: string; agentId: string | null; project: string; task: string; outcome: string; version: number; feedback?: string; durationMs?: number }
type Agent = { id: string; name: string; purpose: string; enabled: boolean; origin: string; activeVersion: number; instructions: string; versions: { version: number; reason: string; instructions: string }[]; maintenanceNeeded: boolean }
type Data = { agents: Agent[]; tasks: Run[]; scope: { excludedProjects: string[] }; patterns: { id: string; name: string; observations: number; projects: number; agentCreated: boolean }[] }
type Health = { issues: { id: string; area: string; symptom: string; proposal: string; status: string }[]; recentRequests: { route: string; durationMs: number; status: number; slow: boolean; at: string }[] }

function ScopeEditor({ excluded, refresh }: { excluded: string[]; refresh: () => Promise<void> }) {
  const [text, setText] = useState(excluded.join(', ')), [error, setError] = useState('')
  const save = async () => {
    try { await api('/common-agents/scope', { excludedProjects: text.split(',').map(value => value.trim()).filter(Boolean) }); await refresh(); setError('') }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }
  return <details><summary>Automation scope</summary><p>Excluded projects are left out of discovery, analysis and automatic role assignment. Their existing agents remain independent.</p><label>Excluded project IDs<input aria-label="Excluded project IDs" value={text} onChange={event => setText(event.target.value)} placeholder="project-one, project-two" /></label><button onClick={() => void save()}>Save automation scope</button>{error && <p role="alert">{error}</p>}</details>
}

function AgentCard({ agent, refresh, repo }: { agent: Agent; refresh: () => Promise<void>; repo: string }) {
  const [task, setTask] = useState(''), [cwd, setCwd] = useState(repo), [instructions, setInstructions] = useState(agent.instructions), [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const act = async (action: string, data: unknown) => {
    setBusy(true); setMessage('')
    try {
      const result = await api<{ status?: string; result?: string }>(`/common-agents/${agent.id}/${action}`, data)
      if (result.status === 'failed') throw new Error(result.result || 'The request failed.')
      await refresh(); setMessage(action === 'run' ? result.result || 'Task sent to Alpha.' : 'Saved.')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <article className="agent-card">
    <header><strong>{agent.name}</strong><span>v{agent.activeVersion} · {agent.enabled ? 'Enabled' : 'Disabled'}</span></header>
    <p>{agent.purpose}</p><small>{agent.origin === 'starter' ? 'Starting role' : 'Created from repeated work'}{agent.maintenanceNeeded ? ' · Maintenance needed' : ''}</small>
    <div className="agent-actions"><button disabled={busy} onClick={() => void act('control', { enabled: !agent.enabled })}>{agent.enabled ? 'Disable' : 'Enable'} {agent.name}</button><label>Active version<select aria-label={`Version for ${agent.name}`} disabled={busy} value={agent.activeVersion} onChange={event => void act('control', { version: Number(event.target.value) })}>{agent.versions.map(item => <option key={item.version} value={item.version}>v{item.version}</option>)}</select></label></div>
    <details><summary>Run a task</summary><label>Project folder<input aria-label={`Project folder for ${agent.name}`} value={cwd} onChange={event => setCwd(event.target.value)} /></label><label>Task<textarea aria-label={`Task for ${agent.name}`} rows={3} value={task} onChange={event => setTask(event.target.value)} /></label><button disabled={busy || !agent.enabled || task.trim().length < 12} onClick={() => void act('run', { id: crypto.randomUUID(), task, cwd })}>Run {agent.name}</button></details>
    <details><summary>Instructions &amp; history</summary><label>Current instructions<textarea aria-label={`Instructions for ${agent.name}`} rows={6} value={instructions} onChange={event => setInstructions(event.target.value)} /></label><label>Reason for revision<input aria-label={`Revision reason for ${agent.name}`} value={reason} onChange={event => setReason(event.target.value)} /></label><button disabled={busy || instructions.trim().length < 80 || reason.trim().length < 10} onClick={() => void act('revise', { instructions, reason })}>Save new version</button><ul>{agent.versions.slice().reverse().map(item => <li key={item.version}><strong>v{item.version}</strong> {item.reason}</li>)}</ul></details>
    {message && <p role="status">{message}</p>}
  </article>
}

function TaskFeedback({ task, refresh }: { task: Run; refresh: () => Promise<void> }) {
  const [feedback, setFeedback] = useState(task.feedback || ''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const send = async (outcome: string) => {
    setBusy(true); setError('')
    try { await api(`/common-agent-tasks/${task.id}/feedback`, { outcome, feedback }); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <article className="agent-run"><strong>{task.agentId || 'Observed task'}{task.version ? ` · v${task.version}` : ''}</strong><p>{task.task}</p><small>{task.project} · {task.outcome === 'completed-unverified' ? 'Turn completed; result not yet accepted' : task.outcome}{task.durationMs !== undefined ? ` · ${(task.durationMs / 1000).toFixed(1)}s` : ''}</small><label>Feedback<input aria-label={`Feedback for task ${task.id}`} value={feedback} onChange={event => setFeedback(event.target.value)} /></label><button disabled={busy} onClick={() => void send('accepted')}>Mark accepted</button><button disabled={busy || feedback.trim().length < 8} onClick={() => void send('needs-fix')}>Needs a fix</button>{error && <p role="alert">{error}</p>}</article>
}

export default function AgentCenter({ initialTab = 'Agents', onClose }: { initialTab?: 'Agents' | 'Health'; onClose: () => void }) {
  const { repo } = useDesktop()
  const dialog = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState(initialTab), [data, setData] = useState<Data | null>(null), [health, setHealth] = useState<Health | null>(null), [error, setError] = useState('')
  const refresh = async () => {
    const [agents, status] = await Promise.all([api<Data>('/common-agents'), api<Health>('/health')]); setData(agents); setHealth(status)
  }
  useEffect(() => {
    const node = dialog.current; node?.showModal()
    const update = () => void refresh().catch(error => setError(error.message))
    update(); const timer = window.setInterval(update, 5000)
    const unsubscribe = onServiceEvent(event => { if (['common-agents', 'health'].includes(event.type)) update() })
    return () => { clearInterval(timer); unsubscribe(); node?.close() }
  }, [])
  return createPortal(<dialog ref={dialog} className="agent-center" aria-label="Alpha agents and health" onCancel={event => { event.preventDefault(); onClose() }}>
    <header><strong>Alpha&apos;s workshop</strong><button aria-label="Close agent center" onClick={onClose}>Close</button></header>
    <nav aria-label="Agent center sections">{(['Agents', 'Health'] as const).map(name => <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</nav>
    <main>{error && <p role="alert">{error}</p>}{tab === 'Agents' ? <>
      <h2>Common agents</h2><p>Reusable roles for work that repeats across projects. Alpha looks for repeated completed tasks, creates roles when there is enough evidence, and reviews failure feedback to maintain them.</p>
      <p>Roles run in your existing coding tools with the current permissions. Versions can be restored below. A completed turn still needs verification of its result.</p>
      {data && <ScopeEditor key={data.scope.excludedProjects.join(',')} excluded={data.scope.excludedProjects} refresh={refresh} />}
      {data?.agents.map(agent => <AgentCard key={`${agent.id}:${agent.activeVersion}`} agent={agent} refresh={refresh} repo={repo} />)}
      <h3>Repeated work</h3>{data?.patterns.length ? <ul>{data.patterns.map(pattern => <li key={pattern.id}>{pattern.name}: {pattern.observations} completed tasks across {pattern.projects} project folders or cards · {pattern.agentCreated ? 'Role available' : 'Watching for three tasks across two projects'}</li>)}</ul> : <p>New tasks will appear here as work completes. Alpha watches task requests and completion events, not every terminal keystroke.</p>}
      <h3>Recent tasks &amp; feedback</h3>{data?.tasks.slice(-15).reverse().map(task => <TaskFeedback key={task.id} task={task} refresh={refresh} />)}
    </> : <><h2>Health &amp; responsiveness</h2><p>Observed API timings and problems. Repeated delays are surfaced with a proposed fix or redesign.</p>{health?.issues.filter(issue => issue.status === 'open').map(issue => <article className="agent-card" key={issue.id}><strong>{issue.area}</strong><p>{issue.symptom}</p><p>{issue.proposal}</p><button onClick={() => void api('/health/resolve', { id: issue.id }).then(refresh).catch(error => setError(error.message))}>Mark resolved</button></article>)}{!health?.issues.some(issue => issue.status === 'open') && <p>No open health issues.</p>}<table><thead><tr><th>Request</th><th>Time</th><th>Status</th></tr></thead><tbody>{health?.recentRequests.slice().reverse().map((request, index) => <tr key={`${request.at}:${index}`}><td>{request.route}</td><td>{(request.durationMs / 1000).toFixed(2)}s{request.slow ? ' · slow' : ''}</td><td>{request.status}</td></tr>)}</tbody></table></>}</main>
  </dialog>, document.body)
}
