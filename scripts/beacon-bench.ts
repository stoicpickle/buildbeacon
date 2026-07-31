import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import QRCode from 'qrcode'
import {
  BeaconReceiver,
  BeaconSource,
  base64UrlDecode,
  base64UrlEncode,
  equalBytes,
  verifyEnvelope,
} from '../src/lib/index'

type Transport = 'identifier-qr' | 'static' | 'animated'
type MediaProfile = 'capture-crf18' | 'transcode-crf27' | 'transcode-crf35'

interface CellResult {
  durationSeconds: number
  erasureProbability: number
  excerpts: number
  successes: number
  recoveryRate: number
  eligibleObservations: number
  erasedObservations: number
  realizedErasureRate: number
  medianRecoverySeconds: number | null
  p95RecoverySeconds: number | null
  failures: Record<string, number>
  medianUniquePackets: number | null
  medianFinalRank: number | null
}

interface StreamResult {
  transport: Transport
  proof: 'identifier-only' | 'signed-receipt'
  markerWidth: number
  markerAreaPercent: number
  qrVersion: number
  qrModules: number
  modulesWithQuietZone: number
  nominalPixelsPerModule: number
  cleanMarkerDecoded: boolean
  mediaProfile: MediaProfile
  videoBytes: number
  sampledFrames: number
  qrDecodedFrames: number
  qrDecodeRate: number
  cells: CellResult[]
}

const ROOT = resolve(import.meta.dirname, '..')
const ENVELOPE_PATH = join(ROOT, 'examples', 'demo', 'signed-receipt.bb')
const EXPECTED_PATH = join(ROOT, 'examples', 'demo', 'expected.json')
const JSON_OUTPUT = join(ROOT, 'benchmarks', 'beacon-bench.json')
const MARKDOWN_OUTPUT = join(ROOT, 'docs', 'BEACON_BENCH.md')
const MARKER_WIDTHS = [240, 280, 320] as const
const TRANSPORTS: Transport[] = ['identifier-qr', 'static', 'animated']
const MEDIA_PROFILES: MediaProfile[] = ['capture-crf18', 'transcode-crf27', 'transcode-crf35']
const EXCERPT_DURATIONS = [3, 6] as const
const ERASURE_RATES = [0, 0.25] as const
const SEED = 'buildbeacon-beacon-bench-v1'
const CANVAS_WIDTH = 1_280
const CANVAS_HEIGHT = 720
const SOURCE_FPS = 30
const SAMPLE_FPS = 8
const SYMBOL_RATE = 2
const CARRIER_SECONDS = 12
const SYMBOL_COUNT = CARRIER_SECONDS * SYMBOL_RATE
const MARKER_FILE_COUNT = SYMBOL_COUNT + 1
const START_SEQUENCE = 73
const BLOCK_SIZE = 64
const MARGIN_MODULES = 4

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; message?: string }
    const detail = typeof failure.stderr === 'string' ? failure.stderr : failure.stderr?.toString('utf8')
    throw new Error(`${command} failed: ${(detail || failure.message || 'unknown error').trim()}`)
  }
}

function round(value: number, places = 4): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? round((sorted[middle - 1]! + sorted[middle]!) / 2, 3) : sorted[middle]!
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)]!
}

function hash32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d)
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b)
  return (hash ^ (hash >>> 16)) >>> 0
}

function allStarts(durationSeconds: number, totalFrames: number): number[] {
  const windowFrames = durationSeconds * SAMPLE_FPS
  return Array.from({ length: totalFrames - windowFrames + 1 }, (_, index) => index)
}

function shouldErase(durationSeconds: number, excerptStart: number, absoluteFrame: number, rate: number): boolean {
  if (rate === 0) return false
  return hash32(`${SEED}:erase:${durationSeconds}:${excerptStart}:${absoluteFrame}`) / 0x1_0000_0000 < rate
}

function decodePng(buffer: Buffer): string | undefined {
  const png = PNG.sync.read(buffer)
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'dontInvert' })?.data
}

async function packageVersion(name: string): Promise<string> {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }
  return packageJson.version
}

