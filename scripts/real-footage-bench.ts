import { createHash } from 'node:crypto'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
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

type Transport = 'static' | 'animated'
type MediaProfile = 'upload-source' | 'local-crf27' | 'local-crf35'

interface CellResult {
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
  testId: string
  transport: Transport
  markerWidth: number
  qrVersion: number
  qrModules: number
  modulesWithQuietZone: number
  nominalPixelsPerModule: number
  cleanMarkerDecoded: boolean
  mediaProfile: MediaProfile
  videoBytes: number
  videoSha256: string
  sampledFrames: number
  qrDecodedFrames: number
  qrDecodeRate: number
  cells: CellResult[]
}

interface UploadCase {
  testId: string
  transport: Transport
  markerWidth: number
  filename: string
  relativePath: string
  sha256: string
  bytes: number
}

interface PlatformManifest {
  schemaVersion: 1
  experiment: string
  generatedAt: string
  fixture: {
    receiptId: string
    envelopeBytes: number
    sourceBlocks: number
    blockSize: number
  }
  carrier: {
    source: string
    durationSeconds: number
    width: number
    height: number
    fps: number
    sha256: string
  }
  uploadCases: UploadCase[]
  platformSlots: Array<{ id: string; status: 'pending'; platform: null }>
  downloadNaming: string
}

interface BenchmarkReport {
  schemaVersion: 1
  benchmark: string
  generatedAt: string
  question: string
  fixture: PlatformManifest['fixture'] & { warning: string }
  carrier: PlatformManifest['carrier'] & { contactSheet: string }
  config: {
    seed: string
    sampleFps: number
    symbolRate: number
    startSequence: number
    markerWidths: readonly number[]
    excerptSeconds: number
    erasureProbabilities: readonly number[]
    excerptStarts: string
    markerPosition: string
    qrErrorCorrection: string
    quietZoneModules: number
    mediaProfiles: Array<{ id: MediaProfile; description: string }>
  }
  tools: Record<string, string>
  streams: StreamResult[]
  interpretation: {
    threshold: Array<{
      markerWidth: number
      mediaProfile: MediaProfile
      staticRecoveryRate: number
      animatedRecoveryRate: number
      animatedMinusStatic: number
    }>
    smallestWidthWithBothReliable: number | null
    smallestWidthWithAnimatedReliable: number | null
    summary: string
    platformRoundTrips: 'prepared-not-run'
  }
}

const ROOT = resolve(import.meta.dirname, '..')
const ENVELOPE_PATH = join(ROOT, 'examples', 'demo', 'signed-receipt.bb')
const OUTPUT_ROOT = join(ROOT, 'bench-results', 'real-footage')
const UPLOAD_ROOT = join(OUTPUT_ROOT, 'uploads')
const JSON_OUTPUT = join(ROOT, 'benchmarks', 'real-footage-bench.json')
const MANIFEST_OUTPUT = join(ROOT, 'benchmarks', 'platform-roundtrip-manifest.json')
const MARKDOWN_OUTPUT = join(ROOT, 'docs', 'REAL_FOOTAGE_BENCH.md')
const CONTACT_SHEET_OUTPUT = join(ROOT, 'docs', 'assets', 'real-footage-carrier.jpg')
const MARKER_WIDTHS = [240, 260, 280] as const
const TRANSPORTS: Transport[] = ['static', 'animated']
const MEDIA_PROFILES: MediaProfile[] = ['upload-source', 'local-crf27', 'local-crf35']
const ERASURE_RATES = [0, 0.25] as const
const SEED = 'buildbeacon-real-footage-v1'
const CANVAS_WIDTH = 1_280
const CANVAS_HEIGHT = 720
const SOURCE_FPS = 30
const SAMPLE_FPS = 8
const SYMBOL_RATE = 2
const CARRIER_SECONDS = 12
const EXCERPT_SECONDS = 6
const SYMBOL_COUNT = CARRIER_SECONDS * SYMBOL_RATE
const MARKER_FILE_COUNT = SYMBOL_COUNT + 1
const START_SEQUENCE = 73
const BLOCK_SIZE = 64
const MARGIN_MODULES = 4
const SERVER_URL = 'http://127.0.0.1:4175'

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

