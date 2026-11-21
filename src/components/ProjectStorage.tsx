import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, isDesktop, onServiceEvent } from '../desktop/client'
import './project-storage.css'

export type ProjectStorageStatus = 'queued' | 'scanning' | 'ready' | 'error'

export interface ProjectStorageRow {
  id: string
  status: ProjectStorageStatus
  allocatedBytes?: number
  logicalBytes?: number
  measuredAt?: string
  error?: string
  skippedLinks?: number
  errors?: number
}

type StorageContextValue = {
  rows: Map<string, ProjectStorageRow>
  loaded: boolean
  refresh: (id: string) => Promise<ProjectStorageRow>
}

const StorageContext = createContext<StorageContextValue | null>(null)
const POLL_INTERVAL_MS = 1_500

function rowTitle(row?: ProjectStorageRow) {
  if (!row || row.status === 'queued' || row.status === 'scanning') return 'Measuring size on disk…'
  if (row.status === 'error' || row.allocatedBytes === undefined) return row?.error ? `Size on disk unavailable: ${row.error}` : 'Size on disk unavailable'
  const parts = [`Size on disk: ${formatBytes(row.allocatedBytes)}`]
  if (row.logicalBytes !== undefined) parts.push(`Logical size: ${formatBytes(row.logicalBytes)}`)
  if (row.skippedLinks) parts.push(`${row.skippedLinks} link${row.skippedLinks === 1 ? '' : 's'} skipped`)
  if (row.errors) parts.push(`${row.errors} read error${row.errors === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

// Shared with the destructive-action previews in EntityControls.
// eslint-disable-next-line react-refresh/only-export-components
export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

export function ProjectStorageProvider({ projectIds, children }: { projectIds: string[]; children: ReactNode }) {
  const [rows, setRows] = useState<Map<string, ProjectStorageRow>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const mounted = useRef(true)
  const inventoryRequest = useRef<Promise<void> | null>(null)
  const refreshRequests = useRef(new Map<string, Promise<ProjectStorageRow>>())
  const pending = [...rows.values()].some(row => row.status === 'queued' || row.status === 'scanning')
  const idsKey = projectIds.join('\0')

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const load = useCallback(async () => {
    if (inventoryRequest.current) return inventoryRequest.current
    const request = api<{ projects: ProjectStorageRow[] }>('/workspace/storage').then(result => {
      if (mounted.current) { setRows(new Map(result.projects.map(row => [row.id, row]))); setLoaded(true) }
    }).finally(() => { if (inventoryRequest.current === request) inventoryRequest.current = null })
    inventoryRequest.current = request
    return request
  }, [])

  useEffect(() => {
    if (!isDesktop || !projectIds.length) return
    void load().catch(() => {
      if (mounted.current) { setRows(new Map(projectIds.map(id => [id, { id, status: 'error' as const, error: 'Measurement service unavailable' }]))); setLoaded(true) }
    })
  // Re-read the inventory when the set of project cards changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, load])

  useEffect(() => {
    if (!isDesktop) return
    const focused = () => { if (document.visibilityState !== 'hidden') void load().catch(() => undefined) }
    const visibility = () => { const next = document.visibilityState !== 'hidden'; setVisible(next); if (next) void load().catch(() => undefined) }
    window.addEventListener('focus', focused)
    window.addEventListener('alpha-workspace-changed', focused)
    document.addEventListener('visibilitychange', visibility)
    return () => { window.removeEventListener('focus', focused); window.removeEventListener('alpha-workspace-changed', focused); document.removeEventListener('visibilitychange', visibility) }
  }, [load])

  useEffect(() => {
    if (!isDesktop) return
    return onServiceEvent(event => { if (event.type === 'project-storage-changed' && document.visibilityState !== 'hidden') void load().catch(() => undefined) })
  }, [load])

  useEffect(() => {
    if (!isDesktop || !visible || !pending) return
    const timer = window.setTimeout(() => { void load().catch(() => undefined) }, POLL_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [load, pending, rows, visible])

  const refresh = useCallback((id: string) => {
    const current = refreshRequests.current.get(id)
    if (current) return current
    setRows(current => new Map(current).set(id, { id, status: 'queued' }))
    const request = api<ProjectStorageRow>(`/workspace/projects/${encodeURIComponent(id)}/storage`, {}).then(row => {
      if (mounted.current) setRows(current => new Map(current).set(id, row))
      return row
    }).catch(reason => {
      const row: ProjectStorageRow = { id, status: 'error', error: reason instanceof Error ? reason.message : String(reason) }
      if (mounted.current) setRows(current => new Map(current).set(id, row))
      throw reason
    }).finally(() => { if (refreshRequests.current.get(id) === request) refreshRequests.current.delete(id) })
    refreshRequests.current.set(id, request)
    return request
  }, [])

  const value = useMemo(() => ({ rows, loaded, refresh }), [rows, loaded, refresh])
  return <StorageContext.Provider value={value}>{children}</StorageContext.Provider>
}

// Context access belongs beside its provider; consumers should not know its polling details.
// eslint-disable-next-line react-refresh/only-export-components
export function useProjectStorage(id: string) {
  const storage = useContext(StorageContext)
  return { row: storage?.rows.get(id), loaded: storage?.loaded ?? false, refresh: storage?.refresh }
}

export function ProjectStorageSize({ id }: { id: string }) {
  const { row, loaded } = useProjectStorage(id)
  const pending = !loaded || row?.status === 'queued' || row?.status === 'scanning'
  const unavailable = loaded && (!row || row.status === 'error' || row.allocatedBytes === undefined)
  const title = rowTitle(row || (loaded ? { id, status: 'error' } : undefined))
  return <span className={`project-storage-size${pending ? ' measuring' : unavailable ? ' unavailable' : ''}`} title={title} aria-label={title}>
    {pending ? 'Measuring…' : unavailable ? 'Unavailable' : `${formatBytes(row!.allocatedBytes!)} on disk`}
  </span>
}