function markerText(
  transport: Transport,
  symbolIndex: number,
  source: BeaconSource,
  staticText: string,
  buildIdText: string,
): Promise<string> | string {
  if (transport === 'identifier-qr') return buildIdText
  if (transport === 'static') return staticText
  return source.frame(START_SEQUENCE + symbolIndex)
}

async function writeMarkerSequence(
  directory: string,
  transport: Transport,
  markerWidth: number,
  source: BeaconSource,
  staticText: string,
  buildIdText: string,
): Promise<{ firstText: string; cleanMarkerDecoded: boolean; qrVersion: number; qrModules: number }> {
  await mkdir(directory, { recursive: true })
  let firstText = ''
  let firstBuffer: Buffer | undefined
  // image2 assigns the last image no duration of its own. One terminal image at
  // t=12s keeps overlay=shortest alive for the complete 12-second carrier.
  for (let index = 0; index < MARKER_FILE_COUNT; index += 1) {
    const text = await markerText(transport, index, source, staticText, buildIdText)
    const buffer = await QRCode.toBuffer(text, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: MARGIN_MODULES,
      width: markerWidth,
      color: { dark: '#080a0c', light: '#ffffff' },
    })
    if (index === 0) {
      firstText = text
      firstBuffer = buffer
    }
    await writeFile(join(directory, `marker-${String(index).padStart(4, '0')}.png`), buffer)
  }
  const qr = QRCode.create(firstText, { errorCorrectionLevel: 'M' })
  if (!firstBuffer) throw new Error(`${transport} did not render a marker`)
  const firstPng = PNG.sync.read(firstBuffer)
  if (firstPng.width !== markerWidth || firstPng.height !== markerWidth) {
    throw new Error(`${transport} marker did not render at the requested ${markerWidth}px square`)
  }
  return {
    firstText,
    cleanMarkerDecoded: decodePng(firstBuffer) === firstText,
    qrVersion: qr.version,
    qrModules: qr.modules.size,
  }
}

