import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { base64UrlEncode, type BeaconSource } from '../lib'

export type BeaconMode = 'animated' | 'static' | 'id'

interface BeaconCanvasProps {
  source?: BeaconSource
  envelope?: Uint8Array
  mode: BeaconMode
}

export function BeaconCanvas({ source, envelope, mode }: BeaconCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [playing, setPlaying] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [sequence, setSequence] = useState(0)
  const [renderError, setRenderError] = useState('')
  const sequenceRef = useRef(0)

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => {
      setReducedMotion(preference.matches)
      if (preference.matches) setPlaying(false)
    }
    update()
    preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [])

  const draw = useCallback(
    async (nextSequence: number) => {
      const canvas = canvasRef.current
      if (!canvas || !source || !envelope || mode === 'id') return
      try {
        const text = mode === 'animated' ? await source.frame(nextSequence) : `BBR1:${base64UrlEncode(envelope)}`
        await QRCode.toCanvas(canvas, text, {
          errorCorrectionLevel: 'M',
          margin: 4,
          width: 344,
          color: { dark: '#080a0c', light: '#ffffff' },
        })
        setRenderError('')
      } catch (error) {
        setRenderError(error instanceof Error ? error.message : 'Unable to render QR frame')
      }
    },
    [envelope, mode, source],
  )

  const step = useCallback(() => {
    const next = mode === 'animated' ? sequenceRef.current + 1 : sequenceRef.current
    sequenceRef.current = next
    setSequence(next)
    void draw(next)
  }, [draw, mode])

  useEffect(() => {
    sequenceRef.current = 0
    setSequence(0)
    setPlaying(false)
    void draw(0)
  }, [draw, source, mode])

  useEffect(() => {
    if (!playing || mode !== 'animated') return undefined
    const timer = window.setInterval(step, 500)
    return () => window.clearInterval(timer)
  }, [mode, playing, step])

  if (!source || !envelope) {
    return <div className="beacon-empty">No current signed beacon. Create or re-create one to continue.</div>
  }

  return (
    <div className="beacon-shell">
      <div className="beacon-topline">
        <span className="eyebrow">Visible transport</span>
        <span className={`transport-state ${playing ? 'is-live' : ''}`} aria-live="polite">{playing ? 'Transmitting' : 'Paused'}</span>
      </div>
      <div className={`beacon-stage ${mode === 'id' ? 'beacon-stage--id' : ''}`}>
        {mode === 'id' ? (
          <div className="build-id-card">
            <span>BUILD</span>
            <strong>{source.id.slice(0, 8).toUpperCase()}</strong>
            <small>Resolver-free meaning stops here</small>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            className="beacon-canvas"
            role="img"
            aria-label={`${mode === 'animated' ? 'Loss-tolerant animated' : 'Static'} BuildBeacon QR for receipt ${source.id.slice(0, 12)}`}
          />
        )}
      </div>
      {renderError && <p className="inline-error">{renderError}</p>}
      <div className="beacon-readout">
        <span>
          <small>Receipt</small>
          <code>{source.id.slice(0, 12)}</code>
        </span>
        <span>
          <small>Frame</small>
          <code>{mode === 'animated' ? String(sequence).padStart(4, '0') : 'fixed'}</code>
        </span>
        <span>
          <small>Source blocks</small>
          <code>{source.blockCount}</code>
        </span>
      </div>
      <div className="beacon-controls">
        {mode === 'animated' && (
          <>
            <button className="button button--primary" type="button" onClick={() => setPlaying((value) => !value)} disabled={reducedMotion && !playing}>
              {playing ? 'Pause beacon' : reducedMotion ? 'Motion disabled' : 'Start beacon'}
            </button>
            <button className="button button--quiet" type="button" onClick={step} disabled={playing}>
              Step one frame
            </button>
          </>
        )}
        {mode === 'static' && <span className="control-note">One QR · larger payload · no join-late coding</span>}
        {mode === 'id' && <span className="control-note">Smallest marker · requires an external lookup</span>}
      </div>
      <p className="motion-note">{reducedMotion ? 'Your reduced-motion preference is active. Use single-step frames instead.' : 'Animation starts only when you ask and runs at two frames per second.'}</p>
    </div>
  )
}
