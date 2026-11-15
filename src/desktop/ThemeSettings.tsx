import { useState } from 'react'
import ThemePicker from '../components/ThemePicker'
import { applicationThemes, themeChoices } from '../lib/application-theme'
import { api, useDesktop } from './client'
import type { ThemeProfile } from './types'

const icons = [{ path: '/art/alpha.png', label: 'Alpha' }, { path: '/art/smurfs.png', label: 'Smurfs' }, { path: '/art/rena.png', label: 'Rena' }]
const backdrops = [{ path: '', label: 'None' }, { path: '/art/smurfs-background.png', label: 'Smurfs' }, { path: '/art/rena-background.png', label: 'Rena' }]

export default function ThemeSettings() {
  const { settings } = useDesktop()
  const choices = themeChoices(settings)
  const [editing, setEditing] = useState(settings.appTheme || 'alpha')
  const [draft, setDraft] = useState<ThemeProfile>({ ...choices[settings.appTheme || 'alpha'] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const select = (id: string) => {
    setEditing(id); setError(''); setMessage('')
    setDraft(id === 'new' ? { ...choices[settings.appTheme || 'alpha'], id: '', label: 'My theme', controller: 'Alpha' } : { ...choices[id] })
  }
  const field = (name: keyof ThemeProfile, value: string) => setDraft(current => ({ ...current, [name]: value }))
  const action = async (name: 'create' | 'save' | 'delete' | 'reset') => {
    setBusy(true); setError(''); setMessage('')
    try {
      const updated = await api<{ appTheme: string; themeProfiles: ThemeProfile[] }>('/themes', { ...draft, id: editing, action: name })
      if (name === 'create') { setEditing(updated.appTheme); setDraft(updated.themeProfiles.find(item => item.id === updated.appTheme)!) }
      if (name === 'delete' || name === 'reset') { const next = name === 'delete' ? 'alpha' : editing; setEditing(next); setDraft(name === 'delete' ? { ...applicationThemes.alpha, id: 'alpha' } : { ...applicationThemes[next as keyof typeof applicationThemes], id: next }) }
      setMessage(name === 'delete' ? 'Theme deleted.' : name === 'reset' ? 'Built-in theme restored.' : 'Theme saved.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const modifiedBuiltIn = !!settings.themeProfiles?.some(item => item.id === editing) && editing in applicationThemes
  return <div className="settings-scroll theme-settings"><section><h3>Theme</h3><ThemePicker /></section>
    <section><h3>Edit or create a theme</h3><label>Theme to edit<select aria-label="Theme to edit" value={editing} onChange={event => select(event.target.value)}>
      {Object.values(choices).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="new">Create new theme…</option>
    </select></label>
      <div className="theme-editor-grid"><label>Name<input aria-label="Theme name" maxLength={48} value={draft.label} onChange={event => field('label', event.target.value)} /></label>
        <label>Voice persona name<input aria-label="Voice persona name" maxLength={48} value={draft.controller} onChange={event => field('controller', event.target.value)} /></label>
        <label>Background color<input aria-label="Background color" type="color" value={draft.background} onChange={event => field('background', event.target.value)} /></label>
        <label>Text color<input aria-label="Text color" type="color" value={draft.foreground} onChange={event => field('foreground', event.target.value)} /></label>
        <label>Accent color<input aria-label="Accent color" type="color" value={draft.accent} onChange={event => field('accent', event.target.value)} /></label>
        <label>Icon artwork<select aria-label="Icon artwork" value={draft.icon} onChange={event => field('icon', event.target.value)}>{icons.map(item => <option key={item.path} value={item.path}>{item.label}</option>)}</select></label>
        <label>Background artwork<select aria-label="Background artwork" value={draft.backdrop} onChange={event => field('backdrop', event.target.value)}>{backdrops.map(item => <option key={item.path} value={item.path}>{item.label}</option>)}</select></label>
      </div>
      <div className="theme-editor-preview" style={{ backgroundColor: draft.background, color: draft.foreground, borderColor: draft.accent }}><img src={draft.icon} alt="" /><span><strong>{draft.label || 'Theme preview'}</strong><small style={{ color: draft.accent }}>Accent and artwork preview</small></span></div>
      <div className="alpha-update-actions"><button className="desk-primary" disabled={busy || !draft.label.trim() || !draft.controller.trim()} onClick={() => void action(editing === 'new' ? 'create' : 'save')}>{editing === 'new' ? 'Create theme' : 'Save theme'}</button>
        {modifiedBuiltIn && <button className="desk-secondary" disabled={busy} onClick={() => void action('reset')}>Restore built-in</button>}
        {editing.startsWith('custom-') && <button className="desk-secondary" disabled={busy} onClick={() => void action('delete')}>Delete theme</button>}
      </div>
      <p>Colors shape the dark palette and a matching light palette. Changes apply to Workspace, Chats, and the Alpha voice persona. Artwork can use the images bundled with Alpha.</p>
      {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    </section>
  </div>
}
