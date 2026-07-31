export const RECEIPT_SCHEMA_VERSION = 1 as const
export const ENVELOPE_VERSION = 1 as const
export const SIGNATURE_ALGORITHM = 'Ed25519' as const

export type CommitAlgorithm = 'git-sha1' | 'git-sha256'
export type TreeState = 'unknown' | 'clean' | 'dirty'
export type CheckResult = 'unknown' | 'pass' | 'fail' | 'skip'

export interface BuildCheck {
  name: string
  result: CheckResult
  evidenceSha256?: string
}

export interface BuildReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION
  repository: string
  commit: {
    algorithm: CommitAlgorithm
    value: string
  }
  treeState: TreeState
  artifact: {
    name: string
    sha256: string
    size?: number
  }
  build: {
    builtAt: string
    builder: string
    runUrl?: string
  }
  checks: BuildCheck[]
}

export interface SigningKeyFile {
  version: 1
  algorithm: typeof SIGNATURE_ALGORITHM
  keyId: string
  publicKey: string
  secretKey: string
  warning: string
}

export type TrustState = 'self-presented' | 'trusted' | 'invalid'

export interface VerificationResult {
  valid: boolean
  signatureValid: boolean
  canonical: boolean
  keyId: string
  publicKey: Uint8Array
  receipt?: BuildReceipt
  trust: TrustState
  reason?: string
}
