export interface TrackedGaze { x: number; y: number; found: boolean }

const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value))

/** Convert the front camera's unmirrored frame into the viewer's visual motion. */
export function cameraFaceToGaze(x: number, y: number): TrackedGaze {
  return { x: clamp((.5 - x) * 2, 1), y: clamp((.5 - y) * 2, 1), found: true }
}

/** Hold tiny detector changes and ease real motion without accumulating drift. */
export class GazeSmoother {
  private x = 0
  private y = 0
  private lastTime = 0
  private acquired = false

  update(measured: TrackedGaze, now: number): TrackedGaze {
    if (!measured.found) { this.acquired = false; this.lastTime = 0; return { x: this.x, y: this.y, found: false } }
    if (!this.acquired) {
      this.acquired = true
      this.lastTime = now
      this.x = measured.x
      this.y = measured.y
      return { x: this.x, y: this.y, found: true }
    }
    const dt = Math.min(.25, Math.max(.016, (now - this.lastTime) / 1000))
    this.lastTime = now
    const ease = (current: number, target: number, deadband: number) => {
      const delta = target - current
      if (Math.abs(delta) <= deadband) return current
      const adjusted = target - Math.sign(delta) * deadband
      const tau = Math.abs(delta) > .35 ? .14 : .30
      return current + (adjusted - current) * (1 - Math.exp(-dt / tau))
    }
    this.x = ease(this.x, measured.x, .035)
    this.y = ease(this.y, measured.y, .045)
    return { x: this.x, y: this.y, found: true }
  }
}