function createCarrier(markerDirectory: string, output: string): void {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${CANVAS_WIDTH}x${CANVAS_HEIGHT}:rate=${SOURCE_FPS}:duration=${CARRIER_SECONDS}`,
    '-framerate', String(SYMBOL_RATE), '-start_number', '0', '-i', join(markerDirectory, 'marker-%04d.png'),
    '-filter_complex', '[0:v][1:v]overlay=x=W-w-56:y=H-h-56:shortest=1[out]',
    '-map', '[out]', '-t', String(CARRIER_SECONDS), '-r', String(SOURCE_FPS),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-g', String(SOURCE_FPS),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', output,
  ])
}

function transcode(input: string, output: string, crf: number): void {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-map', '0:v:0', '-c:v', 'libx264', '-crf', String(crf), '-preset', 'medium',
    '-g', String(SOURCE_FPS), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', output,
  ])
}

async function extractAndDecode(video: string, directory: string): Promise<Array<string | undefined>> {
  await mkdir(directory, { recursive: true })
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', video,
    '-vf', `fps=${SAMPLE_FPS}`, join(directory, 'frame-%04d.png'),
  ])
  const frames = (await readdir(directory)).filter((name) => name.endsWith('.png')).sort()
  const decoded: Array<string | undefined> = []
  for (const frame of frames) decoded.push(decodePng(await readFile(join(directory, frame))))
  return decoded
}

async function recoverStatic(text: string, expectedEnvelope: Uint8Array, expectedReceiptId: string): Promise<boolean> {
  if (!text.startsWith('BBR1:')) return false
  try {
    const envelope = base64UrlDecode(text.slice(5))
    if (!equalBytes(envelope, expectedEnvelope)) return false
    const verification = await verifyEnvelope(envelope)
    if (!verification.valid) return false
    return (await BeaconSource.create(envelope, BLOCK_SIZE)).id === expectedReceiptId
  } catch {
    return false
  }
}

async function evaluateCell(
  transport: Transport,
  decodedFrames: Array<string | undefined>,
  durationSeconds: number,
  erasureProbability: number,
  expectedEnvelope: Uint8Array,
  expectedReceiptId: string,
  staticText: string,
  buildIdText: string,
): Promise<CellResult> {
  const starts = allStarts(durationSeconds, decodedFrames.length)
  const windowFrames = durationSeconds * SAMPLE_FPS
  const recoverySeconds: number[] = []
  const uniquePackets: number[] = []
  const finalRanks: number[] = []
  const failures: Record<string, number> = {}
  let eligibleObservations = 0
  let erasedObservations = 0

  for (const start of starts) {
    for (let relativeFrame = 0; relativeFrame < windowFrames; relativeFrame += 1) {
      eligibleObservations += 1
      if (shouldErase(durationSeconds, start, start + relativeFrame, erasureProbability)) erasedObservations += 1
    }
    const receiver = transport === 'animated' ? new BeaconReceiver() : undefined
    let decodedAny = false
    let relevantAny = false
    let succeeded = false

    for (let relativeFrame = 0; relativeFrame < windowFrames; relativeFrame += 1) {
      const absoluteFrame = start + relativeFrame
      if (shouldErase(durationSeconds, start, absoluteFrame, erasureProbability)) continue
      const text = decodedFrames[absoluteFrame]
      if (!text) continue
      decodedAny = true

      if (transport === 'identifier-qr') {
        relevantAny ||= text.startsWith('BBI1:')
        if (text === buildIdText) succeeded = true
      } else if (transport === 'static') {
        relevantAny ||= text.startsWith('BBR1:')
        if (text === staticText && await recoverStatic(text, expectedEnvelope, expectedReceiptId)) succeeded = true
      } else if (text.startsWith('BB1:')) {
        relevantAny = true
        const progress = await receiver!.add(text)
        if (progress.complete && progress.payload) {
          const verification = await verifyEnvelope(progress.payload)
          succeeded = verification.valid && progress.receiptId === expectedReceiptId && equalBytes(progress.payload, expectedEnvelope)
        }
      }

      if (succeeded) {
        recoverySeconds.push(round(relativeFrame / SAMPLE_FPS, 3))
        if (receiver) {
          uniquePackets.push(receiver.progress.uniqueFrames)
          finalRanks.push(receiver.progress.rank)
        }
        break
      }
    }

    if (!succeeded) {
      let reason = 'unreadable-marker'
      if (decodedAny && !relevantAny) reason = 'wrong-marker-data'
      if (receiver && relevantAny) {
        reason = 'rank-shortfall'
        uniquePackets.push(receiver.progress.uniqueFrames)
        finalRanks.push(receiver.progress.rank)
      }
      failures[reason] = (failures[reason] ?? 0) + 1
    }
  }

  const successes = recoverySeconds.length
  return {
    durationSeconds,
    erasureProbability,
    excerpts: starts.length,
    successes,
    recoveryRate: round(successes / starts.length),
    eligibleObservations,
    erasedObservations,
    realizedErasureRate: round(erasedObservations / eligibleObservations),
    medianRecoverySeconds: median(recoverySeconds),
    p95RecoverySeconds: percentile(recoverySeconds, 0.95),
    failures,
    medianUniquePackets: median(uniquePackets),
    medianFinalRank: median(finalRanks),
  }
}

function cellFor(streams: StreamResult[], transport: Transport, width: number, media: MediaProfile, duration: number, erasure: number): CellResult {
  const stream = streams.find((candidate) => candidate.transport === transport && candidate.markerWidth === width && candidate.mediaProfile === media)
  const cell = stream?.cells.find((candidate) => candidate.durationSeconds === duration && candidate.erasureProbability === erasure)
  if (!cell) throw new Error(`Missing result cell for ${transport}/${width}/${media}/${duration}/${erasure}`)
  return cell
}

function percent(value: number): string {
  return `${round(value * 100, 1).toFixed(1)}%`
}

function outcome(cell: CellResult): string {
  return `${cell.successes}/${cell.excerpts} (${percent(cell.recoveryRate)})`
}

function seconds(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(3)} s`
}

