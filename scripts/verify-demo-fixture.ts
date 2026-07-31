import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { BeaconReceiver, verifyEnvelope } from '../src/lib/index'

const root = resolve(import.meta.dirname, '..')
const video = join(root, 'public', 'demo', 'buildbeacon-six-second.mp4')
const expected = JSON.parse(await readFile(join(root, 'examples', 'demo', 'expected.json'), 'utf8')) as { receiptId: string }
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'buildbeacon-verify-'))

try {
  execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', 'fps=8', join(temporaryDirectory, 'frame-%03d.png')],
    { stdio: 'inherit' },
  )
  const receiver = new BeaconReceiver()
  let sampledFrames = 0
  for (let index = 1; index <= 48 && !receiver.progress.complete; index += 1) {
    const png = PNG.sync.read(await readFile(join(temporaryDirectory, `frame-${String(index).padStart(3, '0')}.png`)))
    sampledFrames += 1
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'dontInvert' })
    if (decoded?.data.startsWith('BB1:')) await receiver.add(decoded.data)
  }
  const progress = receiver.progress
  if (!progress.complete || !progress.payload) throw new Error(`Pixel recovery stopped at matrix rank ${progress.rank}/${progress.required}`)
  if (progress.receiptId !== expected.receiptId) throw new Error(`Recovered unexpected receipt ${progress.receiptId}`)
  const verification = await verifyEnvelope(progress.payload)
  if (!verification.valid) throw new Error(verification.reason ?? 'Recovered receipt signature is invalid')
  console.log(JSON.stringify({
    video: 'public/demo/buildbeacon-six-second.mp4',
    sampledFrames,
    uniquePackets: progress.uniqueFrames,
    matrixRank: `${progress.rank}/${progress.required}`,
    receiptId: progress.receiptId,
    signatureValid: verification.signatureValid,
    trust: verification.trust,
  }, null, 2))
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
