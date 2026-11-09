import { useDesktop } from '../desktop/client'

export type ApplicationTheme = 'alpha' | 'smurfs' | 'higurashi'
export const applicationThemes = {
  alpha: { label: 'Alpha', controller: 'Alpha', icon: '/art/alpha.png', backdrop: '', background: '#08141e', foreground: '#e0f2f8', accent: '#6fe3ed' },
  smurfs: { label: 'Smurfs', controller: 'Papa Smurf', icon: '/art/smurfs.png', backdrop: '/art/smurfs-background.png', background: '#10212d', foreground: '#e6f4ff', accent: '#80caff' },
  higurashi: { label: 'Higurashi', controller: 'Rena', icon: '/art/rena.png', backdrop: '/art/rena-background.png', background: '#211b18', foreground: '#f6e8da', accent: '#efb57a' },
} as const
export function useApplicationTheme() {
  const { settings } = useDesktop()
  const id = settings.appTheme && settings.appTheme in applicationThemes ? settings.appTheme : 'alpha'
  return { id, ...applicationThemes[id] }
}
