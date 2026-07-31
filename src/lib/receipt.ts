import { decode, encode } from 'cbor2'
import { equalBytes, fromHex, toHex } from './encoding'
import {
  RECEIPT_SCHEMA_VERSION,
  type BuildCheck,
  type BuildReceipt,
  type CheckResult,
  type CommitAlgorithm,
  type TreeState,
} from './types'

const COMMIT_ALGORITHMS: Record<CommitAlgorithm, number> = { 'git-sha1': 1, 'git-sha256': 2 }
const COMMIT_ALGORITHMS_BY_ID = new Map(Object.entries(COMMIT_ALGORITHMS).map(([key, value]) => [value, key as CommitAlgorithm]))
const TREE_STATES: Record<TreeState, number> = { unknown: 0, clean: 1, dirty: 2 }
const TREE_STATES_BY_ID = new Map(Object.entries(TREE_STATES).map(([key, value]) => [value, key as TreeState]))
const CHECK_RESULTS: Record<CheckResult, number> = { unknown: 0, pass: 1, fail: 2, skip: 3 }
const CHECK_RESULTS_BY_ID = new Map(Object.entries(CHECK_RESULTS).map(([key, value]) => [value, key as CheckResult]))

const MAX_RECEIPT_BYTES = 2_048

function assertString(value: unknown, label: string, maxLength: number): asserts value is string {
  const characters = typeof value === 'string' ? Array.from(value) : []
  const containsControlCharacter = characters.some((character) => character.codePointAt(0)! < 32)
  const containsUnpairedSurrogate = characters.some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint >= 0xd800 && codePoint <= 0xdfff
  })
  if (typeof value !== 'string' || characters.length === 0 || characters.length > maxLength || containsControlCharacter || containsUnpairedSurrogate) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`)
  }
}

function assertHttpsUrl(value: string, label: string): void {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use https`)
}

export function validateReceipt(receipt: BuildReceipt): void {
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) throw new Error('Unsupported receipt schema version')
  assertString(receipt.repository, 'repository', 256)
  assertHttpsUrl(receipt.repository, 'repository')
  if (!(receipt.commit.algorithm in COMMIT_ALGORITHMS)) throw new Error('Unsupported commit algorithm')
  const commitLength = receipt.commit.algorithm === 'git-sha1' ? 40 : 64
  if (!new RegExp(`^[0-9a-f]{${commitLength}}$`, 'iu').test(receipt.commit.value)) {
    throw new Error(`${receipt.commit.algorithm} commit must contain ${commitLength} hexadecimal characters`)
  }
  if (!(receipt.treeState in TREE_STATES)) throw new Error('Unsupported tree state')
  assertString(receipt.artifact.name, 'artifact.name', 128)
  if (!/^[0-9a-f]{64}$/iu.test(receipt.artifact.sha256)) throw new Error('artifact.sha256 must contain 64 hexadecimal characters')
  if (receipt.artifact.size !== undefined && (!Number.isSafeInteger(receipt.artifact.size) || receipt.artifact.size < 0)) {
    throw new Error('artifact.size must be a non-negative safe integer')
  }
  assertString(receipt.build.builder, 'build.builder', 64)
  const builtAt = Date.parse(receipt.build.builtAt)
  if (!Number.isFinite(builtAt) || new Date(builtAt).toISOString() !== receipt.build.builtAt) {
    throw new Error('build.builtAt must be an ISO-8601 UTC timestamp')
  }
  if (new Date(builtAt).getUTCMilliseconds() !== 0) throw new Error('build.builtAt must use whole-second precision')
  if (receipt.build.runUrl !== undefined) {
    assertString(receipt.build.runUrl, 'build.runUrl', 256)
    assertHttpsUrl(receipt.build.runUrl, 'build.runUrl')
  }
  if (!Array.isArray(receipt.checks) || receipt.checks.length > 16) throw new Error('checks must contain at most 16 entries')
  for (const check of receipt.checks) {
    assertString(check.name, 'check.name', 64)
    if (!(check.result in CHECK_RESULTS)) throw new Error('Unsupported check result')
    if (check.evidenceSha256 !== undefined && !/^[0-9a-f]{64}$/iu.test(check.evidenceSha256)) {
      throw new Error('check.evidenceSha256 must contain 64 hexadecimal characters')
    }
  }
}

function checkToMap(check: BuildCheck): Map<number, unknown> {
  const map = new Map<number, unknown>([
    [0, check.name],
    [1, CHECK_RESULTS[check.result]],
  ])
  if (check.evidenceSha256) map.set(2, fromHex(check.evidenceSha256))
  return map
}

