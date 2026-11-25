import { useEffect, useRef, useState } from 'react'
import { api, desktopState, isDesktop } from '../desktop/client'
import type { Preview } from '../desktop/types'
import MarkdownDocument, { MarkdownView } from './MarkdownDocument'
import { ZoomImage } from './ImagePreview'
import { downloadImage } from '../lib/download'
import ReportFrame from './ReportFrame'
import WorkspaceToolControls from './WorkspaceToolControls'
import type { WorkspaceEntity } from '../types'

export default function ReportViewer({ url, title, relativePath, toolProject, sharedDrive }: {
  url: string
  title: string
  relativePath: string
  toolProject?: Pick<WorkspaceEntity, 'id' | 'tools'>
  sharedDrive?: boolean
}) {
  const markdown = /\.md$/i.test(relativePath)
  const image = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(relativePath)
  const [file, setFile] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [available, setAvailable] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [sharedDriveSync, setSharedDriveSync] = useState(false)
  const [toolSelection, setToolSelection] = useState<{ query: string; ids: string[] } | null>(null)
  const reportFrame = useRef<{ element: HTMLIFrameElement; query: string } | null>(null)
  const sharedDriveFrame = useRef<{ element: HTMLIFrameElement } | null>(null)
  const reportOrigin = new URL(url, location.href).origin
  const toolsEnabled = !!toolProject?.tools?.length && /\.html?$/i.test(relativePath.split(/[?#]/, 1)[0])
  const paint = useRef(0)
  const reveal = (element: HTMLIFrameElement) => {
    cancelAnimationFrame(paint.current)
    paint.current = requestAnimationFrame(() => { paint.current = requestAnimationFrame(() => setLoaded(true)) })
    if (sharedDrive) {
      setSharedDriveSync(false)
      sharedDriveFrame.current = { element }
      element.contentWindow?.postMessage({ type: 'alpha:shared-drive-ready' }, reportOrigin)
    }
    if (!toolsEnabled) return
    const query = crypto.randomUUID()
    reportFrame.current = { element, query }
    setToolSelection(null)
    element.contentWindow?.postMessage({ type: 'alpha:report-tools-query', query }, reportOrigin)
  }
  useEffect(() => {
    if (!toolsEnabled) return
    const receiveToolSelection = (event: MessageEvent) => {
      const frame = reportFrame.current
      if (!frame?.element.isConnected || event.source !== frame.element.contentWindow || event.origin !== reportOrigin) return
      const data = event.data
      if (data?.type !== 'alpha:report-tools' || data.query !== frame.query ||
          !Array.isArray(data.ids) || data.ids.length > 20 || !data.ids.every((id: unknown) => typeof id === 'string')) return
      setToolSelection({ query: frame.query, ids: data.ids })
    }
    window.addEventListener('message', receiveToolSelection)
    return () => window.removeEventListener('message', receiveToolSelection)
  }, [reportOrigin, toolsEnabled])
  useEffect(() => {
    if (!sharedDrive) return
    const receive = (event: MessageEvent) => {
      const frame = sharedDriveFrame.current
      const message = event.data
      const [port] = event.ports
      if (!frame?.element.isConnected || frame.element.closest('[hidden]') ||
          location.hash !== '#/author-ashlyn-brooks/8' ||
          event.source !== frame.element.contentWindow || event.origin !== reportOrigin ||
          message?.type !== 'alpha:shared-drive-request' || typeof message.grant !== 'string' || !port) return
      const { requestId, action, relativePath, text, revision, rejected, choice } = message.request || {}
      if (typeof requestId !== 'string' || !requestId.length || requestId.length > 100) {
        port.close()
        return
      }
      const reply = (value: object) => {
        // The reply port belongs to the requesting document, even during iframe navigation.
        if (frame === sharedDriveFrame.current && frame.element.isConnected && !frame.element.closest('[hidden]') &&
            location.hash === '#/author-ashlyn-brooks/8') {
          port.postMessage({ requestId, ...value })
        }
        port.close()
      }
      void api('/workspace/shared-drive-original', { grant: message.grant, action, relativePath, text, revision, rejected, choice })
        .then(result => {
          if (action === 'sync-list' && frame === sharedDriveFrame.current) setSharedDriveSync(true)
          reply({ result })
        }, (error: Error & { status?: number }) => {
          reply({ error: error.status ? error.message : 'Shared Drive is unavailable.', status: error.status || 503 })
        })
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [reportOrigin, sharedDrive])
  const toolIds = toolProject?.tools?.map(tool => tool.id).filter(id => toolSelection?.ids.includes(id)) ?? []
  const notifyFinished = (id: string, success: boolean) => {
    const frame = reportFrame.current
    if (!frame?.element.isConnected || frame.query !== toolSelection?.query) return
    frame.element.contentWindow?.postMessage({ type: 'alpha:report-tool-finished', query: frame.query, id, success }, reportOrigin)
  }
  useEffect(() => {
    const controller = new AbortController()
    if (markdown && isDesktop) {
      api<Preview>(`/preview?path=${encodeURIComponent(`${desktopState().repo}/${relativePath}`)}`).then(value => { if (!controller.signal.aborted) setFile(value) }).catch(error => { if (!controller.signal.aborted) setError(String(error.message || error)) })
    } else {
      fetch(url, { method: markdown ? 'GET' : 'HEAD', signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error(`Page unavailable (${response.status}).`)
        if (controller.signal.aborted) return
        setAvailable(true)
        if (markdown) setFile({ name: title, path: relativePath, kind: 'text', size: 0, text: await response.text(), url })
      }).catch(error => { if (!controller.signal.aborted) setError(String(error.message || error)) })
    }
    return () => { controller.abort(); cancelAnimationFrame(paint.current) }
  }, [url, title, relativePath, markdown])
  if (error) return <div className="report-error"><strong>{title}</strong><p>{error}</p><a href={url} target="_blank" rel="noreferrer">Open source file</a></div>
  if (markdown) return file ? isDesktop ? <MarkdownDocument file={file} /> : <div className="markdown-reader"><MarkdownView text={file.text || ''} baseUrl={url} /></div> : <div className="report-loading">Opening document…</div>
  if (image) return <div className="report-image"><nav><span>{title}</span><a href={url} target="_blank" rel="noreferrer">Open original</a><a href={url} onClick={event => { event.preventDefault(); void downloadImage(url).catch(error => setError(error.message)) }}>Download</a></nav><ZoomImage src={url} alt={title} /></div>
  const ready = available && loaded
  return <div className="workspace-tool-layout">
    {toolProject && toolIds.length > 0 && <WorkspaceToolControls cardId={toolProject.id} toolIds={toolIds} onRunFinished={notifyFinished} launchesOnly={sharedDriveSync ? 'shared-drive-scan' : undefined} />}
    <div className="workspace-tool-body">
      <div className="report-document" aria-busy={!ready}>
        <ReportFrame url={url} title={title} className={`report-frame${ready ? ' loaded' : ''}`} sandbox={isDesktop ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads' : undefined} onLoad={reveal} onError={() => setError('This page could not be loaded.')} />
        {!ready && <div className="report-loading" role="status">Opening report…</div>}
      </div>
    </div>
  </div>
}
