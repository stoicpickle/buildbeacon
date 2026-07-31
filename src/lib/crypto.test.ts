import * as ed from '@noble/ed25519'
import { describe, expect, it } from 'vitest'
import { fromHex } from './encoding'
import { signReceipt, verifyEnvelope } from './crypto'
import { demoReceipt } from './receipt'

const RFC_8032_SECRET = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
const RFC_8032_PUBLIC = fromHex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
const RFC_8032_SIGNATURE = fromHex(
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155' +
    '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
)

describe('signed receipt envelope', () => {
  it('passes the RFC 8032 empty-message vector with strict verification', async () => {
    expect(await ed.getPublicKeyAsync(RFC_8032_SECRET)).toEqual(RFC_8032_PUBLIC)
    expect(await ed.signAsync(new Uint8Array(), RFC_8032_SECRET)).toEqual(RFC_8032_SIGNATURE)
    expect(await ed.verifyAsync(RFC_8032_SIGNATURE, new Uint8Array(), RFC_8032_PUBLIC, { zip215: false })).toBe(true)
  })

  it('signs and verifies a canonical receipt while keeping trust separate', async () => {
    const envelope = await signReceipt(demoReceipt(), RFC_8032_SECRET)
    const result = await verifyEnvelope(envelope)
    expect(result.valid).toBe(true)
    expect(result.signatureValid).toBe(true)
    expect(result.canonical).toBe(true)
    expect(result.trust).toBe('self-presented')
    expect(result.receipt).toEqual(demoReceipt())
  })

  it('verifies the pooled Buffer representation returned by Node file reads', async () => {
    const envelope = await signReceipt(demoReceipt(), RFC_8032_SECRET)
    const nodeBuffer = Buffer.from(envelope)
    expect((await verifyEnvelope(nodeBuffer)).valid).toBe(true)
  })

  it('fails closed when one envelope byte is changed', async () => {
    const envelope = await signReceipt(demoReceipt(), RFC_8032_SECRET)
    envelope[Math.floor(envelope.length / 2)]! ^= 1
    const result = await verifyEnvelope(envelope)
    expect(result.valid).toBe(false)
    expect(result.trust).toBe('invalid')
  })
})