export function encodeReceipt(receipt: BuildReceipt): Uint8Array {
  validateReceipt(receipt)
  const commit = new Map<number, unknown>([
    [0, COMMIT_ALGORITHMS[receipt.commit.algorithm]],
    [1, fromHex(receipt.commit.value)],
  ])
  const artifact = new Map<number, unknown>([
    [0, receipt.artifact.name],
    [1, fromHex(receipt.artifact.sha256)],
  ])
  if (receipt.artifact.size !== undefined) artifact.set(2, receipt.artifact.size)
  const build = new Map<number, unknown>([
    [0, Math.floor(Date.parse(receipt.build.builtAt) / 1000)],
    [1, receipt.build.builder],
  ])
  if (receipt.build.runUrl) build.set(2, receipt.build.runUrl)
  const map = new Map<number, unknown>([
    [0, RECEIPT_SCHEMA_VERSION],
    [1, receipt.repository],
    [2, commit],
    [3, TREE_STATES[receipt.treeState]],
    [4, artifact],
    [5, build],
    [6, receipt.checks.map(checkToMap)],
  ])
  const bytes = encode(map, { dcbor: true })
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error(`Receipt exceeds ${MAX_RECEIPT_BYTES} encoded bytes`)
  return bytes
}

function expectMap(value: unknown, label: string): Map<unknown, unknown> {
  if (!(value instanceof Map)) throw new Error(`${label} must be a CBOR map`)
  return value
}

function expectBytes(value: unknown, label: string, length?: number): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) {
    throw new Error(`${label} must be a ${length ?? ''}-byte string`)
  }
  return value
}

function assertKeys(map: Map<unknown, unknown>, allowed: number[], label: string): void {
  for (const key of map.keys()) if (typeof key !== 'number' || !allowed.includes(key)) throw new Error(`${label} contains an unknown field`)
}

export function decodeReceipt(bytes: Uint8Array): BuildReceipt {
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) throw new Error('Receipt byte length is outside protocol limits')
  const input = new Uint8Array(bytes)
  const decoded = decode(input, {
    dcbor: true,
    maxDepth: 8,
    preferMap: true,
    rejectDuplicateKeys: true,
    rejectStreaming: true,
    requirePreferred: true,
  })
  const map = expectMap(decoded, 'receipt')
  assertKeys(map, [0, 1, 2, 3, 4, 5, 6], 'receipt')
  const commit = expectMap(map.get(2), 'commit')
  const artifact = expectMap(map.get(4), 'artifact')
  const build = expectMap(map.get(5), 'build')
  assertKeys(commit, [0, 1], 'commit')
  assertKeys(artifact, [0, 1, 2], 'artifact')
  assertKeys(build, [0, 1, 2], 'build')
  const algorithm = COMMIT_ALGORITHMS_BY_ID.get(commit.get(0) as number)
  const treeState = TREE_STATES_BY_ID.get(map.get(3) as number)
  if (!algorithm || !treeState) throw new Error('Receipt uses an unsupported enum value')
  const checksValue = map.get(6)
  if (!Array.isArray(checksValue)) throw new Error('checks must be an array')
  const checks = checksValue.map((value): BuildCheck => {
    const check = expectMap(value, 'check')
    assertKeys(check, [0, 1, 2], 'check')
    const result = CHECK_RESULTS_BY_ID.get(check.get(1) as number)
    if (!result) throw new Error('Check uses an unsupported result')
    const entry: BuildCheck = { name: check.get(0) as string, result }
    if (check.has(2)) entry.evidenceSha256 = toHex(expectBytes(check.get(2), 'check.evidenceSha256', 32))
    return entry
  })
  const builtAtSeconds = build.get(0)
  if (!Number.isSafeInteger(builtAtSeconds)) throw new Error('build.builtAt must be an integer')
  const receipt: BuildReceipt = {
    schemaVersion: map.get(0) as 1,
    repository: map.get(1) as string,
    commit: { algorithm, value: toHex(expectBytes(commit.get(1), 'commit.value')) },
    treeState,
    artifact: {
      name: artifact.get(0) as string,
      sha256: toHex(expectBytes(artifact.get(1), 'artifact.sha256', 32)),
      ...(artifact.has(2) ? { size: artifact.get(2) as number } : {}),
    },
    build: {
      builtAt: new Date((builtAtSeconds as number) * 1000).toISOString(),
      builder: build.get(1) as string,
      ...(build.has(2) ? { runUrl: build.get(2) as string } : {}),
    },
    checks,
  }
  validateReceipt(receipt)
  if (!equalBytes(input, encodeReceipt(receipt))) throw new Error('Receipt is not encoded canonically')
  return receipt
}

export function demoReceipt(): BuildReceipt {
  return {
    schemaVersion: 1,
    repository: 'https://github.com/stoicpickle/buildbeacon',
    commit: { algorithm: 'git-sha1', value: '491b2ddf7a44d269ae5432de2d22255398abfa9d' },
    treeState: 'clean',
    artifact: {
      name: 'initial-readme.md',
      sha256: '7b43b2c1d9c12a279c96eb322d2a183f022b8ae99da7ee3d48720b93e5c1fb8b',
      size: 13,
    },
    build: {
      builtAt: '2026-07-31T17:44:15.000Z',
      builder: 'Synthetic BBP/1 fixture',
      runUrl: 'https://github.com/stoicpickle/buildbeacon/commit/491b2ddf7a44d269ae5432de2d22255398abfa9d',
    },
    checks: [
      { name: 'canonical fixture vector', result: 'pass' },
    ],
  }
}
