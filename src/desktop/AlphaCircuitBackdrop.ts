import * as THREE from 'three'

const ice = 0x8aeaff
const cyan = 0x47ccf3
const steel = 0x163c5b

type DataPulse = { dot: THREE.Mesh; route: THREE.CatmullRomCurve3; offset: number; speed: number }

function circuit(parent: THREE.Object3D, points: [number, number, number][], brightness = .45) {
  const route = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, 'catmullrom', .12)
  const wire = new THREE.Mesh(
    new THREE.TubeGeometry(route, Math.max(24, points.length * 9), .004, 5, false),
    new THREE.MeshBasicMaterial({ color: cyan, transparent: true, opacity: brightness, depthWrite: false }),
  )
  parent.add(wire)
  return route
}

function chip(parent: THREE.Object3D, x: number, y: number, size: number) {
  const group = new THREE.Group()
  group.position.set(x, y, -1.45)
  const shell = new THREE.MeshStandardMaterial({ color: 0x061e33, metalness: .8, roughness: .35 })
  const glow = new THREE.MeshBasicMaterial({ color: 0x71dfff, transparent: true, opacity: .55 })
  const base = new THREE.Mesh(new THREE.BoxGeometry(size, size * .68, .085), shell)
  group.add(base)
  const die = new THREE.Mesh(new THREE.BoxGeometry(size * .55, size * .35, .009), glow)
  die.position.z = .053
  group.add(die)
  for (const side of [-1, 1]) {
    for (let i = -2; i <= 2; i++) {
      const pin = new THREE.Mesh(new THREE.BoxGeometry(.038, .009, .013), glow)
      pin.position.set(side * (size * .55), i * size * .10, .008)
      group.add(pin)
    }
  }
  parent.add(group)
}

/** A spatial circuit-board environment with data moving into the skull. */
export class AlphaCircuitBackdrop {
  private root = new THREE.Group()
  private pulses: DataPulse[] = []
  private chips: THREE.Object3D[] = []

  constructor(scene: THREE.Scene) {
    scene.add(this.root)
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 5.4),
      new THREE.MeshBasicMaterial({ color: 0x041526, side: THREE.DoubleSide }),
    )
    board.position.z = -2
    this.root.add(board)
    const grid = new THREE.MeshBasicMaterial({ color: steel, transparent: true, opacity: .25, depthWrite: false })
    for (let x = -2; x <= 2.01; x += .16) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(.0016, 5.2, .001), grid)
      line.position.set(x, 0, -1.96)
      this.root.add(line)
    }
    for (let y = -2.5; y <= 2.51; y += .16) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(4, .0016, .001), grid)
      line.position.set(0, y, -1.96)
      this.root.add(line)
    }

    const chipPositions: [number, number, number][] = [
      [-1.18, 1.27, .25], [1.19, 1.15, .24], [-1.30, -.55, .32], [1.30, -.50, .31],
      [-.88, -1.68, .27], [.91, -1.64, .27], [0, 1.76, .36],
    ]
    for (const [x, y, size] of chipPositions) {
      chip(this.root, x, y, size)
      this.chips.push(this.root.children[this.root.children.length - 1])
    }
    const pale = new THREE.MeshBasicMaterial({ color: ice, transparent: true, opacity: .7, depthWrite: false })
    for (const side of [-1, 1]) {
      for (let lane = 0; lane < 6; lane++) {
        const y = 1.45 - lane * .49
        const edge = side * (1.95 - lane % 2 * .13)
        const inner = side * (.82 + lane % 3 * .06)
        const route = circuit(this.root, [
          [edge, y + .20, -1.84], [edge, y, -1.80],
          [side * 1.36, y, -1.68], [side * 1.22, y - .11, -1.50],
          [inner, y - .11, -1.23], [side * .55, y - .10, -.72],
        ], lane % 3 === 0 ? .75 : .38)
        const dot = new THREE.Mesh(new THREE.SphereGeometry(lane % 3 === 0 ? .018 : .012, 10, 8), pale.clone())
        this.root.add(dot)
        this.pulses.push({ dot, route, offset: (lane / 6 + (side + 1) * .29) % 1, speed: .11 + lane * .011 })
      }
    }
    for (let lane = 0; lane < 5; lane++) {
      const x = (lane - 2) * .32
      const route = circuit(this.root, [
        [x, 2.5, -1.84], [x, 1.82, -1.74], [x * .7, 1.48, -1.49],
        [x * .6, 1.18, -1.19], [x * .4, .86, -.78],
      ], .37)
      const dot = new THREE.Mesh(new THREE.SphereGeometry(.012, 10, 8), pale.clone())
      this.root.add(dot)
      this.pulses.push({ dot, route, offset: lane * .19, speed: .13 })
    }
    for (const [x, y] of [[-1.7, 1.95], [1.7, 1.95], [-1.7, -1.95], [1.7, -1.95]]) {
      const frame = new THREE.Mesh(new THREE.TorusGeometry(.10, .003, 4, 24), new THREE.MeshBasicMaterial({ color: cyan, transparent: true, opacity: .32 }))
      frame.position.set(x, y, -1.79)
      this.root.add(frame)
    }
  }

  update(time: number, working: boolean) {
    for (const pulse of this.pulses) {
      pulse.dot.position.copy(pulse.route.getPoint((time * pulse.speed * (working ? 2.1 : 1) + pulse.offset) % 1))
      ;(pulse.dot.material as THREE.MeshBasicMaterial).opacity = working ? .95 : .48
    }
    for (let i = 0; i < this.chips.length; i++) {
      const die = (this.chips[i] as THREE.Group).children[1] as THREE.Mesh
      ;(die.material as THREE.MeshBasicMaterial).opacity = (working ? .56 : .30) + Math.sin(time * (working ? 3 : 1.25) + i * 1.7) * (working ? .28 : .10)
    }
  }

  dispose() {
    this.root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      materials.forEach(material => material.dispose())
    })
    this.root.removeFromParent()
  }
}
