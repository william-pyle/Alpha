import { useEffectEvent, useLayoutEffect, useRef } from 'react'
import { onServiceEvent, sendEvent } from './client'
import type { ServiceEvent } from './types'

type TargetKind = 'project-launcher' | 'project-tab' | 'help-launcher' | 'help-tab' | 'workspace-tab' | 'conversation-layout'
export interface UiTarget {
  key: string
  kind: TargetKind
  label: string
  projectId?: string
  threadId?: string
  stepIndex?: number
  stepBinding?: { path: string; id?: string; viewer?: 'card' | 'compare3d' }
  route?: string
  documentId?: string
}

const actions = {
  'project-launcher': ['open-tab'],
  'project-tab': ['activate-tab', 'close-tab'],
  'help-launcher': ['open-tab'],
  'help-tab': ['activate-tab', 'close-tab'],
  'workspace-tab': ['activate-tab'],
  'conversation-layout': ['set-3d-view', 'set-message-panel'],
} satisfies Record<TargetKind, string[]>

type Result = 'applied' | 'stale' | 'unavailable' | 'unconfirmed'
type Verify = () => boolean
interface Command {
  requestId: string
  targetId: string
  expiresAt: number
}
type Apply = (action: string, target: UiTarget, visible: boolean | undefined, stillCurrent: () => boolean) => Result | Verify | Promise<Result | Verify>

const safeLabel = (label: string) => label.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 120) || 'Alpha view'

export function useWorkerUi(connected: boolean, targets: UiTarget[], apply: Apply) {
  const published = useRef(new Map<string, { id: string; target: UiTarget }>())
  const wire = useRef('')
  const pending = useRef<Command | null>(null)
  const recentlySeen = useRef(new Set<string>())
  const frame = useRef<number | null>(null)
  const deadline = useRef<number | null>(null)

  const receive = useEffectEvent((event: ServiceEvent) => {
    if (event.type === 'disconnected') {
      published.current.clear()
      wire.current = ''
      pending.current = null
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      if (deadline.current !== null) clearTimeout(deadline.current)
      return
    }
    if (event.type !== 'worker-ui-action' || !event.requestId || !event.targetId || !event.action || !event.expiresAt) return
    const { requestId, targetId, action, expiresAt } = event
    if (recentlySeen.current.has(requestId)) return
    recentlySeen.current.add(requestId)
    if (recentlySeen.current.size > 512) recentlySeen.current.delete(recentlySeen.current.values().next().value!)
    const reply = (status: Result) => sendEvent({ type: 'worker-ui-ack', requestId, targetId, status })
    const match = [...published.current.values()].find(entry => entry.id === targetId)
    if (!match || !(actions[match.target.kind] as string[]).includes(action)) { reply('stale'); return }
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || document.visibilityState !== 'visible' || pending.current) {
      reply('unavailable')
      return
    }
    const args = event.arguments ?? {}
    const layout = match.target.kind === 'conversation-layout'
    if (layout ? Object.keys(args).length !== 1 || typeof args.visible !== 'boolean' : Object.keys(args).length !== 0) {
      reply('unavailable')
      return
    }
    const command = pending.current = { requestId, targetId, expiresAt }
    const stillCurrent = () => pending.current === command && expiresAt > Date.now() && document.visibilityState === 'visible'
    const finish = (status: Result) => {
      if (pending.current !== command) return
      pending.current = null
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      if (deadline.current !== null) clearTimeout(deadline.current)
      frame.current = deadline.current = null
      reply(status)
    }
    deadline.current = window.setTimeout(() => finish('unconfirmed'), Math.max(0, expiresAt - Date.now() - 20))
    const verify = (result: Result | Verify) => {
      if (!stillCurrent()) { finish('unconfirmed'); return }
      if (typeof result !== 'function') { finish(result); return }
      const inspect = () => {
        if (!stillCurrent()) { finish('unconfirmed'); return }
        if (result()) finish('applied')
        else frame.current = requestAnimationFrame(inspect)
      }
      frame.current = requestAnimationFrame(inspect)
    }
    try { void Promise.resolve(apply(action, match.target, layout ? args.visible as boolean : undefined, stillCurrent)).then(verify, () => finish('unconfirmed')) }
    catch { finish('unconfirmed') }
  })

  useLayoutEffect(() => {
    const unsubscribe = onServiceEvent(event => receive(event))
    return () => {
      unsubscribe()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      if (deadline.current !== null) clearTimeout(deadline.current)
    }
  }, [])

  useLayoutEffect(() => {
    if (!connected) return
    const previous = published.current
    published.current = new Map(targets.slice(0, 128).map(target => [target.key, { id: previous.get(target.key)?.id || crypto.randomUUID(), target }]))
    const announce = () => {
      const targets = document.visibilityState === 'visible' ? [...published.current.values()].map(({ id, target }) => ({
        id, kind: target.kind, label: safeLabel(target.label),
        ...(target.projectId ? { projectId: target.projectId } : {}),
        ...(target.threadId ? { threadId: target.threadId } : {}),
        ...(target.stepIndex === undefined ? {} : { stepIndex: target.stepIndex }),
        ...(target.stepBinding ? { stepBinding: target.stepBinding } : {}),
      })) : []
      const signature = JSON.stringify(targets)
      if (signature === wire.current) return
      wire.current = signature
      sendEvent({ type: 'worker-ui-inventory', targets })
    }
    announce()
    document.addEventListener('visibilitychange', announce)
    return () => document.removeEventListener('visibilitychange', announce)
  }, [connected, targets])
}
