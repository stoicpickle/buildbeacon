import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import QRCode from 'qrcode'
import { BeaconSource, base64UrlEncode, demoReceipt, fromHex, signReceipt, verifyEnvelope } from '../src/lib/index'

// RFC 8032 test vector #1. This key is intentionally public and unsafe for any
// real receipt. It exists only to make the checked-in media fixture reproducible.
const PUBLIC_TEST_SECRET = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
const FRAME_RATE = 8
const FRAME_COUNT = 48
const START_SEQUENCE = 73

const root = resolve(import.meta.dirname, '..')
const publicDirectory = join(root, 'public', 'demo')
const exampleDirectory = join(root, 'examples', 'demo')
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'buildbeacon-demo-'))

try {
  await mkdir(publicDirectory, { recursive: true })
  await mkdir(exampleDirectory, { recursive: true })
  const receipt = demoReceipt()
  const envelope = await signReceipt(receipt, PUBLIC_TEST_SECRET)
  const verification = await verifyEnvelope(envelope)
  const source = await BeaconSource.create(envelope, 64)
  let duplicateFrames = 0

  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const intendedSequence = START_SEQUENCE + index
    const sequence = index > 0 && index % 4 === 0 ? intendedSequence - 1 : intendedSequence
    if (sequence !== intendedSequence) duplicateFrames += 1
    const packet = await source.frame(sequence)
    const png = await QRCode.toBuffer(packet, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 320,
      color: { dark: '#080a0c', light: '#ffffff' },
    })
    await writeFile(join(temporaryDirectory, `frame-${String(index).padStart(4, '0')}.png`), png)
  }

  const outputVideo = join(publicDirectory, 'buildbeacon-six-second.mp4')
  const staticPng = await QRCode.toBuffer(`BBR1:${base64UrlEncode(envelope)}`, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 720,
    color: { dark: '#080a0c', light: '#ffffff' },
  })
  await writeFile(join(publicDirectory, 'buildbeacon-static.png'), staticPng)
  const invalidEnvelope = new Uint8Array(envelope)
  invalidEnvelope[invalidEnvelope.length - 1]! ^= 1
  const invalidStaticPng = await QRCode.toBuffer(`BBR1:${base64UrlEncode(invalidEnvelope)}`, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 720,
    color: { dark: '#080a0c', light: '#ffffff' },
  })
  await writeFile(join(publicDirectory, 'buildbeacon-static-invalid.png'), invalidStaticPng)
  const background = [
    "[0:v]drawbox=x=42:y=48:w=790:h=624:color=0x141d25:t=fill",
    "drawbox=x=42:y=48:w=790:h=44:color=0x202d38:t=fill",
    "drawbox=x=68:y=65:w=10:h=10:color=0xe9634c:t=fill",
    "drawbox=x=86:y=65:w=10:h=10:color=0xf4b94e:t=fill",
    "drawbox=x=104:y=65:w=10:h=10:color=0xc8ff52:t=fill",
    "drawbox=x=75:y=132:w=690:h=3:color=0xc8ff52:t=fill",
    "drawbox=x=75:y=177:w=380:h=14:color=0x94a09e:t=fill",
    "drawbox=x=75:y=225:w=520:h=14:color=0x94a09e:t=fill",
    "drawbox=x=75:y=273:w=250:h=14:color=0xc8ff52:t=fill",
    "drawbox=x=75:y=352:w=690:h=1:color=0x34424c:t=fill",
    "drawbox=x=75:y=397:w=585:h=12:color=0x65736f:t=fill",
    "drawbox=x=75:y=438:w=630:h=12:color=0x65736f:t=fill",
    "drawbox=x=75:y=479:w=495:h=12:color=0x65736f:t=fill",
    "drawbox=x=75:y=592:w=450:h=8:color=0x34424c:t=fill[bg]",
    '[bg][1:v]overlay=x=W-w-56:y=H-h-56:shortest=1[out]',
  ].join(',')

  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=0x0d1117:s=1280x720:r=${FRAME_RATE}:d=6`,
      '-framerate', String(FRAME_RATE), '-start_number', '0', '-i', join(temporaryDirectory, 'frame-%04d.png'),
      '-filter_complex', background,
      '-map', '[out]', '-t', '6', '-r', String(FRAME_RATE),
      '-c:v', 'libx264', '-crf', '27', '-preset', 'medium', '-g', String(FRAME_RATE),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputVideo,
    ],
    { stdio: 'inherit' },
  )

  await writeFile(join(exampleDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  await writeFile(join(exampleDirectory, 'signed-receipt.bb'), envelope)
  await writeFile(join(exampleDirectory, 'frame-0073.txt'), `${await source.frame(START_SEQUENCE)}\n`)
  await writeFile(
    join(exampleDirectory, 'expected.json'),
    `${JSON.stringify({
      protocol: 'BBP/1',
      receiptId: source.id,
      keyId: verification.keyId,
      startSequence: START_SEQUENCE,
      sourceBlocks: source.blockCount,
      frames: FRAME_COUNT,
      duplicateFrames,
      durationSeconds: 6,
      resolution: '1280x720',
      codec: 'H.264 CRF 27 yuv420p',
      staticFixture: 'public/demo/buildbeacon-static.png',
      warning: 'The key is a public RFC 8032 test vector and the receipt is an explicitly synthetic fixture over the real initial commit. Neither provides identity assurance.',
    }, null, 2)}\n`,
  )
  console.log(`Generated ${outputVideo}`)
  console.log(`Receipt ${source.id}; ${FRAME_COUNT - duplicateFrames} unique candidate frames and ${duplicateFrames} duplicates`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
