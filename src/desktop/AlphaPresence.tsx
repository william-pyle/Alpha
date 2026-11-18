import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FilesetResolver, FaceDetector } from '@mediapipe/tasks-vision'
import { AlphaHeadScene } from './AlphaHeadScene'
import { captureState } from './captureState'
import { liveVoice } from './live'
import { useDesktop } from './client'
import { cameraFaceToGaze, FACE_LOSS_GRACE_MS, GazeSmoother } from './gazeTracking'

type CameraState = 'starting' | 'tracking' | 'searching' | 'blocked' | 'unavailable'

export default function AlphaPresence() {
  const desktop = useDesktop()
  const capture = useSyncExternalStore(captureState.subscribe, captureState.snapshot)
  const host = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const cameraStream = useRef<MediaStream | null>(null)
  const stopCamera = useCallback(() => {
    cameraStream.current?.getTracks().forEach(track => track.stop())
    cameraStream.current = null
    if (video.current) { video.current.pause(); video.current.srcObject = null }
  }, [])
  const scene = useRef<AlphaHeadScene | null>(null)
  const [camera, setCamera] = useState<CameraState>('starting')
  const [cameraError, setCameraError] = useState('')
  const [modelError, setModelError] = useState('')
  const cameraEnabled = capture.camera
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')
  const working = desktop.threads.find(item => item.id === desktop.selectedThreadId)?.status === 'working'
  const speech = useRef(desktop.speech)
  const selected = useRef(desktop.selectedThreadId)
  useEffect(() => { speech.current = desktop.speech; selected.current = desktop.selectedThreadId }, [desktop.speech, desktop.selectedThreadId])

  useEffect(() => {
    if (!host.current) return
    try { scene.current = new AlphaHeadScene(host.current, () => setModelError('The 3D model could not load. Restart Alpha to retry.')) }
    catch { requestAnimationFrame(() => setCameraError('The 3D renderer could not start on this graphics device.')); return }
    return () => { scene.current?.dispose(); scene.current = null }
  }, [])
  useEffect(() => { scene.current?.setReducedMotion(desktop.settings.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches) }, [desktop.settings.reducedMotion])
  useEffect(() => { scene.current?.setWorking(working) }, [working])
  useEffect(() => {
    const visibility = () => { if (document.visibilityState !== 'visible') { stopCamera(); captureState.set({ camera: false }) }; setPageVisible(document.visibilityState === 'visible') }
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [stopCamera])
  useEffect(() => {
    let frame = 0
    const update = () => {
      const current = speech.current
      const windowsLevel = current.speaking && current.threadId === selected.current && Date.now() - (current.levelAt || 0) < (current.durationMs || 150) + 100 ? current.level || 0 : 0
      scene.current?.setAudioLevel(Math.max(liveVoice.outputLevel(), windowsLevel)); frame = requestAnimationFrame(update)
    }
    update()
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    if (!cameraEnabled || !pageVisible) { scene.current?.setGaze({ x: 0, y: 0, found: false }); return }
    let cancelled = false, frame = 0, stream: MediaStream | null = null, detector: FaceDetector | null = null
    let lastScan = 0, lastSeen = 0
    const gaze = new GazeSmoother()
    const cameraVideo = video.current
    const start = async () => {
      setCamera('starting'); setCameraError('')
      try {
        if (!navigator.mediaDevices?.getUserMedia || !cameraVideo) { setCamera('unavailable'); return }
        // Tab visibility controls the stream lifetime. Camera frames are only
        // passed to the bundled, local face detector and never reach the service.
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 } }, audio: false })
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return }
        cameraStream.current = stream
        cameraVideo.srcObject = stream
        await cameraVideo.play()
        const base = `${import.meta.env.BASE_URL}models/face-detector/`
        const fileset = await FilesetResolver.forVisionTasks(`${base}wasm`)
        detector = await FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: `${base}blaze_face_short_range.tflite`, delegate: 'CPU' }, runningMode: 'VIDEO', minDetectionConfidence: .55 })
        if (cancelled) { try { detector.close() } catch { /* Capture already stopped. */ } return }
        setCamera('searching')
        const scan = (now: number) => {
          if (cancelled || !detector) return
          if (cameraVideo.readyState >= 2 && now - lastScan > 80) {
            lastScan = now
            try {
              const faces = detector.detectForVideo(cameraVideo, now).detections
              const box = faces[0]?.boundingBox
              const x = box ? (box.originX + box.width / 2) / cameraVideo.videoWidth : NaN
              const y = box ? (box.originY + box.height / 2) / cameraVideo.videoHeight : NaN
              if (Number.isFinite(x) && Number.isFinite(y)) {
                scene.current?.setGaze(gaze.update(cameraFaceToGaze(x, y), now))
                lastSeen = now
                setCamera(current => current === 'tracking' ? current : 'tracking')
              } else {
                scene.current?.setGaze(gaze.update({ x: 0, y: 0, found: false }, now))
                if (lastSeen && now - lastSeen > FACE_LOSS_GRACE_MS) {
                  setCamera(current => current === 'searching' ? current : 'searching')
                }
              }
            } catch { /* A dropped or changing camera frame can be skipped. */ }
          }
          frame = requestAnimationFrame(scan)
        }
        frame = requestAnimationFrame(scan)
      } catch (error) {
        if (cancelled) return
        stream?.getTracks().forEach(track => track.stop())
        if (cameraVideo) { cameraVideo.pause(); cameraVideo.srcObject = null }
        const name = error instanceof DOMException ? error.name : ''
        setCamera(name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'blocked' : 'unavailable')
        setCameraError(error instanceof Error ? error.message : String(error))
      }
    }
    void start()
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      // Releasing capture must not depend on a WASM detector's teardown.
      stream?.getTracks().forEach(track => track.stop())
      stopCamera()
      if (cameraVideo) { cameraVideo.pause(); cameraVideo.srcObject = null }
      try { detector?.close() } catch { /* Camera is off even if inference cleanup fails. */ }
      scene.current?.setGaze({ x: 0, y: 0, found: false })
    }
  }, [cameraEnabled, pageVisible, stopCamera])

  useEffect(() => { captureState.set({ cameraStatus: camera === 'tracking' ? 'Camera active' : `Camera ${camera}`, error: cameraError || modelError }) }, [camera, cameraError, modelError])
  useEffect(() => () => captureState.set({ camera: false, cameraStatus: '' }), [])
  return <section className="alpha-presence" aria-label="Alpha 3D presence">
    <div className="alpha-presence-stage" ref={host} />
    <video ref={video} className="alpha-camera-video" muted playsInline aria-hidden="true" />
  </section>
}
