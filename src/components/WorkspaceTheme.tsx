import { useLayoutEffect } from 'react'
import { useApplicationTheme } from '../lib/application-theme'
import { useWorkspaceTheme } from '../lib/workspace-theme'

export default function WorkspaceTheme() {
  const { resolved } = useWorkspaceTheme()
  const theme = useApplicationTheme()
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.themeSwitching = ''
    root.dataset.workspaceTheme = resolved
    root.dataset.alphaTheme = theme.id
    const mix = (left: string, right: string, fraction: number) => {
      const channel = (value: string, offset: number) => parseInt(value.slice(offset, offset + 2), 16)
      return '#' + [1, 3, 5].map(offset => Math.round(channel(left, offset) * (1 - fraction) + channel(right, offset) * fraction).toString(16).padStart(2, '0')).join('')
    }
    const variables: Record<string, string> = theme.modified ? resolved === 'dark' ? {
      '--bg': theme.background, '--bg-deep': mix(theme.background, '#000000', .3),
      '--surface-1': mix(theme.background, '#ffffff', .07), '--surface-2': mix(theme.background, '#ffffff', .11),
      '--surface-3': mix(theme.background, '#ffffff', .16),
      '--surface-solid': mix(theme.background, '#ffffff', .09), '--sidebar-glass': mix(theme.background, '#ffffff', .04),
      '--topbar-glass': mix(theme.background, '#ffffff', .05) + 'f2', '--text': theme.foreground,
      '--text-bright': mix(theme.foreground, '#ffffff', .35), '--text-dim': mix(theme.foreground, theme.background, .25),
      '--text-muted': mix(theme.foreground, theme.background, .42), '--pink': theme.accent,
      '--pink-bright': mix(theme.accent, '#ffffff', .32), '--purple': mix(theme.accent, theme.foreground, .35),
      '--blue': mix(theme.accent, '#ffffff', .2), '--pink-dim': theme.accent + '19',
      '--purple-dim': theme.accent + '14', '--hairline': theme.foreground + '23',
      '--hairline-strong': theme.foreground + '43', '--alpha-backdrop': theme.backdrop ? `url('${theme.backdrop}')` : 'none',
      '--alpha-shade': theme.background + 'e8',
    } : {
      '--bg': mix(theme.background, '#ffffff', .91), '--bg-deep': mix(theme.background, '#ffffff', .84),
      '--surface-1': '#ffffff', '--surface-2': mix(theme.background, '#ffffff', .88),
      '--surface-3': mix(theme.background, '#ffffff', .81), '--surface-solid': '#ffffff',
      '--sidebar-glass': mix(theme.background, '#ffffff', .87), '--topbar-glass': '#fffffff2',
      '--text': mix(theme.foreground, '#000000', .82), '--text-bright': mix(theme.foreground, '#000000', .9),
      '--text-dim': mix(theme.foreground, '#000000', .65), '--text-muted': mix(theme.foreground, '#000000', .55),
      '--pink': mix(theme.accent, '#000000', .43), '--pink-bright': mix(theme.accent, '#000000', .6),
      '--pink-dim': theme.accent + '19', '--alpha-backdrop': theme.backdrop ? `url('${theme.backdrop}')` : 'none',
      '--alpha-shade': '#ffffffd9',
    } : {}
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value)
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { delete root.dataset.themeSwitching }) })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); for (const name of Object.keys(variables)) root.style.removeProperty(name); delete root.dataset.themeSwitching }
  }, [resolved, theme.id, theme.modified, theme.background, theme.foreground, theme.accent, theme.backdrop])
  return null
}