function shouldErase(excerptStart: number, absoluteFrame: number, rate: number): boolean {
  if (rate === 0) return false
  return hash32(`${SEED}:erase:${EXCERPT_SECONDS}:${excerptStart}:${absoluteFrame}`) / 0x1_0000_0000 < rate
}

function percent(value: number): string {
  return `${round(value * 100, 1).toFixed(1)}%`
}

function seconds(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(3)} s`
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function packageVersion(name: string): Promise<string> {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }
  return packageJson.version
}

function decodePng(buffer: Buffer): string | undefined {
  const png = PNG.sync.read(buffer)
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'dontInvert' })?.data
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
  let output = ''
  server.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  server.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite exited before capture:\n${output.trim()}`)
    try {
      const response = await fetch(SERVER_URL)
      if (response.ok) return
    } catch {
      // The server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  throw new Error(`Timed out waiting for ${SERVER_URL}\n${output.trim()}`)
}

async function captureBrowserCarrier(temporaryDirectory: string, output: string): Promise<void> {
  const videoDirectory = join(temporaryDirectory, 'playwright-video')
  await mkdir(videoDirectory, { recursive: true })
  const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4175', '--strictPort'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  server.stdin.end()
  let browser
  try {
    await waitForServer(server)
    browser = await chromium.launch()
    const context = await browser.newContext({
      viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      recordVideo: { dir: videoDirectory, size: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT } },
      reducedMotion: 'reduce',
      colorScheme: 'dark',
    })
    const page = await context.newPage()
    const pageCreatedAt = Date.now()
    await page.goto(SERVER_URL, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: /Prove the receipt/i }).waitFor()
    await page.addStyleTag({ content: `
      html { scroll-behavior: auto !important; }
      * { caret-color: transparent !important; }
      .beacon-stage:not(.beacon-stage--id) { position: relative; background: #f5f3ec !important; }
      .beacon-stage:not(.beacon-stage--id)::after {
        content: 'CONTROLLED MARKER RESERVED';
        position: absolute;
        inset: 18px;
        display: grid;
        place-items: center;
        border: 1px dashed #a9aaa3;
        color: #6d7470;
        font: 650 10px/1 ui-monospace, monospace;
        letter-spacing: .12em;
      }
      .beacon-canvas { visibility: hidden !important; }
    ` })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(300)

    const walkthroughStartedAt = Date.now()
    await page.waitForTimeout(3_000)
    await page.evaluate(() => document.querySelector('#workbench')?.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(3_000)
    await page.locator('.mode-tabs button').filter({ hasText: 'recover' }).click()
    await page.waitForTimeout(3_000)
    await page.locator('.mode-tabs button').filter({ hasText: 'inspect' }).click()
    await page.waitForTimeout(3_500)

    const rawVideo = join(temporaryDirectory, 'browser-recording.webm')
    const video = page.video()
    if (!video) throw new Error('Playwright did not create a browser recording')
    const savePromise = video.saveAs(rawVideo)
    await context.close()
    await savePromise

    const trimStart = Math.max(0, (walkthroughStartedAt - pageCreatedAt) / 1_000)
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', trimStart.toFixed(3), '-i', rawVideo,
      '-vf', `fps=${SOURCE_FPS},scale=${CANVAS_WIDTH}:${CANVAS_HEIGHT}:force_original_aspect_ratio=decrease,pad=${CANVAS_WIDTH}:${CANVAS_HEIGHT}:(ow-iw)/2:(oh-ih)/2,tpad=stop_mode=clone:stop_duration=1`,
      '-t', String(CARRIER_SECONDS), '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv444p', output,
    ])
  } finally {
    if (browser) await browser.close()
    if (server.exitCode === null) server.kill('SIGTERM')
  }
}

