import { base64UrlDecode, base64UrlEncode, concatBytes, equalBytes, sha256, toHex, utf8 } from './encoding'
import { crc32c } from './crc32c'

const MAGIC_A = 0x42
const MAGIC_B = 0x42
const PROTOCOL_VERSION = 1
const HEADER_BYTES = 32
const RECEIPT_ID_BYTES = 16
const MIN_BLOCK_SIZE = 32
const MAX_BLOCK_SIZE = 128
const MAX_BLOCKS = 32
const MAX_FRAMES = 512
const MAX_PAYLOAD_BYTES = 3_072
const PREFIX = 'BB1:'
const MASK_DOMAIN = utf8('BUILD-BEACON-MASK-V1\0')

export interface BeaconFrame {
  receiptId: Uint8Array
  sequence: number
  blockCount: number
  blockSize: number
  envelopeLength: number
  systematic: boolean
  symbol: Uint8Array
}

export interface ReceiveProgress {
  accepted: boolean
  duplicate: boolean
  rank: number
  required: number
  uniqueFrames: number
  receiptId?: string
  complete: boolean
  payload?: Uint8Array
  reason?: string
}

function u32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value >>> 0, false)
  return bytes
}

function bit(index: number): number {
  return (1 << index) >>> 0
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let index = 0; index < target.length; index += 1) target[index] = target[index]! ^ source[index]!
}

function systematicFor(sequence: number, blockCount: number): boolean {
  const epochLength = blockCount + Math.ceil(blockCount / 2)
  return sequence % epochLength < blockCount
}

async function maskFor(receiptId: Uint8Array, sequence: number, blockCount: number): Promise<number> {
  const slot = sequence % (blockCount + Math.ceil(blockCount / 2))
  if (slot < blockCount) return bit(slot)
  const digest = await sha256(concatBytes(MASK_DOMAIN, receiptId, u32be(sequence), Uint8Array.of(blockCount)))
  let mask = 0
  for (let index = 0; index < blockCount; index += 1) {
    if (((digest[Math.floor(index / 8)]! >>> (index % 8)) & 1) === 1) mask = (mask | bit(index)) >>> 0
  }
  return mask === 0 ? bit(digest[31]! % blockCount) : mask
}

function encodeFrame(frame: BeaconFrame): string {
  const bytes = new Uint8Array(HEADER_BYTES + frame.blockSize)
  const view = new DataView(bytes.buffer)
  bytes[0] = MAGIC_A
  bytes[1] = MAGIC_B
  bytes[2] = PROTOCOL_VERSION
  bytes[3] = frame.systematic ? 1 : 0
  bytes.set(frame.receiptId, 4)
  view.setUint32(20, frame.sequence, false)
  bytes[24] = frame.blockCount
  bytes[25] = frame.blockSize
  view.setUint16(26, frame.envelopeLength, false)
  bytes.set(frame.symbol, HEADER_BYTES)
  view.setUint32(28, crc32c(bytes.subarray(0, 28), bytes.subarray(HEADER_BYTES)), false)
  return `${PREFIX}${base64UrlEncode(bytes)}`
}

export function parseFrameText(text: string): BeaconFrame {
  if (!text.startsWith(PREFIX)) throw new Error('Not a BuildBeacon v1 frame')
  if (text.length > 300) throw new Error('Frame text exceeds protocol limits')
  const bytes = base64UrlDecode(text.slice(PREFIX.length))
  if (bytes.length < HEADER_BYTES) throw new Error('Frame is truncated')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] !== MAGIC_A || bytes[1] !== MAGIC_B || bytes[2] !== PROTOCOL_VERSION) throw new Error('Frame magic or version is unsupported')
  const flags = bytes[3]!
  if ((flags & 0xfe) !== 0) throw new Error('Frame contains unsupported flags')
  const blockCount = bytes[24]!
  const blockSize = bytes[25]!
  const envelopeLength = view.getUint16(26, false)
  if (blockCount < 1 || blockCount > MAX_BLOCKS) throw new Error('Frame block count is outside protocol limits')
  if (blockSize < MIN_BLOCK_SIZE || blockSize > MAX_BLOCK_SIZE) throw new Error('Frame block size is outside protocol limits')
  if (envelopeLength < 1 || envelopeLength > MAX_PAYLOAD_BYTES || envelopeLength > blockCount * blockSize || Math.ceil(envelopeLength / blockSize) !== blockCount) {
    throw new Error('Frame envelope length is inconsistent')
  }
  if (bytes.length !== HEADER_BYTES + blockSize) throw new Error('Frame byte length is inconsistent')
  const sequence = view.getUint32(20, false)
  const systematic = (flags & 1) === 1
  if (systematic !== systematicFor(sequence, blockCount)) throw new Error('Frame systematic flag is inconsistent')
  const expectedCrc = view.getUint32(28, false)
  const actualCrc = crc32c(bytes.subarray(0, 28), bytes.subarray(HEADER_BYTES))
  if (actualCrc !== expectedCrc) throw new Error('Frame CRC32C check failed')
  return {
    receiptId: bytes.slice(4, 4 + RECEIPT_ID_BYTES),
    sequence,
    blockCount,
    blockSize,
    envelopeLength,
    systematic,
    symbol: bytes.slice(HEADER_BYTES),
  }
}

export class BeaconSource {
  readonly payload: Uint8Array
  readonly receiptId: Uint8Array
  readonly blockSize: number
  readonly blockCount: number
  private readonly blocks: Uint8Array[]

