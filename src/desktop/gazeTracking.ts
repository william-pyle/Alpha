export interface TrackedGaze { x: number; y: number; found: boolean }

const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value))
export const FACE_LOSS_GRACE_MS = 4500

/** Convert the front camera's unmirrored frame into the viewer's visual motion. */
export function cameraFaceToGaze(x: number, y: number): TrackedGaze {
  return { x: clamp((.5 - x) * 2, .85), y: clamp((.5 - y) * 2, .85), found: true }
}

/** Hold brief detection gaps and limit both jitter and sudden detector jumps. */
export class GazeSmoother {
  private x = 0
  private y = 0
  private lastTime = 0
  private lastDetection = 0
  private acquired = false

  update(measured: TrackedGaze, now: number): TrackedGaze {
    const dt = this.lastTime ? Math.min(.25, Math.max(0, (now - this.lastTime) / 1000)) : 0
    this.lastTime = now
    const ease = (current: number, target: number, deadband: number, tau: number, rate: number) => {
      const delta = target - current
      if (Math.abs(delta) <= deadband) return current
      const adjusted = target - Math.sign(delta) * deadband
      const step = (adjusted - current) * (1 - Math.exp(-dt / tau))
      return current + clamp(step, rate * dt)
    }
    if (!measured.found) {
      if (!this.acquired) return { x: this.x, y: this.y, found: false }
      if (now - this.lastDetection > FACE_LOSS_GRACE_MS) {
        this.x = ease(this.x, 0, .015, 2.2, .18)
        this.y = ease(this.y, 0, .015, 2.2, .18)
      }
      // Keep control of the head during a gap so its idle motion cannot
      // masquerade as a large tracking correction when a face reappears.
      return { x: this.x, y: this.y, found: true }
    }
    this.acquired = true
    this.lastDetection = now
    this.x = ease(this.x, measured.x, .04, .42, .65)
    this.y = ease(this.y, measured.y, .05, .46, .55)
    return { x: this.x, y: this.y, found: true }
  }
}