async function writeMarkerSequence(
  directory: string,
  transport: Transport,
  markerWidth: number,
  source: BeaconSource,
  staticText: string,
): Promise<{ cleanMarkerDecoded: boolean; qrVersion: number; qrModules: number }> {
  await mkdir(directory, { recursive: true })
  let firstText = ''
  let firstBuffer: Buffer | undefined
  for (let index = 0; index < MARKER_FILE_COUNT; index += 1) {
    const text = transport === 'static' ? staticText : await source.frame(START_SEQUENCE + index)
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
  if (!firstBuffer) throw new Error(`${transport} did not render a marker`)
  const qr = QRCode.create(firstText, { errorCorrectionLevel: 'M' })
  return {
    cleanMarkerDecoded: decodePng(firstBuffer) === firstText,
    qrVersion: qr.version,
    qrModules: qr.modules.size,
  }
}

function overlayMarker(carrier: string, markerDirectory: string, output: string): void {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', carrier,
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
  erasureProbability: number,
  expectedEnvelope: Uint8Array,
  expectedReceiptId: string,
  staticText: string,
): Promise<CellResult> {
  const windowFrames = EXCERPT_SECONDS * SAMPLE_FPS
  if (decodedFrames.length < windowFrames) {
    return {
      erasureProbability,
      excerpts: 0,
      successes: 0,
      recoveryRate: 0,
      eligibleObservations: 0,
      erasedObservations: 0,
      realizedErasureRate: 0,
      medianRecoverySeconds: null,
      p95RecoverySeconds: null,
      failures: { 'insufficient-duration': 1 },
      medianUniquePackets: null,
      medianFinalRank: null,
    }
  }
  const starts = Array.from({ length: decodedFrames.length - windowFrames + 1 }, (_, index) => index)
  const recoverySeconds: number[] = []
  const uniquePackets: number[] = []
  const finalRanks: number[] = []
  const failures: Record<string, number> = {}
  let eligibleObservations = 0
  let erasedObservations = 0

  for (const start of starts) {
    for (let relativeFrame = 0; relativeFrame < windowFrames; relativeFrame += 1) {
      eligibleObservations += 1
      if (shouldErase(start, start + relativeFrame, erasureProbability)) erasedObservations += 1
    }
    const receiver = transport === 'animated' ? new BeaconReceiver() : undefined
    let decodedAny = false
    let relevantAny = false
    let succeeded = false
    for (let relativeFrame = 0; relativeFrame < windowFrames; relativeFrame += 1) {
      const absoluteFrame = start + relativeFrame
      if (shouldErase(start, absoluteFrame, erasureProbability)) {
        continue
      }
      const text = decodedFrames[absoluteFrame]
      if (!text) continue
      decodedAny = true

      if (transport === 'static') {
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

function findCell(streams: StreamResult[], transport: Transport, width: number, profile: MediaProfile, erasure: number): CellResult {
  const stream = streams.find((candidate) => candidate.transport === transport && candidate.markerWidth === width && candidate.mediaProfile === profile)
  const cell = stream?.cells.find((candidate) => candidate.erasureProbability === erasure)
  if (!cell) throw new Error(`Missing ${transport}/${width}/${profile}/${erasure} result`)
  return cell
}

function makeMarkdown(report: BenchmarkReport): string {
  const lines = [
    '# Real-footage Beacon Bench',
    '',
    `**Question:** ${report.question}`,
    '',
    `**Bottom line:** ${report.interpretation.summary}`,
    '',
    '![Four states from the browser-recorded BuildBeacon carrier](assets/real-footage-carrier.jpg)',
    '',
    'The carrier is a real Chromium recording of the public BuildBeacon interface moving through Hero, Transmit, Recover, and Inspect. Its own demonstration QR canvases are suppressed during capture so the controlled overlay is the only machine-readable marker. This is more representative than a generated test pattern, but it is still one local browser, one screen-recording codec, and one overlay position.',
    '',
    'Reproduce the capture and complete local matrix with Node.js 22+, ffmpeg, and a Playwright Chromium installation:',
    '',
    '```sh',
    'npm ci',
    'npx playwright install chromium',
    'npm run bench:real',
    '```',
    '',
    '## Six-second recovery with 25% seeded sample erasure',
    '',
    '| Marker | Media path | Static BBR1 | Animated BBP/1 | Animated delta | Animated p95* |',
    '|---:|---|---:|---:|---:|---:|',
  ]
  for (const width of MARKER_WIDTHS) {
    for (const profile of MEDIA_PROFILES) {
      const staticCell = findCell(report.streams, 'static', width, profile, 0.25)
      const animatedCell = findCell(report.streams, 'animated', width, profile, 0.25)
      lines.push(`| ${width}px | ${profile} | ${staticCell.successes}/${staticCell.excerpts} (${percent(staticCell.recoveryRate)}) | ${animatedCell.successes}/${animatedCell.excerpts} (${percent(animatedCell.recoveryRate)}) | ${round((animatedCell.recoveryRate - staticCell.recoveryRate) * 100, 1).toFixed(1)} pp | ${seconds(animatedCell.p95RecoverySeconds)} |`)
    }
  }
  lines.push(
    '',
    '*Recovery timing starts at the first sampled frame and is reported only for successful excerpts.',
    '',
    '## Optical decode rate before simulated sample loss',
    '',
    '| Marker | Media path | Static frame decode | Animated frame decode |',
    '|---:|---|---:|---:|',
  )
  for (const width of MARKER_WIDTHS) {
    for (const profile of MEDIA_PROFILES) {
      const staticStream = report.streams.find((stream) => stream.transport === 'static' && stream.markerWidth === width && stream.mediaProfile === profile)!
      const animatedStream = report.streams.find((stream) => stream.transport === 'animated' && stream.markerWidth === width && stream.mediaProfile === profile)!
      lines.push(`| ${width}px | ${profile} | ${staticStream.qrDecodedFrames}/${staticStream.sampledFrames} (${percent(staticStream.qrDecodeRate)}) | ${animatedStream.qrDecodedFrames}/${animatedStream.sampledFrames} (${percent(animatedStream.qrDecodeRate)}) |`)
    }
  }
  lines.push(
    '',
    '## Fixed conditions',
    '',
    `- Browser carrier: ${report.carrier.width}×${report.carrier.height}, ${report.carrier.fps} fps, ${report.carrier.durationSeconds} seconds; Playwright Chromium recording normalized losslessly before marker composition.`,
    `- Marker: bottom-right with 56 px inset, ${MARKER_WIDTHS.join('/')} px square, QR error correction M, ${MARGIN_MODULES}-module quiet zone, ${SYMBOL_RATE} BBP/1 symbols per second.`,
    `- Receipt: the checked-in ${report.fixture.envelopeBytes}-byte signed fixture, ${report.fixture.sourceBlocks} source blocks of ${report.fixture.blockSize} bytes, beginning at sequence ${START_SEQUENCE}.`,
    `- Receiver: full ${CANVAS_WIDTH}×${CANVAS_HEIGHT} frames sampled at ${SAMPLE_FPS} fps; all sample-aligned ${EXCERPT_SECONDS}-second windows; no marker crop is supplied.`,
    '- Media paths: upload-source is H.264 CRF 18 from the browser carrier; local-crf27 and local-crf35 are second-generation H.264 transcodes of that exact file.',
    '- The 25% loss condition erases sampled observations after optical decoding. It does not erase entire two-Hz source symbols.',
    '',
    '## Platform round trips',
    '',
    'Six exact upload artifacts and their SHA-256 hashes are recorded in [`../benchmarks/platform-roundtrip-manifest.json`](../benchmarks/platform-roundtrip-manifest.json). Two platform slots remain deliberately unnamed and unrun: publishing to external accounts requires an explicit platform and visibility choice. After downloading each returned set with its original test IDs, run:',
    '',
    '```sh',
    'npm run bench:platform -- <platform-slug> /absolute/path/to/download-directory',
    '```',
    '',
    'The analyzer hashes every returned file, scans whole frames, verifies recovered signed bytes, and writes a per-platform JSON result under the ignored `bench-results/real-footage/returns/` directory.',
    '',
    '## What this does not establish',
    '',
    '- No named social platform has been tested yet, so this report makes no platform-survival claim.',
    '- The visible receipt can still be copied onto unrelated footage; BuildBeacon is not a video-authenticity system.',
    '- One interface, codec stack, overlay position, receipt size, QR decoder, and recording resolution cannot establish broad reliability.',
    '',
    `Machine-readable results: [real-footage-bench.json](../benchmarks/real-footage-bench.json). Exact upload hashes: [platform-roundtrip-manifest.json](../benchmarks/platform-roundtrip-manifest.json).`,
    '',
  )
  return `${lines.join('\n')}\n`
}

async function writeContactSheet(carrier: string): Promise<void> {
  await mkdir(resolve(CONTACT_SHEET_OUTPUT, '..'), { recursive: true })
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', carrier,
    '-vf', `fps=1/3,scale=640:360,tile=2x2:padding=2:margin=0`,
    '-frames:v', '1', '-q:v', '3', CONTACT_SHEET_OUTPUT,
  ])
}

async function runExperiment(): Promise<void> {
  const started = Date.now()
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'buildbeacon-real-footage-'))
  try {
    await mkdir(UPLOAD_ROOT, { recursive: true })
    const envelope = new Uint8Array(await readFile(ENVELOPE_PATH))
    const source = await BeaconSource.create(envelope, BLOCK_SIZE)
    const staticText = `BBR1:${base64UrlEncode(envelope)}`
    const carrier = join(temporaryDirectory, 'browser-carrier.mkv')

    console.log('capture: recording the BuildBeacon browser walkthrough')
    await captureBrowserCarrier(temporaryDirectory, carrier)
    await writeContactSheet(carrier)

    const streams: StreamResult[] = []
    const uploadCases: UploadCase[] = []
    for (const width of MARKER_WIDTHS) {
      for (const transport of TRANSPORTS) {
        const testId = `${transport}-${width}`
        const markerDirectory = join(temporaryDirectory, `markers-${testId}`)
        const density = await writeMarkerSequence(markerDirectory, transport, width, source, staticText)
        const uploadPath = join(UPLOAD_ROOT, `buildbeacon-${testId}.mp4`)
        overlayMarker(carrier, markerDirectory, uploadPath)
        const uploadStat = await stat(uploadPath)
        uploadCases.push({
          testId,
          transport,
          markerWidth: width,
          filename: basename(uploadPath),
          relativePath: uploadPath.slice(ROOT.length + 1),
          sha256: await sha256File(uploadPath),
          bytes: uploadStat.size,
        })

        const videos: Record<MediaProfile, string> = {
          'upload-source': uploadPath,
          'local-crf27': join(temporaryDirectory, `${testId}-crf27.mp4`),
          'local-crf35': join(temporaryDirectory, `${testId}-crf35.mp4`),
        }
        transcode(uploadPath, videos['local-crf27'], 27)
        transcode(uploadPath, videos['local-crf35'], 35)

        for (const profile of MEDIA_PROFILES) {
          process.stdout.write(`decode: ${testId} / ${profile} ... `)
          const decodedFrames = await extractAndDecode(videos[profile], join(temporaryDirectory, `frames-${testId}-${profile}`))
          const cells: CellResult[] = []
          for (const erasure of ERASURE_RATES) {
            cells.push(await evaluateCell(transport, decodedFrames, erasure, envelope, source.id, staticText))
          }
          const videoStat = await stat(videos[profile])
          streams.push({
            testId,
            transport,
            markerWidth: width,
            qrVersion: density.qrVersion,
            qrModules: density.qrModules,
            modulesWithQuietZone: density.qrModules + MARGIN_MODULES * 2,
            nominalPixelsPerModule: round(width / (density.qrModules + MARGIN_MODULES * 2), 3),
            cleanMarkerDecoded: density.cleanMarkerDecoded,
            mediaProfile: profile,
            videoBytes: videoStat.size,
            videoSha256: await sha256File(videos[profile]),
            sampledFrames: decodedFrames.length,
            qrDecodedFrames: decodedFrames.filter(Boolean).length,
            qrDecodeRate: round(decodedFrames.filter(Boolean).length / decodedFrames.length),
            cells,
          })
          console.log('done')
        }
      }
    }

    const threshold = MARKER_WIDTHS.flatMap((width) => MEDIA_PROFILES.map((profile) => {
      const staticCell = findCell(streams, 'static', width, profile, 0.25)
      const animatedCell = findCell(streams, 'animated', width, profile, 0.25)
      return {
        markerWidth: width,
        mediaProfile: profile,
        staticRecoveryRate: staticCell.recoveryRate,
        animatedRecoveryRate: animatedCell.recoveryRate,
        animatedMinusStatic: round(animatedCell.recoveryRate - staticCell.recoveryRate),
      }
    }))
    const smallestWidthWithBothReliable = MARKER_WIDTHS.find((width) => MEDIA_PROFILES.every((profile) => {
      return findCell(streams, 'static', width, profile, 0.25).recoveryRate >= 0.95
        && findCell(streams, 'animated', width, profile, 0.25).recoveryRate >= 0.95
    })) ?? null
    const smallestWidthWithAnimatedReliable = MARKER_WIDTHS.find((width) => MEDIA_PROFILES.every((profile) => {
      return findCell(streams, 'animated', width, profile, 0.25).recoveryRate >= 0.95
    })) ?? null
    const summary = smallestWidthWithAnimatedReliable === null
      ? 'BBP/1 did not maintain 95% recovery across all three local media paths at any tested size; do not spend platform-test effort until the optical path improves.'
      : smallestWidthWithBothReliable === null
        ? `At the smallest tested width, ${smallestWidthWithAnimatedReliable} px, BBP/1 maintained at least 95% recovery through CRF 35 while static BBR1 never did across the tested range. The observed width advantage survives a real browser carrier and earns the prepared platform round trips.`
        : smallestWidthWithAnimatedReliable < smallestWidthWithBothReliable
          ? `BBP/1 maintained at least 95% recovery through CRF 35 at ${smallestWidthWithAnimatedReliable} px; both transports reached the same bar at ${smallestWidthWithBothReliable} px. The tested crossover lies between those widths on a real browser carrier and earns the prepared platform round trips.`
          : `Both transports maintained at least 95% recovery through CRF 35 at the smallest reliable tested width, ${smallestWidthWithBothReliable} px. BBP/1 showed no smaller reliable footprint in this test set, so platform tests should focus on durability rather than a width claim.`

    const generatedAt = new Date().toISOString()
    const carrierHash = await sha256File(carrier)
    const carrierDescription = 'Playwright Chromium recording of the local BuildBeacon UI, normalized to lossless FFV1 before marker composition'
    const manifest: PlatformManifest = {
      schemaVersion: 1,
      experiment: 'BuildBeacon real-footage platform round trip',
      generatedAt,
      fixture: { receiptId: source.id, envelopeBytes: envelope.length, sourceBlocks: source.blockCount, blockSize: source.blockSize },
      carrier: { source: carrierDescription, durationSeconds: CARRIER_SECONDS, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, fps: SOURCE_FPS, sha256: carrierHash },
      uploadCases,
      platformSlots: [
        { id: 'platform-a', status: 'pending', platform: null },
        { id: 'platform-b', status: 'pending', platform: null },
      ],
      downloadNaming: 'Keep or restore each original filename; the analyzer also accepts any extension when the basename begins with the test ID.',
    }
    const ffmpegVersionLine = run('ffmpeg', ['-version']).split('\n')[0]!
    const report: BenchmarkReport = {
      schemaVersion: 1,
      benchmark: 'Real-footage Beacon Bench',
      generatedAt,
      question: 'Does the 240–280 px static-versus-animated crossover survive a real BuildBeacon browser recording, and are the exact artifacts ready for two platform round trips?',
      fixture: { ...manifest.fixture, warning: 'Public RFC 8032 test key and demo receipt; no identity or footage-authenticity assurance.' },
      carrier: { ...manifest.carrier, contactSheet: 'docs/assets/real-footage-carrier.jpg' },
      config: {
        seed: SEED,
        sampleFps: SAMPLE_FPS,
        symbolRate: SYMBOL_RATE,
        startSequence: START_SEQUENCE,
        markerWidths: MARKER_WIDTHS,
        excerptSeconds: EXCERPT_SECONDS,
        erasureProbabilities: ERASURE_RATES,
        excerptStarts: 'all-sample-aligned',
        markerPosition: 'bottom-right, 56px inset',
        qrErrorCorrection: 'M',
        quietZoneModules: MARGIN_MODULES,
        mediaProfiles: [
          { id: 'upload-source', description: 'H.264 CRF 18 marker composition over the normalized Chromium recording' },
          { id: 'local-crf27', description: 'Second-generation H.264 CRF 27 transcode of the upload source' },
          { id: 'local-crf35', description: 'Second-generation H.264 CRF 35 transcode of the upload source' },
        ],
      },
      tools: {
        node: process.version,
        playwright: await packageVersion('@playwright/test'),
        chromium: await chromium.launch().then(async (browser) => {
          const version = browser.version()
          await browser.close()
          return version
        }),
        ffmpeg: ffmpegVersionLine.split(/\s+/u)[2] ?? ffmpegVersionLine,
        qrcode: await packageVersion('qrcode'),
        jsqr: await packageVersion('jsqr'),
      },
      streams,
      interpretation: {
        threshold,
        smallestWidthWithBothReliable,
        smallestWidthWithAnimatedReliable,
        summary,
        platformRoundTrips: 'prepared-not-run',
      },
    }

    await mkdir(join(ROOT, 'benchmarks'), { recursive: true })
    await writeFile(JSON_OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(MANIFEST_OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(MARKDOWN_OUTPUT, makeMarkdown(report))
    console.log(JSON.stringify({
      result: report.interpretation,
      outputs: [
        'benchmarks/real-footage-bench.json',
        'benchmarks/platform-roundtrip-manifest.json',
        'docs/REAL_FOOTAGE_BENCH.md',
        'docs/assets/real-footage-carrier.jpg',
        'bench-results/real-footage/uploads/*.mp4',
      ],
      elapsedSeconds: round((Date.now() - started) / 1_000, 1),
    }, null, 2))
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function findReturnedVideo(directory: string, testId: string, originalFilename: string): Promise<string> {
  const names = await readdir(directory)
  const exact = names.find((name) => name === originalFilename)
  if (exact) return join(directory, exact)
  const prefixMatches = names.filter((name) => name.startsWith(testId) || name.startsWith(`buildbeacon-${testId}.`))
  if (prefixMatches.length !== 1) {
    throw new Error(`Expected one returned file for ${testId} in ${directory}; found ${prefixMatches.length}`)
  }
  return join(directory, prefixMatches[0]!)
}

async function analyzePlatform(platform: string, directory: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(platform)) throw new Error('Platform slug must use lowercase letters, numbers, and hyphens')
  const manifest = JSON.parse(await readFile(MANIFEST_OUTPUT, 'utf8')) as PlatformManifest
  const envelope = new Uint8Array(await readFile(ENVELOPE_PATH))
  const source = await BeaconSource.create(envelope, BLOCK_SIZE)
  if (source.id !== manifest.fixture.receiptId) throw new Error('Checked-in fixture no longer matches the platform manifest')
  const staticText = `BBR1:${base64UrlEncode(envelope)}`
  const temporaryDirectory = await mkdtemp(join(tmpdir(), `buildbeacon-${platform}-`))
  try {
    const results = []
    for (const uploadCase of manifest.uploadCases) {
      const returnedPath = await findReturnedVideo(directory, uploadCase.testId, uploadCase.filename)
      process.stdout.write(`analyze: ${uploadCase.testId} ... `)
      const decodedFrames = await extractAndDecode(returnedPath, join(temporaryDirectory, uploadCase.testId))
      const cells = []
      for (const erasure of ERASURE_RATES) {
        cells.push(await evaluateCell(uploadCase.transport, decodedFrames, erasure, envelope, source.id, staticText))
      }
      results.push({
        testId: uploadCase.testId,
        transport: uploadCase.transport,
        markerWidth: uploadCase.markerWidth,
        uploadSha256: uploadCase.sha256,
        returnedFilename: basename(returnedPath),
        returnedSha256: await sha256File(returnedPath),
        byteIdenticalToUpload: await sha256File(returnedPath) === uploadCase.sha256,
        returnedBytes: (await stat(returnedPath)).size,
        sampledFrames: decodedFrames.length,
        qrDecodedFrames: decodedFrames.filter(Boolean).length,
        qrDecodeRate: round(decodedFrames.filter(Boolean).length / decodedFrames.length),
        cells,
      })
      console.log('done')
    }
    const output = {
      schemaVersion: 1,
      experiment: manifest.experiment,
      platform,
      analyzedAt: new Date().toISOString(),
      sourceManifestSha256: await sha256File(MANIFEST_OUTPUT),
      results,
    }
    const returnDirectory = join(OUTPUT_ROOT, 'returns')
    await mkdir(returnDirectory, { recursive: true })
    const outputPath = join(returnDirectory, `${platform}.json`)
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)
    console.log(JSON.stringify({ output: outputPath, results }, null, 2))
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === '--analyze-platform') {
    const platform = process.argv[3]
    const directory = process.argv[4]
    if (!platform || !directory) throw new Error('Usage: real-footage-bench.ts --analyze-platform <platform-slug> <download-directory>')
    await analyzePlatform(platform, resolve(directory))
    return
  }
  if (process.argv.length > 2) throw new Error('Unknown arguments. Run without arguments, or use --analyze-platform <platform-slug> <download-directory>.')
  await runExperiment()
}

main().catch((error) => {
  console.error(`real-footage-bench: ${error instanceof Error ? error.message : 'unexpected error'}`)
  process.exitCode = 1
})
