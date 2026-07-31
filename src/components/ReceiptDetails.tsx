import type { VerificationResult } from '../lib'

interface ReceiptDetailsProps {
  verification?: VerificationResult
  transportRecovered?: boolean
  receiptId?: string
}

function shorten(value: string, start = 12, end = 8): string {
  return value.length <= start + end + 1 ? value : `${value.slice(0, start)}…${value.slice(-end)}`
}

export function ReceiptDetails({ verification, transportRecovered = false, receiptId }: ReceiptDetailsProps) {
  const receipt = verification?.receipt
  const signatureLabel = !verification ? 'Not checked' : verification.signatureValid ? 'Signature valid' : 'Signature invalid'
  const trustLabel = !verification
    ? 'Not evaluated'
    : verification.trust === 'trusted'
      ? 'Pinned key trusted'
      : verification.trust === 'self-presented'
        ? 'Self-presented key'
        : 'Not trusted'
  return (
    <div className="inspect-stack">
      <div className="proof-states">
        <div className={`proof-state ${transportRecovered ? 'proof-state--pass' : ''}`}>
          <span className="state-icon">1</span>
          <span><small>Transport</small><strong>{transportRecovered ? 'Receipt reconstructed' : 'Waiting for frames'}</strong></span>
        </div>
        <div className={`proof-state ${verification ? (verification.signatureValid ? 'proof-state--pass' : 'proof-state--fail') : ''}`}>
          <span className="state-icon">2</span>
          <span><small>Cryptography</small><strong>{signatureLabel}</strong></span>
        </div>
        <div className={`proof-state ${verification?.trust === 'invalid' ? 'proof-state--fail' : 'proof-state--warn'}`}>
          <span className="state-icon">3</span>
          <span><small>Trust</small><strong>{trustLabel}</strong></span>
        </div>
      </div>

      {receipt ? (
        <div className="receipt-card">
          <div className="receipt-card__header">
            <div><span className="eyebrow eyebrow--dark">{verification?.signatureValid ? 'Claimed build facts' : 'Unverified build claims'}</span><h3>{receipt.artifact.name}</h3></div>
            <span className={`status-chip ${verification?.signatureValid ? '' : 'status-chip--invalid'}`}>{verification?.signatureValid ? 'signed' : 'invalid'}</span>
          </div>
          <dl className="receipt-grid">
            <div><dt>Repository</dt><dd><a href={receipt.repository} target="_blank" rel="noreferrer">{receipt.repository.replace('https://github.com/', '')}</a></dd></div>
            <div><dt>Commit</dt><dd><code title={receipt.commit.value}>{shorten(receipt.commit.value)}</code></dd></div>
            <div><dt>Artifact SHA-256</dt><dd><code title={receipt.artifact.sha256}>{shorten(receipt.artifact.sha256)}</code></dd></div>
            <div><dt>Builder claim</dt><dd>{receipt.build.builder}</dd></div>
            <div><dt>Built at</dt><dd>{new Date(receipt.build.builtAt).toLocaleString()}</dd></div>
            <div><dt>Tree state</dt><dd>{receipt.treeState}</dd></div>
            <div className="receipt-grid__wide"><dt>Signer fingerprint</dt><dd><code>{verification.keyId}</code></dd></div>
            {receiptId && <div className="receipt-grid__wide"><dt>Receipt ID</dt><dd><code>{receiptId}</code></dd></div>}
          </dl>
          <div className="check-list">
            {receipt.checks.map((check) => (
              <span key={check.name} className={`check-pill check-pill--${check.result}`}>
                {check.result === 'pass' ? '✓' : '·'} {check.name}: {check.result}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="empty-inspector"><span>⌁</span><p>Recover a beacon or load a signed receipt to inspect its claims.</p></div>
      )}

      <div className="honesty-note">
        <strong>Important boundary</strong>
        <p>A valid signature protects the receipt from undetected changes. It does not prove the surrounding footage came from the claimed artifact, and a self-presented key does not establish who the signer is.</p>
      </div>
    </div>
  )
}
