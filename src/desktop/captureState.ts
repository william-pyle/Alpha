// Session-only consent: never restore a microphone or camera request from disk.
let state = { camera: false, cameraStatus: '', error: '' }
const listeners = new Set<() => void>()
export const captureState = {
  snapshot: () => state,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  set: (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()) },
}
