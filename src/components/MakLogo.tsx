/** Fixed application identity. Theme/persona artwork is deliberately separate. */
export default function MakLogo({ size = 64 }: { size?: number; animated?: boolean; tone?: 'pink' | 'black' }) {
  return <img className="mak-logo app-identity" src="/identity/alpha.svg" width={size} height={size} alt="" aria-hidden="true" draggable={false} style={{ display: 'block', flexShrink: 0, objectFit: 'contain' }} />
}
