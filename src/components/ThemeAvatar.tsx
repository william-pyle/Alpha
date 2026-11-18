import { useApplicationTheme } from '../lib/application-theme'

/** Optional persona artwork, never the application/window identity. */
export default function ThemeAvatar({ size = 35 }: { size?: number }) {
  const theme = useApplicationTheme()
  return <img className="mak-logo theme-avatar" src={theme.icon} width={size} height={size} alt="" aria-hidden="true" draggable={false} style={{ display: 'block', flexShrink: 0, objectFit: 'contain' }} />
}
