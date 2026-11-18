import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
export default function ConversationDialog({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  // Close and restore focus during commit, before a search jump or replacement
  // dialog takes focus after rendering. Passive cleanup can run after those actions.
  useLayoutEffect(() => { const previous = document.activeElement as HTMLElement | null; const node = dialog.current; node?.showModal(); return () => { node?.close(); const details = previous?.closest('details'); if (details && !details.open) details.querySelector('summary')?.focus(); else if (previous?.isConnected) previous.focus(); else document.querySelector<HTMLElement>('.conversation-tabs [aria-selected=true], [aria-label="New conversation"]')?.focus() } }, [])
  return createPortal(<dialog ref={dialog} className="conversation-dialog" aria-label={title} onCancel={event => { event.preventDefault(); close() }}><header><h2>{title}</h2><button aria-label={`Close ${title}`} onClick={close}>Close</button></header>{children}</dialog>, document.body)
}
