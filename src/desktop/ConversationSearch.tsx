import { useEffect, useState } from 'react'
import ConversationDialog from './ConversationDialog'
import { api } from './client'
import type { ThreadMessage } from './types'

export default function ConversationSearch({ threadId, close, jump }: { threadId: string; close: () => void; jump: (messages: ThreadMessage[], id: string) => void }) {
  const [query, setQuery] = useState(''), [page, setPage] = useState(0), [result, setResult] = useState<{ matches: { id: string; role: string; excerpt: string }[]; total: number }>({ matches: [], total: 0 }), [error, setError] = useState('')
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => { void api<typeof result>(`/threads/${threadId}/search?q=${encodeURIComponent(query)}&offset=${page * 50}`).then(value => { if (current) { setResult(value); setError('') } }).catch(reason => { if (current) setError(String(reason)) }) }, 150)
    return () => { current = false; clearTimeout(timer) }
  }, [query, page, threadId])
  return <ConversationDialog title="Search this conversation" close={close}><input autoFocus aria-label="Search message text" value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} /><p>{result.total} matches in this conversation only.</p>{error && <p role="alert">{error}</p>}<div className="conversation-search-results">{result.matches.map(item => <button key={item.id} onClick={() => void api<{ messages: ThreadMessage[] }>(`/threads/${threadId}/message-context?id=${encodeURIComponent(item.id)}`).then(value => { close(); jump(value.messages, item.id) }).catch(reason => setError(String(reason)))}><strong>{item.role === 'user' ? 'You' : 'Alpha'}</strong><span>{item.excerpt}</span></button>)}</div><button disabled={!page} onClick={() => setPage(page - 1)}>Previous results</button><button disabled={(page + 1) * 50 >= result.total} onClick={() => setPage(page + 1)}>Next results</button></ConversationDialog>
}