  private constructor(payload: Uint8Array, receiptId: Uint8Array, blockSize: number) {
    this.payload = payload
    this.receiptId = receiptId
    this.blockSize = blockSize
    this.blockCount = Math.ceil(payload.length / blockSize)
    this.blocks = Array.from({ length: this.blockCount }, (_, index) => {
      const block = new Uint8Array(blockSize)
      block.set(payload.subarray(index * blockSize, (index + 1) * blockSize))
      return block
    })
  }

  static async create(payload: Uint8Array, blockSize = 96): Promise<BeaconSource> {
    if (payload.length < 1 || payload.length > MAX_PAYLOAD_BYTES) throw new Error('Beacon payload is outside protocol limits')
    if (!Number.isInteger(blockSize) || blockSize < MIN_BLOCK_SIZE || blockSize > MAX_BLOCK_SIZE) {
      throw new Error(`Block size must be an integer from ${MIN_BLOCK_SIZE} through ${MAX_BLOCK_SIZE}`)
    }
    const blockCount = Math.ceil(payload.length / blockSize)
    if (blockCount > MAX_BLOCKS) throw new Error(`Payload requires more than ${MAX_BLOCKS} source blocks`)
    const digest = await sha256(payload)
    return new BeaconSource(new Uint8Array(payload), digest.slice(0, RECEIPT_ID_BYTES), blockSize)
  }

  get id(): string {
    return toHex(this.receiptId)
  }

  async frame(sequence: number): Promise<string> {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error('Sequence must be a uint32')
    const mask = await maskFor(this.receiptId, sequence, this.blockCount)
    const symbol = new Uint8Array(this.blockSize)
    for (let index = 0; index < this.blockCount; index += 1) if ((mask & bit(index)) !== 0) xorInto(symbol, this.blocks[index]!)
    return encodeFrame({
      receiptId: this.receiptId,
      sequence,
      blockCount: this.blockCount,
      blockSize: this.blockSize,
      envelopeLength: this.payload.length,
      systematic: systematicFor(sequence, this.blockCount),
      symbol,
    })
  }
}

interface Equation {
  mask: number
  value: Uint8Array
}

export class BeaconReceiver {
  private receiptId?: Uint8Array
  private blockCount = 0
  private blockSize = 0
  private envelopeLength = 0
  private readonly pivots: Array<Equation | undefined> = []
  private readonly sequences = new Set<number>()
  private rank = 0
  private payload?: Uint8Array

  get progress(): ReceiveProgress {
    return {
      accepted: false,
      duplicate: false,
      rank: this.rank,
      required: this.blockCount,
      uniqueFrames: this.sequences.size,
      receiptId: this.receiptId ? toHex(this.receiptId) : undefined,
      complete: this.payload !== undefined,
      payload: this.payload,
    }
  }

  async add(text: string): Promise<ReceiveProgress> {
    try {
      if (this.sequences.size >= MAX_FRAMES) throw new Error('Receiver frame limit reached')
      const frame = parseFrameText(text)
      if (!this.receiptId) {
        this.receiptId = frame.receiptId
        this.blockCount = frame.blockCount
        this.blockSize = frame.blockSize
        this.envelopeLength = frame.envelopeLength
        this.pivots.length = frame.blockCount
      } else if (
        !equalBytes(this.receiptId, frame.receiptId) ||
        this.blockCount !== frame.blockCount ||
        this.blockSize !== frame.blockSize ||
        this.envelopeLength !== frame.envelopeLength
      ) {
        throw new Error('Frame belongs to a different or inconsistent beacon')
      }
      if (this.sequences.has(frame.sequence)) return { ...this.progress, duplicate: true }
      this.sequences.add(frame.sequence)
      let row: Equation = {
        mask: await maskFor(frame.receiptId, frame.sequence, frame.blockCount),
        value: new Uint8Array(frame.symbol),
      }
      for (let pivot = 0; pivot < this.blockCount; pivot += 1) {
        const existing = this.pivots[pivot]
        if (existing && (row.mask & bit(pivot)) !== 0) {
          row.mask = (row.mask ^ existing.mask) >>> 0
          xorInto(row.value, existing.value)
        }
      }
      if (row.mask !== 0) {
        let pivot = 0
        while (pivot < this.blockCount && (row.mask & bit(pivot)) === 0) pivot += 1
        this.pivots[pivot] = row
        this.rank += 1
        for (let other = 0; other < this.blockCount; other += 1) {
          const equation = this.pivots[other]
          if (other !== pivot && equation && (equation.mask & bit(pivot)) !== 0) {
            equation.mask = (equation.mask ^ row.mask) >>> 0
            xorInto(equation.value, row.value)
          }
        }
      }
      if (this.rank === this.blockCount && !this.payload) {
        const reconstructed = new Uint8Array(this.blockCount * this.blockSize)
        for (let index = 0; index < this.blockCount; index += 1) {
          const equation = this.pivots[index]
          if (!equation || equation.mask !== bit(index)) throw new Error('Decoder matrix did not reduce to source blocks')
          reconstructed.set(equation.value, index * this.blockSize)
        }
        const candidate = reconstructed.slice(0, this.envelopeLength)
        const digest = await sha256(candidate)
        if (!equalBytes(digest.slice(0, RECEIPT_ID_BYTES), this.receiptId)) throw new Error('Reconstructed envelope digest does not match the beacon ID')
        this.payload = candidate
      }
      return { ...this.progress, accepted: true }
    } catch (error) {
      return { ...this.progress, reason: error instanceof Error ? error.message : 'Frame rejected' }
    }
  }
}
