import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { BeaconCanvas, type BeaconMode } from './components/BeaconCanvas'
import { ReceiptDetails } from './components/ReceiptDetails'
import { RecoveryLab } from './components/RecoveryLab'
import {
  BeaconSource,
  base64UrlDecode,
  demoReceipt,
  generateSigningKey,
  signReceipt,
  verifyEnvelope,
  type BuildReceipt,
  type VerificationResult,
} from './lib'

type Mode = 'transmit' | 'recover' | 'inspect'

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function App() {
  const [mode, setMode] = useState<Mode>('transmit')
  const [beaconMode, setBeaconMode] = useState<BeaconMode>('animated')
  const [receipt, setReceipt] = useState<BuildReceipt>(demoReceipt)
  const [envelope, setEnvelope] = useState<Uint8Array>()
  const [source, setSource] = useState<BeaconSource>()
  const [verification, setVerification] = useState<VerificationResult>()
  const [recoveredId, setRecoveredId] = useState('')
  const [transportRecovered, setTransportRecovered] = useState(false)
  const [proofNonce, setProofNonce] = useState(0)
  const [formError, setFormError] = useState('')
  const [signing, setSigning] = useState(false)
  const signingOperationRef = useRef(0)

  const createDemoEnvelope = useCallback(async (nextReceipt: BuildReceipt) => {
    const operation = signingOperationRef.current + 1
    signingOperationRef.current = operation
    setSigning(true)
    try {
      const key = await generateSigningKey()
      const bytes = await signReceipt(nextReceipt, base64UrlDecode(key.secretKey))
      const nextSource = await BeaconSource.create(bytes, 64)
      const nextVerification = await verifyEnvelope(bytes)
      if (signingOperationRef.current !== operation) return
      setEnvelope(bytes)
      setSource(nextSource)
      setVerification(nextVerification)
      setTransportRecovered(false)
      setRecoveredId('')
      setFormError('')
    } catch (error) {
      if (signingOperationRef.current !== operation) return
      setFormError(error instanceof Error ? error.message : 'Unable to sign receipt')
    } finally {
      if (signingOperationRef.current === operation) setSigning(false)
    }
  }, [])

  useEffect(() => {
    void createDemoEnvelope(receipt)
    // The initial fixture is intentionally generated once with a tab-local key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createDemoEnvelope])

  const updateReceipt = useCallback((path: string, value: string) => {
    signingOperationRef.current += 1
    setEnvelope(undefined)
    setSource(undefined)
    setVerification(undefined)
    setTransportRecovered(false)
    setRecoveredId('')
    setFormError('Claims changed. Create a new signed beacon before using the marker.')
    setSigning(false)
    setReceipt((current) => {
      const next = structuredClone(current)
      if (path === 'repository') next.repository = value
      if (path === 'commit') next.commit.value = value
      if (path === 'artifact.name') next.artifact.name = value
      if (path === 'artifact.sha256') next.artifact.sha256 = value
      if (path === 'builder') next.build.builder = value
      return next
    })
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    await createDemoEnvelope(receipt)
  }

  const runProof = () => {
    setMode('recover')
    setProofNonce((value) => value + 1)
    window.setTimeout(() => document.querySelector('#workbench')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
  }

  const recovered = useCallback((_bytes: Uint8Array, result: VerificationResult, receiptId: string) => {
    setTransportRecovered(true)
    setVerification(result)
    setRecoveredId(receiptId)
  }, [])

  const scanStarted = useCallback(() => {
    setTransportRecovered(false)
    setVerification(undefined)
    setRecoveredId('')
  }, [])

  const modeCopy = useMemo(
    () => ({
      transmit: ['Transmit', 'Compose a receipt and put it into visible motion.'],
      recover: ['Recover', 'Reconstruct from a checked-in clip, your clip, or a camera.'],
      inspect: ['Inspect', 'Separate transport success, signature integrity, and signer trust.'],
    }),
    [],
  )

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="BuildBeacon home"><span className="wordmark-mark">B</span><span>BuildBeacon</span></a>
        <nav aria-label="Primary navigation">
          <a href="#workbench">Workbench</a>
          <a href="#how-it-works">Protocol</a>
          <a href="https://github.com/stoicpickle/buildbeacon" target="_blank" rel="noreferrer">GitHub ↗</a>
        </nav>
        <span className="version-badge">EXPERIMENTAL v0.1</span>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <span className="hero-kicker"><i /> OFFLINE VISUAL TRANSPORT</span>
            <h1>Prove the receipt.<br /><em>Keep it in the pixels.</em></h1>
            <p>BuildBeacon turns a signed software-build receipt into a looping, loss-tolerant QR beacon. Recover it from a usable recording fragment and check its signature locally—no upload or lookup server required.</p>
            <div className="hero-actions">
              <button className="button button--hero" type="button" onClick={runProof}>Run the 6-second proof <span>→</span></button>
              <button className="text-button" type="button" onClick={() => { setMode('transmit'); document.querySelector('#workbench')?.scrollIntoView({ behavior: 'smooth' }) }}>Create a beacon</button>
            </div>
            <div className="hero-facts">
              <span><strong>Ed25519</strong><small>receipt signature</small></span>
              <span><strong>BBP/1</strong><small>erasure transport</small></span>
              <span><strong>Local</strong><small>pixel decoding</small></span>
            </div>
          </div>
          <div className="hero-beacon">
            <div className="hero-beacon__label"><span>LIVE INSTRUMENT</span><span>USER CONTROLLED</span></div>
            <BeaconCanvas source={source} envelope={envelope} mode="animated" />
          </div>
        </section>

        <section className="context-strip">
          <span>Metadata gets stripped.</span><span>Clips get trimmed.</span><span>Pixels tend to survive.</span>
        </section>

        <section id="workbench" className="workbench-section">
          <div className="section-heading">
            <div><span className="section-number">01</span><span className="eyebrow eyebrow--dark">BuildBeacon workbench</span><h2>{modeCopy[mode][0]}</h2><p>{modeCopy[mode][1]}</p></div>
            <div className="mode-tabs" role="group" aria-label="Workbench mode">
              {(['transmit', 'recover', 'inspect'] as const).map((item) => (
                <button key={item} type="button" aria-pressed={mode === item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>
                  <span>{item === 'transmit' ? '01' : item === 'recover' ? '02' : '03'}</span>{item}
                </button>
              ))}
            </div>
          </div>

          {mode === 'transmit' && (
            <div className="transmit-layout">
              <form className="receipt-form" onSubmit={(event) => void submit(event)}>
                <div className="panel-heading"><div><span className="eyebrow eyebrow--dark">Signed claim</span><h3>Build receipt</h3></div><span className="demo-key-label">DEMO KEY · TAB ONLY</span></div>
                <label>Repository URL<input value={receipt.repository} onChange={(event) => updateReceipt('repository', event.target.value)} /></label>
                <label>Git commit<input className="mono-input" value={receipt.commit.value} onChange={(event) => updateReceipt('commit', event.target.value)} /></label>
                <div className="field-pair">
                  <label>Artifact name<input value={receipt.artifact.name} onChange={(event) => updateReceipt('artifact.name', event.target.value)} /></label>
                  <label>Builder claim<input value={receipt.build.builder} onChange={(event) => updateReceipt('builder', event.target.value)} /></label>
                </div>
                <label>Artifact SHA-256<input className="mono-input" value={receipt.artifact.sha256} onChange={(event) => updateReceipt('artifact.sha256', event.target.value)} /></label>
                {formError && <p className="inline-error">{formError}</p>}
                <div className="form-footer">
                  <button className="button button--primary" type="submit" disabled={signing}>{signing ? 'Signing locally…' : 'Create signed beacon'}</button>
                  <span>For demos only. Use the CLI for persistent signing keys.</span>
                </div>
              </form>

              <div className="transmitter-panel">
                <div className="format-switch" role="group" aria-label="Marker format">
                  <button type="button" className={beaconMode === 'id' ? 'active' : ''} onClick={() => setBeaconMode('id')}>Build ID</button>
                  <button type="button" className={beaconMode === 'static' ? 'active' : ''} onClick={() => setBeaconMode('static')}>Static QR</button>
                  <button type="button" className={beaconMode === 'animated' ? 'active' : ''} onClick={() => setBeaconMode('animated')}>Loss-tolerant</button>
                </div>
                <BeaconCanvas source={source} envelope={envelope} mode={beaconMode} />
                <div className="download-row">
                  <button className="text-button text-button--dark" type="button" disabled={!envelope} onClick={() => envelope && download(`buildbeacon-${source?.id.slice(0, 8)}.bb`, new Uint8Array(envelope).buffer, 'application/cbor')}>Download signed receipt</button>
                  <button className="text-button text-button--dark" type="button" onClick={() => download('buildbeacon-receipt.json', `${JSON.stringify(receipt, null, 2)}\n`, 'application/json')}>Download claims JSON</button>
                </div>
              </div>
            </div>
          )}

          {mode === 'recover' && <RecoveryLab proofNonce={proofNonce} onScanStarted={scanStarted} onRecovered={recovered} />}
          {mode === 'inspect' && <ReceiptDetails verification={verification} transportRecovered={transportRecovered} receiptId={recoveredId || source?.id} />}
        </section>

        <section id="how-it-works" className="protocol-section">
          <div className="protocol-intro"><span className="section-number section-number--light">02</span><span className="eyebrow">What survives</span><h2>A tiny receipt,<br />repeated intelligently.</h2><p>Each frame is useful on its own. Enough independent frames reconstruct the exact canonical receipt, even when the viewer joins between cycles or frames disappear.</p></div>
          <ol className="protocol-steps">
            <li><span>01</span><div><strong>Sign</strong><p>Canonical dCBOR claims are domain-separated and signed with Ed25519.</p></div></li>
            <li><span>02</span><div><strong>Transmit</strong><p>Systematic and repair symbols become CRC-protected QR frames.</p></div></li>
            <li><span>03</span><div><strong>Recover</strong><p>Gaussian elimination reconstructs after enough independent frames arrive.</p></div></li>
            <li><span>04</span><div><strong>Inspect</strong><p>The app checks exact bytes and signature, then presents claims separately from trust.</p></div></li>
          </ol>
        </section>

        <section className="truth-section">
          <div><span className="eyebrow eyebrow--dark">Honest by design</span><h2>What it proves.<br /><em>What it cannot.</em></h2></div>
          <div className="truth-columns">
            <article><span className="truth-icon truth-icon--yes">✓</span><h3>Receipt integrity</h3><p>Given enough decodable frames, BuildBeacon reconstructs the exact signed receipt and detects changes to it.</p></article>
            <article><span className="truth-icon truth-icon--no">×</span><h3>Not video authenticity</h3><p>The beacon can be copied or replayed onto unrelated footage. It is not cryptographically bound to nearby pixels.</p></article>
            <article><span className="truth-icon truth-icon--warn">!</span><h3>Trust is separate</h3><p>An embedded key proves mathematical integrity, not identity. Compare or pin its fingerprint out of band.</p></article>
          </div>
        </section>
      </main>

      <footer><a className="wordmark" href="#top"><span className="wordmark-mark">B</span><span>BuildBeacon</span></a><p>Experimental, offline visual transport for signed build receipts.</p><a href="https://github.com/stoicpickle/buildbeacon" target="_blank" rel="noreferrer">Source on GitHub ↗</a></footer>
    </div>
  )
}