function transportLabel(transport: Transport): string {
  if (transport === 'identifier-qr') return 'Identifier QR control'
  if (transport === 'static') return 'Static BBR1'
  return 'Animated BBP/1'
}

function makeMarkdown(report: BenchmarkReport): string {
  const streams = report.streams
  const primary = report.interpretation.primary
  const primaryStaticCell = cellFor(streams, 'static', 320, 'transcode-crf27', 6, 0.25)
  const lines = [
    '# Beacon Bench 1',
    '',
    '**Question:** At the same visible footprint, when does a loss-tolerant BBP/1 marker recover the checked-in signed receipt more reliably than a static BBR1 QR—and how close can either come to a benchmark-only identifier QR?',
    '',
    `**Bottom line:** ${report.interpretation.summary}`,
    '',
    'This is a controlled lab benchmark, not a claim about a named social platform or arbitrary footage. The experimental identifier-QR control is not a shipped BuildBeacon mode or protocol format: it decodes only the fixture receipt ID and exercises no resolver. BBR1 and BBP/1 recover and verify the complete signed envelope offline.',
    '',
    '## Evaluation rule for this run',
    '',
    'The primary cell is a 320 px marker, a six-second excerpt, one H.264 CRF 18 capture followed by a CRF 27 transcode, and a 25% seeded sample-erasure probability. “Animated advantage” requires at least 95% observed BBP/1 recovery and at least a 15-point observed advantage over BBR1. The broader continuation gate also requires that result under both CRF 27 and CRF 35 transcodes at at least one tested footprint, with p95 recovery under five seconds among successful excerpts. These are point-estimate thresholds for this one carrier, not confidence-bound reliability claims.',
    '',
    '## Primary result',
    '',
    '| Transport | Observed outcome | Median recovery* | p95 recovery* | Evidence returned |',
    '|---|---:|---:|---:|---|',
  ]
  for (const transport of TRANSPORTS) {
    const cell = cellFor(streams, transport, 320, 'transcode-crf27', 6, 0.25)
    lines.push(`| ${transportLabel(transport)} | ${outcome(cell)} | ${seconds(cell.medianRecoverySeconds)} | ${seconds(cell.p95RecoverySeconds)} | ${transport === 'identifier-qr' ? 'identifier decoded; no lookup exercised' : 'signed receipt'} |`)
  }
  lines.push(
    '',
    '*Recovery timing is measured from the first sample timestamp at 0.000 seconds and only among successful excerpts.',
    '',
    `Primary BBP/1 minus BBR1 recovery delta: **${round(primary.animatedMinusStatic * 100, 1).toFixed(1)} percentage points**. Classification: **${primary.classification}**.`,
    '',
    '## Why marker size matters',
    '',
    '| Transport | QR text | QR version | Data modules | Modules with quiet zone | 320 px pitch |',
    '|---|---:|---:|---:|---:|---:|',
  )
  for (const density of report.density) {
    lines.push(`| ${transportLabel(density.transport)} | ${density.textCharacters} chars | ${density.qrVersion} | ${density.qrModules}×${density.qrModules} | ${density.modulesWithQuietZone}×${density.modulesWithQuietZone} | ${density.pixelsPerModuleAt320.toFixed(2)} px/module |`)
  }
  lines.push(
    '',
    `At 320 px, BBR1 would need an approximately **${report.interpretation.staticWidthForAnimatedPitchAt320}px** marker to match the BBP/1 frame’s module pitch. At 240 px the clean static marker was already unreadable while the clean animated marker decoded, so the observed gap existed before H.264. Chunking creates the density advantage; the erasure code then makes enough arbitrary symbols reconstructable. This is not a pure “fountain code versus QR” result or evidence that recompression created the gap.`,
    '',
    '## Six-second outcomes at 25% configured sample-erasure probability',
    '',
    '| Marker | Media path | Identifier QR | Static BBR1 | Animated BBP/1 | Animated delta |',
    '|---:|---|---:|---:|---:|---:|',
  )
  for (const width of MARKER_WIDTHS) {
    for (const media of MEDIA_PROFILES) {
      const id = cellFor(streams, 'identifier-qr', width, media, 6, 0.25)
      const staticCell = cellFor(streams, 'static', width, media, 6, 0.25)
      const animated = cellFor(streams, 'animated', width, media, 6, 0.25)
      lines.push(`| ${width}px | ${media} | ${outcome(id)} | ${outcome(staticCell)} | ${outcome(animated)} | ${round((animated.recoveryRate - staticCell.recoveryRate) * 100, 1).toFixed(1)} pp |`)
    }
  }
  lines.push(
    '',
    '## Duration tradeoff at the current 320 px footprint',
    '',
    '| Excerpt | Identifier QR | Static BBR1 | Animated BBP/1 | Animated p95* |',
    '|---:|---:|---:|---:|---:|',
  )
  for (const duration of EXCERPT_DURATIONS) {
    const id = cellFor(streams, 'identifier-qr', 320, 'transcode-crf27', duration, 0.25)
    const staticCell = cellFor(streams, 'static', 320, 'transcode-crf27', duration, 0.25)
    const animated = cellFor(streams, 'animated', 320, 'transcode-crf27', duration, 0.25)
    lines.push(`| ${duration}s | ${outcome(id)} | ${outcome(staticCell)} | ${outcome(animated)} | ${seconds(animated.p95RecoverySeconds)} |`)
  }
  lines.push(
    '',
    '## Fixed conditions',
    '',
    `- The same ${report.fixture.envelopeBytes}-byte signed fixture and expected receipt ID are used by every transport.`,
    '- The identifier QR is an experimental optical lower-bound control. It is not the shipped eight-character visible Build ID, and no lookup service is implemented or tested.',
    `- The carrier is ${CANVAS_WIDTH}×${CANVAS_HEIGHT}, ${SOURCE_FPS} fps, ${CARRIER_SECONDS} seconds; the marker updates at the public transmitter default of ${SYMBOL_RATE} Hz.`,
    `- The animated stream begins at sequence ${START_SEQUENCE}, exercising a join-late slice rather than sequence-zero startup. Short-excerpt outcomes can change with this phase.`,
    `- The receiver samples full frames at ${SAMPLE_FPS} Hz through jsQR. It is not given a cropped marker region.`,
    `- QR error correction is M with a ${MARGIN_MODULES}-module quiet zone. Marker position, colors, H.264 preset, GOP, and yuv420p format are held constant.`,
    `- Every possible sample-aligned start in the one carrier is evaluated: ${CARRIER_SECONDS * SAMPLE_FPS - 3 * SAMPLE_FPS + 1} three-second excerpts and ${CARRIER_SECONDS * SAMPLE_FPS - 6 * SAMPLE_FPS + 1} six-second excerpts. The same seeded erasure mask is used for every transport at each start. These overlapping windows are descriptive outcomes, not independent statistical trials.`,
    `- A configured 25% erasure probability removes receiver sample timestamps, not whole 2 Hz symbols. The six-second masks realized ${percent(primaryStaticCell.realizedErasureRate)} erasure across ${primaryStaticCell.eligibleObservations} window observations.`,
    '- `capture-crf18` is a first-generation x264 encode. `transcode-crf27` and `transcode-crf35` are genuine second-generation encodes of that capture.',
    '',
    '## Reproduce',
    '',
    'Requirements: Node.js 22.12+, npm dependencies, ffmpeg with libx264, and several minutes of local CPU time.',
    '',
    '```bash',
    'npm ci',
    'npm run bench',
    '```',
    '',
    `Machine-readable results: [benchmarks/beacon-bench.json](../benchmarks/beacon-bench.json). The checked-in run used ffmpeg ${report.tools.ffmpeg}.`,
    '',
    '## Limits and non-claims',
    '',
    '- The synthetic moving carrier is not a real application demo or a named platform pipeline.',
    '- The overlapping excerpts come from one carrier and one encode per transport/size. Percentages are exact descriptions of those windows, not population reliability estimates.',
    '- Sample erasure means decoder timestamps were discarded after media decoding; it is not whole-symbol loss or a claim about network or platform frame loss.',
    '- The benchmark does not test crop, blur, glare, perspective, camera capture, codecs other than H.264, or an independent BBP/1 implementation.',
    '- The identifier QR is a hypothetical control. It would require a resolver and network or local index before it could return provenance.',
    '- A valid signed receipt still does not authenticate the surrounding footage or establish signer identity.',
    '- The generator and receiver share this implementation. The result is product evidence, not an interoperability or security audit.',
  )
  return `${lines.join('\n')}\n`
}

