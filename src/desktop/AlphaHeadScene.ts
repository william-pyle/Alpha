import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { AlphaCircuitBackdrop } from './AlphaCircuitBackdrop'

type Gaze = { x: number; y: number; found: boolean }
const clamp = THREE.MathUtils.clamp

/** The generated GLB is the face; board and neural activity are scene geometry. */
export class AlphaHeadScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(34, 1, .1, 30)
  private head = new THREE.Group()
  private backdrop: AlphaCircuitBackdrop
  private neurons: { mesh: THREE.Mesh; phase: number; base: number }[] = []
  private jawMeshes: THREE.Mesh[] = []
  private mouth: THREE.Mesh | null = null
  private lowerLip: THREE.Mesh | null = null
  private observer: ResizeObserver
  private frame = 0
  private start = performance.now()
  private gaze: Gaze = { x: 0, y: 0, found: false }
  private work = false
  private audio = 0
  private manualUntil = 0
  private drag: { x: number; y: number } | null = null
  private manual = { x: 0, y: 0 }
  private disposed = false
  private colorMap: THREE.Texture

  constructor(private host: HTMLElement, private onLoadError: () => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.02
    this.renderer.domElement.setAttribute('aria-hidden', 'true')
    this.host.appendChild(this.renderer.domElement)
    this.scene.background = new THREE.Color(0x03111f)
    this.camera.position.set(0, .02, 6.2)
    this.camera.lookAt(0, 0, 0)
    this.scene.add(new THREE.AmbientLight(0x9bdcf6, .7))
    const key = new THREE.PointLight(0xb3efff, 9, 9); key.position.set(-2, 2, 3); this.scene.add(key)
    const fill = new THREE.PointLight(0x2369c8, 5, 9); fill.position.set(2, -.1, 2.4); this.scene.add(fill)
    const rim = new THREE.PointLight(0x55dfff, 9, 9); rim.position.set(.5, .8, -1.6); this.scene.add(rim)
    this.backdrop = new AlphaCircuitBackdrop(this.scene)
    this.scene.add(this.head)
    this.colorMap = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}models/alpha-head/color.jpg`)
    this.colorMap.colorSpace = THREE.SRGBColorSpace
    this.colorMap.flipY = false
    new GLTFLoader().load(`${import.meta.env.BASE_URL}models/alpha-head/alpha-android.glb`, gltf => {
      if (this.disposed) { this.disposeObject(gltf.scene); return }
      const model = gltf.scene
      const bounds = new THREE.Box3().setFromObject(model)
      const size = bounds.getSize(new THREE.Vector3())
      const center = bounds.getCenter(new THREE.Vector3())
      const scale = 1.9 / Math.max(size.x, size.y)
      model.position.copy(center.clone().multiplyScalar(-1))
      model.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return
        this.addJawMorph(object)
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) {
          if (!(material instanceof THREE.MeshStandardMaterial)) continue
          material.map = this.colorMap
          material.color.set(0xffffff)
          material.roughness = .62
          material.metalness = .12
          material.metalnessMap = null
          material.roughnessMap = null
          material.needsUpdate = true
        }
      })
      const facing = new THREE.Group()
      facing.rotation.y = -Math.PI / 2
      facing.scale.setScalar(scale)
      facing.add(model)
      this.head.add(facing)
      this.addNeurons(model, center, scale)
      this.addMouth()
      this.host.dataset.modelReady = 'true'
    }, undefined, () => { if (!this.disposed) { this.host.dataset.modelReady = 'error'; this.onLoadError() } })
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    this.resize()
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown)
    window.addEventListener('pointerup', this.pointerUp)
    window.addEventListener('pointermove', this.pointerMove)
    this.animate()
  }

  private addNeurons(model: THREE.Object3D, center: THREE.Vector3, scale: number) {
    // Use the actual surface of the generated cranial mesh. The brightest
    // vertex in each projected cell keeps the firing point above the plating.
    const surface = new Map<string, THREE.Vector3>()
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      const positions = object.geometry.getAttribute('position')
      if (!positions) return
      for (let i = 0; i < positions.count; i++) {
        const x = -(positions.getZ(i) - center.z) * scale
        const y = (positions.getY(i) - center.y) * scale
        const z = (positions.getX(i) - center.x) * scale
        if (Math.abs(x) > .65 || y < .43 || y > .95 || z < .25) continue
        const key = `${Math.floor((x + .65) / .095)}:${Math.floor((y - .43) / .095)}`
        if (!surface.has(key) || surface.get(key)!.z < z) surface.set(key, new THREE.Vector3(x, y, z + .022))
      }
    })
    const points = [...surface.values()].sort((a, b) => Math.sin(a.x * 71 + a.y * 163) - Math.sin(b.x * 71 + b.y * 163))
    for (let i = 0; i < Math.min(42, points.length); i++) {
      const material = new THREE.MeshBasicMaterial({ color: i % 9 === 0 ? 0xffd080 : 0x69ddff, transparent: true, opacity: .12, depthWrite: false })
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(i % 9 === 0 ? .017 : .010, 8, 6), material)
      mesh.position.copy(points[i])
      this.head.add(mesh)
      this.neurons.push({ mesh, phase: i * 1.79, base: i % 9 === 0 ? .12 : .08 })
    }
  }
  private addMouth() {
    const cavity = new THREE.MeshBasicMaterial({ color: 0x061a2e, transparent: true, opacity: 0, depthWrite: false })
    const lip = new THREE.MeshPhysicalMaterial({ color: 0x2d8ba8, metalness: .45, roughness: .34, transparent: true, opacity: 0 })
    this.mouth = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), cavity)
    this.mouth.position.set(0, -.405, .84)
    this.mouth.scale.set(.18, .002, .012)
    this.lowerLip = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 12), lip)
    this.lowerLip.position.set(0, -.422, .845)
    this.lowerLip.scale.set(.19, .011, .014)
    this.head.add(this.mouth, this.lowerLip)
  }
  private addJawMorph(mesh: THREE.Mesh) {
    const geometry = mesh.geometry
    const positions = geometry.getAttribute('position')
    if (!positions) return
    const changes = new Float32Array(positions.count * 3)
    for (let i = 0; i < positions.count; i++) {
      // The GLB's face points along +X. Ease the lower face downward while
      // holding the upper lip and skull fixed.
      const forward = clamp((positions.getX(i) - .19) / .22, 0, 1)
      const lower = clamp((-.13 - positions.getY(i)) / .19, 0, 1)
      const center = 1 - clamp((Math.abs(positions.getZ(i)) - .13) / .21, 0, 1)
      changes[i * 3 + 1] = -.046 * forward * lower * center
    }
    geometry.morphTargetsRelative = true
    geometry.morphAttributes.position = [new THREE.BufferAttribute(changes, 3)]
    mesh.updateMorphTargets()
    this.jawMeshes.push(mesh)
  }
  setGaze(gaze: Gaze) { this.gaze = gaze }
  setWorking(working: boolean) { this.work = working }
  setAudioLevel(level: number) { this.audio = clamp(level, 0, 1) }
  private pointerDown = (event: PointerEvent) => { this.drag = { x: event.clientX, y: event.clientY }; this.manualUntil = performance.now() + 6000; this.renderer.domElement.style.cursor = 'grabbing' }
  private pointerUp = () => { this.drag = null; this.renderer.domElement.style.cursor = 'grab' }
  private pointerMove = (event: PointerEvent) => {
    if (!this.drag) return
    this.manual.x = clamp(this.manual.x + (event.clientX - this.drag.x) * .006, -.48, .48)
    this.manual.y = clamp(this.manual.y + (event.clientY - this.drag.y) * .004, -.25, .25)
    this.drag = { x: event.clientX, y: event.clientY }
    this.manualUntil = performance.now() + 6000
  }
  private resize() {
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.position.z = Math.max(5.1, 2.45 / (2 * Math.tan(THREE.MathUtils.degToRad(17)) * this.camera.aspect))
    this.camera.updateProjectionMatrix()
  }
  private animate = () => {
    const now = performance.now(), t = (now - this.start) / 1000
    const manual = now < this.manualUntil
    const targetY = manual ? this.manual.x : this.gaze.found ? this.gaze.x * .22 : Math.sin(t * .32) * .06
    const targetX = manual ? this.manual.y : this.gaze.found ? -this.gaze.y * .14 : Math.sin(t * .27) * .025
    this.head.rotation.y += (targetY - this.head.rotation.y) * .065
    this.head.rotation.x += (targetX - this.head.rotation.x) * .065
    this.head.position.y = Math.sin(t * 1.1) * .006
    const opening = this.audio > .025 ? Math.pow(this.audio, .66) * .12 : 0
    for (const mesh of this.jawMeshes) {
      const influences = mesh.morphTargetInfluences
      if (influences) influences[0] += ((opening / .12) - influences[0]) * .38
    }
    if (this.mouth) this.mouth.scale.y += ((.002 + opening) - this.mouth.scale.y) * .38
    if (this.lowerLip) this.lowerLip.position.y += ((-.422 - opening * .52) - this.lowerLip.position.y) * .33
    if (this.mouth) (this.mouth.material as THREE.MeshBasicMaterial).opacity = Math.min(.9, opening * 8)
    if (this.lowerLip) (this.lowerLip.material as THREE.MeshPhysicalMaterial).opacity = Math.min(.85, opening * 8)
    for (const { mesh, phase, base } of this.neurons) {
      const flicker = Math.pow(Math.max(0, Math.sin(t * (this.work ? 5.4 : 2.0) + phase)), this.work ? 4 : 10)
      ;(mesh.material as THREE.MeshBasicMaterial).opacity = base + flicker * (this.work ? .8 : .2)
    }
    this.backdrop.update(t, this.work)
    this.renderer.render(this.scene, this.camera)
    this.frame = requestAnimationFrame(this.animate)
  }
  private disposeObject(root: THREE.Object3D) {
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) {
        if (material instanceof THREE.MeshStandardMaterial && material.map !== this.colorMap) material.map?.dispose()
        material.dispose()
      }
    })
  }
  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown)
    window.removeEventListener('pointerup', this.pointerUp)
    window.removeEventListener('pointermove', this.pointerMove)
    this.backdrop.dispose()
    this.disposeObject(this.head)
    this.colorMap.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
