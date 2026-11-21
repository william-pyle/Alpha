import { useState } from 'react'
import { api, reportError } from './client'
import ConversationDialog from './ConversationDialog'

export default function DeleteConversationDialog({ conversation, close, deleted }: { conversation: { id: string; name: string }; close: () => void; deleted?: () => void }) {
  const [busy, setBusy] = useState(false)
  return <ConversationDialog title="Delete conversation" close={() => { if (!busy) close() }}>
    <p>Permanently delete <strong>{conversation.name}</strong> from Alpha?</p>
    <p>This removes its Alpha messages, draft, History entry, local worker records and conversation-linked Questions or notices. This cannot be undone.</p>
    <p>Copies you explicitly shared in other conversations remain in those conversations.</p>
    <p>Files you attached or saved in Workspace remain available.</p>
    <p>Any Codex, Claude or other provider-native transcript remains in that provider's own history. Alpha does not delete provider-native history.</p>
    <p>Alpha will refuse deletion while this conversation has running workers, active work or pending Questions; it will not stop or discard them for you.</p>
    <button disabled={busy} onClick={() => {
      setBusy(true)
      void api(`/threads/${conversation.id}/delete`, {}, 'DELETE').then(() => { deleted?.(); close() }).catch(reportError).finally(() => setBusy(false))
    }}>Delete from Alpha</button>
    <button disabled={busy} onClick={close}>Cancel</button>
  </ConversationDialog>
}
