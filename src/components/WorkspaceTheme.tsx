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
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { delete root.dataset.themeSwitching }) })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); delete root.dataset.themeSwitching }
  }, [resolved, theme.id])
  return null
}
