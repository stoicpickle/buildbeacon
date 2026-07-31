import * as ed from '@noble/ed25519'
import { decode, encode } from 'cbor2'
import { base64UrlEncode, concatBytes, equalBytes, sha256, toHex, utf8 } from './encoding'
import { decodeReceipt, encodeReceipt } from './receipt'
import {
  ENVELOPE_VERSION,
  SIGNATURE_ALGORITHM,
  type BuildReceipt,
  type SigningKeyFile,
  type VerificationResult,
} from './types'

const DOMAIN = utf8('BUILD-BEACON-RECEIPT-V1\0')
export const MAX_ENVELOPE_BYTES = 3_072

export async function keyIdFor(publicKey: Uint8Array): Promise<string> {
  return `sha256:${toHex(await sha256(publicKey))}`
}

export async function generateSigningKey(): Promise<SigningKeyFile> {
  const { secretKey, publicKey } = await ed.keygenAsync()
  return {
    version: 1,
    algorithm: SIGNATURE_ALGORITHM,
    keyId: await keyIdFor(publicKey),
    publicKey: base64UrlEncode(publicKey),
    secretKey: base64UrlEncode(secretKey),
    warning: 'PRIVATE DEMO KEY — keep this file secret; v1 does not provide rotation or revocation.',
  }
}

export async function signReceipt(receipt: BuildReceipt, secretKey: Uint8Array): Promise<Uint8Array> {
  if (secretKey.length !== 32) throw new Error('Ed25519 secret key must be 32 bytes')
  const receiptBytes = encodeReceipt(receipt)
  const publicKey = await ed.getPublicKeyAsync(secretKey)
  const signature = await ed.signAsync(concatBytes(DOMAIN, receiptBytes), secretKey)
  const envelope = new Map<number, unknown>([
    [0, ENVELOPE_VERSION],
    [1, 1],
    [2, publicKey],
    [3, receiptBytes],
    [4, signature],
  ])
  const bytes = encode(envelope, { dcbor: true })
  if (bytes.length > MAX_ENVELOPE_BYTES) throw new Error(`Signed envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`)
  return bytes
}

interface DecodedEnvelope {
  publicKey: Uint8Array
  receiptBytes: Uint8Array
  signature: Uint8Array
}

function decodeEnvelope(bytes: Uint8Array): DecodedEnvelope {
  if (bytes.length === 0 || bytes.length > MAX_ENVELOPE_BYTES) throw new Error('Envelope byte length is outside protocol limits')
  const input = new Uint8Array(bytes)
  const value = decode(input, {
    dcbor: true,
    maxDepth: 10,
    preferMap: true,
    rejectDuplicateKeys: true,
    rejectStreaming: true,
    requirePreferred: true,
  })
  if (!(value instanceof Map)) throw new Error('Envelope must be a CBOR map')
  for (const key of value.keys()) if (typeof key !== 'number' || ![0, 1, 2, 3, 4].includes(key)) throw new Error('Envelope contains an unknown field')
  if (value.get(0) !== ENVELOPE_VERSION || value.get(1) !== 1) throw new Error('Unsupported envelope version or signature algorithm')
  const publicKey = value.get(2)
  const receiptBytes = value.get(3)
  const signature = value.get(4)
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new Error('Envelope public key must be 32 bytes')
  if (!(receiptBytes instanceof Uint8Array) || receiptBytes.length > 2_048) throw new Error('Envelope receipt is outside protocol limits')
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('Envelope signature must be 64 bytes')
  const canonical = encode(value, { dcbor: true })
  if (!equalBytes(input, canonical)) throw new Error('Envelope is not encoded canonically')
  return { publicKey, receiptBytes, signature }
}

export async function verifyEnvelope(
  bytes: Uint8Array,
  trustedKeyIds: ReadonlySet<string> = new Set(),
): Promise<VerificationResult> {
  try {
    const envelope = decodeEnvelope(bytes)
    const receipt = decodeReceipt(envelope.receiptBytes)
    const keyId = await keyIdFor(envelope.publicKey)
    const signatureValid = await ed.verifyAsync(
      envelope.signature,
      concatBytes(DOMAIN, envelope.receiptBytes),
      envelope.publicKey,
      { zip215: false },
    )
    return {
      valid: signatureValid,
      signatureValid,
      canonical: true,
      keyId,
      publicKey: envelope.publicKey,
      receipt,
      trust: signatureValid ? (trustedKeyIds.has(keyId) ? 'trusted' : 'self-presented') : 'invalid',
      ...(!signatureValid ? { reason: 'Ed25519 signature does not match the receipt' } : {}),
    }
  } catch (error) {
    return {
      valid: false,
      signatureValid: false,
      canonical: false,
      keyId: '',
      publicKey: new Uint8Array(),
      trust: 'invalid',
      reason: error instanceof Error ? error.message : 'Invalid signed envelope',
    }
  }
}