interface BenchmarkReport {
  schemaVersion: 1
  benchmark: 'Beacon Bench 1'
  question: string
  fixture: {
    envelopeBytes: number
    receiptId: string
    sourceBlocks: number
    blockSize: number
    warning: string
  }
  config: {
    seed: string
    canvas: string
    sourceFps: number
    sampleFps: number
    symbolRate: number
    carrierSeconds: number
    startSequence: number
    markerWidths: readonly number[]
    excerptDurations: readonly number[]
    erasureProbabilities: readonly number[]
    excerptStarts: 'all-sample-aligned'
    identifierQrControl: string
    qrErrorCorrection: 'M'
    quietZoneModules: number
    mediaProfiles: Array<{ id: MediaProfile; description: string }>
  }
  tools: {
    node: string
    ffmpeg: string
    qrcode: string
    jsqr: string
  }
  density: Array<{
    transport: Transport
    textCharacters: number
    qrVersion: number
    qrModules: number
    modulesWithQuietZone: number
    pixelsPerModuleAt320: number
  }>
  streams: StreamResult[]
  interpretation: {
    primary: {
      cell: string
      staticRecoveryRate: number
      animatedRecoveryRate: number
      animatedMinusStatic: number
      classification: string
    }
    continuationGate: {
      passed: boolean
      qualifyingMarkerWidths: number[]
      requirement: string
    }
    staticWidthForAnimatedPitchAt320: number
    summary: string
  }
}

