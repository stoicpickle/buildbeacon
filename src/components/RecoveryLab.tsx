import { useCallback, useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import {
  BeaconReceiver,
  BeaconSource,
  base64UrlDecode,
  verifyEnvelope,
  type ReceiveProgress,
  type VerificationResult,
} from '../lib'

interface RecoveryLabProps {
  proofNonce: number
  onScanStarted: () => void
  onRecovered: (bytes: Uint8Array, verification: VerificationResult, receiptId: string) => void
}

type ScannerState = 'idle' | 'loading' | 'scanning' | 'complete' | 'failed' | 'camera'

const EMPTY_PROGRESS: ReceiveProgress = { accepted: false, duplicate: false, rank: 0, required: 0, uniqueFrames: 0, complete: false }
const MAX_FILE_BYTES = 250 * 1024 * 1024
const MAX_DURATION_SECONDS = 120
const MAX_SOURCE_DIMENSION = 4_096
const MAX_SOURCE_PIXELS = 16_777_216
const MAX_SAMPLED_FRAMES = 960
const MAX_CANVAS_SIDE = 960
const EVENT_TIMEOUT_MS = 10_000

function waitFor(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer)
      target.removeEventListener(event, onSuccess)
      target.removeEventListener('error', onError)
    }
    const onSuccess = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('The media could not be decoded by this browser'))
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for media ${event}`))
    }, EVENT_TIMEOUT_MS)
    target.addEventListener(event, onSuccess, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}

function drawVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): string | undefined {
  if (video.videoWidth < 1 || video.videoHeight < 1) return undefined
  const scale = Math.min(1, MAX_CANVAS_SIDE / video.videoWidth, MAX_CANVAS_SIDE / video.videoHeight)
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return undefined
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  return jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' })?.data
}

export function RecoveryLab({ proofNonce, onScanStarted, onRecovered }: RecoveryLabProps) {
  const [state, setState] = useState<ScannerState>('idle')
  const [progress, setProgress] = useState<ReceiveProgress>(EMPTY_PROGRESS)
  const [message, setMessage] = useState('Choose the built-in proof, a clip, or a live camera.')
  const [processedFrames, setProcessedFrames] = useState(0)
  const [showMedia, setShowMedia] = useState(false)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const scanCanvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | undefined>(undefined)
  const cameraLoopRef = useRef<number | undefined>(undefined)
  const receiverRef = useRef(new BeaconReceiver())
  const operationRef = useRef(0)
  const activeRef = useRef(true)
  const mediaUrlRef = useRef<string | undefined>(undefined)

  const stopCamera = useCallback(() => {
    if (cameraLoopRef.current !== undefined) cancelAnimationFrame(cameraLoopRef.current)
    cameraLoopRef.current = undefined
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = undefined
    if (videoRef.current) videoRef.current.srcObject = null
    if (activeRef.current) setState((current) => (current === 'camera' ? 'idle' : current))
  }, [])

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      operationRef.current += 1
      if (cameraLoopRef.current !== undefined) cancelAnimationFrame(cameraLoopRef.current)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      if (mediaUrlRef.current) URL.revokeObjectURL(mediaUrlRef.current)
    }
  }, [])

  const resetEvidence = useCallback(() => {
    onScanStarted()
    setProgress(EMPTY_PROGRESS)
    setProcessedFrames(0)
  }, [onScanStarted])

  const finishEnvelope = useCallback(
    async (bytes: Uint8Array, receiptId: string, operation: number) => {
      const verification = await verifyEnvelope(bytes)
      if (!activeRef.current || operationRef.current !== operation) return
      setState(verification.valid ? 'complete' : 'failed')
      setMessage(verification.valid ? 'Receipt reconstructed. Signature valid under the embedded key.' : verification.reason ?? 'Receipt signature is invalid.')
      onRecovered(bytes, verification, receiptId)
      stopCamera()
    },
    [onRecovered, stopCamera],
  )

  const acceptText = useCallback(
    async (text: string | undefined, receiver: BeaconReceiver, operation: number): Promise<boolean> => {
      if (!text) return false
      if (text.startsWith('BBR1:')) {
        try {
          if (text.length > 4_200) throw new Error('Static receipt QR exceeds protocol limits')
          const bytes = base64UrlDecode(text.slice(5))
          const source = await BeaconSource.create(bytes)
          if (!activeRef.current || operationRef.current !== operation) return false
          const next: ReceiveProgress = {
            accepted: true,
            duplicate: false,
            rank: 1,
            required: 1,
            uniqueFrames: 1,
            receiptId: source.id,
            complete: true,
            payload: bytes,
          }
          setProgress(next)
          await finishEnvelope(bytes, source.id, operation)
          return true
        } catch (error) {
          if (!activeRef.current || operationRef.current !== operation) return false
          setState('failed')
          setMessage(error instanceof Error ? error.message : 'Static receipt QR is invalid')
          return false
        }
      }
      if (!text.startsWith('BB1:')) return false
      const next = await receiver.add(text)
      if (!activeRef.current || operationRef.current !== operation) return false
      setProgress(next)
      if (next.complete && next.payload) {
        await finishEnvelope(next.payload, next.receiptId ?? '', operation)
        return true
      }
      return false
    },
    [finishEnvelope],
  )

  const scanBlob = useCallback(
    async (blob: Blob, label: string, existingOperation?: number) => {
      const operation = existingOperation ?? operationRef.current + 1
      operationRef.current = operation
      if (existingOperation === undefined) resetEvidence()
      stopCamera()
      setState('loading')
      setMessage(`Loading ${label} locally…`)
      if (blob.size < 1 || blob.size > MAX_FILE_BYTES) {
        setState('failed')
        setMessage('Clip must be between 1 byte and 250 MiB.')
        return
      }
      const receiver = new BeaconReceiver()
      receiverRef.current = receiver
      setProgress(receiver.progress)
      const canvas = scanCanvasRef.current!
      if (mediaUrlRef.current) URL.revokeObjectURL(mediaUrlRef.current)
      const url = URL.createObjectURL(blob)
      mediaUrlRef.current = url
      if (!blob.type.startsWith('image/')) setImagePreviewUrl(undefined)
      try {
        if (blob.type.startsWith('image/')) {
          const bitmap = await createImageBitmap(blob)
          if (!activeRef.current || operationRef.current !== operation) {
            bitmap.close()
            return
          }
          if (
            bitmap.width < 1 ||
            bitmap.height < 1 ||
            bitmap.width > MAX_SOURCE_DIMENSION ||
            bitmap.height > MAX_SOURCE_DIMENSION ||
            bitmap.width * bitmap.height > MAX_SOURCE_PIXELS
          ) {
            bitmap.close()
            throw new Error('Image dimensions exceed the 4096-pixel-side / 16-megapixel limit')
          }
          setImagePreviewUrl(url)
          setShowMedia(false)
          setState('scanning')
          setMessage('Scanning one static QR image locally…')
          const scale = Math.min(1, MAX_CANVAS_SIDE / bitmap.width, MAX_CANVAS_SIDE / bitmap.height)
          canvas.width = Math.max(1, Math.round(bitmap.width * scale))
          canvas.height = Math.max(1, Math.round(bitmap.height * scale))
          const context = canvas.getContext('2d', { willReadFrequently: true })
          if (!context) throw new Error('Canvas pixel decoding is unavailable')
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          bitmap.close()
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
          setProcessedFrames(1)
          const decoded = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' })?.data
          if (await acceptText(decoded, receiver, operation)) return
          setState('failed')
          setMessage('No valid static BuildBeacon receipt was found in this image.')
          return
        }
        setImagePreviewUrl(undefined)
        setShowMedia(true)
        const video = videoRef.current!
        video.pause()
        video.srcObject = null
        video.muted = true
        video.playsInline = true
        video.preload = 'auto'
        video.src = url
        video.load()
        await waitFor(video, 'loadedmetadata')
        if (!activeRef.current || operationRef.current !== operation) return
        if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > MAX_DURATION_SECONDS) {
          throw new Error(`Clip duration must be finite and no longer than ${MAX_DURATION_SECONDS} seconds`)
        }
        if (
          video.videoWidth < 1 ||
          video.videoHeight < 1 ||
          video.videoWidth > MAX_SOURCE_DIMENSION ||
          video.videoHeight > MAX_SOURCE_DIMENSION ||
          video.videoWidth * video.videoHeight > MAX_SOURCE_PIXELS
        ) {
          throw new Error('Clip dimensions exceed the 4096-pixel-side / 16-megapixel limit')
        }
        const step = 1 / 8
        const sampleCount = Math.ceil(video.duration / step)
        if (sampleCount > MAX_SAMPLED_FRAMES) throw new Error(`Clip requires more than ${MAX_SAMPLED_FRAMES} sampled frames`)
        setState('scanning')
        setMessage(`Scanning ${video.duration.toFixed(1)} seconds of visible pixels…`)
        for (let index = 0; index < sampleCount; index += 1) {
          if (!activeRef.current || operationRef.current !== operation) return
          video.currentTime = Math.min(index * step, Math.max(0, video.duration - 0.001))
          await waitFor(video, 'seeked')
          if (!activeRef.current || operationRef.current !== operation) return
          setProcessedFrames(index + 1)
          if (await acceptText(drawVideoFrame(video, canvas), receiver, operation)) return
        }
        setProgress(receiver.progress)
        setState('failed')
        setMessage('Not enough independent, decodable BuildBeacon frames were found in this clip.')
      } catch (error) {
        if (!activeRef.current || operationRef.current !== operation) return
        setState('failed')
        setMessage(error instanceof Error ? error.message : 'Clip scan failed')
      }
    },
    [acceptText, resetEvidence, stopCamera],
  )

  const runBuiltInProof = useCallback(async () => {
    const operation = operationRef.current + 1
    operationRef.current = operation
    resetEvidence()
    stopCamera()
    setShowMedia(false)
    setImagePreviewUrl(undefined)
    try {
      setState('loading')
      setMessage('Fetching the checked-in six-second fixture…')
      const response = await fetch(`${import.meta.env.BASE_URL}demo/buildbeacon-six-second.mp4`)
      if (!response.ok) throw new Error('The six-second fixture is unavailable')
      const blob = await response.blob()
      if (!activeRef.current || operationRef.current !== operation) return
      await scanBlob(blob, 'the six-second proof', operation)
    } catch (error) {
      if (!activeRef.current || operationRef.current !== operation) return
      setState('failed')
      setMessage(error instanceof Error ? error.message : 'Proof could not run')
    }
  }, [resetEvidence, scanBlob, stopCamera])

  useEffect(() => {
    if (proofNonce > 0) void runBuiltInProof()
  }, [proofNonce, runBuiltInProof])

  const cancelScan = useCallback(() => {
    operationRef.current += 1
    videoRef.current?.pause()
    setState('idle')
    setMessage('Scan cancelled. Choose another local source when ready.')
    setShowMedia(false)
    setImagePreviewUrl(undefined)
  }, [])

  const startCamera = useCallback(async () => {
    operationRef.current += 1
    const operation = operationRef.current
    resetEvidence()
    stopCamera()
    setShowMedia(false)
    setImagePreviewUrl(undefined)
    let acquiredStream: MediaStream | undefined
    try {
      acquiredStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      if (!activeRef.current || operationRef.current !== operation) {
        acquiredStream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = acquiredStream
      const video = videoRef.current!
      video.src = ''
      video.srcObject = acquiredStream
      setShowMedia(true)
      await video.play()
      if (!activeRef.current || operationRef.current !== operation) {
        acquiredStream.getTracks().forEach((track) => track.stop())
        return
      }
      const receiver = new BeaconReceiver()
      receiverRef.current = receiver
      setProgress(receiver.progress)
      setState('camera')
      setMessage('Camera frames stay in this tab. Point it at a running beacon.')
      let lastScan = 0
      let cameraSamples = 0
      const scan = async (time: number) => {
        if (!streamRef.current || operationRef.current !== operation) return
        if (time - lastScan >= 100) {
          lastScan = time
          cameraSamples += 1
          setProcessedFrames(cameraSamples)
          if (await acceptText(drawVideoFrame(video, scanCanvasRef.current!), receiver, operation)) return
          if (cameraSamples >= MAX_SAMPLED_FRAMES) {
            setState('failed')
            setMessage(`Camera scan stopped at the ${MAX_SAMPLED_FRAMES}-frame safety limit.`)
            stopCamera()
            return
          }
        }
        cameraLoopRef.current = requestAnimationFrame((next) => void scan(next))
      }
      cameraLoopRef.current = requestAnimationFrame((time) => void scan(time))
    } catch (error) {
      acquiredStream?.getTracks().forEach((track) => track.stop())
      stopCamera()
      if (!activeRef.current || operationRef.current !== operation) return
      setShowMedia(false)
      setState('failed')
      setMessage(error instanceof Error ? error.message : 'Camera permission was not granted')
    }
  }, [acceptText, resetEvidence, stopCamera])

  const percent = progress.required > 0 ? Math.min(100, Math.round((progress.rank / progress.required) * 100)) : 0
  const busy = state === 'loading' || state === 'scanning'
  const visibleVideo = showMedia && (state === 'complete' || state === 'failed' || state === 'camera')

  return (
    <div className="recovery-layout">
      <div className="video-stage">
        <div className="video-stage__chrome"><span /><span /><span /><small>LOCAL PIXEL DECODER</small></div>
        <video
          ref={videoRef}
          className={visibleVideo && !imagePreviewUrl ? 'camera-preview' : 'sr-only'}
          muted
          playsInline
          controls={visibleVideo && state !== 'camera'}
          aria-label={state === 'camera' ? 'Local camera preview' : 'Clip currently being decoded locally'}
        />
        {imagePreviewUrl && <img className="camera-preview" src={imagePreviewUrl} alt="Static QR image being decoded locally" />}
        {!visibleVideo && !imagePreviewUrl && (
          <div className="scanner-visual" aria-hidden="true">
            <div className="scan-reticle"><i /><i /><i /><i /></div>
            <div className={`scan-line ${busy ? 'scan-line--active' : ''}`} />
            <span>{state === 'complete' ? 'RECEIPT RECOVERED' : state === 'failed' ? 'SCAN INCOMPLETE' : 'READY FOR VISIBLE FRAMES'}</span>
          </div>
        )}
        {(visibleVideo || imagePreviewUrl) && <span className="media-badge">{state === 'complete' ? 'RECEIPT RECOVERED' : state === 'failed' ? 'SCAN INCOMPLETE' : 'CAMERA ACTIVE'}</span>}
        <canvas ref={scanCanvasRef} className="sr-only" aria-hidden="true" />
      </div>

      <div className="recovery-console">
        <span className="eyebrow eyebrow--dark">Recovery lab</span>
        <h3>Can the pixels carry the receipt?</h3>
        <p role="status" aria-live="polite">{message}</p>

        <div className="rank-meter">
          <div className="rank-meter__label"><span>Matrix rank</span><strong>{progress.rank} / {progress.required || '—'}</strong></div>
          <div
            className="rank-meter__track"
            role="progressbar"
            aria-label="Independent frame matrix rank"
            aria-valuemin={0}
            aria-valuemax={progress.required || 1}
            aria-valuenow={progress.rank}
            aria-valuetext={progress.required ? `${progress.rank} of ${progress.required}` : 'Waiting for a beacon'}
          ><span style={{ width: `${percent}%` }} /></div>
        </div>

        <div className="scan-stats">
          <span><small>Frames sampled</small><strong>{processedFrames}</strong></span>
          <span><small>Unique packets</small><strong>{progress.uniqueFrames}</strong></span>
          <span><small>Decode</small><strong>{progress.complete ? 'complete' : `${percent}%`}</strong></span>
        </div>

        <div className="recovery-actions">
          <button className="button button--primary" type="button" onClick={() => void runBuiltInProof()} disabled={busy || state === 'camera'}>
            Run the 6-second proof
          </button>
          <button className="button button--quiet button--dark" type="button" onClick={() => inputRef.current?.click()} disabled={busy || state === 'camera'}>
            Upload media
          </button>
          {busy ? (
            <button className="button button--quiet button--dark" type="button" onClick={cancelScan}>Cancel scan</button>
          ) : state === 'camera' ? (
            <button className="button button--quiet button--dark" type="button" onClick={() => { operationRef.current += 1; stopCamera(); setShowMedia(false) }}>Stop camera</button>
          ) : (
            <button className="button button--quiet button--dark" type="button" onClick={() => void startCamera()}>Use camera</button>
          )}
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept="video/*,image/png,image/jpeg,image/webp"
            aria-label="Upload a local video or QR image"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void scanBlob(file, file.name)
              event.currentTarget.value = ''
            }}
          />
        </div>
        <p className="privacy-line">No uploads. No account. Clips are capped at 250 MiB / 120 seconds. Camera access ends when you stop it or leave this mode.</p>
      </div>
    </div>
  )
}
