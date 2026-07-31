#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { stdin, stdout } from 'node:process'
import QRCode from 'qrcode'
import {
  BeaconReceiver,
  BeaconSource,
  base64UrlDecode,
  demoReceipt,
  generateSigningKey,
  signReceipt,
  validateReceipt,
  verifyEnvelope,
  type BuildReceipt,
  type SigningKeyFile,
} from './lib/index'

const HELP = `BuildBeacon 0.1 — visual transport for signed build receipts

Usage:
  buildbeacon keygen --out <key.json>
  buildbeacon create --input <receipt.json> --key <key.json|-> --out <receipt.bb>
  buildbeacon verify --input <receipt.bb>
  buildbeacon simulate --input <receipt.bb> [--offset 73] [--loss 0.30] [--frames 96]
  buildbeacon frames --input <receipt.bb> --out-dir <directory> [--count 24] [--offset 0]
  buildbeacon demo --out <receipt.json>

Private keys are accepted only from a mode-0600 file or stdin. Receipt and frame
verification is local; a valid self-presented key does not establish signer identity.`

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function requiredFlag(name: string): string {
  const value = flag(name)
  if (!value) throw new Error(`Missing required ${name}`)
  return value
}

function integerFlag(name: string, fallback: number, min: number, max: number): number {
  const value = Number(flag(name, String(fallback)))
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} through ${max}`)
  return value
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

async function readKey(path: string): Promise<Uint8Array> {
  if (path !== '-') {
    const stats = await import('node:fs/promises').then(({ stat }) => stat(path))
    if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      throw new Error('Private key file permissions are too broad; run chmod 600 on the key file')
    }
  }
  const bytes = path === '-' ? await readStdin() : await readFile(path)
  let key: SigningKeyFile
  try {
    key = JSON.parse(new TextDecoder().decode(bytes)) as SigningKeyFile
  } catch {
    throw new Error('Private key file is not valid JSON')
  }
  if (key.version !== 1 || key.algorithm !== 'Ed25519' || typeof key.secretKey !== 'string') throw new Error('Unsupported private key file')
  const secret = base64UrlDecode(key.secretKey)
  if (secret.length !== 32) throw new Error('Private key must contain a 32-byte Ed25519 secret')
  return secret
}

async function writeNew(path: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  await writeFile(path, data, { flag: 'wx', mode })
  if (process.platform !== 'win32') await chmod(path, mode)
}

async function keygen(): Promise<void> {
  const output = requiredFlag('--out')
  const key = await generateSigningKey()
  await writeNew(output, `${JSON.stringify(key, null, 2)}\n`, 0o600)
  console.log(JSON.stringify({ created: output, keyId: key.keyId, permissions: process.platform === 'win32' ? 'verify ACLs manually' : '0600' }, null, 2))
}

async function create(): Promise<void> {
  const input = requiredFlag('--input')
  const output = requiredFlag('--out')
  const receipt = JSON.parse(await readFile(input, 'utf8')) as BuildReceipt
  validateReceipt(receipt)
  const envelope = await signReceipt(receipt, await readKey(requiredFlag('--key')))
  await writeNew(output, envelope)
  const source = await BeaconSource.create(envelope)
  console.log(JSON.stringify({ created: output, receiptId: source.id, envelopeBytes: envelope.length, sourceBlocks: source.blockCount }, null, 2))
}

async function verify(): Promise<void> {
  const input = requiredFlag('--input')
  const result = await verifyEnvelope(await readFile(input))
  console.log(JSON.stringify({
    valid: result.valid,
    signatureValid: result.signatureValid,
    trust: result.trust,
    keyId: result.keyId,
    reason: result.reason,
    receipt: result.receipt,
  }, null, 2))
  if (!result.valid) process.exitCode = 2
}

function shouldDrop(sequence: number, loss: number): boolean {
  const bucket = (Math.imul(sequence, 1_103_515_245) + 12_345) >>> 0
  return bucket / 0x1_0000_0000 < loss
}

async function simulate(): Promise<void> {
  const envelope = await readFile(requiredFlag('--input'))
  const offset = integerFlag('--offset', 73, 0, 0xfffffff0)
  const frameCount = integerFlag('--frames', 96, 1, 512)
  const loss = Number(flag('--loss', '0.30'))
  if (!Number.isFinite(loss) || loss < 0 || loss >= 1) throw new Error('--loss must be at least 0 and less than 1')
  const source = await BeaconSource.create(envelope)
  const receiver = new BeaconReceiver()
  let dropped = 0
  for (let sequence = offset; sequence < offset + frameCount && !receiver.progress.complete; sequence += 1) {
    if (shouldDrop(sequence, loss)) {
      dropped += 1
      continue
    }
    await receiver.add(await source.frame(sequence))
  }
  const progress = receiver.progress
  const verification = progress.payload ? await verifyEnvelope(progress.payload) : undefined
  console.log(JSON.stringify({
    transportRecovered: progress.complete,
    receiptId: progress.receiptId,
    matrixRank: `${progress.rank}/${progress.required}`,
    uniqueFrames: progress.uniqueFrames,
    droppedFrames: dropped,
    signatureValid: verification?.signatureValid ?? false,
    trust: verification?.trust ?? 'invalid',
  }, null, 2))
  if (!progress.complete || !verification?.valid) process.exitCode = 2
}

async function frames(): Promise<void> {
  const input = requiredFlag('--input')
  const outputDirectory = requiredFlag('--out-dir')
  const count = integerFlag('--count', 24, 1, 512)
  const offset = integerFlag('--offset', 0, 0, 0xffffffff - count)
  const source = await BeaconSource.create(await readFile(input))
  await mkdir(outputDirectory, { recursive: true })
  for (let index = 0; index < count; index += 1) {
    const sequence = offset + index
    const text = await source.frame(sequence)
    const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 320 })
    await writeNew(`${outputDirectory}/frame-${String(sequence).padStart(4, '0')}.svg`, svg)
  }
  console.log(JSON.stringify({ created: count, directory: outputDirectory, receiptId: source.id }, null, 2))
}

async function writeDemo(): Promise<void> {
  await writeNew(requiredFlag('--out'), `${JSON.stringify(demoReceipt(), null, 2)}\n`)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    stdout.write(`${HELP}\n`)
    return
  }
  if (command === 'keygen') return keygen()
  if (command === 'create') return create()
  if (command === 'verify' || command === 'inspect') return verify()
  if (command === 'simulate') return simulate()
  if (command === 'frames') return frames()
  if (command === 'demo') return writeDemo()
  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  console.error(`buildbeacon: ${error instanceof Error ? error.message : 'unexpected error'}`)
  process.exitCode = 1
})