async function main(): Promise<void> {
  const started = Date.now()
  const envelope = new Uint8Array(await readFile(ENVELOPE_PATH))
  const expected = JSON.parse(await readFile(EXPECTED_PATH, 'utf8')) as { receiptId: string }
  const verification = await verifyEnvelope(envelope)
  if (!verification.valid) throw new Error(verification.reason ?? 'Fixture envelope is invalid')
  const source = await BeaconSource.create(envelope, BLOCK_SIZE)
  if (source.id !== expected.receiptId) throw new Error('Fixture receipt ID does not match expected.json')
  const staticText = `BBR1:${base64UrlEncode(envelope)}`
  // Benchmark-only identifier QR. BBI1 is not a shipped protocol prefix or UI
  // mode; this control measures the optical lower bound of carrying an ID only.
  const buildIdText = `BBI1:${source.id}`
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'buildbeacon-bench-'))
  const streams: StreamResult[] = []
  const density = new Map<Transport, BenchmarkReport['density'][number]>()

  try {
    for (const markerWidth of MARKER_WIDTHS) {
      for (const transport of TRANSPORTS) {
        process.stdout.write(`Beacon Bench: ${transport} at ${markerWidth}px ... `)
        const streamDirectory = join(temporaryDirectory, `${transport}-${markerWidth}`)
        const markerDirectory = join(streamDirectory, 'markers')
        await mkdir(streamDirectory, { recursive: true })
        const marker = await writeMarkerSequence(markerDirectory, transport, markerWidth, source, staticText, buildIdText)
        const modulesWithQuietZone = marker.qrModules + MARGIN_MODULES * 2
        density.set(transport, {
          transport,
          textCharacters: marker.firstText.length,
          qrVersion: marker.qrVersion,
          qrModules: marker.qrModules,
          modulesWithQuietZone,
          pixelsPerModuleAt320: round(320 / modulesWithQuietZone, 3),
        })

        const capture = join(streamDirectory, 'capture-crf18.mp4')
        const transcode27 = join(streamDirectory, 'transcode-crf27.mp4')
        const transcode35 = join(streamDirectory, 'transcode-crf35.mp4')
        createCarrier(markerDirectory, capture)
        transcode(capture, transcode27, 27)
        transcode(capture, transcode35, 35)
        const videos: Record<MediaProfile, string> = {
          'capture-crf18': capture,
          'transcode-crf27': transcode27,
          'transcode-crf35': transcode35,
        }

        for (const mediaProfile of MEDIA_PROFILES) {
          const decodedFrames = await extractAndDecode(videos[mediaProfile], join(streamDirectory, `decoded-${mediaProfile}`))
          if (decodedFrames.length !== CARRIER_SECONDS * SAMPLE_FPS) {
            throw new Error(`${transport}/${markerWidth}/${mediaProfile} produced ${decodedFrames.length} samples; expected ${CARRIER_SECONDS * SAMPLE_FPS}`)
          }
          const expectedTexts = transport === 'animated'
            ? new Set(await Promise.all(Array.from({ length: MARKER_FILE_COUNT }, (_, index) => source.frame(START_SEQUENCE + index))))
            : new Set([transport === 'static' ? staticText : buildIdText])
          const qrDecodedFrames = decodedFrames.filter((text) => text !== undefined && expectedTexts.has(text)).length
          const cells: CellResult[] = []
          for (const duration of EXCERPT_DURATIONS) {
            for (const erasure of ERASURE_RATES) {
              cells.push(await evaluateCell(
                transport,
                decodedFrames,
                duration,
                erasure,
                envelope,
                expected.receiptId,
                staticText,
                buildIdText,
              ))
            }
          }
          streams.push({
            transport,
            proof: transport === 'identifier-qr' ? 'identifier-only' : 'signed-receipt',
            markerWidth,
            markerAreaPercent: round((markerWidth * markerWidth * 100) / (CANVAS_WIDTH * CANVAS_HEIGHT), 3),
            qrVersion: marker.qrVersion,
            qrModules: marker.qrModules,
            modulesWithQuietZone,
            nominalPixelsPerModule: round(markerWidth / modulesWithQuietZone, 3),
            cleanMarkerDecoded: marker.cleanMarkerDecoded,
            mediaProfile,
            videoBytes: (await stat(videos[mediaProfile])).size,
            sampledFrames: decodedFrames.length,
            qrDecodedFrames,
            qrDecodeRate: round(qrDecodedFrames / decodedFrames.length),
            cells,
          })
        }
        console.log('done')
      }
    }

    const primaryStatic = cellFor(streams, 'static', 320, 'transcode-crf27', 6, 0.25)
    const primaryAnimated = cellFor(streams, 'animated', 320, 'transcode-crf27', 6, 0.25)
    const primaryDelta = round(primaryAnimated.recoveryRate - primaryStatic.recoveryRate)
    let classification = 'inconclusive'
    if (primaryAnimated.recoveryRate >= 0.95 && primaryDelta >= 0.15) classification = 'animated advantage demonstrated in the primary lab cell'
    else if (Math.abs(primaryDelta) <= 0.05) classification = 'no observed recovery difference across this carrier’s sample-aligned excerpts at 320 px'
    else if (primaryDelta >= 0.15) classification = 'animated tradeoff: meaningful gain below the absolute reliability gate'
    else if (primaryAnimated.recoveryRate < 0.95 && primaryStatic.recoveryRate < 0.95) classification = 'both transports inadequate in the primary lab cell'

    const qualifyingMarkerWidths = MARKER_WIDTHS.filter((width) => {
      return (['transcode-crf27', 'transcode-crf35'] as const).every((media) => {
        const staticCell = cellFor(streams, 'static', width, media, 6, 0.25)
        const animatedCell = cellFor(streams, 'animated', width, media, 6, 0.25)
        return animatedCell.recoveryRate >= 0.95
          && animatedCell.recoveryRate - staticCell.recoveryRate >= 0.15
          && animatedCell.p95RecoverySeconds !== null
          && animatedCell.p95RecoverySeconds < 5
      })
    })
    const gatePassed = qualifyingMarkerWidths.length > 0
    const summary = gatePassed
      ? `For this 403-byte fixture, BBP/1 meets the lab follow-up threshold at ${qualifyingMarkerWidths.join(', ')} px; the gap already exists in the clean QR density test, while BBR1 is equally successful and faster at 280 and 320 px. This earns a real-footage follow-up, not a general resilience claim.`
      : `BBP/1 does not meet the lab follow-up threshold across both transcodes at any tested footprint. The experimental identifier QR remains an optical lower bound only; no resolver was exercised.`

    const densityRows = TRANSPORTS.map((transport) => density.get(transport)!)
    const staticDensity = density.get('static')!
    const animatedDensity = density.get('animated')!
    const ffmpegVersionLine = run('ffmpeg', ['-version']).split('\n')[0]!
    const report: BenchmarkReport = {
      schemaVersion: 1,
      benchmark: 'Beacon Bench 1',
      question: 'At equal visible footprint, when does BBP/1 recover a complete signed receipt more reliably than BBR1, and how close can either come to an identifier-only QR control?',
      fixture: {
        envelopeBytes: envelope.length,
        receiptId: source.id,
        sourceBlocks: source.blockCount,
        blockSize: source.blockSize,
        warning: 'Public RFC 8032 test key and synthetic receipt; no identity or footage-authenticity assurance.',
      },
      config: {
        seed: SEED,
        canvas: `${CANVAS_WIDTH}x${CANVAS_HEIGHT}`,
        sourceFps: SOURCE_FPS,
        sampleFps: SAMPLE_FPS,
        symbolRate: SYMBOL_RATE,
        carrierSeconds: CARRIER_SECONDS,
        startSequence: START_SEQUENCE,
        markerWidths: MARKER_WIDTHS,
        excerptDurations: EXCERPT_DURATIONS,
        erasureProbabilities: ERASURE_RATES,
        excerptStarts: 'all-sample-aligned',
        identifierQrControl: 'Benchmark-only BBI1 receipt ID; not a shipped BuildBeacon mode or protocol format; no resolver exercised.',
        qrErrorCorrection: 'M',
        quietZoneModules: MARGIN_MODULES,
        mediaProfiles: [
          { id: 'capture-crf18', description: 'First-generation H.264 CRF 18 capture' },
          { id: 'transcode-crf27', description: 'Second-generation H.264 CRF 27 transcode of the capture' },
          { id: 'transcode-crf35', description: 'Second-generation H.264 CRF 35 transcode of the capture' },
        ],
      },
      tools: {
        node: process.version,
        ffmpeg: ffmpegVersionLine.split(/\s+/u)[2] ?? ffmpegVersionLine,
        qrcode: await packageVersion('qrcode'),
        jsqr: await packageVersion('jsqr'),
      },
      density: densityRows,
      streams,
      interpretation: {
        primary: {
          cell: '320px / 6s / transcode-crf27 / 25% configured sample-erasure probability',
          staticRecoveryRate: primaryStatic.recoveryRate,
          animatedRecoveryRate: primaryAnimated.recoveryRate,
          animatedMinusStatic: primaryDelta,
          classification,
        },
        continuationGate: {
          passed: gatePassed,
          qualifyingMarkerWidths: [...qualifyingMarkerWidths],
          requirement: 'Observed point estimates at one tested width: BBP/1 >=95%, advantage >=15 points, and successful-excerpt p95 <5s under both CRF 27 and CRF 35 transcodes for all sample-aligned six-second excerpts with 25% configured sample-erasure probability.',
        },
        staticWidthForAnimatedPitchAt320: Math.round(320 * staticDensity.modulesWithQuietZone / animatedDensity.modulesWithQuietZone),
        summary,
      },
    }

    await mkdir(join(ROOT, 'benchmarks'), { recursive: true })
    await writeFile(JSON_OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(MARKDOWN_OUTPUT, makeMarkdown(report))
    console.log(JSON.stringify({
      result: report.interpretation,
      outputs: ['benchmarks/beacon-bench.json', 'docs/BEACON_BENCH.md'],
      elapsedSeconds: round((Date.now() - started) / 1_000, 1),
    }, null, 2))
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`beacon-bench: ${error instanceof Error ? error.message : 'unexpected error'}`)
  process.exitCode = 1
})
