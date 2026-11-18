import { useEffect, useState } from 'react'
import ConversationDialog from './ConversationDialog'
import { reportError, selectThread, useDesktop } from './client'
import { useWorkspace } from '../lib/workspace'

export default function QuickSwitcher({ close, command }: { close: () => void; command: (id: string) => void }) {
  const state = useDesktop(), { workspace } = useWorkspace()
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0)
  const choices = [
    ...state.threads.map(t => ({ id: `thread:${t.id}`, label: t.name, detail: `Conversation · ${t.projectId || 'Unassigned'} · ${t.purpose || ''}`, run: async () => { await selectThread(t.id); command('conversation') } })),
    ...(workspace?.entities || []).map(p => ({ id: `project:${p.id}`, label: p.title, detail: `Project · ${p.category || ''}`, run: () => { location.hash = `#/${encodeURIComponent(p.id)}/0`; command('show-workspace') } })),
    ...[['conversation-history', 'Conversation history'], ['new-conversation', 'New conversation'], ['important-events', 'Important events'], ['learned-preferences', "What I've learned"], ['workspace', 'Workspace'], ['questions', 'Questions'], ['settings', 'Settings'], ['search-conversation', 'Search this conversation'], ['work-details', 'Work details'], ['health', 'Alpha health']].map(([id, label]) => ({ id, label, detail: 'Command', run: () => command(id) })),
  ].filter(item => `${item.label} ${item.detail}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const selected = Math.min(index, Math.max(0, choices.length - 1))
  useEffect(() => { document.getElementById(`quick-${selected}`)?.scrollIntoView({ block: 'nearest' }) }, [selected, query])
  const choose = async (i: number) => { const item = choices[i]; if (!item) return; try { await item.run(); close() } catch (error) { reportError(error) } }
  return <ConversationDialog title="Quick switcher" close={close}><div className="quick-switcher" onKeyDown={event => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setIndex(event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (selected + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % Math.max(1, choices.length)) }
    if (event.key === 'Enter') { event.preventDefault(); void choose(selected) }
  }}><input autoFocus role="combobox" aria-label="Find project, conversation or command" aria-expanded="true" aria-controls="quick-options" aria-activedescendant={choices.length ? `quick-${selected}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setIndex(0) }} /><div id="quick-options" role="listbox">{choices.map((item, i) => <button tabIndex={-1} role="option" aria-selected={i === selected} id={`quick-${i}`} key={item.id} onClick={() => void choose(i)}><strong>{item.label}</strong><small>{item.detail}</small></button>)}</div>{!choices.length && <p>No matches.</p>}</div></ConversationDialog>
}
