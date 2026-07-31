import { beforeAll, describe, expect, it } from 'vitest'
import { signReceipt } from './crypto'
import { base64UrlDecode, base64UrlEncode, fromHex } from './encoding'
import { BeaconReceiver, BeaconSource, parseFrameText } from './fountain'
import { demoReceipt } from './receipt'
import { crc32c } from './crc32c'

const SECRET = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
let envelope: Uint8Array
let source: BeaconSource

beforeAll(async () => {
  envelope = await signReceipt(demoReceipt(), SECRET)
  source = await BeaconSource.create(envelope, 64)
})

describe('BBP/1 loss-tolerant frame transport', () => {
  it('matches the standard CRC32C check vector', () => {
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283)
  })

  it('round-trips a frame and exposes bounded metadata', async () => {
    const parsed = parseFrameText(await source.frame(37))
    expect(parsed.blockCount).toBe(source.blockCount)
    expect(parsed.blockSize).toBe(64)
    expect(parsed.envelopeLength).toBe(envelope.length)
    expect(parsed.sequence).toBe(37)
    expect(source.id).toBe('6b3ba041e95d4a51da0da0f55965bf1d')
  })

  it('recovers join-late with deterministic loss and reordering', async () => {
    const frames: string[] = []
    for (let sequence = 73; sequence < 73 + 96; sequence += 1) {
      if (sequence % 4 !== 0) frames.push(await source.frame(sequence))
    }
    frames.reverse()
    const receiver = new BeaconReceiver()
    let progress = receiver.progress
    for (const frame of frames) {
      progress = await receiver.add(frame)
      if (progress.complete) break
    }
    expect(progress.complete).toBe(true)
    expect(progress.rank).toBe(source.blockCount)
    expect(progress.payload).toEqual(envelope)
  })

  it('recovers from every start offset in a complete fountain epoch', async () => {
    const epochLength = source.blockCount + Math.ceil(source.blockCount / 2)
    for (let offset = 0; offset < epochLength; offset += 1) {
      const receiver = new BeaconReceiver()
      let progress = receiver.progress
      for (let sequence = offset; sequence < offset + epochLength; sequence += 1) {
        progress = await receiver.add(await source.frame(sequence))
      }
      expect(progress.complete, `start offset ${offset}`).toBe(true)
      expect(progress.payload).toEqual(envelope)
    }
  })

  it('ignores duplicate equations', async () => {
    const receiver = new BeaconReceiver()
    const frame = await source.frame(2)
    expect((await receiver.add(frame)).accepted).toBe(true)
    const duplicate = await receiver.add(frame)
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.uniqueFrames).toBe(1)
  })

  it('rejects a one-bit packet mutation through CRC32C', async () => {
    const frame = await source.frame(4)
    const bytes = base64UrlDecode(frame.slice(4))
    bytes[bytes.length - 1]! ^= 1
    const receiver = new BeaconReceiver()
    const progress = await receiver.add(`BB1:${base64UrlEncode(bytes)}`)
    expect(progress.accepted).toBe(false)
    expect(progress.reason).toMatch(/CRC32C/u)
  })

  it('does not mix receipts', async () => {
    const otherReceipt = demoReceipt()
    otherReceipt.artifact.name = 'different-artifact.tar.gz'
    const otherSource = await BeaconSource.create(await signReceipt(otherReceipt, SECRET), 64)
    const receiver = new BeaconReceiver()
    expect((await receiver.add(await source.frame(0))).accepted).toBe(true)
    const mixed = await receiver.add(await otherSource.frame(1))
    expect(mixed.accepted).toBe(false)
    expect(mixed.reason).toMatch(/different/u)
  })
})
