import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspace } from '../lib/workspace'
import CategoryManager from '../components/CategoryManager'
import { api, reportError, setPreview, useDesktop } from './client'
import { Icon } from './Icons'
import McpPanel from './McpPanel'
import WorkspaceSettings from './WorkspaceSettings'
import type { Folder, Preview } from './types'

function SkillsSettings({ close }: { close: () => void }) {
  const { repo, sharedLibrary } = useDesktop()
  const [project, setProject] = useState<Folder['entries']>([])
  useEffect(() => {
    api<Folder>(`/files?path=${encodeURIComponent(`${repo}/.agents/skills`)}&mode=all`).then(folder => setProject(folder.entries.filter(entry => entry.directory))).catch(() => setProject([]))
  }, [repo])
  const open = async (path: string) => {
    try { setPreview(await api<Preview>(`/preview?path=${encodeURIComponent(path)}`)); close() }
    catch (error) { reportError(error) }
  }
  return <div className="mdi-skills-settings"><h2>Skills</h2><p>Shared skills are available across Alpha. Project skills take precedence for their project.</p><h3>Shared library</h3><div className="mdi-skill-list">{sharedLibrary?.skills.map(name => <button key={name} onClick={() => void open(`${sharedLibrary.root}/.agents/skills/${name}/SKILL.md`)}><Icon name="skills" size={15} />{name}</button>) || <p>No shared skills installed.</p>}</div><h3>This project</h3><div className="mdi-skill-list">{project.length ? project.map(entry => <button key={entry.path} onClick={() => void open(`${entry.path}/SKILL.md`)}><Icon name="skills" size={15} />{entry.name}</button>) : <p>No project skills found.</p>}</div></div>
}

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<'General' | 'MCP' | 'Categories' | 'Skills'>('General')
  const { workspace, reload } = useWorkspace()
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close() }, [])
  return createPortal(<dialog ref={dialog} className="mdi-settings-dialog" aria-label="Settings" onCancel={event => { event.preventDefault(); onClose() }}><header className="mdi-settings-header"><h1>Settings</h1><button aria-label="Close settings" onClick={onClose}><Icon name="close" size={18} /></button></header><div className="mdi-settings-main"><nav role="tablist" aria-label="Settings sections">{(['General', 'MCP', 'Categories', 'Skills'] as const).map(name => <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}</nav><div className="mdi-settings-content">{tab === 'General' && <WorkspaceSettings onClose={onClose} />}{tab === 'MCP' && <McpPanel onClose={onClose} />}{tab === 'Categories' && <div className="mdi-category-settings"><h2>Card categories</h2><p>Add, edit, or delete the categories used by Workspace cards.</p><CategoryManager embedded categories={workspace?.categories || []} entities={workspace?.entities || []} onChanged={reload} /></div>}{tab === 'Skills' && <SkillsSettings close={onClose} />}</div></div></dialog>, document.body)
}
